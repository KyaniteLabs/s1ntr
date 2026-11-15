import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CampaignClosureLedger,
  DurableCampaignClosureEvidenceRegistry,
  assertAuthenticCampaignClosureEvidenceAuthority,
  bootstrapCampaignClosureEvidenceAuthority,
  deriveCampaignOwnerPreference,
  type CampaignLearningAuthorizationEvidence,
  type CampaignClosurePersistence,
  type CampaignExperimentOutcome,
} from '../../../src/creative-run/CampaignClosure.js';
import { FileCampaignLedgerPersistence } from '../../../src/creative-run/CampaignPersistence.js';
import { DurableCampaignClosureLedger } from '../../../src/creative-run/CampaignClosure.js';
import { CampaignService } from '../../../src/creative-run/CampaignService.js';
import { CreativeRunCoordinator, type LearningAuthorization,
  type LearningStageReceipt, type ProvisionalLearningTransfer } from '../../../src/creative-run/CreativeRunCoordinator.js';
import { buildCandidateManifest } from '../../../src/creative-run/CandidateHypothesisProduction.js';
import { createCaptureAuthority, createEnvelopeAuthority } from '../../../src/creative-run/OwnerQualityReview.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const wireDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = { manifestDigest: 'a'.repeat(64), campaignRunId: 'campaign-closure-test' };
const briefIds = ['brief-a', 'brief-b', 'brief-c'] as const;

class MemoryPersistence implements CampaignClosurePersistence {
  readonly records = new Map<string, string>();
  readonly locks = new Map<string, Promise<void>>();
  async read(key: string): Promise<string | null> { return this.records.get(key) ?? null; }
  async write(key: string, data: string): Promise<void> { this.records.set(key, data); }
  async claim<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, previous.then(() => next));
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function recordInput(briefId: typeof briefIds[number], outcome: CampaignExperimentOutcome = 'experiment-improved', options: {
  ownerPreference?: 'treatment-preferred' | 'baseline-preferred' | 'tie';
  release?: 'release-worthy' | 'not-release-worthy';
} = {}) {
  const planDigest = digest(`plan:${briefId}`);
  const preference = options.ownerPreference ?? 'treatment-preferred';
  const blindPreference = {
    planDigest, treatmentArtifactDigest: digest(`artifact:${briefId}`),
    reviewer: {
      role: 'specialist' as const, provider: 'independent-provider', model: 'independent-model',
      pipe: 'independent-pipe', effort: 'high', contributionLineage: `reviewer:${briefId}`,
      assignment: `blind-treatment:${briefId}`,
    }, outcome: preference,
  };
  const owner = { ownerPacketDigest: digest(`packet:${briefId}`), preference,
    release: options.release ?? 'release-worthy' };
  return {
    briefId,
    revision: {
      planDigest, receiptDigest: digest(`revision:${briefId}`), outcome,
      improvementEstablished: outcome === 'experiment-improved',
      blindPreference: { ...blindPreference, receiptDigest: wireDigest(blindPreference) },
    },
    settlement: {
      stageId: `revision-${briefId}`, allocationId: `allocation-${briefId}`,
      reservationDigest: digest(`reservation:${briefId}`), settlementDigest: digest(`settlement:${briefId}`),
    },
    owner: { ...owner, decisionDigest: digest(owner) },
  };
}

async function durableLearningFixture(directory: string, id = 'learning-authorization-a') {
  const persistence = new FileCampaignLedgerPersistence(directory);
  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const envelopeAuthority = createEnvelopeAuthority({ keyId: 'learning-envelope', privateKeyPem });
  const captureAuthority = createCaptureAuthority({ keyId: 'learning-capture', privateKeyPem });
  const manifest = await buildCandidateManifest('A new unseen moonlit motion study.');
  const registry = new DurableCampaignClosureEvidenceRegistry(
    persistence, envelopeAuthority, captureAuthority,
  );
  const authorizationBody = {
    schema: 'sinter.learning-authorization' as const, schemaVersion: 1 as const,
    decision: 'allow' as const,
    issuer: { id: 'issuer', role: 'issuer' as const, assertionDigest: digest('issuer') },
    owner: { id: 'owner', role: 'owner' as const, assertionDigest: digest('owner') },
    authorityRegistryId: 'registry', applicationBoundary: 'campaign-test', ruleId: 'contrast',
    artifactDigest: manifest.candidates[0]!.artifact.artifactDigest,
    planDigest: digest('plan'), revisionReceiptDigest: digest('revision'),
    issuedAt: '2026-08-01T10:00:00.000Z', expiresAt: '2026-08-03T10:00:00.000Z',
    maximumTransfers: 1 as const, initialRevocationState: 'active' as const,
  };
  const authorization: LearningAuthorization = Object.freeze({ ...authorizationBody,
    authorizationDigest: wireDigest(authorizationBody) });
  return { persistence, envelopeAuthority, captureAuthority, manifest, registry, authorization, id };
}

async function persistLearningEvidence(fixture: Awaited<ReturnType<typeof durableLearningFixture>>) {
  const context = (rules: Readonly<Record<string, number>>) => ({ rules,
    contextDigest: wireDigest({ rules }) });
  const provisionalBody = {
    schema: 'sinter.provisional-learning-transfer' as const, schemaVersion: 1 as const,
    authorizationDigest: fixture.authorization.authorizationDigest,
    ruleId: fixture.authorization.ruleId, ruleValue: 2,
    artifactDigest: fixture.authorization.artifactDigest,
    planDigest: fixture.authorization.planDigest,
    revisionReceiptDigest: fixture.authorization.revisionReceiptDigest,
    priorContext: context({}), nextContext: context({ contrast: 2 }),
  };
  const provisional: ProvisionalLearningTransfer = Object.freeze({ ...provisionalBody,
    provisionalDigest: wireDigest(provisionalBody) });
  const stageBody = {
    schema: 'sinter.learning-stage-receipt' as const, schemaVersion: 1 as const,
    status: 'staged' as const, reason: 'STAGED' as const,
    persistenceBoundary: 'in-memory-transaction-only' as const, provisional,
    mutationCounters: { tasteWrites: 0, modelTrainingWrites: 0, ruleWrites: 0, contextWrites: 0 },
  };
  const stage: LearningStageReceipt = Object.freeze({ ...stageBody, receiptDigest: wireDigest(stageBody) });
  const unsigned = { id: fixture.id, binding, briefId: 'brief-a',
    manifestIntentDigest: digest(fixture.manifest.intent), manifest: fixture.manifest,
    planDigest: fixture.authorization.planDigest,
    route: { provider: 'provider', model: 'model', pipe: 'pipe', effort: 'high' },
    revisionReceiptDigest: fixture.authorization.revisionReceiptDigest,
    authorization: fixture.authorization, stage, provisional };
  const evidence: CampaignLearningAuthorizationEvidence = Object.freeze({ ...unsigned,
    signatureBase64: fixture.envelopeAuthority.signReview(unsigned), evidenceDigest: digest(unsigned) });
  await fixture.persistence.write(`campaign-closure:evidence:learning:${fixture.id}`, JSON.stringify(evidence));
  const stateBody = { authorizationEvidenceId: fixture.id, state: 'active' as const };
  await fixture.persistence.write(`campaign-closure:learning-state:${fixture.id}`,
    JSON.stringify({ ...stateBody, stateDigest: digest(stateBody) }));
  return evidence;
}

describe('CampaignClosureLedger', () => {
  it('rejects a structural fake evidence resolver before closure can resolve caller data', () => {
    expect(() => assertAuthenticCampaignClosureEvidenceAuthority({
      sealLearningAuthorization: async () => ({}) as never,
      resolveRevision: async () => ({}) as never,
      resolveOwnerDecision: async () => ({}) as never,
      resolveLearningAuthorization: async () => ({}) as never,
      resolveLearningAuthorizationState: async () => ({}) as never,
      resolveActiveLearningAuthorization: async () => ({}) as never,
      beginLearningAuthorizationExecution: async () => ({}) as never,
      resolveLearningAuthorizationExecution: async () => ({}) as never,
      commitLearningAuthorizationExecution: async () => ({}) as never,
      abortLearningAuthorizationExecution: async () => ({}) as never,
      consumeLearningAuthorization: async () => ({}) as never,
      revokeLearningAuthorization: async () => ({}) as never,
    })).toThrow('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_PROVENANCE_INVALID');
  });

  it('accepts only the active bootstrap registry, never a direct or subclass constructor', () => {
    class CallerSubclass extends DurableCampaignClosureEvidenceRegistry {}
    const direct = new DurableCampaignClosureEvidenceRegistry(new MemoryPersistence(), {} as never, {} as never);
    const subclass = new CallerSubclass(new MemoryPersistence(), {} as never, {} as never);
    expect(() => assertAuthenticCampaignClosureEvidenceAuthority(direct))
      .toThrow('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_PROVENANCE_INVALID');
    expect(() => assertAuthenticCampaignClosureEvidenceAuthority(subclass))
      .toThrow('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_PROVENANCE_INVALID');
    expect(() => new CampaignService(new CreativeRunCoordinator(), { closureEvidenceAuthority: direct }))
      .toThrow('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_PROVENANCE_INVALID');
    const bootstrapped = bootstrapCampaignClosureEvidenceAuthority({
      persistence: new MemoryPersistence(), envelopeAuthority: {} as never, captureAuthority: {} as never,
    });
    expect(assertAuthenticCampaignClosureEvidenceAuthority(bootstrapped)).toBe(bootstrapped);
  });

  it('maps the winner only within the exact baseline/treatment pair', () => {
    const baseline = digest('baseline');
    const treatment = digest('treatment');
    const pair = [{ blindId: 'blind-a', artifactDigest: baseline },
      { blindId: 'blind-b', artifactDigest: treatment }] as const;
    expect(deriveCampaignOwnerPreference({ outcome: 'preferred', winnerBlindId: 'blind-a', candidates: pair },
      baseline, treatment)).toBe('baseline-preferred');
    expect(deriveCampaignOwnerPreference({ outcome: 'preferred', winnerBlindId: 'blind-b', candidates: pair },
      baseline, treatment)).toBe('treatment-preferred');
    expect(deriveCampaignOwnerPreference({ outcome: 'rejected', candidates: pair }, baseline, treatment)).toBe('tie');
    expect(() => deriveCampaignOwnerPreference({ outcome: 'preferred', winnerBlindId: 'blind-a',
      candidates: [{ blindId: 'blind-a', artifactDigest: baseline },
        { blindId: 'blind-x', artifactDigest: digest('cross-artifact') }] }, baseline, treatment))
      .toThrow('CAMPAIGN_CLOSURE_OWNER_PREFERENCE_PAIR_INVALID');
  });

  it('survives the crash boundary after owner-packet persistence and closes exactly once after reload', async () => {
    const persistence = new MemoryPersistence();
    const first = new CampaignClosureLedger(binding, briefIds, persistence);
    const inputs = briefIds.map(briefId => recordInput(briefId));
    await Promise.all(inputs.map(input => first.record(input)));
    const reloaded = new CampaignClosureLedger(binding, briefIds, persistence);
    const replay = await reloaded.record(inputs[0]!);
    expect(replay.owner.ownerPacketDigest).toBe(inputs[0]!.owner.ownerPacketDigest);
    expect(replay.revision.blindPreference.reviewer.assignment).toBe('blind-treatment:brief-a');
    const receipt = await reloaded.close();
    expect(receipt.status).toBe('passed');
    expect(receipt.improvedBriefCount).toBe(3);
    expect(receipt.ownerTreatmentPreferenceCount).toBe(3);
    expect((await reloaded.close()).closureDigest).toBe(receipt.closureDigest);
  });

  it('rejects replay conflicts, concurrent competing writes, and tampered reloads', async () => {
    const persistence = new MemoryPersistence();
    const ledger = new CampaignClosureLedger(binding, briefIds, persistence);
    const original = recordInput('brief-a');
    await ledger.record(original);
    await expect(ledger.record(recordInput('brief-a', 'experiment-regressed')))
      .rejects.toThrow('CAMPAIGN_CLOSURE_OUTCOME_IMMUTABLE');
    await expect(Promise.all([
      ledger.record(recordInput('brief-b')),
      ledger.record(recordInput('brief-b', 'experiment-regressed')),
    ])).rejects.toThrow('CAMPAIGN_CLOSURE_OUTCOME_IMMUTABLE');
    const key = `campaign-closure:outcome:${binding.manifestDigest}:${binding.campaignRunId}:brief-a`;
    persistence.records.set(key, JSON.stringify({ ...await ledger.record(original), recordDigest: 'b'.repeat(64) }));
    await expect(new CampaignClosureLedger(binding, briefIds, persistence).record(original))
      .rejects.toThrow('CAMPAIGN_CLOSURE_RECORD_TAMPERED');
  });

  it('requires the exact revision stage, every terminal brief, and durable red for failed gates', async () => {
    const persistence = new MemoryPersistence();
    const ledger = new CampaignClosureLedger(binding, briefIds, persistence);
    await expect(ledger.record({ ...recordInput('brief-a'), settlement: {
      ...recordInput('brief-a').settlement, stageId: 'revision-brief-b',
    } })).rejects.toThrow('CAMPAIGN_CLOSURE_REVISION_STAGE_MISMATCH');
    await ledger.record(recordInput('brief-a'));
    await expect(ledger.close()).rejects.toThrow('CAMPAIGN_CLOSURE_BRIEF_NOT_TERMINAL:brief-b');
    await ledger.record(recordInput('brief-b', 'experiment-regressed', {
      ownerPreference: 'baseline-preferred', release: 'not-release-worthy',
    }));
    await ledger.record(recordInput('brief-c', 'experiment-inconclusive', {
      ownerPreference: 'tie', release: 'not-release-worthy',
    }));
    await expect(ledger.close()).resolves.toMatchObject({
      status: 'durable-red',
      reasons: expect.arrayContaining([
        'fewer-than-two-briefs-improved',
        'owner-treatment-preference-gate-failed',
        'owner-release-worthiness-gate-failed',
      ]),
    });
  });

  it('uses CampaignPersistence for a crash-safe, restartable closeout ledger', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'campaign-closure-'));
    const manifest = { ...binding, briefs: briefIds.map((id) => ({ id })) } as never;
    try {
      const first = new DurableCampaignClosureLedger(manifest, new FileCampaignLedgerPersistence(directory));
      await first.record(recordInput('brief-a'));
      const restarted = new DurableCampaignClosureLedger(manifest, new FileCampaignLedgerPersistence(directory));
      expect((await restarted.record(recordInput('brief-a'))).briefId).toBe('brief-a');
      await restarted.record(recordInput('brief-b'));
      await restarted.record(recordInput('brief-c'));
      await expect(restarted.close()).resolves.toMatchObject({ status: 'passed' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('durably reserves, aborts, retries, and commits one whole comparison', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'campaign-learning-'));
    try {
      const fixture = await durableLearningFixture(directory);
      const evidence = await persistLearningEvidence(fixture);
      const scope = { binding, briefId: 'brief-a', now: '2026-08-02T10:00:00.000Z' };
      await expect(fixture.registry.resolveActiveLearningAuthorization(fixture.id, scope))
        .resolves.toMatchObject({ evidenceDigest: evidence.evidenceDigest });
      const first = await fixture.registry.beginLearningAuthorizationExecution(fixture.id,
        { ...scope, executionId: 'comparison-attempt-1' });
      const restarted = new DurableCampaignClosureEvidenceRegistry(
        fixture.persistence, fixture.envelopeAuthority, fixture.captureAuthority,
      );
      await expect(restarted.resolveLearningAuthorizationExecution(fixture.id, first, scope.now))
        .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_ARM_REQUIRED');
      await expect(restarted.resolveLearningAuthorizationExecution(fixture.id, first, 'treatment', scope.now))
        .resolves.toMatchObject({ id: fixture.id });
      await expect(restarted.commitLearningAuthorizationExecution(fixture.id, first, scope.now))
        .rejects.toThrow('CAMPAIGN_LEARNING_COMPARISON_INCOMPLETE');
      await expect(restarted.resolveLearningAuthorizationExecution(fixture.id, first, 'control', scope.now))
        .resolves.toMatchObject({ id: fixture.id });
      await expect(restarted.consumeLearningAuthorization(fixture.id))
        .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_EXECUTION_REQUIRED');
      await expect(restarted.abortLearningAuthorizationExecution(fixture.id, first))
        .resolves.toMatchObject({ state: 'active' });
      const retry = await restarted.beginLearningAuthorizationExecution(fixture.id,
        { ...scope, executionId: 'comparison-attempt-2' });
      await restarted.resolveLearningAuthorizationExecution(fixture.id, retry, 'treatment', scope.now);
      await restarted.resolveLearningAuthorizationExecution(fixture.id, retry, 'control', scope.now);
      const committed = await restarted.commitLearningAuthorizationExecution(fixture.id, retry, scope.now);
      expect(committed).toMatchObject({ state: 'consumed', execution: retry,
        authorizedArms: ['treatment', 'control'] });
      await expect(restarted.commitLearningAuthorizationExecution(fixture.id, retry, scope.now))
        .resolves.toEqual(committed);
      await expect(restarted.commitLearningAuthorizationExecution(fixture.id, first, scope.now))
        .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
      await expect(restarted.beginLearningAuthorizationExecution(fixture.id,
        { ...scope, executionId: 'comparison-replay' }))
        .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for cross-bound, expired, revoked, competing, and tampered state', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'campaign-learning-reject-'));
    try {
      const fixture = await durableLearningFixture(directory, 'learning-reject');
      await persistLearningEvidence(fixture);
      const current = { binding, briefId: 'brief-a', now: '2026-08-02T10:00:00.000Z' };
      await expect(fixture.registry.beginLearningAuthorizationExecution(fixture.id,
        { ...current, binding: { ...binding, campaignRunId: 'other' }, executionId: 'cross-campaign' }))
        .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_SCOPE_MISMATCH');
      await expect(fixture.registry.beginLearningAuthorizationExecution(fixture.id,
        { ...current, briefId: 'brief-b', executionId: 'cross-brief' }))
        .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_SCOPE_MISMATCH');
      await expect(fixture.registry.beginLearningAuthorizationExecution(fixture.id,
        { ...current, now: '2026-08-03T10:00:00.000Z', executionId: 'expired' }))
        .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_EXPIRED');
      const competing = await Promise.allSettled([
        fixture.registry.beginLearningAuthorizationExecution(fixture.id,
          { ...current, executionId: 'competing-a' }),
        fixture.registry.beginLearningAuthorizationExecution(fixture.id,
          { ...current, executionId: 'competing-b' }),
      ]);
      expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const winner = competing.find((result) => result.status === 'fulfilled');
      if (!winner || winner.status !== 'fulfilled') throw new Error('expected one execution winner');
      await fixture.registry.abortLearningAuthorizationExecution(fixture.id, winner.value);
      await expect(fixture.registry.revokeLearningAuthorization(fixture.id))
        .resolves.toMatchObject({ state: 'revoked' });
      await expect(fixture.registry.beginLearningAuthorizationExecution(fixture.id,
        { ...current, executionId: 'revoked' }))
        .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
      const stateKey = `campaign-closure:learning-state:${fixture.id}`;
      const stored = JSON.parse((await fixture.persistence.read(stateKey))!);
      await fixture.persistence.write(stateKey, JSON.stringify({ ...stored, state: 'active' }));
      await expect(fixture.registry.resolveLearningAuthorizationState(fixture.id))
        .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_STATE_INVALID');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
