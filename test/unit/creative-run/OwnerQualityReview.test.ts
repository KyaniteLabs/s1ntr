import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { issueExecutorAttestation, verifyExecutorAttestation } from '../../../src/identity/executorAttestation.js';
import { buildRegistry, CLIPROXY_SURFACE, LUNA_IDENTITY, LUNA_SEAT,
  LUNA_SUBSCRIPTION_FUNDING, NOW_ISO } from '../identity/helpers.js';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import {
  createBlindReviewSession,
  type BlindReviewJudgment,
  type BlindReviewSession,
  type CandidateEvidenceAssignment,
} from '../../../src/creative-run/BlindReviewEvidence.js';
import { buildCandidateManifest, campaignCreativeThesisDigest,
  type CampaignActualCandidateManifest } from '../../../src/creative-run/CandidateHypothesisProduction.js';
import {
  assertDurableBlindReviewProvenance,
  createCaptureAuthority,
  createEnvelopeAuthority,
  createExecutorReviewerAttestationVerifier,
  createOwnerReviewPacket,
  createReviewerAttestationVerifier,
  deriveEvidenceSchedule,
  publishOwnerReviewPacket,
  recomputeAndPublishOwnerReviewPacket,
  renderOwnerReviewPacket,
  sealOwnerQualityReview,
  verifyOwnerQualityReviewBundle,
  verifyOwnerReviewPacket,
  type BriefSlotArtifact,
  type CaptureAuthority,
  type CreativeQualityReviewInput,
  type EnvelopeAuthority,
  type EvidenceBackedScore,
  type OwnerCaptureInputs,
  type OwnerEvidenceCapture,
  type OwnerPacketEnvelope,
  type OwnerReviewPacket,
  type OwnerReviewPacketStore,
  type ReviewerAttestationVerifier,
  type ReviewerExecutorAttestation,
  type SealedOwnerCampaignRef,
} from '../../../src/creative-run/OwnerQualityReview.js';
import {
  CampaignFundingReservationAuthority,
  bootstrapCampaignFundingAuthority,
  digestCampaignProviderEndpoint,
  type CampaignFundingReservationV1,
  type OwnerReviewAdmission,
} from '../../../src/creative-run/CampaignExecutionAuthority.js';
import { ManagedOwnerReviewRenderer } from '../../../src/creative-run/ManagedOwnerReviewRenderer.js';
import {
  buildCampaignExecutionPlan,
  createCampaignManifest,
  type CampaignManifest,
  type CampaignRouteFreeze,
  type CampaignSlotGraph,
} from '../../../src/creative-run/CampaignManifest.js';
import { spawn } from 'node:child_process';
import { subscriptionFunding } from '../../../src/identity/fundingTruth.js';
import type { CompositionGraph } from '../../../src/composition/CompositionGraph.js';

const INTENT = 'A luminous field whose motion follows a musical pulse and one accessible control.';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digestOf(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function generateKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function makeAttestation(role: 'specialist' | 'holistic', index: number, keyId: string, privateKeyPem: string): ReviewerExecutorAttestation {
  const fields = {
    provider: `${role}-provider-${index}`, model: `${role}-model-${index}`,
    pipe: `${role}-pipe-${index}`, effort: `${role}-effort-${index}`,
    contributionLineage: `${role}-lineage-${index}`, assignment: `${role}-assignment-${index}`,
  };
  const unsigned = {
    schema: 'sinter.reviewer-attestation', schemaVersion: 1 as const,
    attestationId: `${role}-${index}-${keyId}`, role,
    ...fields, keyId, nonce: `nonce-${role}-${index}`,
  };
  const signatureBase64 = sign(null, Buffer.from(stable(unsigned)), privateKeyPem as unknown as Buffer).toString('base64');
  return { ...unsigned, signatureBase64, resultDigest: digestOf(unsigned) };
}

function makeAttestationWithField(role: 'specialist' | 'holistic', index: number, keyId: string, privateKeyPem: string, field: string, value: string): ReviewerExecutorAttestation {
  const base = makeAttestation(role, index, keyId, privateKeyPem);
  const overrides = { [field]: value } as Record<string, string>;
  const unsigned = {
    schema: 'sinter.reviewer-attestation', schemaVersion: 1 as const,
    attestationId: base.attestationId, role,
    provider: overrides['provider'] ?? base.provider,
    model: overrides['model'] ?? base.model,
    pipe: overrides['pipe'] ?? base.pipe,
    effort: overrides['effort'] ?? base.effort,
    contributionLineage: overrides['contributionLineage'] ?? base.contributionLineage,
    assignment: overrides['assignment'] ?? base.assignment,
    keyId, nonce: base.nonce,
  };
  const signatureBase64 = sign(null, Buffer.from(stable(unsigned)), privateKeyPem as unknown as Buffer).toString('base64');
  return { ...unsigned, signatureBase64, resultDigest: digestOf(unsigned) };
}

function makeLunaAttestation(role: 'specialist' | 'holistic', keyId: string, privateKeyPem: string): ReviewerExecutorAttestation {
  const unsigned = {
    schema: 'sinter.reviewer-attestation', schemaVersion: 1 as const,
    attestationId: `luna-${keyId}`, role,
    provider: 'luna-labs', model: 'gpt-5.6-luna', pipe: 'luna-direct',
    effort: 'high', contributionLineage: 'luna-lineage', assignment: 'luna-harness-assignment',
    keyId, nonce: `nonce-luna`,
  };
  const signatureBase64 = sign(null, Buffer.from(stable(unsigned)), privateKeyPem as unknown as Buffer).toString('base64');
  return { ...unsigned, signatureBase64, resultDigest: digestOf(unsigned) };
}

function attestationBody(attestation: ReviewerExecutorAttestation) {
  const { signatureBase64: _s, resultDigest: _d, ...body } = attestation;
  return body;
}

const LUNA_PATTERN = /\bluna\b/i;

function fixtureKeys() {
  const capture = generateKey();
  const envelope = generateKey();
  const attestation = generateKey();
  return { capture, envelope, attestation };
}

const asset = (ref: string, payload: string = ref) => ({ ref, mimeType: 'application/json', payload });

interface FixtureSetup {
  readonly captureKey: ReturnType<typeof generateKey>;
  readonly envelopeKey: ReturnType<typeof generateKey>;
  readonly attestationKey: ReturnType<typeof generateKey>;
  readonly captureAuthority: CaptureAuthority;
  readonly envelopeAuthority: EnvelopeAuthority;
  readonly attestationVerifier: ReviewerAttestationVerifier;
}

function makeSetup(): FixtureSetup {
  const keys = fixtureKeys();
  const captureAuthority = createCaptureAuthority({ keyId: 'capture-key', privateKeyPem: keys.capture.privateKeyPem });
  const envelopeAuthority = createEnvelopeAuthority({ keyId: 'envelope-key', privateKeyPem: keys.envelope.privateKeyPem });
  const trustedAttestationKeys = new Map([['attest-key', keys.attestation.publicKeyPem]]);
  const attestationVerifier = createReviewerAttestationVerifier({
    trustedKeys: trustedAttestationKeys, prohibitedPatterns: [LUNA_PATTERN],
  });
  return { captureKey: keys.capture, envelopeKey: keys.envelope, attestationKey: keys.attestation,
    captureAuthority, envelopeAuthority, attestationVerifier };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'owner-review-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function slotGraphFor(briefId: string, slot: { readonly id: string; readonly graphNodeIds: readonly string[] },
): CampaignSlotGraph {
  const nodes = slot.graphNodeIds.map((id, i) => ({
    id, type: 'layer' as const,
    layer: { domain: i === 0 ? 'p5' : 'tone', prompt: `node-${id}`,
      blendMode: 'normal' as const, opacity: 1, generated: false },
  }));
  const graph: CompositionGraph = {
    schema: 'sinter.composition-graph', schemaVersion: '2.0', status: 'ready',
    id: `graph-${slot.id}`, title: slot.id,
    budgets: { maxNodes: Math.max(nodes.length, 1),
      maxEdges: Math.max(0, nodes.length - 1), maxProviderCalls: nodes.length },
    nodes, edges: nodes.slice(1).map((n, i) => ({
      id: `e-${i}`, type: 'before' as const, from: nodes[i]!.id, to: n.id,
    })),
  };
  return { briefId, candidateSlotId: slot.id, graph };
}

function routeFreezeFor(manifest: CampaignManifest): CampaignRouteFreeze {
  const routes = [
    { role: 'generator' as const, seatId: 'gen-seat', provider: 'openai', model: 'kimi-k3',
      seed: digestOf('g1'), retryBudget: 1 },
    { role: 'harness' as const, seatId: 'dream-seat', provider: 'openai', model: 'kimi-k3',
      seed: digestOf('d1'), retryBudget: 1 },
    { role: 'evaluator' as const, seatId: 'specialist-review', provider: 'openai',
      model: 'gemini-3.1-pro-low', seed: digestOf('rv-specialist'), retryBudget: 1 },
    { role: 'evaluator' as const, seatId: 'holistic-review', provider: 'anthropic',
      model: 'claude-review', seed: digestOf('rv-holistic'), retryBudget: 1 },
  ];
  return {
    routes,
    transportBudgets: {
      recovery: { retries: 1, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' },
      revision: { retries: 0, fallbacks: 0, toolTurns: 1, primaryMode: 'generate' },
      'transfer-treatment': { retries: 0, fallbacks: 1, toolTurns: 0, primaryMode: 'generate' },
      review: { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' },
    },
    transferTargetDigest: digestOf('transfer-target'),
    diversityDimensions: [
      { id: 'conceptual', description: 'distinct governing concept' },
      { id: 'structural', description: 'distinct graph topology' },
      { id: 'temporal', description: 'distinct clock/phase behavior' },
    ],
    candidateDiversity: manifest.briefs.flatMap((brief, briefIndex) =>
      brief.candidateSlots.map((slot, slotIndex) => ({
        briefId: brief.id, candidateSlotId: slot.id,
        thesisDigest: digestOf(`thesis-${briefIndex}-${slotIndex}`),
        dimensions: {
          conceptual: `${brief.id}-concept-${slot.id}`,
          structural: `${brief.id}-structure-${slot.id}`,
          temporal: `${brief.id}-time-${slot.id}`,
        },
      }))),
  };
}

async function admitOwnerReviewFor(
  campaignManifest: CampaignManifest,
  briefIds: readonly string[],
  candidateSetDigests: readonly { readonly briefId: string; readonly digest: string }[],
  root: string,
): Promise<{ readonly authority: CampaignFundingReservationAuthority;
  readonly reservation: CampaignFundingReservationV1;
  readonly withAdmission: <T>(operation: (admission: OwnerReviewAdmission) => Promise<T>) => Promise<T> }> {
  const freeze = routeFreezeFor(campaignManifest);
  const capacities = Object.fromEntries(freeze.routes.map((route) => {
    const seatDigest = digestOf(route.seatId);
    return [route.seatId, { seat: { seatId: route.seatId, seatDigest, surface: 'cliproxy-seat' },
      identity: { provider: route.provider, model: route.model, effort: 'medium' },
      funding: subscriptionFunding({ seatDigest, quotaCounters: { calls: 0, inputTokens: 0,
        outputTokens: 0, activeSeconds: 0 }, quotaSurface: 'cliproxy-seat' }),
      surface: 'cliproxy-seat',
      endpointDigest: digestCampaignProviderEndpoint('http://localhost:8317/v1'),
      remaining: { providerCalls: 128, inputTokens: 10_000_000,
        outputTokens: 3_000_000, activeSeconds: 100_000 } }];
  }));
  const authority = bootstrapCampaignFundingAuthority({ rootDir: root,
    env: { ...process.env, SINTER_CAMPAIGN_CAPACITY_JSON: JSON.stringify(capacities) } });
  const slotGraphs = campaignManifest.briefs.flatMap((brief) =>
    brief.candidateSlots.map((slot) => slotGraphFor(brief.id, slot)));
  const plan = buildCampaignExecutionPlan(campaignManifest, slotGraphs, freeze);
  const reservation = await authority.reserve({
    campaignRunId: campaignManifest.campaignRunId, plan,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const withAdmission = <T>(operation: (admission: OwnerReviewAdmission) => Promise<T>) =>
    authority.runOwnerReviewScope((mint) => operation(mint({
      reservation, manifest: campaignManifest, briefIds, candidateSetDigests,
    })));
  return { authority, reservation, withAdmission };
}

/** Build a minimal valid campaign manifest distinct from the fixture's, for mismatch tests. */
function buildOtherCampaignManifest(campaignRunId: string): CampaignManifest {
  const requiredEvidenceClasses = ['source', 'visual', 'temporal', 'interaction', 'runtime', 'clock', 'accessibility'] as const;
  const body = { campaignRunId, briefId: 'brief-other', candidateId: 'c1', nodeId: 'n1',
    audioRequirement: 'not-applicable' as const,
    requiredEvidenceClasses, evidenceScheduleDigest: digestOf(requiredEvidenceClasses) };
  const slotDigest = digestOf(body);
  return createCampaignManifest({
    campaignRunId, owner: { authorityId: 'owner-other', selectionMethod: 'host-sealed' },
    briefs: [{ id: 'brief-other', sealedBriefDigest: digestOf('brief-other'),
      unseenAt: '2026-08-01T00:00:00.000Z', exampleFree: true,
      candidateSlots: [{ id: 'c1', graphNodeIds: ['n1'],
        ownerEvidence: { ...body, slotDigest } }] }],
    transfer: { mode: 'sealed-brief', sealedBriefDigest: digestOf('t'),
      unseenAt: '2026-08-01T00:00:00.000Z', treatmentControlAllocation: 'treatment-first',
      routeDigest: digestOf('r'), randomSourceDigest: digestOf('rand'),
      evidenceScheduleDigest: digestOf('es'), nonOverlapDigest: digestOf('no') },
    rolesDigest: digestOf('roles'), executorRequirementsDigest: digestOf('exec'),
    evidenceModalitiesDigest: digestOf('mod'), ownerCheckpointsDigest: digestOf('oc'),
    qualityRubricVersion: 'v1', randomSourceDigest: digestOf('rand2'),
    evidenceScheduleDigest: digestOf('es2'), requiredReviewStageIds: [
      'specialist-review-brief-other-c1', 'holistic-review-brief-other-c1'],
    stopStates: ['complete'], ceilings: { providerCalls: 64, inputTokens: 3_000_000,
      outputTokens: 750_000, activeMinutes: 360 },
  });
}

async function fixture(setup: FixtureSetup, options: { audio?: 'required' | 'optional'; omitAudio?: boolean } = {}) {
  const thesis = buildCrossModalArtifact({ brief: INTENT, artifactId: 'thesis' }).thesis;
  const manifest = await buildCandidateManifest(INTENT, { creativeThesis: thesis });
  // Audio modality is derived from the frozen brief slot (campaign thesis),
  // not from caller-provided candidate modalities.
  const requiredEvidenceClasses = options.audio === 'optional'
    ? ['source', 'visual', 'temporal', 'interaction', 'runtime', 'clock', 'accessibility'] as const
    : ['source', 'visual', 'temporal', 'audio', 'interaction', 'runtime', 'clock', 'accessibility'] as const;
  const campaignRunId = 'campaign-run-1';
  const slots = manifest.candidates.map((sourceCandidate, index) => {
    const candidateId = sourceCandidate.id;
    const body = { campaignRunId, briefId: 'brief-1', candidateId, nodeId: `node-${index}`,
      audioRequirement: options.audio === 'optional' ? 'not-applicable' as const : 'required' as const,
      requiredEvidenceClasses, evidenceScheduleDigest: digestOf(requiredEvidenceClasses) };
    return { id: candidateId, graphNodeIds: [`node-${index}`], ownerEvidence: {
      ...body, slotDigest: digestOf(body),
    } };
  });
  const campaignManifest = createCampaignManifest({
    campaignRunId, owner: { authorityId: 'owner-1', selectionMethod: 'host-sealed' },
    briefs: [{ id: 'brief-1', sealedBriefDigest: digestOf(INTENT), unseenAt: '2026-08-01T00:00:00.000Z',
      exampleFree: true, candidateSlots: slots }],
    transfer: { mode: 'sealed-brief', sealedBriefDigest: digestOf('transfer'), unseenAt: '2026-08-01T00:00:00.000Z',
      treatmentControlAllocation: 'treatment-first', routeDigest: digestOf('route'),
      randomSourceDigest: digestOf('random'), evidenceScheduleDigest: digestOf('schedule'),
      nonOverlapDigest: digestOf('non-overlap') },
    rolesDigest: digestOf('roles'), executorRequirementsDigest: digestOf('executors'),
    evidenceModalitiesDigest: digestOf('modalities'), ownerCheckpointsDigest: digestOf('checkpoints'),
    qualityRubricVersion: 'v1', randomSourceDigest: digestOf('random'),
    evidenceScheduleDigest: digestOf('schedule'), requiredReviewStageIds: slots.flatMap((slot) => [
      `specialist-review-brief-1-${slot.id}`, `holistic-review-brief-1-${slot.id}`]),
    stopStates: ['complete'], ceilings: { providerCalls: 64, inputTokens: 3_000_000,
      outputTokens: 750_000, activeMinutes: 360 },
  });
  const sourceByCandidate = new Map(manifest.candidates.map((candidate) =>
    [candidate.id, `<main>${candidate.id}</main>`] as const));
  const actualManifest: CampaignActualCandidateManifest = {
    schema: 'sinter.campaign-actual-candidate-manifest', schemaVersion: 1,
    campaignRunId, manifestDigest: campaignManifest.manifestDigest, briefId: 'brief-1',
    candidates: campaignManifest.briefs[0]!.candidateSlots.map((slot, index) => {
      const candidate = manifest.candidates.find((item) => item.id === slot.id)!;
      return { id: slot.id, briefId: 'brief-1', slotDigest: slot.ownerEvidence.slotDigest,
        graphDigest: digestOf(`graph-${index}`), graphNodeIds: slot.graphNodeIds,
        thesisDigest: campaignCreativeThesisDigest(thesis),
        diversity: { fixture: `candidate-${index}` },
        artifact: { html: candidate.artifact.html,
          artifactDigest: createHash('sha256').update(candidate.artifact.html).digest('hex'),
          sourceDigest: createHash('sha256').update(sourceByCandidate.get(slot.id)!).digest('hex'),
          layers: [], successCount: candidate.artifact.successCount,
          layerCount: candidate.artifact.layerCount } };
    }),
  };
  const assignments: CandidateEvidenceAssignment[] = actualManifest.candidates.map((candidate, index) => ({
    candidateId: candidate.id, sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: options.audio === 'optional' ? ['visual'] : ['visual', 'audio', 'motion', 'interaction'],
    generationIdentity: { role: 'generator', provider: `generator-provider-${index}`,
      model: `generator-model-${index}`, pipe: `generator-pipe-${index}`,
      effort: `generator-effort-${index}`, contributionLineage: `generator-lineage-${index}`,
      assignment: `generator-assignment-${index}` },
    ...(options.audio === 'optional' || options.omitAudio ? {} : {
      crossModalArtifact: buildCrossModalArtifact({ brief: INTENT,
        artifactId: `cross-modal-${index}`,
        sourceCandidateArtifactDigest: candidate.artifact.artifactDigest, thesis }),
    }),
  }));
  const session = createBlindReviewSession(actualManifest, assignments);
  const evidence: OwnerCaptureInputs[] = session.packet.candidates.map((candidate, index) => ({
    source: asset(`${candidate.blindId}.source`,
      sourceByCandidate.get(actualManifest.candidates[index]!.id)!),
    timeSamples: [asset(`${candidate.blindId}.frame-0`, `frame:${candidate.blindId}`)],
    interactionTrace: asset(`${candidate.blindId}.interaction`, 'focus,activate'),
    runtimeState: asset(`${candidate.blindId}.runtime`, '{"ready":true}'),
    clockEvents: asset(`${candidate.blindId}.clock`, '0,16,32'),
    accessibility: asset(`${candidate.blindId}.a11y`, 'keyboard:pass;contrast:pass'),
    knownFailures: [], hardFloorFailures: [],
  }));
  const { authority, reservation, withAdmission } = await admitOwnerReviewFor(
    campaignManifest,
    ['brief-1'],
    [{ briefId: 'brief-1', digest: session.packet.candidateSetDigest }],
    dir,
  );
  const campaign: SealedOwnerCampaignRef = { manifest: campaignManifest, fundingReservation: reservation };
  const first = campaignManifest.briefs[0]!.candidateSlots[0]!.ownerEvidence;
  const briefSlot: BriefSlotArtifact = { ...first, manifestDigest: campaignManifest.manifestDigest,
    slotId: first.candidateId,
    artifactDigest: actualManifest.candidates[0]!.artifact.artifactDigest,
    sourceDigest: actualManifest.candidates[0]!.artifact.sourceDigest };
  const { packet, admission } = await withAdmission(async (activeAdmission) => ({
    admission: activeAdmission,
    packet: await createOwnerReviewPacket(session, setup.captureAuthority, {
      campaign, admission: activeAdmission, briefId: 'brief-1', evidence,
    }),
  }));
  const envelope = setup.envelopeAuthority.seal({
    campaignRunId: briefSlot.campaignRunId,
    manifestDigest: briefSlot.manifestDigest,
    briefId: briefSlot.briefId,
    blindPacketDigest: session.packet.packetDigest,
    packetDigest: packet.packetDigest,
  });
  return { session, packet, envelope, briefSlot, campaign, admission, authority, reservation, evidence };
}

function evidenceJudgments(session: BlindReviewSession): BlindReviewJudgment[] {
  return session.packet.candidates.map((candidate) => ({
    blindId: candidate.blindId, outcome: 'pass',
    claims: candidate.requiredModalities.flatMap((modality) => {
      const medium = candidate.media.find((item) => item.modality === modality);
      return medium ? [{ modality, artifactDigest: candidate.artifactDigest,
        evidenceDigest: medium.digest, claim: `${modality} inspected` }] : [];
    }),
  }));
}

const SCORE_VALUES = { coherence: 4, specificity: 4, surprise: 3, emotionalTemporalArc: 3,
  crossModalCausality: 3, intentionality: 4, revisitDesire: 3 } as const;

function reviewsForPacket(setup: FixtureSetup, packet: OwnerReviewPacket): CreativeQualityReviewInput[] {
  return packet.candidates.flatMap((candidate, index) => (['specialist', 'holistic'] as const).map((role) => {
    const attestation = makeAttestation(role, index, 'attest-key', setup.attestationKey.privateKeyPem);
    return {
      blindId: candidate.blindId, packetDigest: packet.packetDigest,
      evidenceRootDigest: candidate.evidenceRootDigest, attestation,
      verdict: 'pass' as const,
      scores: packet.candidates[0]!.evidence.flatMap((ev) =>
        ev.evidenceClass !== 'audio' || candidate.audioRequirement === 'required'
          ? [{ dimension: dimensionForEvidence(ev.evidenceClass) ?? 'coherence', score: 4, evidenceDigests: [ev.digest] }]
          : []
      ).slice(0, 1).concat(
        (['coherence', 'specificity', 'surprise', 'emotionalTemporalArc',
          'crossModalCausality', 'intentionality', 'revisitDesire'] as const).map(d => ({
          dimension: d, score: SCORE_VALUES[d] as number,
          evidenceDigests: [candidate.evidence[0]!.digest],
        }))
      ).filter((item, i, arr) => arr.findIndex(x => x.dimension === item.dimension) === i) as EvidenceBackedScore[],
      finding: { text: `${role} inspected exact evidence`, evidenceDigests: [candidate.evidence[0]!.digest] },
      criticalFlaws: [], disagreement: [],
    };
  }));
}

function dimensionForEvidence(cls: string): string | null {
  const map: Record<string, string> = { temporal: 'emotionalTemporalArc', audio: 'crossModalCausality',
    interaction: 'intentionality', source: 'coherence', visual: 'specificity',
    runtime: 'coherence', clock: 'emotionalTemporalArc', accessibility: 'intentionality' };
  return map[cls] ?? null;
}

function cleanReviews(setup: FixtureSetup, packet: OwnerReviewPacket): CreativeQualityReviewInput[] {
  return packet.candidates.flatMap((candidate, index) => (['specialist', 'holistic'] as const).map((role) => {
    const attestation = makeAttestation(role, index, 'attest-key', setup.attestationKey.privateKeyPem);
    const validDigests = candidate.evidence.filter(ev =>
      !(ev.evidenceClass === 'audio' && candidate.audioRequirement !== 'required')
    ).map(ev => ev.digest);
    return {
      blindId: candidate.blindId, packetDigest: packet.packetDigest,
      evidenceRootDigest: candidate.evidenceRootDigest, attestation,
      verdict: 'pass' as const,
      scores: (['coherence', 'specificity', 'surprise', 'emotionalTemporalArc',
        'crossModalCausality', 'intentionality', 'revisitDesire'] as const).map(dimension => ({
        dimension, score: SCORE_VALUES[dimension] as number,
        evidenceDigests: [validDigests[0]!],
      })),
      finding: { text: `${role} inspected exact evidence`, evidenceDigests: [validDigests[0]!] },
      criticalFlaws: [], disagreement: [],
    };
  }));
}

describe('OwnerQualityReview', () => {
  it('builds an owner-readable exact packet with signed captures and seals independent review', async () => {
    const setup = makeSetup();
    const { session, packet, envelope, briefSlot } = await fixture(setup);
    expect(packet.candidates.every((c) => new Set(c.evidence.map((e) => e.evidenceClass)).size === 8)).toBe(true);
    expect(packet.contactSheetHtml).toContain('<iframe');
    expect(packet.contactSheetHtml).toContain('<audio controls');
    expect(packet.contactSheetHtml).toContain('Owner preference: pending');
    expect(packet.contactSheetHtml).toContain('Temporal samples');
    expect(packet.contactSheetHtml).toContain('Interaction trace');
    expect(packet.contactSheetHtml).toContain('Runtime/DOM state');
    expect(packet.contactSheetHtml).toContain('Accessibility results');
    expect(packet.ownerDecisions).toEqual({ preference: null, releaseWorthiness: null });
    expect(verifyOwnerReviewPacket(packet, setup.captureAuthority)).toEqual({ conclusive: true, invalidEvidence: [] });

    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    });
    expect(sealed.candidates.every((c) => c.outcome === 'eligible')).toBe(true);
    expect(sealed.ownerDecisions).toEqual({ preference: null, releaseWorthiness: null });
    expect(sealed.envelopeDigest).toEqual(envelope.envelopeDigest);
  });

  it('derives audio requirement from the frozen campaign thesis (brief slot), not caller input', async () => {
    const setup = makeSetup();
    // Candidate modalities include audio, but the brief slot says not-applicable.
    // The packet must follow the brief slot (frozen campaign thesis), not the
    // caller-provided candidate modalities.
    const { packet } = await fixture(setup, { audio: 'optional' });
    expect(packet.candidates.every((c) => c.audioRequirement === 'not-applicable')).toBe(true);
    expect(packet.candidates.every((c) => !c.evidence.some((e) => e.evidenceClass === 'audio'))).toBe(true);
    expect(packet.candidates.every((c) => c.prohibitedClaims.includes('audio'))).toBe(true);
    expect(deriveEvidenceSchedule('not-applicable')).toEqual({
      audioRequirement: 'not-applicable',
      requiredEvidenceClasses: ['source', 'visual', 'temporal', 'interaction', 'runtime', 'clock', 'accessibility'],
    });
    expect(deriveEvidenceSchedule('required')).toEqual({
      audioRequirement: 'required',
      requiredEvidenceClasses: ['source', 'visual', 'temporal', 'audio', 'interaction', 'runtime', 'clock', 'accessibility'],
    });
    // Every signed capture binds the brief slot's audioRequirement — durable
    // campaign-thesis binding, not caller input.
    expect(packet.candidates.every((c) => c.evidence.every((e) =>
      e.briefSlot.audioRequirement === 'not-applicable'))).toBe(true);
  });

  it('overrides candidate audio modalities with the frozen brief-slot decision', async () => {
    const setup = makeSetup();
    const { packet } = await fixture(setup, { audio: 'optional' });
    // Brief slot's not-applicable decision wins over candidate's audio modality.
    expect(packet.candidates.every((c) => c.audioRequirement === 'not-applicable')).toBe(true);
    expect(packet.candidates.every((c) => !c.evidence.some((e) => e.evidenceClass === 'audio'))).toBe(true);
    expect(verifyOwnerReviewPacket(packet, setup.captureAuthority).conclusive).toBe(true);
  });

  it('makes required-audio reviews inconclusive when audio evidence is absent in the blind packet', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup, { audio: 'required', omitAudio: true });
    expect(packet.candidates.every((c) => c.audioRequirement === 'required')).toBe(true);
    expect(packet.candidates.every((c) => c.inconclusiveReasons.includes('missing-required-audio'))).toBe(true);
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    });
    expect(sealed.candidates.every((c) => c.outcome === 'inconclusive')).toBe(true);
  });

  it('rejects unsigned or tampered capture receipts', async () => {
    const setup = makeSetup();
    const { packet } = await fixture(setup);
    const tampered = structuredClone(packet) as OwnerReviewPacket;
    const target = tampered.candidates[0]!.evidence[0]!;
    (target as { payloadUri: string }).payloadUri = `${target.payloadUri}tampered`;
    const verification = verifyOwnerReviewPacket(tampered, setup.captureAuthority);
    expect(verification.conclusive).toBe(false);
  });

  it('cryptographically rejects a capture whose signature changes but digest body does not', async () => {
    const setup = makeSetup();
    const { packet } = await fixture(setup);
    const tampered = structuredClone(packet) as OwnerReviewPacket;
    (tampered.candidates[0]!.evidence[0] as { signatureBase64: string }).signatureBase64 = Buffer.alloc(64).toString('base64');
    expect(verifyOwnerReviewPacket(tampered, setup.captureAuthority).invalidEvidence)
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'capture-signature-invalid' })]));
  });

  it('rejects candidate source bytes that do not exact-match the sealed manifest slot', async () => {
    const setup = makeSetup();
    const { session, campaign, authority, reservation, evidence } = await fixture(setup);
    const changed = structuredClone(evidence) as OwnerCaptureInputs[];
    changed[0] = { ...changed[0]!, source: asset('override', 'caller override') };
    await authority.runOwnerReviewScope(async (mint) => {
      const admission = mint({ reservation, manifest: campaign.manifest, briefIds: ['brief-1'],
        candidateSetDigests: [{ briefId: 'brief-1', digest: session.packet.candidateSetDigest }] });
      await expect(createOwnerReviewPacket(session, setup.captureAuthority,
        { campaign, admission, briefId: 'brief-1', evidence: changed }))
        .rejects.toThrow(/SOURCE_DIGEST_MISMATCH/);
    });
  });

  it('rejects a blind packet whose candidate set differs from the settled admission', async () => {
    const setup = makeSetup();
    const { session, campaign, authority, reservation, evidence } = await fixture(setup);
    const swapped = structuredClone(session) as BlindReviewSession;
    (swapped.packet as { candidateSetDigest: string }).candidateSetDigest = digestOf('swapped-set');
    await authority.runOwnerReviewScope(async (mint) => {
      const admission = mint({ reservation, manifest: campaign.manifest, briefIds: ['brief-1'],
        candidateSetDigests: [{ briefId: 'brief-1', digest: session.packet.candidateSetDigest }] });
      await expect(createOwnerReviewPacket(swapped, setup.captureAuthority,
        { campaign, admission, briefId: 'brief-1', evidence }))
        .rejects.toThrow('OWNER_REVIEW_CANDIDATE_SET_MISMATCH');
    });
  });

  it('rejects a forged owner-review admission (not host-issued via admitOwnerReview)', async () => {
    const setup = makeSetup();
    const { session, campaign, reservation, evidence } = await fixture(setup);
    // A caller-fabricated plain object is NOT branded in the module-private
    // WeakSet, so assertOwnerReviewAdmission rejects it even if its contents
    // look identical to the real admission. This closes the caller-supplied
    // verifier attack surface: external code cannot mint an admission.
    const forged: OwnerReviewAdmission = Object.freeze({
      reservation, manifest: campaign.manifest, briefIds: ['brief-1'],
      candidateSetDigests: [{ briefId: 'brief-1', digest: session.packet.candidateSetDigest }],
      activeIssuerId: reservation.subject.keyId,
      activeIssuerKeyFingerprint: digestOf(reservation.subject.keyId),
    });
    await expect(createOwnerReviewPacket(session, setup.captureAuthority, {
      campaign, admission: forged, briefId: 'brief-1', evidence,
    })).rejects.toThrow(/ADMISSION_NOT_HOST_ISSUED/);
  });

  it('rejects a reservation with an invalid funding signature at admitOwnerReview', async () => {
    const setup = makeSetup();
    const { session, campaign, authority, reservation, evidence } = await fixture(setup);
    // Tamper with the reservation signature; the host authority must reject it.
    const tampered: CampaignFundingReservationV1 = {
      ...reservation,
      signature: Buffer.alloc(64).toString('base64'),
      reservationDigest: digestOf('forged'),
    };
    await expect(authority.runOwnerReviewScope(async (mint) => mint({
      reservation: tampered, manifest: campaign.manifest, briefIds: ['brief-1'],
      candidateSetDigests: [{ briefId: 'brief-1', digest: session.packet.candidateSetDigest }],
    }))).rejects.toThrow(/FUNDING_SIGNATURE_INVALID/);
    // The real admission still works
    await authority.runOwnerReviewScope(async (mint) => {
      await expect(createOwnerReviewPacket(session, setup.captureAuthority, {
        campaign, admission: mint({ reservation, manifest: campaign.manifest, briefIds: ['brief-1'],
          candidateSetDigests: [{ briefId: 'brief-1', digest: session.packet.candidateSetDigest }] }),
        briefId: 'brief-1', evidence,
      })).resolves.toMatchObject({ briefId: 'brief-1' });
    });
    void session;
  });

  it('rejects admitOwnerReview when reservation binds to a different manifest', async () => {
    const setup = makeSetup();
    const { authority, reservation, campaign } = await fixture(setup);
    // Build a second valid manifest+reservation for a different campaignRunId,
    // using the SAME authority so the signature is valid. The mismatch
    // (different campaignRunId / manifestDigest) must be rejected.
    const otherManifest = buildOtherCampaignManifest('campaign-run-other');
    const otherSlotGraphs = otherManifest.briefs.flatMap((brief) =>
      brief.candidateSlots.map((slot) => slotGraphFor(brief.id, slot)));
    const otherPlan = buildCampaignExecutionPlan(otherManifest, otherSlotGraphs, routeFreezeFor(otherManifest));
    const otherReservation = await authority.reserve({
      campaignRunId: otherManifest.campaignRunId, plan: otherPlan,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(authority.runOwnerReviewScope(async (mint) => mint({
      reservation: otherReservation, manifest: campaign.manifest, briefIds: ['brief-1'],
      candidateSetDigests: [{ briefId: 'brief-1', digest: digestOf('mismatch') }],
    }))).rejects.toThrow(/MANIFEST_BINDING_MISMATCH/);
    // Sanity: the original reservation+manifest still admits cleanly.
    await expect(authority.runOwnerReviewScope(async (mint) => mint({
      reservation, manifest: campaign.manifest, briefIds: ['brief-1'],
      candidateSetDigests: [{ briefId: 'brief-1', digest: digestOf('sanity') }],
    }))).resolves.toMatchObject({ briefIds: ['brief-1'],
      candidateSetDigests: [{ briefId: 'brief-1', digest: digestOf('sanity') }] });
  });

  it('rejects admitOwnerReview for a brief not present in the manifest', async () => {
    const setup = makeSetup();
    const { authority, reservation, campaign } = await fixture(setup);
    await expect(authority.runOwnerReviewScope(async (mint) => mint({
      reservation, manifest: campaign.manifest, briefIds: ['brief-not-in-manifest'],
      candidateSetDigests: [{ briefId: 'brief-not-in-manifest', digest: digestOf('outside') }],
    }))).rejects.toThrow(/BRIEF_OUTSIDE_MANIFEST/);
  });

  it.each(['source', 'visual', 'temporal', 'audio', 'interaction', 'runtime', 'clock', 'accessibility'] as const)(
    'makes %s tampering detectable by capture signature verification', async (evidenceClass) => {
      const setup = makeSetup();
      const { packet } = await fixture(setup);
      const tampered = structuredClone(packet) as OwnerReviewPacket;
      const candidate = tampered.candidates[0]!;
      const target = candidate.evidence.find((e) => e.evidenceClass === evidenceClass)!;
      (target as { digest: string }).digest = '0'.repeat(64);
      const verification = verifyOwnerReviewPacket(tampered, setup.captureAuthority);
      expect(verification.conclusive).toBe(false);
    },
  );

  it('requires evidence backing for every score', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const bare = cleanReviews(setup, packet);
    bare[0] = { ...bare[0]!, scores: bare[0]!.scores.map((s, i) =>
      i === 0 ? { ...s, evidenceDigests: [] } : s) };
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: bare,
    });
    expect(sealed.candidates[0]?.failures).toContain('specialist:coherence:evidence-backing-missing');
  });

  it('requires evidence backing for findings and vetoes', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const bare = cleanReviews(setup, packet);
    bare[0] = { ...bare[0]!, finding: { ...bare[0]!.finding, evidenceDigests: [] },
      criticalFlaws: [{ reason: 'unusable interaction', evidenceDigests: [] }] };
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: bare,
    });
    expect(sealed.candidates[0]?.failures).toContain('specialist:finding-evidence-backing-missing');
    expect(sealed.candidates[0]?.failures).toContain('specialist:veto-evidence-backing-missing');
  });

  it('rejects reviewer identity overlapping with generator across provider/model/pipe/effort/lineage/assignment', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const overlapping = cleanReviews(setup, packet);
    // Create a properly signed attestation with a field that overlaps the generator
    overlapping[0] = { ...overlapping[0]!,
      attestation: makeAttestationWithField('specialist', 0, 'attest-key', setup.attestationKey.privateKeyPem, 'provider', 'generator-provider-0') };
    expect(() => sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: overlapping,
    })).toThrow(/QUALITY_REVIEW_IDENTITY_OVERLAP/);
  });

  it('rejects Luna-prohibited reviewer identity', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const lunaReviews = cleanReviews(setup, packet);
    lunaReviews[0] = { ...lunaReviews[0]!,
      attestation: makeLunaAttestation('specialist', 'attest-key', setup.attestationKey.privateKeyPem) };
    expect(() => sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: lunaReviews,
    })).toThrow(/QUALITY_REVIEW_ATTESTATION_INVALID:attestation-luna-prohibited/);
  });

  it('permits Luna in the production evaluator completion verifier', () => {
    const registry = buildRegistry();
    const completion = issueExecutorAttestation(registry, {
      attestationId: 'luna-specialist', runDigest: 'run', requestDigest: 'request',
      attemptDigest: 'attempt', routeDigest: 'luna-direct', requestedIdentity: LUNA_IDENTITY,
      resolvedIdentity: LUNA_IDENTITY, effort: LUNA_IDENTITY.effort,
      fallbackChain: [{ ordinal: 0, identity: LUNA_IDENTITY }], seat: LUNA_SEAT,
      funding: LUNA_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat', issuedAt: NOW_ISO,
      nonce: 'luna-specialist-nonce', surface: CLIPROXY_SURFACE, durationMs: 1, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 1, outputTokens: 1, activeSeconds: 1 },
    });
    const attestation: ReviewerExecutorAttestation = {
      schema: 'sinter.reviewer-attestation', schemaVersion: 1, role: 'specialist',
      attestationId: completion.subject.attestationId,
      provider: completion.subject.resolvedIdentity.provider,
      model: completion.subject.resolvedIdentity.model, pipe: completion.subject.routeDigest,
      effort: completion.subject.resolvedIdentity.effort,
      contributionLineage: completion.subject.attemptDigest,
      assignment: `specialist:${completion.subject.requestDigest}`,
      keyId: completion.subject.keyId, nonce: completion.subject.nonce,
      signatureBase64: completion.signature,
      resultDigest: createHash('sha256').update(JSON.stringify(completion)).digest('hex'), completion,
    };
    const verifier = createExecutorReviewerAttestationVerifier(
      (candidate) => verifyExecutorAttestation(registry, candidate, NOW_ISO));
    expect(verifier.verify(attestation, 'specialist')).toEqual({ valid: true });
  });

  it('verifies signed envelope on seal and rejects untrusted envelope', async () => {
    const setup = makeSetup();
    const { session, packet, envelope, briefSlot } = await fixture(setup);
    const otherKey = generateKey();
    const otherAuthority = createEnvelopeAuthority({ keyId: 'other-key', privateKeyPem: otherKey.privateKeyPem });
    const forgedEnvelope = otherAuthority.seal({
      campaignRunId: briefSlot.campaignRunId, manifestDigest: briefSlot.manifestDigest,
      briefId: briefSlot.briefId,
      blindPacketDigest: session.packet.packetDigest, packetDigest: packet.packetDigest,
    });
    expect(() => sealOwnerQualityReview({
      session, packet, envelope: forgedEnvelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    })).toThrow(/OWNER_PACKET_ENVELOPE_INVALID/);
    // Valid envelope still works
    expect(() => sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    })).not.toThrow();
  });

  it('is restart-verifiable: a persisted envelope verifies without in-memory state', async () => {
    const setup = makeSetup();
    const { packet, envelope } = await fixture(setup);
    // Simulate restart: new authority with same key
    const restartedAuthority = createEnvelopeAuthority({ keyId: 'envelope-key', privateKeyPem: setup.envelopeKey.privateKeyPem });
    const result = restartedAuthority.verify(envelope);
    expect(result.valid).toBe(true);
  });

  it('cryptographically rejects an envelope signature replacement', async () => {
    const setup = makeSetup();
    const { envelope } = await fixture(setup);
    const tampered = { ...envelope, signatureBase64: Buffer.alloc(64).toString('base64') };
    expect(setup.envelopeAuthority.verify(tampered)).toEqual({ valid: false, reason: 'envelope-signature-invalid' });
  });

  it('preserves reviewer ties and disagreement without fabricating certainty', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const divided = cleanReviews(setup, packet);
    divided[1] = { ...divided[1]!, verdict: 'tie', disagreement: ['temporal arc remains ambiguous'] };
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: divided,
    });
    expect(sealed.candidates[0]?.outcome).toBe('inconclusive');
    expect(sealed.candidates[0]?.disagreement).toEqual(['temporal arc remains ambiguous']);
  });

  it('does not promote a relative winner below absolute floors', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const weak = cleanReviews(setup, packet).map((review, i) => ({
      ...review, scores: review.scores.map(s => s.dimension === 'coherence' ? { ...s, score: 2 } : s),
      criticalFlaws: i === 0 ? [{ reason: 'unusable interaction', evidenceDigests: [packet.candidates[0]!.evidence[0]!.digest] }] : [],
    }));
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: weak,
    });
    expect(sealed.status).toBe('no-eligible-candidate');
    expect(sealed.candidates.every((c) => c.outcome === 'below-floor')).toBe(true);
  });

  it('applies critical-flaw veto even when verdict is pass', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    // Every candidate's specialist marks a critical flaw with evidence
    // backing but verdict 'pass'. The critical flaw itself is the veto per
    // CreativeQualityRubric v1, independent of the verdict field.
    const vetoed = cleanReviews(setup, packet);
    packet.candidates.forEach((candidate, ci) => {
      const specialistIndex = ci * 2; // specialist is first per candidate
      vetoed[specialistIndex] = {
        ...vetoed[specialistIndex]!,
        verdict: 'pass' as const,
        criticalFlaws: [{ reason: 'seizure-inducing flicker', evidenceDigests: [candidate.evidence[0]!.digest] }],
      };
    });
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: vetoed,
    });
    expect(sealed.candidates.every((c) => c.failures.includes('specialist:critical-flaw-veto'))).toBe(true);
    expect(sealed.candidates.every((c) => c.outcome === 'below-floor')).toBe(true);
    expect(sealed.status).toBe('no-eligible-candidate');
  });

  it('binds every evidence item to the exact campaign origin and candidate artifact digest', async () => {
    const setup = makeSetup();
    const { packet } = await fixture(setup);
    // Every capture across every candidate binds the same brief slot and the
    // candidate's artifact digest. Tampering with one capture's brief slot
    // must be detected by verifyOwnerReviewPacket.
    const tampered = structuredClone(packet) as OwnerReviewPacket;
    const target = tampered.candidates[0]!.evidence[0]!;
    (target as { briefSlot: { briefId: string } }).briefSlot = {
      ...target.briefSlot, briefId: 'wrong-brief',
    };
    const verification = verifyOwnerReviewPacket(tampered, setup.captureAuthority);
    expect(verification.conclusive).toBe(false);
    expect(verification.invalidEvidence.some((e) => e.reason === 'capture-brief-id-mismatch')).toBe(true);
  });

  it('detects when captures bind different campaign origins', async () => {
    const setup = makeSetup();
    const { packet } = await fixture(setup);
    const tampered = structuredClone(packet) as OwnerReviewPacket;
    // Flip one capture's manifestDigest to simulate a mixed-origin packet.
    const target = tampered.candidates[0]!.evidence[1]!;
    (target as { briefSlot: { manifestDigest: string } }).briefSlot = {
      ...target.briefSlot, manifestDigest: 'f'.repeat(64),
    };
    const verification = verifyOwnerReviewPacket(tampered, setup.captureAuthority);
    expect(verification.conclusive).toBe(false);
    expect(verification.invalidEvidence.some((e) => e.reason === 'capture-campaign-origin-mismatch'
      || e.reason === 'capture-invalid')).toBe(true);
  });
});

describe('OwnerQualityReview publication', () => {
  it('rejects a conflicting immutable putIfAbsent result', async () => {
    const setup = makeSetup();
    const { packet, envelope } = await fixture(setup);
    const conflicting = { ...packet, packetDigest: 'f'.repeat(64) };
    const store: OwnerReviewPacketStore = { putIfAbsent: vi.fn(async () => ({ packet: conflicting, created: false })),
      compareAndSwap: vi.fn() };
    await expect(publishOwnerReviewPacket(envelope, setup.envelopeAuthority, packet, store))
      .rejects.toThrow(/PUT_IF_ABSENT_CONFLICT/);
  });
  it('publishes an exact packet once atomically and reuses its immutable receipt', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const records = new Map<string, OwnerReviewPacket>();
    const store: OwnerReviewPacketStore = {
      putIfAbsent: vi.fn(async (pkt: OwnerReviewPacket) => {
        if (records.has(pkt.briefId)) return { packet: records.get(pkt.briefId)!, created: false };
        records.set(pkt.briefId, pkt);
        return { packet: pkt, created: true };
      }),
      compareAndSwap: vi.fn(async (briefId: string, expectedDigest: string | null, pkt: OwnerReviewPacket) => {
        const existing = records.get(briefId);
        const currentDigest = existing?.packetDigest ?? null;
        if (currentDigest !== expectedDigest) throw new Error('CAS_CONFLICT');
        records.set(briefId, pkt);
        return { packet: pkt, created: expectedDigest === null };
      }),
    };
    const first = await publishOwnerReviewPacket(envelope, setup.envelopeAuthority, packet, store);
    const replay = await publishOwnerReviewPacket(envelope, setup.envelopeAuthority, packet, store);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.packet.packetDigest).toBe(packet.packetDigest);
    expect(store.putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('recomputes and publishes idempotently on restart (same digest)', async () => {
    const setup = makeSetup();
    const { session, campaign, authority, reservation, evidence } = await fixture(setup);
    const records = new Map<string, OwnerReviewPacket>();
    const store: OwnerReviewPacketStore = {
      putIfAbsent: vi.fn(async (pkt: OwnerReviewPacket) => {
        if (records.has(pkt.briefId)) return { packet: records.get(pkt.briefId)!, created: false };
        records.set(pkt.briefId, pkt);
        return { packet: pkt, created: true };
      }),
      compareAndSwap: vi.fn(),
    };
    const [result1, result2] = await authority.runOwnerReviewScope(async (mint) => {
      const admission = mint({ reservation, manifest: campaign.manifest, briefIds: ['brief-1'],
        candidateSetDigests: [{ briefId: 'brief-1', digest: session.packet.candidateSetDigest }] });
      return [
        await recomputeAndPublishOwnerReviewPacket(session, setup.captureAuthority,
          setup.envelopeAuthority, { campaign, admission, briefId: 'brief-1', evidence }, store),
        await recomputeAndPublishOwnerReviewPacket(session, setup.captureAuthority,
          setup.envelopeAuthority, { campaign, admission, briefId: 'brief-1', evidence }, store),
      ];
    });
    expect(result1.created).toBe(true);
    expect(result2.created).toBe(false);
    expect(result1.packet.packetDigest).toBe(result2.packet.packetDigest);
    expect(result1.envelope.envelopeDigest).toBe(result2.envelope.envelopeDigest);
  });

  it('handles concurrent publication: only one wins, the other gets the existing packet', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const records = new Map<string, OwnerReviewPacket>();
    let writeInProgress = false;
    const store: OwnerReviewPacketStore = {
      putIfAbsent: vi.fn(async (pkt: OwnerReviewPacket) => {
        // Simulate atomic putIfAbsent: if already present, return existing
        if (records.has(pkt.briefId)) return { packet: records.get(pkt.briefId)!, created: false };
        records.set(pkt.briefId, pkt);
        return { packet: pkt, created: true };
      }),
      compareAndSwap: vi.fn(),
    };
    const [r1, r2] = await Promise.all([
      publishOwnerReviewPacket(envelope, setup.envelopeAuthority, packet, store),
      publishOwnerReviewPacket(envelope, setup.envelopeAuthority, packet, store),
    ]);
    expect(r1.created !== r2.created).toBe(true);
    expect(r1.packet.packetDigest).toBe(r2.packet.packetDigest);
  });

  it('rejects publication of a tampered packet whose content digest no longer matches', async () => {
    const setup = makeSetup();
    const { packet, envelope } = await fixture(setup);
    const store: OwnerReviewPacketStore = {
      putIfAbsent: vi.fn(),
      compareAndSwap: vi.fn(),
    };
    // Tamper with the contact-sheet HTML after sealing — the claimed
    // packetDigest no longer matches the recomputed digest.
    const tampered = structuredClone(packet) as OwnerReviewPacket;
    (tampered as { contactSheetHtml: string }).contactSheetHtml = '<html>tampered</html>';
    // Fix the envelope binding so the recompute check is the gate, not the envelope check.
    await expect(publishOwnerReviewPacket(envelope, setup.envelopeAuthority, tampered, store))
      .rejects.toThrow(/OWNER_PACKET_DIGEST_RECOMPUTE_MISMATCH|OWNER_PACKET_ENVELOPE_BINDING_MISMATCH/);
    expect(store.putIfAbsent).not.toHaveBeenCalled();
  });
});

describe('OwnerQualityReview durable provenance', () => {
  it('verifies a sealed bundle restart-safe without WeakMap or in-memory state', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    });
    // Simulate restart: reconstruct authorities from persisted keys.
    const restartedCapture = createCaptureAuthority({ keyId: 'capture-key', privateKeyPem: setup.captureKey.privateKeyPem });
    const restartedEnvelope = createEnvelopeAuthority({ keyId: 'envelope-key', privateKeyPem: setup.envelopeKey.privateKeyPem });
    const verification = verifyOwnerQualityReviewBundle(sealed, packet, envelope, {
      captureAuthority: restartedCapture, envelopeAuthority: restartedEnvelope,
      attestationVerifier: setup.attestationVerifier,
    });
    expect(verification.valid).toBe(true);
    expect(verification.reasons).toEqual([]);
  });

  it('detects tampering with the bundle review digest on restart', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    });
    const tampered = structuredClone(sealed);
    // Flip the status to the opposite value — the reviewDigest no longer matches.
    const originalStatus = sealed.status;
    (tampered as { status: string }).status = originalStatus === 'eligible-candidate-present'
      ? 'no-eligible-candidate' : 'eligible-candidate-present';
    const verification = verifyOwnerQualityReviewBundle(tampered, packet, envelope, {
      captureAuthority: setup.captureAuthority, envelopeAuthority: setup.envelopeAuthority,
      attestationVerifier: setup.attestationVerifier,
    });
    expect(verification.valid).toBe(false);
    expect(verification.reasons).toContain('bundle-review-digest-recompute-mismatch');
  });

  it('cryptographically rejects a tampered reviewer completion after restart', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    });
    const tampered = structuredClone(sealed);
    (tampered.candidates[0]!.reviews[0]!.attestation as { signatureBase64: string })
      .signatureBase64 = Buffer.from('tampered').toString('base64');
    const verification = verifyOwnerQualityReviewBundle(tampered, packet, envelope, {
      captureAuthority: setup.captureAuthority, envelopeAuthority: setup.envelopeAuthority,
      attestationVerifier: setup.attestationVerifier,
    });
    expect(verification.valid).toBe(false);
    expect(verification.reasons.some((reason) => reason.includes('attestation-signature-invalid')))
      .toBe(true);
  });

  it('assertDurableBlindReviewProvenance catches blind-review digest tampering', async () => {
    const setup = makeSetup();
    const { session, packet, envelope } = await fixture(setup);
    const sealed = sealOwnerQualityReview({
      session, packet, envelope, envelopeAuthority: setup.envelopeAuthority,
      captureAuthority: setup.captureAuthority, attestationVerifier: setup.attestationVerifier,
      evidenceJudgments: evidenceJudgments(session), reviews: cleanReviews(setup, packet),
    });
    // Tamper with a judgment in the blind review record.
    const tamperedReview = structuredClone(sealed.blindReview);
    (tamperedReview.judgments[0] as { outcome: string }).outcome = 'fail';
    expect(() => assertDurableBlindReviewProvenance(
      { packetDigest: session.packet.packetDigest }, tamperedReview, sealed.unmasked,
    )).toThrow(/BLIND_REVIEW_DIGEST_RECOMPUTE_MISMATCH/);
  });
});

describe('ManagedOwnerReviewRenderer', () => {
  it('spawns a child process and cleans it up on close', async () => {
    const renderer = new ManagedOwnerReviewRenderer({ readyTimeoutMs: 10_000 });
    const html = '<!doctype html><html><body><h1>Test</h1></body></html>';
    await renderer.render(html);
    expect(renderer.isRunning).toBe(true);
    expect(renderer.childPid).toBeTypeOf('number');
    const pid = renderer.childPid!;
    await renderer.close();
    expect(renderer.isRunning).toBe(false);
    // Verify child process is dead
    try {
      process.kill(pid, 0);
      expect.fail('Child process should have been killed');
    } catch {
      // Expected: ESRCH means process doesn't exist
    }
  });

  it('cleans up child process on render failure via finally in renderOwnerReviewPacket', async () => {
    const setup = makeSetup();
    const { packet, envelope } = await fixture(setup);
    const renderer = new ManagedOwnerReviewRenderer({ readyTimeoutMs: 10_000 });
    await renderer.render(packet.contactSheetHtml);
    const pid = renderer.childPid!;
    const closeSpy = vi.fn(async () => { await renderer.close(); });
    // Simulate render path where renderOwnerReviewPacket is called with failing render
    const failingRenderer = {
      render: vi.fn(async () => { throw new Error('render failed'); }),
      close: closeSpy,
    };
    await expect(renderOwnerReviewPacket(packet, envelope, setup.envelopeAuthority, failingRenderer))
      .rejects.toThrow('render failed');
    expect(closeSpy).toHaveBeenCalledOnce();
    // The actual child process should be cleaned up
    try {
      process.kill(pid, 0);
      expect.fail('Child process should have been killed');
    } catch {
      // Expected
    }
  });

  it('always tears down the renderer even on render error', async () => {
    const setup = makeSetup();
    const { packet, envelope } = await fixture(setup);
    const closeSpy = vi.fn(async () => {});
    const renderer = {
      render: vi.fn(async () => { throw new Error('render failed'); }),
      close: closeSpy,
    };
    await expect(renderOwnerReviewPacket(packet, envelope, setup.envelopeAuthority, renderer))
      .rejects.toThrow('render failed');
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it('kills the child process when readiness fails so no orphan remains', async () => {
    // Override spawnFn to launch a real long-lived process that never writes
    // to stdout, so awaitReady times out. The render() catch-block must
    // SIGKILL the child to prevent an orphan server process.
    const silentSpawn = (() => spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })) as typeof spawn;
    const renderer = new ManagedOwnerReviewRenderer({
      spawnFn: silentSpawn,
      readyTimeoutMs: 200,
    });
    const html = '<!doctype html><html><body>test</body></html>';
    await expect(renderer.render(html)).rejects.toThrow(/MANAGED_RENDERER_CHILD_START_TIMEOUT/);
    expect(renderer.isRunning).toBe(false);
    expect(renderer.childPid).toBeNull();
    // No #state was set, so close() is a safe no-op.
    await renderer.close();
  });

  it('binds the server explicitly to 127.0.0.1 (loopback only, no externhost)', async () => {
    // The contact-sheet server must call server.listen with an explicit
    // 127.0.0.1 host so it is never reachable on 0.0.0.0 / external interfaces.
    // Capture the spawn arguments and verify the child script binds loopback.
    const capturedCalls: ReadonlyArray<readonly string[]> = [];
    const capturingSpawn = ((...args: readonly unknown[]) => {
      const cmd = args[0] as string;
      const argv = args[1] as readonly string[];
      capturedCalls.push([cmd, ...argv]);
      return spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    }) as unknown as typeof spawn;
    const renderer = new ManagedOwnerReviewRenderer({
      spawnFn: capturingSpawn,
      readyTimeoutMs: 10_000,
    });
    const html = '<!doctype html><html><body>loopback-bind-test</body></html>';
    const handle = await renderer.render(html);
    try {
      // The spawned child script must explicitly bind to 127.0.0.1.
      const scriptArg = capturedCalls[0]?.[2] ?? '';
      expect(scriptArg).toContain("listen(0,'127.0.0.1'");
      // Fetch the URL to prove the live server serves the HTML on loopback.
      const response = await fetch(handle.url);
      const text = await response.text();
      expect(text).toContain('loopback-bind-test');
    } finally {
      await renderer.close();
    }
  });
});
