import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import {
  createCanonicalCreativeArtifact,
  createIndependentBlindTreatmentPreference,
  type ApplyAttributableRevisionOptions,
  type CompileExperimentPlanOptions,
  type CriticContribution,
} from '../../../src/creative-run/AttributableRevision.js';
import {
  type BlindReviewJudgment,
  type CandidateEvidenceAssignment,
} from '../../../src/creative-run/BlindReviewEvidence.js';
import {
  buildCandidateManifest,
  type CandidateManifest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';
import { CreativeRunCoordinator } from '../../../src/creative-run/CreativeRunCoordinator.js';
import * as coordinatorSurface from '../../../src/creative-run/CreativeRunCoordinator.js';
import * as ownerAuthoritySurface from '../../../src/creative-run/OwnerLearningAuthority.js';
import {
  type IssueLearningAuthorizationOptions,
  type LearningAuthorization,
  type MutationCounters,
  type OwnerAuthorityCapability,
  type TrustedAuthorityAssertion,
} from '../../../src/creative-run/OwnerLearningAuthority.js';
import {
  FIGURE_GROUND_METRIC,
  FIGURE_GROUND_TARGET,
  WCAG_CONTRAST_METRIC,
} from '../../../src/creative-run/HtmlCssContrast.js';

const INTENT = 'A luminous field whose motion responds to a musical pulse and one accessible control.';
const BASELINE = '<!doctype html><html><head><title>candidate-1</title>'
  + '<style>body { color: #777777; background-color: #ffffff; }</style>'
  + '</head><body>A quiet field</body></html>';
const NOW = '2026-08-01T12:00:00.000Z';
const ZERO: MutationCounters = {
  tasteWrites: 0, modelTrainingWrites: 0, ruleWrites: 0, contextWrites: 0,
};
const AUTHORITY_KEYS = generateKeyPairSync('ed25519');
const AUTHORITY_PUBLIC_KEY = AUTHORITY_KEYS.publicKey.export({ format: 'pem', type: 'spki' }).toString();
let assertionNonce = 0;

function signedAssertion(
  role: 'owner' | 'issuer',
  overrides: Partial<Omit<TrustedAuthorityAssertion, 'signatureBase64'>> = {},
): TrustedAuthorityAssertion {
  const body = {
    schema: 'sinter.application-authority-assertion' as const,
    schemaVersion: 1 as const,
    registryId: 'test-owner-registry',
    principalId: role === 'owner' ? 'owner-simon' : 'learning-issuer',
    role,
    issuedAt: '2026-08-01T11:00:00.000Z',
    expiresAt: '2026-08-02T11:00:00.000Z',
    nonce: `authority-${role}-${assertionNonce += 1}`,
    ...overrides,
  };
  return {
    ...body,
    signatureBase64: sign(null, Buffer.from(JSON.stringify(body)), AUTHORITY_KEYS.privateKey)
      .toString('base64'),
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function identity(role: 'generator' | 'specialist' | 'holistic', suffix: string) {
  return {
    role,
    provider: `provider-${suffix}`,
    model: `model-${suffix}`,
    pipe: `pipe-${suffix}`,
    effort: `effort-${suffix}`,
    contributionLineage: `lineage-${suffix}`,
    assignment: `assignment-${suffix}`,
  } as const;
}

function completeJudgments(
  candidates: readonly { readonly blindId: string; readonly artifactDigest: string;
    readonly media: readonly { readonly modality: 'visual' | 'audio' | 'motion' | 'interaction';
      readonly digest: string }[] }[],
): BlindReviewJudgment[] {
  return candidates.map((candidate) => ({
    blindId: candidate.blindId,
    outcome: 'pass',
    claims: candidate.media.map((media) => ({
      modality: media.modality,
      artifactDigest: candidate.artifactDigest,
      evidenceDigest: media.digest,
      claim: `${media.modality} exact evidence inspected`,
    })),
  }));
}

function observed(options: CompileExperimentPlanOptions): ApplyAttributableRevisionOptions {
  const source = options.packet.candidates[0]!.artifactDigest;
  const candidateId = options.unmasked.mappings[0]!.candidateId;
  const post = BASELINE.replace('candidate-1', candidateId).replace('#777777', '#111111');
  return {
    route: options.route,
    runtime: options.runtime,
    captureSchedule: options.captureSchedule,
    causalPredicate: options.causalPredicate,
    postArtifact: createCanonicalCreativeArtifact(post, source),
  };
}

async function authorityFixture(
  failure?: 'after-mutation',
  now = NOW,
) {
  const coordinator = new CreativeRunCoordinator({
    now: () => now,
    ownerAuthority: {
      registryId: 'test-owner-registry',
      publicKeyPem: AUTHORITY_PUBLIC_KEY,
      applicationBoundary: 'test-signed-principal-boundary',
      testOnlyTransactionFailure: failure,
    },
  });
  const ownerCapability = coordinator.acceptOwnerAuthorityCapability(signedAssertion('owner'));
  const issuerCapability = coordinator.acceptOwnerAuthorityCapability(signedAssertion('issuer'));
  const thesis = buildCrossModalArtifact({ brief: INTENT, artifactId: 'authority-thesis' }).thesis;
  const generated = await buildCandidateManifest(INTENT, { creativeThesis: thesis });
  const candidates = generated.candidates.map((candidate, index) => {
    if (index !== 0) return candidate;
    const html = BASELINE.replace('candidate-1', candidate.id);
    return {
      ...candidate,
      artifact: { ...candidate.artifact, html, artifactDigest: sha(html).slice(0, 16) },
    };
  });
  const manifest = { ...generated, candidates } as CandidateManifest;
  const assignments: CandidateEvidenceAssignment[] = manifest.candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: ['visual', 'audio', 'motion', 'interaction'],
    generationIdentity: identity('generator', `generator-${index}`),
    crossModalArtifact: buildCrossModalArtifact({
      brief: INTENT,
      artifactId: `authority-cross-modal-${index}`,
      sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
      thesis,
    }),
  }));
  const blind = coordinator.createBlindReviewSession(manifest, assignments);
  const review = blind.submitReview(blind.packet, completeJudgments(blind.packet.candidates));
  const unmasked = blind.unmask();
  const candidate = blind.packet.candidates[0]!;
  const claim = review.judgments[0]!.claims[0]!;
  const baselineHtml = BASELINE.replace('candidate-1', manifest.candidates[0]!.id);
  const postHtml = baselineHtml.replace('#777777', '#111111');
  const before = createCanonicalCreativeArtifact(
    baselineHtml, candidate.artifactDigest,
  ).analysis.contrastRatio;
  const after = createCanonicalCreativeArtifact(
    postHtml, candidate.artifactDigest,
  ).analysis.contrastRatio;
  const treatment = {
    id: 'increase-figure-ground',
    targetKind: 'principle' as const,
    targetId: FIGURE_GROUND_TARGET,
    before,
    after,
  };
  const critics: CriticContribution[] = [
    {
      id: 'specialist', identity: identity('specialist', 'specialist'),
      blindId: candidate.blindId, artifactDigest: candidate.artifactDigest,
      claims: [claim], treatment, priority: 2,
    },
    {
      id: 'holistic', identity: identity('holistic', 'holistic'),
      blindId: candidate.blindId, artifactDigest: candidate.artifactDigest,
      claims: [claim], treatment: { ...treatment, id: 'alternate', targetKind: 'parameter',
        targetId: 'density', before: 2, after: 3 }, priority: 1,
    },
  ];
  const planOptions: CompileExperimentPlanOptions = {
    packet: blind.packet, review, unmasked, critics,
    route: { provider: 'fixed-provider', model: 'fixed-model', pipe: 'fixed-pipe', effort: 'high' },
    runtime: { id: 'html-css-static-runtime', version: '1.0.0', seed: 'fixed-seed' },
    allowedDiffs: [`principles.${FIGURE_GROUND_TARGET}`],
    forbiddenDiffs: ['graphElements', 'parameters'],
    captureSchedule: [{ id: 'visual-final', atMs: 0, modality: 'visual' }],
    causalPredicate: { metricId: FIGURE_GROUND_METRIC, direction: 'increase', minimumDelta: 1 },
    hardFloors: [{ metricId: WCAG_CONTRAST_METRIC, minimum: 4.5 }],
  };
  const revisionSession = coordinator.createAttributableRevisionSession(planOptions);
  const revisionObserved = observed(planOptions);
  const revisionReceipt = revisionSession.apply({
    ...revisionObserved,
    independentBlindPreference: createIndependentBlindTreatmentPreference(
      revisionSession.plan, revisionObserved.postArtifact,
      identity('specialist', 'independent-treatment-reviewer'), 'treatment-preferred',
    ),
  });
  const authority = coordinator.createOwnerLearningAuthoritySession({
    packet: blind.packet,
    review,
    unmasked,
    experimentPlan: revisionSession.plan,
    revisionReceipt,
    now: () => now,
  });
  return {
    authority, coordinator, ownerCapability, issuerCapability,
    packet: blind.packet, review, unmasked,
    plan: revisionSession.plan, revisionReceipt,
  };
}

function authInput(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  overrides: Partial<IssueLearningAuthorizationOptions> = {},
): IssueLearningAuthorizationOptions {
  return {
    decision: 'allow',
    issuerCapability: fixture.issuerCapability,
    ownerCapability: fixture.ownerCapability,
    ruleId: FIGURE_GROUND_TARGET,
    artifactDigest: fixture.revisionReceipt.revisedState.artifactDigest,
    planDigest: fixture.plan.planDigest,
    revisionReceiptDigest: fixture.revisionReceipt.receiptDigest,
    issuedAt: '2026-08-01T11:00:00.000Z',
    expiresAt: '2026-08-02T11:00:00.000Z',
    ...overrides,
  };
}

function assertZero(counters: MutationCounters): void {
  expect(counters).toEqual(ZERO);
}

describe('OwnerLearningAuthority', () => {
  it('exposes no deep-module registry, session constructor, or session factory', () => {
    expect(Object.keys(ownerAuthoritySurface).sort()).toEqual([
      'OWNER_AUTHORITY_SCHEMA_VERSION',
      'OWNER_LEARNING_PERSISTENCE_BOUNDARY',
    ]);
    expect(existsSync(new URL(
      '../../../src/creative-run/OwnerLearningAuthority.internal.ts', import.meta.url,
    ))).toBe(false);
    expect(Object.keys(coordinatorSurface)).not.toContain('createCoordinatorOwnerAuthority');
    expect(Object.keys(coordinatorSurface)).not.toContain('ApplicationOwnerAuthorityRegistry');
    expect(Object.keys(coordinatorSurface)).not.toContain('OwnerLearningAuthoritySessionImpl');
  });

  it('requires application-signed opaque capabilities, not role strings or self-hashes', async () => {
    const fixture = await authorityFixture();
    const pair = fixture.packet.candidates.slice(0, 2);
    const preference = (ownerCapability: OwnerAuthorityCapability) =>
      fixture.authority.recordPreference({ ownerCapability,
        blindIds: [pair[0]!.blindId, pair[1]!.blindId], outcome: 'tie', decidedAt: NOW });

    expect(() => preference({ id: 'owner-simon', role: 'owner' } as never))
      .toThrow(/CAPABILITY_PROVENANCE_INVALID/);
    expect(() => preference(structuredClone(fixture.ownerCapability)))
      .toThrow(/CAPABILITY_PROVENANCE_INVALID/);
    expect(() => preference({ [Symbol('owner')]: true } as never))
      .toThrow(/CAPABILITY_PROVENANCE_INVALID/);
    expect(() => preference(fixture.issuerCapability)).toThrow(/CAPABILITY_ROLE_INVALID:owner/);
    expect(() => fixture.authority.issueLearningAuthorization({
      ...authInput(fixture),
      issuerCapability: fixture.ownerCapability,
      ownerCapability: fixture.issuerCapability,
    })).toThrow(/CAPABILITY_ROLE_INVALID:issuer/);

    const unsigned = signedAssertion('owner');
    const selfHashed = { ...unsigned, signatureBase64: sha(JSON.stringify(unsigned)) };
    const fresh = new CreativeRunCoordinator({ now: () => NOW, ownerAuthority: {
      registryId: 'test-owner-registry', publicKeyPem: AUTHORITY_PUBLIC_KEY,
      applicationBoundary: 'test-signed-principal-boundary',
    } });
    expect(() => fresh.acceptOwnerAuthorityCapability(selfHashed))
      .toThrow(/SIGNATURE_INVALID/);

    const other = new CreativeRunCoordinator({ now: () => NOW, ownerAuthority: {
      registryId: 'other-registry', publicKeyPem: AUTHORITY_PUBLIC_KEY,
      applicationBoundary: 'other-signed-principal-boundary',
    } });
    const otherOwner = other.acceptOwnerAuthorityCapability(signedAssertion('owner', {
      registryId: 'other-registry', nonce: 'other-owner-capability',
    }));
    expect(() => preference(otherOwner)).toThrow(/CAPABILITY_PROVENANCE_INVALID/);
  });
  it('keeps preference, release, and learning authority as separate exact receipts', async () => {
    const fixture = await authorityFixture();
    const pair = fixture.packet.candidates.slice(0, 2);
    const preference = fixture.authority.recordPreference({
      ownerCapability: fixture.ownerCapability,
      blindIds: [pair[0]!.blindId, pair[1]!.blindId],
      outcome: 'preferred',
      winnerBlindId: pair[0]!.blindId,
      decidedAt: NOW,
    });
    const mapping = fixture.unmasked.mappings[0]!;
    const release = fixture.authority.recordReleaseDecision({
      ownerCapability: fixture.ownerCapability,
      candidateId: mapping.candidateId,
      artifactDigest: pair[0]!.artifactDigest,
      decision: 'release-worthy',
      decidedAt: NOW,
    });

    expect(preference.schema).toBe('sinter.owner-preference-decision');
    expect(preference.applicationBoundary).toBe('test-signed-principal-boundary');
    expect(preference.owner.assertionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(preference.candidates).toEqual(pair.map(({ blindId, artifactDigest }) => (
      { blindId, artifactDigest }
    )));
    expect(release.schema).toBe('sinter.owner-release-decision');
    expect(release.receiptDigest).not.toBe(preference.receiptDigest);
    expect(fixture.authority.createContextSnapshot().rules).toEqual({});
    assertZero(preference.mutationCounters);
    assertZero(release.mutationCounters);
    assertZero(fixture.authority.mutationCounters());
  });

  it('records negative owner decisions as terminal evidence without learning mutation', async () => {
    const fixture = await authorityFixture();
    const pair = fixture.packet.candidates.slice(0, 2);
    const preference = fixture.authority.recordPreference({
      ownerCapability: fixture.ownerCapability,
      blindIds: [pair[0]!.blindId, pair[1]!.blindId], outcome: 'rejected', decidedAt: NOW,
    });
    const mapping = fixture.unmasked.mappings[0]!;
    const release = fixture.authority.recordReleaseDecision({
      ownerCapability: fixture.ownerCapability, candidateId: mapping.candidateId,
      artifactDigest: pair[0]!.artifactDigest, decision: 'not-release-worthy', decidedAt: NOW,
    });

    expect(preference.outcome).toBe('rejected');
    expect(release.decision).toBe('not-release-worthy');
    assertZero(fixture.authority.mutationCounters());
  });

  it('stages against an immutable prior snapshot and transfers one exact rule atomically', async () => {
    const fixture = await authorityFixture();
    const authorization = fixture.authority.issueLearningAuthorization(authInput(fixture));
    const stage = fixture.authority.stageLearningTransfer(authorization, FIGURE_GROUND_TARGET);
    const transfer = fixture.authority.transferLearning(stage.provisional!);

    expect(stage.status).toBe('staged');
    expect(stage.persistenceBoundary).toBe('in-memory-transaction-only');
    expect(Object.isFrozen(stage.provisional!.priorContext)).toBe(true);
    expect(Object.isFrozen(stage.provisional!.nextContext.rules)).toBe(true);
    expect(fixture.authority.createContextSnapshot().rules[FIGURE_GROUND_TARGET])
      .toBe(fixture.revisionReceipt.revisedState.principles[FIGURE_GROUND_TARGET]);
    expect(transfer).toMatchObject({
      status: 'transferred', reason: 'TRANSFERRED',
      persistenceBoundary: 'in-memory-transaction-only',
      mutationCounters: { tasteWrites: 0, modelTrainingWrites: 0, ruleWrites: 1, contextWrites: 1 },
    });
    expect(fixture.authority.authorizationState(authorization)).toBe('consumed');

    const replay = fixture.authority.transferLearning(stage.provisional!);
    expect(replay.reason).toBe('AUTHORIZATION_ALREADY_CONSUMED');
    assertZero(replay.mutationCounters);
  });

  it('fails closed for missing authorization', async () => {
    const missing = await authorityFixture();
    const missingStage = missing.authority.stageLearningTransfer(undefined, FIGURE_GROUND_TARGET);
    expect(missingStage.reason).toBe('AUTHORIZATION_MISSING');
    assertZero(missingStage.mutationCounters);
  });

  // Each rejection builds a complete, independent authority fixture. Give each
  // its normal test budget instead of squeezing all eight into one 5s window.
  it.each<[Partial<IssueLearningAuthorizationOptions>, string]>([
    [{ decision: 'deny' }, 'AUTHORIZATION_DENIED'],
    [{ issuedAt: '2026-08-01T12:30:00.000Z', expiresAt: '2026-08-02T12:30:00.000Z' },
      'AUTHORIZATION_NOT_YET_VALID'],
    [{ expiresAt: '2026-08-01T11:30:00.000Z' }, 'AUTHORIZATION_EXPIRED'],
    [{ ruleId: 'different-rule' }, 'AUTHORIZATION_SCOPE_MISMATCH'],
    [{ artifactDigest: 'different-artifact' }, 'AUTHORIZATION_ARTIFACT_MISMATCH'],
    [{ planDigest: 'different-plan' }, 'AUTHORIZATION_PLAN_MISMATCH'],
    [{ revisionReceiptDigest: 'different-receipt' }, 'AUTHORIZATION_RECEIPT_MISMATCH'],
  ])('fails closed for authorization override %j (%s)', async (overrides, reason) => {
    const fixture = await authorityFixture();
    const authorization = fixture.authority.issueLearningAuthorization(
      authInput(fixture, overrides),
    );
    const stage = fixture.authority.stageLearningTransfer(authorization, FIGURE_GROUND_TARGET);
    expect(stage.reason).toBe(reason);
    assertZero(stage.mutationCounters);
    expect(fixture.authority.createContextSnapshot().rules).toEqual({});
  });

  it('blocks revoked and tampered authorizations without mutation', async () => {
    const revokedFixture = await authorityFixture();
    const revoked = revokedFixture.authority.issueLearningAuthorization(authInput(revokedFixture));
    const revocation = revokedFixture.authority.revokeLearningAuthorization(revoked);
    const revokedStage = revokedFixture.authority.stageLearningTransfer(revoked, FIGURE_GROUND_TARGET);

    expect(revocation.state).toBe('revoked');
    expect(revocation.priorMutationCounters).toEqual(ZERO);
    expect(revocation.resultingMutationCounters).toEqual(ZERO);
    expect(revokedFixture.authority.authorizationState(revoked)).toBe('revoked');
    expect(revokedStage.reason).toBe('AUTHORIZATION_REVOKED');
    assertZero(revokedStage.mutationCounters);

    const tamperedFixture = await authorityFixture();
    const authentic = tamperedFixture.authority.issueLearningAuthorization(authInput(tamperedFixture));
    const tampered = { ...authentic, artifactDigest: 'tampered' } as LearningAuthorization;
    const tamperedStage = tamperedFixture.authority.stageLearningTransfer(
      tampered, FIGURE_GROUND_TARGET,
    );
    expect(tamperedStage.reason).toBe('AUTHORIZATION_DIGEST_MISMATCH');
    assertZero(tamperedStage.mutationCounters);

    const copied = structuredClone(authentic);
    const copiedStage = tamperedFixture.authority.stageLearningTransfer(copied, FIGURE_GROUND_TARGET);
    expect(copiedStage.reason).toBe('AUTHORIZATION_PROVENANCE_INVALID');
    assertZero(copiedStage.mutationCounters);

    const rehashed = structuredClone(authentic) as LearningAuthorization;
    (rehashed as { artifactDigest: string }).artifactDigest = 'attacker-artifact';
    const { authorizationDigest: _old, ...body } = rehashed;
    (rehashed as { authorizationDigest: string }).authorizationDigest = sha(JSON.stringify(body));
    const rehashedStage = tamperedFixture.authority.stageLearningTransfer(
      rehashed, FIGURE_GROUND_TARGET,
    );
    expect(rehashedStage.reason).toBe('AUTHORIZATION_PROVENANCE_INVALID');
    assertZero(rehashedStage.mutationCounters);
  });

  it('revalidates immediately before transfer and blocks post-stage revocation', async () => {
    const fixture = await authorityFixture();
    const authorization = fixture.authority.issueLearningAuthorization(authInput(fixture));
    const staged = fixture.authority.stageLearningTransfer(authorization, FIGURE_GROUND_TARGET);
    fixture.authority.revokeLearningAuthorization(authorization);
    const transfer = fixture.authority.transferLearning(staged.provisional!);

    expect(transfer.reason).toBe('AUTHORIZATION_REVOKED');
    expect(transfer.rollbackReceipt).toMatchObject({
      persistenceBoundary: 'in-memory-transaction-only',
      priorContextDigest: staged.provisional!.priorContext.contextDigest,
      restoredContextDigest: staged.provisional!.priorContext.contextDigest,
      priorMutationCounters: ZERO,
      restoredMutationCounters: ZERO,
      restored: true,
    });
    expect(transfer.resultingContextDigest).toBe(staged.provisional!.priorContext.contextDigest);
    expect(fixture.authority.createContextSnapshot().rules).toEqual({});
    assertZero(transfer.mutationCounters);
  });

  it('rejects provisional mutation and copied provisional provenance', async () => {
    const fixture = await authorityFixture();
    const authorization = fixture.authority.issueLearningAuthorization(authInput(fixture));
    const staged = fixture.authority.stageLearningTransfer(authorization, FIGURE_GROUND_TARGET);
    const tampered = structuredClone(staged.provisional!);
    (tampered as { ruleId: string }).ruleId = 'tampered-rule';
    const tamperResult = fixture.authority.transferLearning(tampered);
    expect(tamperResult.reason).toBe('PROVISIONAL_DIGEST_MISMATCH');
    assertZero(tamperResult.mutationCounters);

    const copied = structuredClone(staged.provisional!);
    const copyResult = fixture.authority.transferLearning(copied);
    expect(copyResult.reason).toBe('PROVISIONAL_PROVENANCE_INVALID');
    assertZero(copyResult.mutationCounters);
  });

  it('rejects caller context adapters and detects internal context drift', async () => {
    const fixture = await authorityFixture();
    const liar = { snapshot: () => ({ rules: {}, contextDigest: 'fake' }),
      counters: () => ({ tasteWrites: -9, modelTrainingWrites: -9, ruleWrites: -9,
        contextWrites: -9 }) };
    expect(() => fixture.coordinator.createOwnerLearningAuthoritySession({
      packet: fixture.packet, review: fixture.review, unmasked: fixture.unmasked,
      experimentPlan: fixture.plan, revisionReceipt: fixture.revisionReceipt,
      context: liar,
    } as never)).toThrow(/CREATE_CONTEXT_ADAPTER_UNSUPPORTED/);

    const first = fixture.authority.issueLearningAuthorization(authInput(fixture));
    const firstStage = fixture.authority.stageLearningTransfer(first, FIGURE_GROUND_TARGET);
    const second = fixture.authority.issueLearningAuthorization(authInput(fixture, {
      expiresAt: '2026-08-02T12:00:00.000Z',
    }));
    const secondStage = fixture.authority.stageLearningTransfer(second, FIGURE_GROUND_TARGET);
    expect(fixture.authority.transferLearning(secondStage.provisional!).status).toBe('transferred');
    const drift = fixture.authority.transferLearning(firstStage.provisional!);
    expect(drift.reason).toBe('PRIOR_CONTEXT_CHANGED');
    assertZero(drift.mutationCounters);
  });

  it('rolls back exact prior context and counters after a partial transfer failure', async () => {
    const fixture = await authorityFixture('after-mutation');
    const authorization = fixture.authority.issueLearningAuthorization(authInput(fixture));
    const staged = fixture.authority.stageLearningTransfer(authorization, FIGURE_GROUND_TARGET);
    const transfer = fixture.authority.transferLearning(staged.provisional!);

    expect(transfer.reason).toBe('TRANSFER_FAILED_ROLLED_BACK');
    expect(transfer.rollbackReceipt).toMatchObject({
      persistenceBoundary: 'in-memory-transaction-only',
      priorContextDigest: staged.provisional!.priorContext.contextDigest,
      restoredContextDigest: staged.provisional!.priorContext.contextDigest,
      priorMutationCounters: ZERO,
      restoredMutationCounters: ZERO,
      restored: true,
    });
    expect(fixture.authority.createContextSnapshot().rules).toEqual({});
    expect(fixture.authority.authorizationState(authorization)).toBe('active');
    assertZero(transfer.mutationCounters);
    assertZero(fixture.authority.mutationCounters());
  });

  it('rejects rollback-failure injection instead of supporting a non-atomic path', () => {
    expect(() => new CreativeRunCoordinator({
      now: () => NOW,
      ownerAuthority: {
        registryId: 'test-owner-registry',
        publicKeyPem: AUTHORITY_PUBLIC_KEY,
        applicationBoundary: 'test-signed-principal-boundary',
        testOnlyTransactionFailure: 'rollback-failure',
      } as never,
    })).toThrow(/OWNER_AUTHORITY_TEST_FAULT_INVALID/);
  });
});
