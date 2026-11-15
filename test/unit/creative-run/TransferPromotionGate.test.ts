import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import {
  createCanonicalCreativeArtifact,
  createIndependentBlindTreatmentPreference,
  type CompileExperimentPlanOptions,
  type CriticContribution,
} from '../../../src/creative-run/AttributableRevision.js';
import type {
  BlindReviewJudgment,
  CandidateEvidenceAssignment,
} from '../../../src/creative-run/BlindReviewEvidence.js';
import {
  buildCandidateManifest,
  type CandidateManifest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';
import {
  CreativeRunCoordinator,
  type TransferCandidateGenerationRequest,
} from '../../../src/creative-run/CreativeRunCoordinator.js';
import {
  FIGURE_GROUND_METRIC,
  FIGURE_GROUND_TARGET,
  WCAG_CONTRAST_METRIC,
} from '../../../src/creative-run/HtmlCssContrast.js';
import { formatTransferPromotionDecision } from '../../../src/cli/TransferPromotionCli.js';
import {
  createArtistReviewSession,
  resolveArtistReviewPromotionCheckpoint,
} from '../../../src/creative-run/ArtistReviewExperience.js';
import type {
  MutationCounters,
  TrustedAuthorityAssertion,
} from '../../../src/creative-run/OwnerLearningAuthority.js';
import type { PromotionComparisonPacket } from '../../../src/creative-run/TransferPromotionGate.js';

const INTENT = 'A luminous field whose motion responds to a musical pulse and one accessible control.';
const NOW = '2026-08-01T12:00:00.000Z';
const BASELINE = '<!doctype html><html><head><title>candidate-1</title>'
  + '<style>body { color: #777777; background-color: #ffffff; }</style>'
  + '</head><body>A quiet field</body></html>';
const TRANSFER_TREATMENT = '<!doctype html><html><head><title>Aurora</title><style>'
  + 'body{color:#eaf4ff;background-color:#112244;display:grid;padding:24px;}'
  + 'section{width:70vw;height:60vh;transform:rotate(2deg);animation:tide 7s ease-in-out infinite;}'
  + '@keyframes tide{from{opacity:.4}to{opacity:1}}</style></head>'
  + '<body><section>Aurora tide opens into quiet blue space</section></body></html>';
const TRANSFER_CONTROL = '<!doctype html><html><head><title>Ember</title><style>'
  + 'body{color:#fff1dd;background-color:#553311;display:flex;margin:12px;}'
  + 'main{border-radius:50%;transition:opacity 2s linear;}</style></head>'
  + '<body><main><div>Amber stones gather around a warm center</div></main></body></html>';
const ZERO: MutationCounters = {
  tasteWrites: 0, modelTrainingWrites: 0, ruleWrites: 0, contextWrites: 0,
};
const KEYS = generateKeyPairSync('ed25519');
const PUBLIC_KEY = KEYS.publicKey.export({ format: 'pem', type: 'spki' }).toString();
let assertionNonce = 0;

class InspectableCoordinator extends CreativeRunCoordinator {
  ordinaryPrompt(prompt: string): string {
    return this.prepareOrdinaryCreatePrompt(prompt);
  }
}

function assertion(
  role: 'owner' | 'issuer' | 'reviewer',
  principalId = `${role}-principal`,
): TrustedAuthorityAssertion {
  const body = {
    schema: 'sinter.application-authority-assertion' as const,
    schemaVersion: 1 as const,
    registryId: 'transfer-promotion-registry', principalId, role,
    issuedAt: '2026-08-01T11:00:00.000Z', expiresAt: '2026-08-02T11:00:00.000Z',
    nonce: `${role}-${assertionNonce += 1}`,
  };
  return { ...body, signatureBase64: sign(
    null, Buffer.from(JSON.stringify(body)), KEYS.privateKey,
  ).toString('base64') };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function identity(role: 'generator' | 'specialist' | 'holistic', suffix: string) {
  return {
    role, provider: `provider-${suffix}`, model: `model-${suffix}`,
    pipe: `pipe-${suffix}`, effort: `effort-${suffix}`,
    contributionLineage: `lineage-${suffix}`, assignment: `assignment-${suffix}`,
  } as const;
}

function judgments(
  candidates: readonly { readonly blindId: string; readonly artifactDigest: string;
    readonly media: readonly { readonly modality: 'visual' | 'audio' | 'motion' | 'interaction';
      readonly digest: string }[] }[],
): BlindReviewJudgment[] {
  return candidates.map((candidate) => ({
    blindId: candidate.blindId, outcome: 'pass',
    claims: candidate.media.map((media) => ({
      modality: media.modality, artifactDigest: candidate.artifactDigest,
      evidenceDigest: media.digest, claim: `${media.modality} exact evidence inspected`,
    })),
  }));
}

async function fixture(options: {
  transferFailure?: boolean;
  treatmentHtml?: string;
  controlHtml?: string;
} = {}) {
  const generationRequests: TransferCandidateGenerationRequest[] = [];
  const coordinator = new InspectableCoordinator({
    now: () => NOW,
    ownerAuthority: {
      registryId: 'transfer-promotion-registry', publicKeyPem: PUBLIC_KEY,
      applicationBoundary: 'test-application-boundary',
      ...(options.transferFailure
        ? { testOnlyTransactionFailure: 'after-mutation' as const } : {}),
    },
    transferCandidateGenerator: (request) => {
      generationRequests.push(request);
      return request.arm === 'treatment'
        ? options.treatmentHtml ?? TRANSFER_TREATMENT
        : options.controlHtml ?? TRANSFER_CONTROL;
    },
  });
  const ownerCapability = coordinator.acceptOwnerAuthorityCapability(assertion('owner'));
  const issuerCapability = coordinator.acceptOwnerAuthorityCapability(assertion('issuer'));
  const reviewerCapability = coordinator.acceptOwnerAuthorityCapability(assertion('reviewer'));
  const thesis = buildCrossModalArtifact({ brief: INTENT, artifactId: 'transfer-thesis' }).thesis;
  const generated = await buildCandidateManifest(INTENT, { creativeThesis: thesis });
  const candidates = generated.candidates.map((candidate, index) => {
    if (index !== 0) return candidate;
    const html = BASELINE.replace('candidate-1', candidate.id);
    return { ...candidate, artifact: {
      ...candidate.artifact, html, artifactDigest: sha(html).slice(0, 16),
    } };
  });
  const manifest = { ...generated, candidates } as CandidateManifest;
  const assignments: CandidateEvidenceAssignment[] = manifest.candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: ['visual', 'audio', 'motion', 'interaction'],
    generationIdentity: identity('generator', `generator-${index}`),
    crossModalArtifact: buildCrossModalArtifact({
      brief: INTENT, artifactId: `transfer-cross-modal-${index}`,
      sourceCandidateArtifactDigest: candidate.artifact.artifactDigest, thesis,
    }),
  }));
  const blind = coordinator.createBlindReviewSession(manifest, assignments);
  const review = blind.submitReview(blind.packet, judgments(blind.packet.candidates));
  const unmasked = blind.unmask();
  const evidence = blind.packet.candidates[0]!;
  const claim = review.judgments[0]!.claims[0]!;
  const baselineHtml = BASELINE.replace('candidate-1', manifest.candidates[0]!.id);
  const treatmentHtml = baselineHtml.replace('#777777', '#111111');
  const before = createCanonicalCreativeArtifact(baselineHtml, evidence.artifactDigest)
    .analysis.contrastRatio;
  const after = createCanonicalCreativeArtifact(treatmentHtml, evidence.artifactDigest)
    .analysis.contrastRatio;
  const treatment = {
    id: 'increase-figure-ground', targetKind: 'principle' as const,
    targetId: FIGURE_GROUND_TARGET, before, after,
  };
  const critics: CriticContribution[] = [
    { id: 'specialist', identity: identity('specialist', 'specialist'),
      blindId: evidence.blindId, artifactDigest: evidence.artifactDigest,
      claims: [claim], treatment, priority: 2 },
    { id: 'holistic', identity: identity('holistic', 'holistic'),
      blindId: evidence.blindId, artifactDigest: evidence.artifactDigest,
      claims: [claim], treatment: { ...treatment, id: 'density-alternative',
        targetKind: 'parameter', targetId: 'density', before: 2, after: 3 }, priority: 1 },
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
  const postArtifact = createCanonicalCreativeArtifact(treatmentHtml, evidence.artifactDigest);
  const independentBlindPreference = createIndependentBlindTreatmentPreference(
    revisionSession.plan, postArtifact, identity('specialist', 'independent-treatment'), 'treatment-preferred',
  );
  const revision = revisionSession.apply({
    route: planOptions.route, runtime: planOptions.runtime,
    captureSchedule: planOptions.captureSchedule,
    causalPredicate: planOptions.causalPredicate,
    postArtifact, independentBlindPreference,
  });
  const authority = coordinator.createOwnerLearningAuthoritySession({
    packet: blind.packet, review, unmasked,
    experimentPlan: revisionSession.plan, revisionReceipt: revision, now: () => NOW,
  });
  const artist = createArtistReviewSession({
    sessionId: `transfer-review-${assertionNonce}`,
    manifest, packet: blind.packet, review, unmasked,
    plan: revisionSession.plan, revision, authority, now: () => NOW,
    tokenSecret: Buffer.alloc(32, 9), nonce: () => `promotion-${assertionNonce += 1}`,
  });
  const stageToken = artist.issueActionToken({
    kind: 'learning', operation: 'stage', ruleId: FIGURE_GROUND_TARGET,
    expiresAt: '2026-08-02T11:00:00.000Z',
  }, { ownerCapability, issuerCapability }, '2026-08-01T13:00:00.000Z');
  expect(artist.executeAction(stageToken).accepted).toBe(true);
  const checkpoint = artist.promotionCheckpoint();
  const binding = resolveArtistReviewPromotionCheckpoint(checkpoint);
  const experiment = await coordinator.openTransferPromotionExperiment(
    checkpoint, { renderGate: false },
  );
  const { gate, sealedBrief } = experiment;
  const treatmentCreate = experiment.treatment;
  const controlCreate = experiment.control;
  return {
    coordinator, authority, gate, ownerCapability, issuerCapability, reviewerCapability,
    generationRequests,
    authorization: binding.authorization, stage: binding.stage, revision, checkpoint, sealedBrief,
    treatmentArtifact: treatmentCreate.artifact,
    controlArtifact: controlCreate.artifact,
    treatmentCreate, controlCreate,
  };
}

function treatmentCandidate(packet: PromotionComparisonPacket) {
  const candidate = packet.candidates.find((item) => {
    const uri = item.media[0]?.playableUri ?? '';
    const encoded = uri.slice(uri.indexOf(',') + 1);
    const outer = Buffer.from(encoded, 'base64').toString();
    if (outer.includes('Aurora tide')) return true;
    return [...outer.matchAll(/data:text\/html;base64,([A-Za-z0-9+/=]+)/g)]
      .some((match) => Buffer.from(match[1]!, 'base64').toString().includes('Aurora tide'));
  });
  if (!candidate) throw new Error('fixture treatment media missing');
  return candidate;
}

async function preferredFixture(transferFailure = false) {
  const source = await fixture({ transferFailure });
  const reviewer = source.gate.openReviewerSink(source.reviewerCapability);
  const selected = treatmentCandidate(reviewer.packet);
  const blindedJudgment = reviewer.submit({
    preferredBlindId: selected.blindId,
    claim: 'treatment provides visibly stronger figure-ground separation',
  });
  const decision = source.gate.evaluate({
    blindedJudgment, ownerCapability: source.ownerCapability,
    ownerJudgment: {
      preferredArtifact: 'treatment',
      claim: 'owner independently confirms the stronger creative direction',
    },
  });
  return { ...source, reviewer, blindedJudgment, decision };
}

describe('TransferPromotionGate', () => {
  it('freezes authentic prerequisites without public behavior or digest injection', async () => {
    const source = await fixture();
    expect(source.gate.freeze.schema).toBe('sinter.transfer-promotion-freeze');
    expect(source.gate.freeze.ownerAuthorizationDigest)
      .toBe(source.authorization.authorizationDigest);
    expect(source.gate.freeze.sealedBriefDigest).toBe(source.sealedBrief.briefDigest);
    expect(Object.isFrozen(source.gate.freeze)).toBe(true);
    await expect(source.coordinator.openTransferPromotionExperiment(
      {} as never, { renderGate: false },
    )).rejects.toThrow('ARTIST_REVIEW_PROMOTION_CHECKPOINT_INVALID');
  });

  it('binds only authentic W8-15 owner sessions and staged receipts', async () => {
    const source = await fixture();
    await expect(source.coordinator.openTransferPromotionExperiment(
      { ...source.checkpoint } as never, { renderGate: false },
    )).rejects.toThrow('ARTIST_REVIEW_PROMOTION_CHECKPOINT_INVALID');
  });

  it('uses the real Create path to mint and register revision-bound artifacts', async () => {
    const source = await preferredFixture();
    expect(source.treatmentArtifact.createRunId)
      .toBe(source.treatmentCreate.composition.creativeRun.rootRunId);
    expect(source.coordinator.transferPromotionDecision(source.treatmentArtifact.createRunId))
      .toBe(source.decision);
    expect(source.treatmentArtifact.causalInputDigest)
      .toBe(source.gate.freeze.treatmentCausalInputDigest);
    expect(source.controlArtifact.causalInputDigest)
      .toBe(source.gate.freeze.controlCausalInputDigest);
    expect(source.treatmentArtifact.causalInputDigest)
      .not.toBe(source.controlArtifact.causalInputDigest);
    expect(source.generationRequests.map((request) => request.arm))
      .toEqual(['control', 'treatment']);
    expect(new Set(source.generationRequests.map((request) => request.experimentRunId)).size)
      .toBe(1);
    expect(source.generationRequests[0]!.prompt).toBe(INTENT);
    expect(source.generationRequests[1]!.prompt)
      .toContain(`Authorized experimental revision: ${FIGURE_GROUND_TARGET}=`);
    expect(source.generationRequests.map((request) => request.causalInputDigest))
      .toEqual([
        source.controlArtifact.causalInputDigest,
        source.treatmentArtifact.causalInputDigest,
      ]);
    expect('composeTransferPromotionCandidate' in source.coordinator).toBe(false);
    expect('createTransferPromotionGateSession' in source.coordinator).toBe(false);
  });

  it('requires a distinct reviewer capability and rejects producer roles', async () => {
    const source = await fixture();
    expect(() => source.gate.openReviewerSink(source.ownerCapability))
      .toThrow('OWNER_AUTHORITY_CAPABILITY_ROLE_INVALID:reviewer');
    const samePrincipal = source.coordinator.acceptOwnerAuthorityCapability(
      assertion('reviewer', 'owner-principal'),
    );
    expect(() => source.gate.openReviewerSink(samePrincipal))
      .toThrow('TRANSFER_PROMOTION_REVIEWER_NOT_INDEPENDENT');
  });

  it('publishes randomized blind IDs and opaque evidence bindings, not known hashes', async () => {
    const source = await fixture();
    const packet = source.gate.openReviewerSink(source.reviewerCapability).packet;
    const serialized = JSON.stringify(packet);
    expect(packet.candidates.every((candidate) => /^blind-[0-9a-f]{24}$/.test(candidate.blindId)))
      .toBe(true);
    expect(packet.candidates.every((candidate) => candidate.evidenceBinding.startsWith('evidence-')))
      .toBe(true);
    expect(serialized).not.toContain(source.treatmentArtifact.artifactDigest);
    expect(serialized).not.toContain(source.controlArtifact.artifactDigest);
    expect(serialized).not.toContain(sha(source.treatmentCreate.composition.html));
    expect(serialized).not.toContain('treatmentArtifactDigest');
    expect(serialized).not.toContain('controlArtifactDigest');
  });

  it('accepts only a reviewer-sink-minted judgment and makes the sink single use', async () => {
    const source = await fixture();
    const sink = source.gate.openReviewerSink(source.reviewerCapability);
    const selected = treatmentCandidate(sink.packet);
    const review = sink.submit({ preferredBlindId: selected.blindId, claim: 'reviewed' });
    expect(review.reviewer.role).toBe('reviewer');
    expect(() => sink.submit({ preferredBlindId: selected.blindId, claim: 'replay' }))
      .toThrow('TRANSFER_PROMOTION_REVIEW_REPLAYED');
    expect(() => source.gate.evaluate({
      blindedJudgment: { ...review }, ownerCapability: source.ownerCapability,
      ownerJudgment: { preferredArtifact: 'treatment', claim: 'owner reviewed' },
    })).toThrow('TRANSFER_PROMOTION_REVIEW_PROVENANCE_INVALID');
  });

  it('binds reviews and decisions to private gate object identity across equal-content runs', async () => {
    const left = await preferredFixture();
    const right = await fixture();
    expect(left.gate.freeze.gateSessionId).not.toBe(right.gate.freeze.gateSessionId);
    expect(() => right.gate.evaluate({
      blindedJudgment: left.blindedJudgment,
      ownerCapability: right.ownerCapability,
      ownerJudgment: { preferredArtifact: 'treatment', claim: 'cross-run' },
    })).toThrow('TRANSFER_PROMOTION_REVIEW_PROVENANCE_INVALID');
    const receipt = right.gate.promote(left.decision, {
      ownerCapability: right.ownerCapability, sourceCapability: right.issuerCapability,
    });
    expect(receipt.reason).toBe('PROMOTION_CROSS_RUN');
  });

  it('requires the exact owner and issuer identities frozen in authorization', async () => {
    const source = await preferredFixture();
    const wrongOwner = source.coordinator.acceptOwnerAuthorityCapability(
      assertion('owner', 'other-owner'),
    );
    const wrongIssuer = source.coordinator.acceptOwnerAuthorityCapability(
      assertion('issuer', 'other-issuer'),
    );
    expect(source.gate.promote(source.decision, {
      ownerCapability: wrongOwner, sourceCapability: source.issuerCapability,
    }).reason).toBe('OWNER_CAPABILITY_INVALID');
    expect(source.gate.promote(source.decision, {
      ownerCapability: source.ownerCapability, sourceCapability: wrongIssuer,
    }).reason).toBe('SOURCE_CAPABILITY_INVALID');
  });

  it('promotes only after independent and owner agreement and updates ordinary Create', async () => {
    const source = await preferredFixture();
    expect(source.decision.status).toBe('preferred');
    expect(formatTransferPromotionDecision(source.decision)).toContain('Decision: preferred');
    expect(source.coordinator.ordinaryCreateContext().rules).toEqual({});
    const receipt = source.gate.promote(source.decision, {
      ownerCapability: source.ownerCapability, sourceCapability: source.issuerCapability,
    });
    expect(receipt.status).toBe('promoted');
    expect(receipt.owner).toEqual(source.authorization.owner);
    expect(receipt.source).toEqual(source.authorization.issuer);
    expect(source.coordinator.ordinaryPrompt('Create a new work'))
      .toContain(`Authorized creative rule context:\n${FIGURE_GROUND_TARGET}=`);
  });

  it('rejects when either independent reviewer or owner prefers control', async () => {
    const independentReject = await fixture();
    const independentSink = independentReject.gate.openReviewerSink(
      independentReject.reviewerCapability,
    );
    const treatment = treatmentCandidate(independentSink.packet);
    const control = independentSink.packet.candidates.find((item) => item !== treatment)!;
    const independentDecision = independentReject.gate.evaluate({
      blindedJudgment: independentSink.submit({
        preferredBlindId: control.blindId, claim: 'control is stronger',
      }),
      ownerCapability: independentReject.ownerCapability,
      ownerJudgment: { preferredArtifact: 'treatment', claim: 'owner prefers treatment' },
    });
    expect(independentDecision.reason).toBe('BLINDED_REVIEW_REJECTED_TREATMENT');

    const ownerReject = await fixture();
    const ownerSink = ownerReject.gate.openReviewerSink(ownerReject.reviewerCapability);
    const ownerDecision = ownerReject.gate.evaluate({
      blindedJudgment: ownerSink.submit({
        preferredBlindId: treatmentCandidate(ownerSink.packet).blindId,
        claim: 'treatment is stronger',
      }),
      ownerCapability: ownerReject.ownerCapability,
      ownerJudgment: { preferredArtifact: 'control', claim: 'owner prefers control' },
    });
    expect(ownerDecision.reason).toBe('OWNER_REJECTED_TREATMENT');
  });

  it('fails closed on near-copy and unassessable dimensions', async () => {
    const near = '<!doctype html><html><head><title>One</title><style>'
      + 'body{color:#111;background:#fff;display:grid;padding:20px;animation:pulse 4s linear}'
      + '</style></head><body>same luminous circle motif</body></html>';
    const source = await fixture({
      treatmentHtml: near,
      controlHtml: near.replace('<title>One</title>', '<title>Two</title>')
        .replace('padding:20px', 'padding:20px '),
    });
    const sink = source.gate.openReviewerSink(source.reviewerCapability);
    const review = sink.submit({
      preferredBlindId: sink.packet.candidates[0]!.blindId, claim: 'candidate preferred',
    });
    const decision = source.gate.evaluate({
      blindedJudgment: review, ownerCapability: source.ownerCapability,
      ownerJudgment: { preferredArtifact: 'treatment', claim: 'owner preferred' },
    });
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toBe('COPYING_DETECTED');
    expect(decision.comparison.dimensionAssessments).toHaveLength(6);
    expect(decision.comparison.houseStyleCollapse).toBe(true);
  });

  it('does not mutate on rejected evidence or promotion replay', async () => {
    const source = await preferredFixture();
    const first = source.gate.promote(source.decision, {
      ownerCapability: source.ownerCapability, sourceCapability: source.issuerCapability,
    });
    const replay = source.gate.promote(source.decision, {
      ownerCapability: source.ownerCapability, sourceCapability: source.issuerCapability,
    });
    expect(first.status).toBe('promoted');
    expect(replay.reason).toBe('PROMOTION_REPLAYED');
    expect(source.authority.mutationCounters())
      .toEqual({ ...ZERO, ruleWrites: 1, contextWrites: 1 });
  });

  it('returns the verified W8-15 rollback when production transfer fails', async () => {
    const source = await preferredFixture(true);
    const receipt = source.gate.promote(source.decision, {
      ownerCapability: source.ownerCapability, sourceCapability: source.issuerCapability,
    });
    expect(receipt.reason).toBe('LEARNING_TRANSFER_FAILED');
    expect(receipt.learningTransfer?.reason).toBe('TRANSFER_FAILED_ROLLED_BACK');
    expect(receipt.learningTransfer?.rollbackReceipt?.restored).toBe(true);
    expect(source.authority.mutationCounters()).toEqual(ZERO);
    expect(source.coordinator.ordinaryCreateContext().rules).toEqual({});
  });

  it('keeps randomness and structural authority behavior out of production options', async () => {
    const surface = await import('../../../src/creative-run/TransferPromotionGate.js');
    expect(Object.keys(surface).sort()).toEqual([
      'SIMILARITY_DIMENSIONS',
      'TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY',
      'TRANSFER_PROMOTION_SCHEMA_VERSION',
    ]);
    const source = await fixture();
    expect('nonce' in source.gate).toBe(false);
    expect('sealComparison' in source.gate).toBe(false);
  });
});
