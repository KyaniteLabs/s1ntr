import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompositionRequest } from '../../../src/composition/CompositionGraph.js';
import { DreamQueue } from '../../../src/dreaming/DreamQueue.js';
import type {
  DreamAssimilationGovernance,
  DreamAssimilationRunner,
} from '../../../src/dreaming/DreamTaskRunner.js';
import { runNextDreamTask } from '../../../src/dreaming/DreamTaskRunner.js';
import {
  DurableCampaignClosureEvidenceRegistry,
  type CampaignClosureReceipt,
  type CampaignLearningAuthorizationEvidence,
} from '../../../src/creative-run/CampaignClosure.js';
import {
  bootstrapCampaignTransferEvaluator,
  CampaignContinuation,
  campaignTransferNonOverlapDigest,
  campaignTransferRouteDigest,
  resolveCampaignDreamLesson,
  type CampaignDreamLessonCapability,
  type CampaignContinuationHost,
  type CampaignTransferEvaluationInput,
  type CampaignTransferOutcome,
} from '../../../src/creative-run/CampaignContinuation.js';
import {
  FileCampaignLedgerPersistence,
  type CampaignLedgerPersistence,
} from '../../../src/creative-run/CampaignPersistence.js';
import type { CampaignFundingReservationV1 } from '../../../src/creative-run/CampaignExecutionAuthority.js';
import type { CampaignFundingReservationAuthority } from '../../../src/creative-run/CampaignExecutionAuthority.js';
import { CampaignService } from '../../../src/creative-run/CampaignService.js';
import { unitTestCampaignAuthorityBoundary } from '../../fixtures/campaignAuthorityBoundary.js';
import {
  createCampaignManifest,
  type CampaignBudgetFeasibility,
  type CampaignExecutionPlan,
} from '../../../src/creative-run/CampaignManifest.js';
import type {
  CampaignEvidenceCheckpoint,
  CampaignRunAdmission,
  CoordinatedCompositionResult,
  CreativeRunHandle,
  CreativeRunRecord,
} from '../../../src/creative-run/CreativeRunCoordinatorBase.js';
import {
  buildCandidateManifest,
  type CandidateManifest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';
import type {
  LearningAuthorization,
  LearningStageReceipt,
  ProvisionalLearningTransfer,
} from '../../../src/creative-run/CreativeRunCoordinator.js';
import { createCaptureAuthority, createEnvelopeAuthority } from
  '../../../src/creative-run/OwnerQualityReview.js';
import type { CampaignEvidenceReceipt, CampaignOriginReceipt } from
  '../../../src/runtime-core/CampaignOrigin.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const continuationDigest = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value : stable(value)).digest('hex');
const wireDigest = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

class DreamMarkerFaultPersistence implements CampaignLedgerPersistence {
  faultInjected = false;

  constructor(private readonly backing: FileCampaignLedgerPersistence) {}

  read(key: string): Promise<string | null> { return this.backing.read(key); }
  readSync(key: string): string | null { return this.backing.readSync(key); }
  claim<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.backing.claim(key, operation);
  }
  write(key: string, data: string): Promise<void> {
    if (!this.faultInjected && key.startsWith('campaign-continuation:')) {
      const value = JSON.parse(data) as { phases?: { dream?: string };
        dreamRecommendationDigest?: string };
      if (value.phases?.dream === 'running' && value.dreamRecommendationDigest) {
        this.faultInjected = true;
        return Promise.reject(new Error('FAULT_AFTER_DREAM_SUCCESS'));
      }
    }
    return this.backing.write(key, data);
  }
}

interface ContinuationFixture {
  readonly root: string;
  readonly persistence: FileCampaignLedgerPersistence;
  readonly learningEvidenceId: string;
  readonly evidence: CampaignLearningAuthorizationEvidence;
  readonly registry: DurableCampaignClosureEvidenceRegistry;
  readonly envelopeAuthority: ReturnType<typeof createEnvelopeAuthority>;
  readonly captureAuthority: ReturnType<typeof createCaptureAuthority>;
  readonly candidateManifest: CandidateManifest;
  readonly manifest: ReturnType<typeof createCampaignManifest>;
  readonly admission: CampaignRunAdmission;
  readonly checkpoint: CampaignEvidenceCheckpoint;
  readonly targetContent: string;
}

async function fixture(options: { persistEvidence?: boolean; now?: string } = {}): Promise<ContinuationFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'campaign-continuation-'));
  directories.push(root);
  const persistence = new FileCampaignLedgerPersistence(root);
  const campaignRunId = `campaign-${path.basename(root)}`;
  const learningEvidenceId = `learning-${path.basename(root)}`;
  const targetContent = 'An unseen study of slow blue arcs and quiet negative space.';
  const candidateManifest = await buildCandidateManifest('A copper lattice pulsing against charcoal.');
  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const envelopeAuthority = createEnvelopeAuthority({ keyId: 'learning-envelope', privateKeyPem });
  const captureAuthority = createCaptureAuthority({ keyId: 'learning-capture', privateKeyPem });
  const registry = new DurableCampaignClosureEvidenceRegistry(
    persistence, envelopeAuthority, captureAuthority,
  );
  const authorizationBody = {
    schema: 'sinter.learning-authorization' as const,
    schemaVersion: 1 as const,
    decision: 'allow' as const,
    issuer: { id: 'issuer', role: 'issuer' as const, assertionDigest: digest('issuer') },
    owner: { id: 'owner', role: 'owner' as const, assertionDigest: digest('owner') },
    authorityRegistryId: 'registry', applicationBoundary: 'campaign-continuation-test',
    ruleId: 'contrast', artifactDigest: candidateManifest.candidates[0]!.artifact.artifactDigest,
    planDigest: digest('learning-plan'), revisionReceiptDigest: digest('revision'),
    issuedAt: '2026-08-01T10:00:00.000Z', expiresAt: '2026-08-03T10:00:00.000Z',
    maximumTransfers: 1 as const, initialRevocationState: 'active' as const,
  };
  const authorization: LearningAuthorization = Object.freeze({ ...authorizationBody,
    authorizationDigest: wireDigest(authorizationBody) });
  const route = { provider: 'provider', model: 'model', pipe: 'pipe', effort: 'high' };
  const briefDigest = digest('sealed-source-brief');
  const evidenceScheduleDigest = digest('evidence-schedule');
  const randomSourceDigest = digest('random-source');
  const targetDigest = continuationDigest(targetContent);
  const ownerEvidenceBody = { campaignRunId, briefId: 'brief-a', candidateId: 'candidate-a',
    nodeId: 'node-a', audioRequirement: 'not-applicable' as const,
    requiredEvidenceClasses: ['source', 'visual', 'temporal', 'interaction', 'runtime',
      'clock', 'accessibility'] as const, evidenceScheduleDigest };
  const manifest = createCampaignManifest({
    campaignRunId,
    owner: { authorityId: 'owner-a', selectionMethod: 'sealed-owner-selection' },
    briefs: [{ id: 'brief-a', sealedBriefDigest: briefDigest,
      unseenAt: '2026-08-01T00:00:00.000Z', exampleFree: true,
      candidateSlots: [{ id: 'candidate-a', graphNodeIds: ['node-a'],
        ownerEvidence: { ...ownerEvidenceBody, slotDigest: digest(ownerEvidenceBody) } }] }],
    transfer: { mode: 'sealed-brief', sealedBriefDigest: targetDigest,
      unseenAt: '2026-08-01T00:00:00.000Z', treatmentControlAllocation: 'treatment-first',
      routeDigest: campaignTransferRouteDigest(route), randomSourceDigest,
      evidenceScheduleDigest,
      nonOverlapDigest: campaignTransferNonOverlapDigest(targetDigest,
        [briefDigest, digest(candidateManifest.intent)]) },
    rolesDigest: digest('roles'), executorRequirementsDigest: digest('executors'),
    evidenceModalitiesDigest: digest('modalities'), ownerCheckpointsDigest: digest('checkpoints'),
    qualityRubricVersion: 'rubric-v1', randomSourceDigest, evidenceScheduleDigest,
    requiredReviewStageIds: ['specialist-review-brief-a-candidate-a'],
    stopStates: ['complete'], ceilings: { providerCalls: 8, inputTokens: 10_000,
      outputTokens: 5_000, activeMinutes: 60 },
  });
  const planBody = {
    schema: 'sinter.campaign-execution-plan' as const, schemaVersion: 1 as const,
    manifestDigest: manifest.manifestDigest, campaignRunId,
    routeFreeze: { routes: [], transportBudgets: {}, transferTargetDigest: targetDigest,
      diversityDimensions: [], candidateDiversity: [] },
    routeFreezeDigest: digest('route-freeze'), slotGraphDigests: [], stages: [],
  };
  const plan: CampaignExecutionPlan = Object.freeze({ ...planBody, planDigest: digest(planBody) });
  const feasibilityBody = { passed: true, failures: [], requiredStageCount: 0,
    totals: { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeMinutes: 0 } };
  const feasibility: CampaignBudgetFeasibility = Object.freeze({ ...feasibilityBody,
    feasibilityDigest: digest(feasibilityBody) });
  const fundingSubject = {
    schemaVersion: 'campaign-funding-reservation.v1' as const,
    reservationId: 'reservation-a', campaignRunId, manifestDigest: manifest.manifestDigest,
    planDigest: plan.planDigest, routeFreezeDigest: plan.routeFreezeDigest, allocations: [],
    issuedAt: '2026-08-01T09:00:00.000Z', expiresAt: '2026-08-03T10:00:00.000Z',
    nonce: 'nonce-a', keyId: 'key-a',
  };
  const fundingReservation: CampaignFundingReservationV1 = Object.freeze({
    subject: fundingSubject, signature: 'signature', reservationDigest: digest(fundingSubject),
  });
  const record: CreativeRunRecord = {
    schemaVersion: 2, rootRunId: `root-${campaignRunId}`, lineageId: 'lineage-a',
    requestKey: campaignRunId, entryPoint: 'cli-compose', releaseRoot: 'release-root',
    status: 'reserved', providerReservation: { id: 'provider-reservation', status: 'reserved',
      source: 'synthetic-no-spend' },
    readiness: { wave: 8, ready: true, source: 'synthetic-no-spend', reason: 'test' },
    campaignOrigin: { manifestDigest: manifest.manifestDigest, planDigest: plan.planDigest,
      campaignFundingReservationDigest: fundingReservation.reservationDigest,
      feasibilityDigest: feasibility.feasibilityDigest, routeFreezeDigest: plan.routeFreezeDigest },
    createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z',
  };
  const creativeRun: CreativeRunHandle = {
    rootRunId: record.rootRunId, lineageId: record.lineageId, requestKey: record.requestKey,
    providerReservation: record.providerReservation, readiness: record.readiness, record,
  };
  const admission: CampaignRunAdmission = {
    creativeRun, manifestDigest: manifest.manifestDigest, planDigest: plan.planDigest,
    plan, feasibility, fundingReservation,
  };
  const checkpointBody = {
    schema: 'sinter.campaign-evidence-checkpoint' as const, schemaVersion: 1 as const,
    originPending: true as const, campaignRunId, rootRunId: creativeRun.rootRunId,
    manifestDigest: manifest.manifestDigest,
    campaignFundingReservationDigest: fundingReservation.reservationDigest,
    campaignPlanDigest: plan.planDigest, campaignRouteFreezeDigest: plan.routeFreezeDigest,
    receipts: [] as CampaignEvidenceReceipt[],
  };
  const checkpoint: CampaignEvidenceCheckpoint = Object.freeze({ ...checkpointBody,
    checkpointDigest: continuationDigest(checkpointBody) });
  const context = (rules: Readonly<Record<string, number>>) => ({ rules,
    contextDigest: wireDigest({ rules }) });
  const provisionalBody = {
    schema: 'sinter.provisional-learning-transfer' as const, schemaVersion: 1 as const,
    authorizationDigest: authorization.authorizationDigest, ruleId: authorization.ruleId,
    ruleValue: 2, artifactDigest: authorization.artifactDigest,
    planDigest: authorization.planDigest,
    revisionReceiptDigest: authorization.revisionReceiptDigest,
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
  const stage: LearningStageReceipt = Object.freeze({ ...stageBody,
    receiptDigest: wireDigest(stageBody) });
  const unsigned = {
    id: learningEvidenceId,
    binding: { manifestDigest: manifest.manifestDigest, campaignRunId }, briefId: 'brief-a',
    manifestIntentDigest: digest(candidateManifest.intent), manifest: candidateManifest,
    planDigest: authorization.planDigest, route,
    revisionReceiptDigest: authorization.revisionReceiptDigest,
    authorization, stage, provisional,
  };
  const evidence: CampaignLearningAuthorizationEvidence = Object.freeze({ ...unsigned,
    signatureBase64: envelopeAuthority.signReview(unsigned), evidenceDigest: digest(unsigned) });
  if (options.persistEvidence !== false) {
    await persistence.write(`campaign-closure:evidence:learning:${learningEvidenceId}`,
      JSON.stringify(evidence));
    const stateBody = { authorizationEvidenceId: learningEvidenceId, state: 'active' as const };
    await persistence.write(`campaign-closure:learning-state:${learningEvidenceId}`,
      JSON.stringify({ ...stateBody, stateDigest: digest(stateBody) }));
  }
  return { root, persistence, learningEvidenceId, evidence, registry, envelopeAuthority,
    captureAuthority, candidateManifest, manifest, admission, checkpoint, targetContent };
}

function composition(f: ContinuationFixture, stage: 'transfer-treatment' | 'transfer-control'):
CoordinatedCompositionResult {
  return {
    html: `<html><body>${stage}</body></html>`, title: stage, background: '#000000',
    layers: [], successCount: 1, creativeRun: f.admission.creativeRun,
    candidateManifest: f.candidateManifest,
  };
}

function closure(f: ContinuationFixture): CampaignClosureReceipt {
  return {
    binding: { campaignRunId: f.manifest.campaignRunId,
      manifestDigest: f.manifest.manifestDigest },
    briefIds: ['brief-a'], records: [], improvedBriefCount: 1,
    ownerTreatmentPreferenceCount: 1, ownerReleaseWorthyCount: 1,
    status: 'passed', reasons: [], closureDigest: digest('closure'),
  };
}

function origin(f: ContinuationFixture, receipts: readonly CampaignEvidenceReceipt[]): CampaignOriginReceipt {
  const binding = {
    campaignRunId: f.manifest.campaignRunId, rootRunId: f.admission.creativeRun.rootRunId,
    manifestDigest: f.manifest.manifestDigest, releaseHead: 'a'.repeat(40),
    sourceFingerprint: digest('source'), schemaDigest: digest('schema'),
    implementationDigest: digest('implementation'), wave8ReleaseRootDigest: digest('wave8'),
    campaignFundingReservationDigest: f.admission.fundingReservation.reservationDigest,
    campaignPlanDigest: f.admission.plan.planDigest,
    campaignRouteFreezeDigest: f.admission.plan.routeFreezeDigest,
  };
  return {
    schema: 'sinter.campaign-origin-receipt', schemaVersion: 1,
    receiptId: `${f.manifest.campaignRunId}:origin`, kind: 'campaign-origin', keyId: 'test-key',
    ...binding, orderedReceiptDigests: receipts.map((receipt) => receipt.resultDigest),
    signatureBase64: 'test-signature', resultDigest: digest({ binding, receipts }),
  };
}

function host(f: ContinuationFixture, options: {
  outcome?: CampaignTransferOutcome;
  persistence?: CampaignLedgerPersistence;
  registry?: DurableCampaignClosureEvidenceRegistry;
  evaluator?: ReturnType<typeof bootstrapCampaignTransferEvaluator>;
  finalize?: CampaignContinuationHost['finalize'];
  compose?: CampaignContinuationHost['compose'];
  dream?: CampaignContinuationHost['dream'];
  now?: CampaignContinuationHost['now'];
} = {}) {
  const compose = options.compose ?? vi.fn(async (
    _admission: CampaignRunAdmission, _request: CompositionRequest, _options,
    stageId: 'transfer-treatment' | 'transfer-control',
  ) => composition(f, stageId));
  const evaluate = vi.fn(async (_input: CampaignTransferEvaluationInput) => ({
    outcome: options.outcome ?? 'improved', rationaleDigest: digest('rationale'),
  }));
  const evaluator = options.evaluator ?? bootstrapCampaignTransferEvaluator(evaluate);
  const dream = options.dream ?? vi.fn(async () => ({ generation: { recommendation: {
    recommendationDigest: digest('dream-recommendation'),
  } } }));
  const finalize = options.finalize ?? vi.fn(async (
    _admission: CampaignRunAdmission, receipts: readonly CampaignEvidenceReceipt[],
  ) => origin(f, receipts));
  const value: CampaignContinuationHost = {
    persistence: options.persistence ?? f.persistence,
    learningAuthority: options.registry ?? f.registry,
    evaluator, originVerifier: vi.fn(),
    now: options.now ?? (() => new Date('2026-08-02T10:00:00.000Z')),
    binding: (admission) => ({ campaignRunId: f.manifest.campaignRunId,
      rootRunId: admission.creativeRun.rootRunId, manifestDigest: admission.manifestDigest,
      planDigest: admission.plan.planDigest, routeFreezeDigest: admission.plan.routeFreezeDigest,
      campaignFundingReservationDigest: admission.fundingReservation.reservationDigest }),
    close: async () => closure(f), compose, dream, finalize,
  };
  return { value, compose, evaluate, evaluator, dream, finalize };
}

function durableDreamHost(
  f: ContinuationFixture,
  persistence: CampaignLedgerPersistence,
): CampaignContinuationHost['dream'] {
  return async (admission, queue, runner, governance, options) => {
    const causalLesson = resolveCampaignDreamLesson(options.causalLesson);
    const campaignAdmission = Object.freeze({ campaignRunId: f.manifest.campaignRunId,
      manifestDigest: f.manifest.manifestDigest, planDigest: admission.plan.planDigest,
      stageId: 'dream' as const });
    return runNextDreamTask(queue, runner, {
      ...governance,
      campaignDreamAdmission: {
        admission: campaignAdmission,
        assertActiveExactCampaignDreamAdmission: (candidate) => {
          if (candidate !== campaignAdmission) throw new Error('inactive campaign Dream');
        },
        origin: { rootRunId: admission.creativeRun.rootRunId,
          fundingReservationDigest: admission.fundingReservation.reservationDigest,
          feasibilityDigest: admission.feasibility.feasibilityDigest,
          routeFreezeDigest: admission.plan.routeFreezeDigest },
        composeFunded: async () => { throw new Error('runner mock owns funded generation'); },
        causalLesson,
      },
    }, { claimKey: options.requestKey, persistence });
  };
}

function runInput(f: ContinuationFixture, continuation: CampaignContinuation) {
  const target = continuation.sealTarget(f.manifest,
    { mode: 'sealed-brief', brief: f.targetContent });
  const queue = new DreamQueue();
  const runner: DreamAssimilationRunner = {
    runDreamAndAssimilate: async () => { throw new Error('host seam should own Dream execution'); },
  };
  const governance = { identities: {}, evaluators: {} } as DreamAssimilationGovernance;
  return { admission: f.admission, manifest: f.manifest, checkpoint: f.checkpoint,
    learningEvidenceId: f.learningEvidenceId, target, queue, runner, governance };
}

type FundedDreamInvoker = {
  runFundedCampaignDream(admission: CampaignRunAdmission, queue: DreamQueue,
    runner: DreamAssimilationRunner,
    governance: Omit<DreamAssimilationGovernance, 'campaignDreamAdmission'>,
    claimKey: string, lesson: CampaignDreamLessonCapability): Promise<unknown>;
};

function campaignServiceDreamInvoker(persistence: CampaignLedgerPersistence): FundedDreamInvoker {
  const funding = { verify: () => true } as unknown as CampaignFundingReservationAuthority;
  return new CampaignService({} as never, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: funding,
    progressPersistence: persistence }) as unknown as FundedDreamInvoker;
}

describe('Campaign continuation transfer freeze', () => {
  it('binds the exact provider/model route and rejects route drift by digest', () => {
    const frozen = campaignTransferRouteDigest({ provider: 'openai', model: 'generator-a' });
    expect(frozen).toMatch(/^[a-f0-9]{64}$/);
    expect(campaignTransferRouteDigest({ provider: 'openai', model: 'generator-a' })).toBe(frozen);
    expect(campaignTransferRouteDigest({ provider: 'openai', model: 'generator-b' })).not.toBe(frozen);
    expect(campaignTransferRouteDigest({ provider: 'other', model: 'generator-a' })).not.toBe(frozen);
  });

  it('binds target identity to the complete source inventory without order ambiguity', () => {
    const target = 'a'.repeat(64);
    const sourceA = 'b'.repeat(64);
    const sourceB = 'c'.repeat(64);
    const frozen = campaignTransferNonOverlapDigest(target, [sourceA, sourceB]);
    expect(campaignTransferNonOverlapDigest(target, [sourceB, sourceA, sourceA])).toBe(frozen);
    expect(campaignTransferNonOverlapDigest(target, [sourceA])).not.toBe(frozen);
    expect(campaignTransferNonOverlapDigest(sourceA, [target, sourceB])).not.toBe(frozen);
  });
});

describe('CampaignContinuation durable product path', () => {
  it('rejects a causal lesson capability at the wrong CampaignService boundary', async () => {
    const sourceCampaign = await fixture();
    const otherCampaign = await fixture();
    const created = host(sourceCampaign);
    const continuation = new CampaignContinuation(created.value);
    await continuation.run(runInput(sourceCampaign, continuation));
    const capability = created.dream.mock.calls[0][4].causalLesson;
    const queue = new DreamQueue();
    queue.enqueue('elite-x-elite', [{ id: 'source', descriptor: [0.5], quality: 0.8,
      artifact: { domain: 'html', prompt: 'source', code: '<p>source</p>' } }], 1);
    expect(() => campaignServiceDreamInvoker(otherCampaign.persistence).runFundedCampaignDream(
      otherCampaign.admission, queue, { runDreamAndAssimilate: vi.fn() },
      { identities: {}, evaluators: {} }, 'cross-campaign-dream', capability,
    )).toThrow('CAMPAIGN_DREAM_LESSON_BINDING_INVALID');
  });

  it('does not create continuation state for missing, expired, or revoked authorization', async () => {
    const cases = [
      { state: 'missing', prepare: async () => fixture({ persistEvidence: false }),
        expected: 'CAMPAIGN_CLOSURE_EVIDENCE_MISSING' },
      { state: 'expired', prepare: async () => fixture(),
        expected: 'CAMPAIGN_LEARNING_AUTHORIZATION_EXPIRED', expired: true },
      { state: 'revoked', prepare: async () => {
        const value = await fixture();
        await value.registry.revokeLearningAuthorization(value.learningEvidenceId);
        return value;
      }, expected: 'CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE' },
    ] as const;
    for (const testCase of cases) {
      const f = await testCase.prepare();
      const created = host(f, { ...('expired' in testCase
        ? { now: () => new Date('2026-08-04T10:00:00.000Z') } : {}) });
      const continuation = new CampaignContinuation(created.value);
      await expect(continuation.run(runInput(f, continuation))).rejects.toThrow(testCase.expected);
      const key = `campaign-continuation:${f.manifest.campaignRunId}:${f.manifest.manifestDigest}`;
      expect(await f.persistence.read(key), testCase.state).toBeNull();
    }
  });

  it('recovers an interrupted persisted origin without duplicating completed effects', async () => {
    const f = await fixture();
    const composeCalls: Array<{ requestKey: string; stageId: string }> = [];
    const compose: CampaignContinuationHost['compose'] = vi.fn(async (
      _admission, _request, options, stageId,
    ) => {
      composeCalls.push({ requestKey: options.requestKey, stageId });
      return composition(f, stageId);
    });
    const evaluationInputs: CampaignTransferEvaluationInput[] = [];
    const evaluator = bootstrapCampaignTransferEvaluator(async (input) => {
      evaluationInputs.push(input);
      return { outcome: 'improved', rationaleDigest: digest('rationale') };
    });
    const dream = vi.fn(async () => ({ generation: { recommendation: {
      recommendationDigest: digest('dream-recommendation'),
    } } }));
    const finalize = vi.fn<CampaignContinuationHost['finalize']>()
      .mockRejectedValueOnce(new Error('simulated host interruption'))
      .mockImplementation(async (_admission, receipts) => origin(f, receipts));
    const firstHost = host(f, { compose, evaluator, dream, finalize });
    const first = new CampaignContinuation(firstHost.value);
    await expect(first.run(runInput(f, first))).rejects.toThrow('simulated host interruption');

    const restartedRegistry = new DurableCampaignClosureEvidenceRegistry(
      new FileCampaignLedgerPersistence(f.root),
      f.envelopeAuthority,
      f.captureAuthority,
    );
    const restartedHost = host(f, { registry: restartedRegistry, compose, evaluator, dream, finalize });
    const restarted = new CampaignContinuation(restartedHost.value);
    const projection = await restarted.run(runInput(f, restarted));

    expect(composeCalls).toEqual([
      { requestKey: `${f.manifest.campaignRunId}:transfer-treatment`, stageId: 'transfer-treatment' },
      { requestKey: `${f.manifest.campaignRunId}:transfer-control`, stageId: 'transfer-control' },
    ]);
    expect(evaluationInputs).toHaveLength(1);
    expect(evaluationInputs[0]!.evaluationId).toBe(continuationDigest({
      campaignRunId: f.manifest.campaignRunId, manifestDigest: f.manifest.manifestDigest,
      planDigest: f.admission.plan.planDigest,
      targetDigest: continuationDigest(f.targetContent),
      treatmentArtifactDigest: continuationDigest(composition(f, 'transfer-treatment').html),
      controlArtifactDigest: continuationDigest(composition(f, 'transfer-control').html),
    }));
    expect(dream).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(projection).toMatchObject({ transferOutcome: 'improved',
      dreamRecommendationDigest: digest('dream-recommendation') });
  });

  it('replays the exact Dream after external success and a continuation-marker crash', async () => {
    const f = await fixture();
    const queuePath = path.join(f.root, 'dream-queue.json');
    const queue = new DreamQueue({ persistPath: queuePath });
    const source = (id: string) => [{ id, descriptor: [0.5], quality: 0.8,
      artifact: { domain: 'html' as const, prompt: id, code: `<p>${id}</p>` } }];
    const selectedId = queue.enqueue('elite-x-elite', source('selected'), 0.9)!;
    const nextId = queue.enqueue('elite-x-compost', source('next'), 0.4)!;
    const recommendationDigest = digest('one-recommendation');
    const runDreamAndAssimilate = vi.fn(async () => ({
      recommendation: { recommendationDigest },
    }) as never);
    const runner: DreamAssimilationRunner = { runDreamAndAssimilate };
    const persistence = new DreamMarkerFaultPersistence(f.persistence);
    const dream = durableDreamHost(f, persistence);
    const firstHost = host(f, { persistence, dream });
    const first = new CampaignContinuation(firstHost.value);
    const firstInput = { ...runInput(f, first), queue, runner };

    await expect(first.run(firstInput)).rejects.toThrow('FAULT_AFTER_DREAM_SUCCESS');
    expect(persistence.faultInjected).toBe(true);
    expect(runDreamAndAssimilate).toHaveBeenCalledOnce();
    const prompt = runDreamAndAssimilate.mock.calls[0][0].prompt;
    expect(prompt).toContain('outcome=improved');
    expect(prompt).toContain(`rule_id=${f.evidence.provisional.ruleId}`);
    expect(prompt).toContain(`rule_value=${String(f.evidence.provisional.ruleValue)}`);
    expect(prompt).toContain(`authorization_evidence_digest=${f.evidence.evidenceDigest}`);
    expect(prompt).toContain('Preserve the authenticated causal rule');

    const restartedQueue = new DreamQueue({ persistPath: queuePath });
    const restartedHost = host(f, { persistence, dream });
    const restarted = new CampaignContinuation(restartedHost.value);
    const projection = await restarted.run({ ...runInput(f, restarted),
      queue: restartedQueue, runner });

    expect(projection.dreamRecommendationDigest).toBe(recommendationDigest);
    expect(runDreamAndAssimilate).toHaveBeenCalledOnce();
    expect(restartedQueue.getTasks('completed').map((task) => task.id)).toEqual([selectedId]);
    expect(restartedQueue.getTasks('queued').map((task) => task.id)).toEqual([nextId]);
    const claim = JSON.parse((await f.persistence.read(
      `campaign-dream-task:${f.manifest.campaignRunId}:dream`,
    ))!);
    expect(claim).toMatchObject({ status: 'completed', task: { id: selectedId },
      generation: { recommendation: { recommendationDigest } } });
    expect(claim.requestKey).toContain(selectedId);
  });

  it.each(['improved', 'inconclusive', 'regressed'] as const)(
    'persists and projects the %s evaluation while invoking Dream through CampaignContinuation',
    async (outcome) => {
      const f = await fixture();
      const created = host(f, { outcome });
      const continuation = new CampaignContinuation(created.value);
      const projection = await continuation.run(runInput(f, continuation));
      const key = `campaign-continuation:${f.manifest.campaignRunId}:${f.manifest.manifestDigest}`;
      const persisted = JSON.parse((await f.persistence.read(key))!);
      const journal = JSON.parse((await f.persistence.read(
        `campaign-progress:${f.manifest.campaignRunId}:${f.manifest.manifestDigest}`,
      ))!);

      expect(projection.transferOutcome).toBe(outcome);
      expect(persisted).toMatchObject({ ownerAuthorityId: f.manifest.owner.authorityId,
        outcome, evaluationDigest: projection.transferEvaluationDigest,
        phases: { evaluation: 'completed', dream: 'completed', origin: 'completed' } });
      expect(journal.receipts).toContainEqual({
        receiptId: `${f.manifest.campaignRunId}:transfer-evaluation`,
        kind: 'transfer-evaluation', resultDigest: projection.transferEvaluationDigest,
      });
      expect(created.dream).toHaveBeenCalledOnce();
      expect(created.dream).toHaveBeenCalledWith(f.admission, expect.any(DreamQueue),
        expect.objectContaining({ runDreamAndAssimilate: expect.any(Function) }),
        expect.objectContaining({ identities: {}, evaluators: {} }),
        expect.objectContaining({ requestKey: `${f.manifest.campaignRunId}:dream`,
          causalLesson: expect.any(Object) }));
      const options = created.dream.mock.calls[0][4];
      expect(resolveCampaignDreamLesson(options.causalLesson)).toMatchObject({ outcome,
        campaignRunId: f.manifest.campaignRunId, manifestDigest: f.manifest.manifestDigest,
        planDigest: f.admission.planDigest, ruleId: f.evidence.provisional.ruleId,
        evaluationDigest: projection.transferEvaluationDigest });
      const queue = new DreamQueue();
      queue.enqueue('elite-x-elite', [{ id: 'campaign-source', descriptor: [0.5], quality: 0.8,
        artifact: { domain: 'html', prompt: 'source', code: '<p>source</p>' } }], 1);
      const runDreamAndAssimilate = vi.fn(async () => ({ recommendation: {
        recommendationDigest: digest(`service-dream-${outcome}`),
      } }) as never);
      await campaignServiceDreamInvoker(f.persistence).runFundedCampaignDream(
        f.admission, queue, { runDreamAndAssimilate }, { identities: {}, evaluators: {} },
        `${f.manifest.campaignRunId}:service-dream:${outcome}`, options.causalLesson,
      );
      expect(runDreamAndAssimilate.mock.calls[0][0].prompt).toContain(`outcome=${outcome}`);
      expect(runDreamAndAssimilate.mock.calls[0][0].prompt)
        .toContain(`rule_id=${f.evidence.provisional.ruleId}`);
    },
  );
});
