import type { BlindReviewJudgment, BlindReviewSession } from './BlindReviewEvidence.js';
import { resolveCampaignBlindCandidateBinding } from './BlindReviewEvidence.js';
import type { OwnerReviewAdmission } from './CampaignExecutionAuthority.js';
import type { CampaignRunAdmission } from './CreativeRunCoordinatorBase.js';
import {
  assertOwnerReviewScopeLease,
  type CampaignService,
  type OwnerReviewScopeLease,
} from './CampaignService.js';
import type { LLMClient } from '../llm/LLMClient.js';
import { LLMClient as RuntimeLLMClient } from '../llm/LLMClient.js';
import { selectApiKeyForEndpoint } from '../config/ProviderKeyResolver.js';
import { sha256Hex } from '../identity/hostAdapterRegistry.js';
import type { CampaignFundingAllocation } from './CampaignExecutionAuthority.js';
import { computeCampaignRouteDigest, resolveCampaignAllocationSurface } from './CampaignExecutionAuthority.js';
import { type CampaignManifest } from './CampaignManifest.js';
import { bootstrapCampaignExecutorAuthority } from '../identity/executorAuthorityBootstrap.js';
import { loadPinnedProductionHostAuthority } from '../identity/executorAuthorityBootstrap.js';
import { GLMCodingPlanReviewClient } from '../llm/GLMCodingPlanHostAdapter.js';
import type { HarnessTransportAuthority } from '../identity/harnessTransportGuard.js';
import type { ExecutorAttemptRecord } from '../identity/harnessTransportGuard.js';
import type {
  ExecutorAttestationV2,
  ExecutorAttestationV3,
} from '../identity/executorAttestation.js';
import { isFundingTruthComplete } from '../identity/fundingTruth.js';
import {
  createOwnerReviewPacket,
  createExecutorReviewerAttestationVerifier,
  publishOwnerReviewPacket,
  renderOwnerReviewPacket,
  sealOwnerQualityReview,
  type CaptureAuthority,
  type CreativeQualityReviewInput,
  type EnvelopeAuthority,
  type OwnerCaptureInputs,
  type OwnerQualityReviewBundle,
  type OwnerReviewHandle,
  type OwnerPacketEnvelope,
  type OwnerReviewPacket,
  type OwnerReviewPacketRenderer,
  type OwnerReviewPacketStore,
  type ReviewerAttestationVerifier, type ReviewerExecutorAttestation,
  type SealedOwnerCampaignRef,
} from './OwnerQualityReview.js';

type OwnerReviewClient = Pick<LLMClient,
  'generate' | 'getHarnessExecutorProjection' | 'verifyPersistedExecutorCompletion'>;

interface ActiveOwnerReviewHost {
  readonly specialist: OwnerReviewClient;
  readonly holistic: OwnerReviewClient;
}
const activeHosts = new WeakSet<object>();
let activeHost: ActiveOwnerReviewHost | undefined;
let productionHostEnabled = false;
let productionExecutorFactory: ((binding: Parameters<typeof bootstrapCampaignExecutorAuthority>[0])
  => HarnessTransportAuthority) | undefined;

/** @internal Called once by the production composition root, never by campaign callers. */
export function bootstrapActiveOwnerReviewHost(specialist: LLMClient, holistic: LLMClient): void {
  if (activeHost) throw new Error('OWNER_REVIEW_HOST_ALREADY_BOOTSTRAPPED');
  activeHost = Object.freeze({ specialist, holistic });
  activeHosts.add(activeHost);
}

/** Install the sole production reviewer host at process composition. */
export function bootstrapProductionOwnerReviewHost(
  testExecutorFactory?: typeof productionExecutorFactory,
): void {
  if (testExecutorFactory && process.env.NODE_ENV !== 'test') {
    throw new Error('OWNER_REVIEW_EXECUTOR_TEST_FACTORY_FORBIDDEN');
  }
  productionHostEnabled = true;
  productionExecutorFactory = testExecutorFactory;
  // Production composition must not inherit a deterministic test host from
  // an earlier in-process fixture; its reviewer clients are route-bound.
  activeHost = undefined;
}

/** @internal Deterministic test-only composition seam. */
export function bootstrapTestOwnerReviewHost(specialist: LLMClient, holistic: LLMClient): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('OWNER_REVIEW_TEST_BOOTSTRAP_FORBIDDEN');
  activeHost = Object.freeze({ specialist, holistic });
  activeHosts.add(activeHost);
}

function productionClient(allocation: CampaignFundingAllocation): OwnerReviewClient {
  const baseUrl = productionEndpoint(allocation);
  if (!baseUrl) throw new Error(`OWNER_REVIEW_ROUTE_UNRESOLVED:${allocation.stageId}`);
  if (allocation.surface === 'glm-coding-plan-seat') {
    return new GLMCodingPlanReviewClient(allocation, loadPinnedProductionHostAuthority().registry);
  }
  const seatKeyName = `SINTER_CAMPAIGN_SEAT_KEY_${allocation.seat.seatId
    .replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const apiKey = process.env[seatKeyName]
    ?? selectApiKeyForEndpoint(baseUrl, allocation.identity.model);
  if (!apiKey || sha256Hex(apiKey) !== allocation.seat.seatDigest
    || (allocation.funding.mode === 'subscription-seat'
      && allocation.funding.seatDigest !== allocation.seat.seatDigest)) {
    throw new Error(`OWNER_REVIEW_FUNDING_IDENTITY_MISMATCH:${allocation.stageId}`);
  }
  return new RuntimeLLMClient({ role: 'evaluator', baseUrl, apiKey,
    provider: allocation.identity.provider, model: allocation.identity.model,
    thinking: { enabled: true, effort: allocation.identity.effort as 'high' },
    harnessTransportAuthority: (productionExecutorFactory ?? bootstrapCampaignExecutorAuthority)(
      { seat: allocation.seat, funding: allocation.funding }),
  });
}

function productionEndpoint(allocation: CampaignFundingAllocation): string | undefined {
  const seatEndpointName = `SINTER_CAMPAIGN_SEAT_BASE_URL_${allocation.seat.seatId
    .replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const seatEndpoint = process.env[seatEndpointName];
  if (seatEndpoint) return seatEndpoint;
  const cliproxyBaseUrl = process.env.CODEX_PROXY_BASE_URL
    ?? process.env.SINTER_CODEX_PROXY_BASE_URL
    ?? process.env.LIMINAL_CODEX_PROXY_BASE_URL
    ?? 'http://localhost:8317/v1';
  // moonshot-direct covers classic Moonshot (/v1) and Kimi coding seats.
  // Prefer coding endpoint for kimi identities so capacity endpointDigest and
  // transportProvider stay aligned with freeze (api.kimi.com/coding/v1).
  if (allocation.surface === 'moonshot-direct') {
    const provider = allocation.identity.provider;
    const model = allocation.identity.model.toLowerCase();
    if (provider === 'kimi' || model.includes('kimi-for-coding') || model.includes('kimi-k3')
      || model.includes('kimi-k2')) {
      return 'https://api.kimi.com/coding/v1';
    }
    return 'https://api.moonshot.ai/v1';
  }
  const endpoints: Partial<Record<CampaignFundingAllocation['surface'], string>> = {
    'openai-direct': 'https://api.openai.com/v1',
    'anthropic-direct': 'https://api.anthropic.com/v1',
    'google-direct': 'https://generativelanguage.googleapis.com',
    'openrouter': 'https://openrouter.ai/api/v1', 'glm-direct': 'https://api.z.ai/api/anthropic',
    'glm-coding-plan-seat': 'https://api.z.ai/api/anthropic',
    'minimax-direct': 'https://api.minimax.io/anthropic',
    'kimi-cliproxy': cliproxyBaseUrl, 'cliproxy-seat': cliproxyBaseUrl,
    'kilo-gateway-entitlement': 'https://api.kilo.ai/api/gateway',
  };
  return endpoints[allocation.surface];
}

export interface OwnerReviewLifecycleInput {
  readonly campaign: SealedOwnerCampaignRef;
  readonly admission: OwnerReviewAdmission;
  readonly briefId: string;
  readonly session: BlindReviewSession;
  readonly evidence: readonly OwnerCaptureInputs[];
  readonly evidenceJudgments: readonly BlindReviewJudgment[];
  readonly captureAuthority: CaptureAuthority;
  readonly envelopeAuthority: EnvelopeAuthority;
  readonly store: OwnerReviewPacketStore;
  readonly renderer: OwnerReviewPacketRenderer;
}

export interface OwnerReviewLifecycleResult {
  readonly surface: 'studio' | 'cli';
  readonly packet: OwnerReviewPacket;
  readonly bundle: OwnerQualityReviewBundle;
  readonly handle: OwnerReviewHandle;
  readonly created: boolean;
  /** Host-only handoff for terminal campaign closure; it contains no serializable authority. */
  readonly closureContext: OwnerReviewClosureContext;
}

/** Bound text transport for reviewers; the intact playable packet remains owner-facing. */
function reviewerPacketProjection(packet: OwnerReviewPacket, blindId: string) {
  return Object.freeze({
    schema: 'sinter.owner-review-transport-projection' as const, schemaVersion: 1 as const,
    sourcePacketDigest: packet.packetDigest, blindPacketDigest: packet.blindPacketDigest,
    briefId: packet.briefId, contactSheetDigest: sha256Hex(packet.contactSheetHtml),
    candidates: Object.freeze(packet.candidates.filter((candidate) => candidate.blindId === blindId)
      .map((candidate) =>
    Object.freeze({ ...candidate, evidence: Object.freeze(candidate.evidence.map((capture) =>
      capture.evidenceClass === 'audio'
        ? Object.freeze({ ...capture, payloadUri: undefined,
          payloadDisposition: 'owner-playable-only' as const })
        : capture),
    ) }))),
  });
}

export function ownerReviewerSystemPrompt(role: 'specialist' | 'holistic'): string {
  const evidenceScope = role === 'specialist'
    ? 'Judge source, runtime, clock, interaction-contract, and accessibility evidence only. Do not claim direct visual, motion, or audio perception; the blind owner performs that experiential review.'
    : 'Judge cross-modal coherence only from the signed evidence projection. This text transport cannot render, play, or interact with the artifact, so never claim direct visual, motion, interaction, or audio perception; the blind owner performs that experiential review.';
  return `You are the sealed ${role} owner-quality reviewer. ${evidenceScope} ` +
    'Return only JSON for verdict, scores, finding, criticalFlaws, and disagreement.';
}

declare const OWNER_REVIEW_CLOSURE_CONTEXT_BRAND: unique symbol;
/** Opaque reference to the host-held envelope and packet store for one brief. */
export interface OwnerReviewClosureContext {
  readonly [OWNER_REVIEW_CLOSURE_CONTEXT_BRAND]: true;
}
interface OwnerReviewClosureContextBinding {
  readonly briefId: string;
  readonly packetDigest: string;
  readonly envelope: OwnerPacketEnvelope;
  readonly store: OwnerReviewPacketStore;
}
const OWNER_REVIEW_CLOSURE_CONTEXTS = new WeakMap<object, OwnerReviewClosureContextBinding>();

/** Internal resolver used only by CampaignService's host-owned completion path. */
export function resolveOwnerReviewClosureContext(
  context: OwnerReviewClosureContext,
): OwnerReviewClosureContextBinding {
  const binding = OWNER_REVIEW_CLOSURE_CONTEXTS.get(context);
  if (!binding) throw new Error('OWNER_REVIEW_CLOSURE_CONTEXT_INVALID');
  return binding;
}

function hostAttestation(role: 'specialist' | 'holistic', record: ExecutorAttemptRecord): ReviewerExecutorAttestation {
  const subject = record.attestation.subject;
  const attestation = Object.freeze({
    schema: 'sinter.reviewer-attestation' as const, schemaVersion: 1 as const,
    attestationId: subject.attestationId, role,
    provider: subject.resolvedIdentity.provider, model: subject.resolvedIdentity.model,
    pipe: subject.routeDigest, effort: subject.resolvedIdentity.effort,
    contributionLineage: subject.attemptDigest, assignment: `${role}:${subject.requestDigest}`,
    keyId: subject.keyId, nonce: subject.nonce,
    signatureBase64: record.attestation.signature,
    resultDigest: record.attestationDigest,
    completion: record.attestation.subject.schemaVersion === 'executor-attestation.v2'
      || record.attestation.subject.schemaVersion === 'executor-attestation.v3'
      ? record.attestation as ExecutorAttestationV2 | ExecutorAttestationV3 : undefined,
  });
  return attestation;
}

function exactCompletion(client: OwnerReviewClient, digest: string): ExecutorAttemptRecord {
  const matches = client.getHarnessExecutorProjection().attempts
    .filter((attempt) => attempt.attestationDigest === digest);
  if (matches.length !== 1) throw new Error('OWNER_REVIEW_EXACT_COMPLETION_AMBIGUOUS');
  return matches[0]!;
}

function extractReviewJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenced) return fenced[1]!.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function parseReview(text: string, binding: Pick<CreativeQualityReviewInput,
  'blindId' | 'packetDigest' | 'evidenceRootDigest' | 'attestation'>): CreativeQualityReviewInput {
  let parsed: Omit<CreativeQualityReviewInput,
    'blindId' | 'packetDigest' | 'evidenceRootDigest' | 'attestation'>;
  try {
    parsed = JSON.parse(extractReviewJson(text));
  } catch {
    // LLM returned malformed JSON — fall through to defaults below
    parsed = {} as typeof parsed;
  }
  return Object.freeze({
    ...parsed,
    disagreement: Array.isArray(parsed.disagreement) ? parsed.disagreement : [],
    criticalFlaws: Array.isArray(parsed.criticalFlaws)
      ? parsed.criticalFlaws.map((veto) => ({
          reason: typeof veto.reason === 'string' ? veto.reason : '',
          evidenceDigests: Array.isArray(veto.evidenceDigests) ? [...veto.evidenceDigests] : [],
        }))
      : [],
    scores: Array.isArray(parsed.scores) ? parsed.scores : [],
    finding: parsed.finding && typeof parsed.finding === 'object'
      ? {
          text: typeof parsed.finding.text === 'string' ? parsed.finding.text : '',
          evidenceDigests: Array.isArray(parsed.finding.evidenceDigests)
            ? [...parsed.finding.evidenceDigests] : [],
        }
      : { text: '', evidenceDigests: [] },
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict : 'tie',
    ...binding,
  });
}

function assertReviewerAllocation(
  admission: CampaignRunAdmission,
  allocation: CampaignFundingAllocation,
): void {
  const stage = admission.plan.stages.find((item) => item.id === allocation.stageId);
  const route = admission.plan.routeFreeze.routes.find((item) => item.seatId === stage?.seatId);
  if (!stage || stage.kind !== 'review' || allocation.role !== 'evaluator' || !route
    || route.role !== 'evaluator') throw new Error(`OWNER_REVIEW_STAGE_ROUTE_INVALID:${allocation.stageId}`);
  if (allocation.identity.provider !== route.provider || allocation.identity.model !== route.model
    || allocation.seat.seatId !== route.seatId || allocation.seat.surface !== allocation.surface
    || !isFundingTruthComplete(allocation.funding)
    || (allocation.funding.mode === 'subscription-seat'
      && allocation.funding.seatDigest !== allocation.seat.seatDigest)
    || allocation.logicalAttemptId !== `${admission.creativeRun.requestKey}:${allocation.stageId}`
    || allocation.routeDigest !== computeCampaignRouteDigest(route)) {
    throw new Error(`OWNER_REVIEW_STAGE_ROUTE_MISMATCH:${allocation.stageId}`);
  }
  const endpoint = productionEndpoint(allocation);
  if (!endpoint || resolveCampaignAllocationSurface(
    allocation, allocation.identity.provider, endpoint) !== allocation.surface)
    throw new Error(`OWNER_REVIEW_STAGE_SURFACE_MISMATCH:${allocation.stageId}`);
}

function prepareReviewerHost(
  admission: CampaignRunAdmission,
  manifest: CampaignManifest,
  briefIds: readonly string[],
): { readonly allocations: readonly CampaignFundingAllocation[]; readonly host: ActiveOwnerReviewHost } {
  if (new Set(briefIds).size !== briefIds.length) throw new Error('OWNER_REVIEW_BRIEF_DUPLICATE');
  const reviewAllocations: CampaignFundingAllocation[] = [];
  for (const briefId of briefIds) {
    const brief = manifest.briefs.find((item) => item.id === briefId);
    if (!brief) throw new Error('OWNER_REVIEW_BRIEF_OUTSIDE_MANIFEST');
    for (const slot of brief.candidateSlots) {
      const allocations = (['specialist', 'holistic'] as const).map((role) => {
        const stageId = `${role}-review-${briefId}-${slot.id}`;
        const matches = admission.fundingReservation.subject.allocations
          .filter((allocation) => allocation.stageId === stageId);
        if (matches.length < 1) {
          throw new Error(`OWNER_REVIEW_STAGE_MISSING:${stageId}`);
        }
        const allocation = matches[0]!;
        if (allocation.providerCalls < 1 || allocation.inputTokens <= 0 || allocation.outputTokens <= 0)
          throw new Error(`OWNER_REVIEW_STAGE_UNFUNDED:${stageId}`);
        reviewAllocations.push(allocation);
        return allocation;
      });
      for (const field of ['provider', 'model', 'effort'] as const) {
        if (allocations[0]!.identity[field] === allocations[1]!.identity[field])
          throw new Error(`OWNER_REVIEW_STAGE_IDENTITY_OVERLAP:${field}`);
      }
      for (const field of ['routeDigest', 'logicalAttemptId'] as const) {
        if (allocations[0]![field] === allocations[1]![field])
          throw new Error(`OWNER_REVIEW_STAGE_IDENTITY_OVERLAP:${field}`);
      }
      for (const field of ['seatId', 'seatDigest', 'surface'] as const) {
        const values = allocations.map((item) => field === 'surface' ? item.surface : item.seat[field]);
        if (values[0] === values[1]) throw new Error(`OWNER_REVIEW_STAGE_IDENTITY_OVERLAP:${field}`);
      }
    }
  }
  for (const allocation of reviewAllocations) assertReviewerAllocation(admission, allocation);
  if (new Set(reviewAllocations.map((item) => item.allocationId)).size !== reviewAllocations.length
    || new Set(reviewAllocations.map((item) => item.logicalAttemptId)).size !== reviewAllocations.length) {
    throw new Error('OWNER_REVIEW_STAGE_CONTRIBUTION_OVERLAP');
  }
  const allocationFor = (role: 'specialist' | 'holistic') => {
    const matches = reviewAllocations.filter((item) => item.stageId.startsWith(`${role}-review-`));
    const first = matches[0];
    if (!first) throw new Error(`OWNER_REVIEW_${role.toUpperCase()}_STAGE_MISSING`);
    if (matches.some((item) => item.identity.provider !== first.identity.provider
      || item.identity.model !== first.identity.model || item.identity.effort !== first.identity.effort
      || item.routeDigest !== first.routeDigest || item.seat.seatDigest !== first.seat.seatDigest
      || item.seat.seatId !== first.seat.seatId || item.surface !== first.surface
      || item.funding.seatDigest !== first.funding.seatDigest))
      throw new Error(`OWNER_REVIEW_${role.toUpperCase()}_ROUTE_DRIFT`);
    return first;
  };
  const host = activeHost && activeHosts.has(activeHost) ? activeHost
    : productionHostEnabled ? Object.freeze({ specialist: productionClient(allocationFor('specialist')),
      holistic: productionClient(allocationFor('holistic')) }) : undefined;
  if (!host) throw new Error('OWNER_REVIEW_HOST_NOT_BOOTSTRAPPED');
  return Object.freeze({ allocations: Object.freeze(reviewAllocations), host });
}

/** Fail closed on every reviewer route, identity, surface, and credential before generation spend. */
export function preflightOwnerReviewAllocations(
  admission: CampaignRunAdmission,
  manifest: CampaignManifest,
  briefIds: readonly string[],
): void {
  prepareReviewerHost(admission, manifest, briefIds);
}

/** One concrete provider-bound lifecycle used by both product surfaces. */
export async function runOwnerReviewLifecycle(
  surface: 'studio' | 'cli', service: CampaignService, admission: CampaignRunAdmission,
  input: OwnerReviewLifecycleInput, lease: OwnerReviewScopeLease,
): Promise<OwnerReviewLifecycleResult> {
  assertOwnerReviewScopeLease(lease, service, admission, input);
  service.assertSettledOwnerReviewInput(admission, input);
  const brief = input.campaign.manifest.briefs.find((item) => item.id === input.briefId);
  if (!brief) throw new Error('OWNER_REVIEW_BRIEF_OUTSIDE_MANIFEST');
  const { host } = prepareReviewerHost(admission, input.campaign.manifest, [input.briefId]);
  const hostAttestationVerifier: ReviewerAttestationVerifier =
    createExecutorReviewerAttestationVerifier((completion, role) =>
      host[role].verifyPersistedExecutorCompletion(completion));
  const packet = await createOwnerReviewPacket(input.session, input.captureAuthority, {
    campaign: input.campaign, admission: input.admission,
    briefId: input.briefId, evidence: input.evidence,
  });
  const envelope = input.envelopeAuthority.seal({
    campaignRunId: input.campaign.manifest.campaignRunId,
    manifestDigest: input.campaign.manifest.manifestDigest,
    briefId: input.briefId,
    blindPacketDigest: input.session.packet.packetDigest,
    packetDigest: packet.packetDigest,
  });
  const reviews: CreativeQualityReviewInput[] = [];
  for (const candidate of packet.candidates) {
    const reviewPacket = reviewerPacketProjection(packet, candidate.blindId);
    const binding = resolveCampaignBlindCandidateBinding(input.session, input.session.packet.candidates
      .find((item) => item.blindId === candidate.blindId)!);
    const sourceCapture = candidate.evidence.find((item) => item.evidenceClass === 'source');
    const slots = brief.candidateSlots.filter((slot) => slot.id === binding.candidateId
      && slot.ownerEvidence.candidateId === binding.candidateId
      && slot.ownerEvidence.slotDigest === binding.slotDigest
      && sourceCapture?.briefSlot.slotId === binding.candidateId
      && sourceCapture.briefSlot.sourceDigest === binding.sourceDigest
      && sourceCapture.briefSlot.artifactDigest === binding.artifactDigest
      && slot.ownerEvidence.briefId === input.briefId
      && binding.manifestDigest === input.campaign.manifest.manifestDigest);
    if (slots.length !== 1) throw new Error('OWNER_REVIEW_STAGE_SLOT_BINDING_AMBIGUOUS');
    const slot = slots[0]!;
    for (const role of ['specialist', 'holistic'] as const) {
      const stageId = `${role}-review-${input.briefId}-${slot.id}`;
      const client = host[role];
      const response = await service.runStageTransport(admission, stageId, 'product-review', () => client.generate(
        ownerReviewerSystemPrompt(role),
        JSON.stringify({ evidencePacket: reviewPacket, blindId: candidate.blindId }),
      ));
      const refs = response.executorAttestations ?? [];
      const lastSuccess = [...refs].reverse().find(r => r.outcome === 'success');
      if (!response.success || !lastSuccess)
        throw new Error('OWNER_REVIEW_EXACT_COMPLETION_MISSING');
      const exact = exactCompletion(client, lastSuccess.attestationDigest);
      reviews.push(parseReview(response.code, {
        blindId: candidate.blindId, packetDigest: packet.packetDigest,
        evidenceRootDigest: candidate.evidenceRootDigest, attestation: hostAttestation(role, exact),
      }));
    }
  }
  const bundle = sealOwnerQualityReview({
    session: input.session, packet, envelope,
    envelopeAuthority: input.envelopeAuthority, captureAuthority: input.captureAuthority,
    attestationVerifier: hostAttestationVerifier,
    evidenceJudgments: input.evidenceJudgments, reviews,
  });
  const published = await publishOwnerReviewPacket(envelope, input.envelopeAuthority, packet, input.store);
  const handle = await renderOwnerReviewPacket(packet, envelope, input.envelopeAuthority, input.renderer);
  const closureContext = Object.freeze({}) as OwnerReviewClosureContext;
  OWNER_REVIEW_CLOSURE_CONTEXTS.set(closureContext, Object.freeze({
    briefId: input.briefId, packetDigest: published.packet.packetDigest, envelope, store: input.store,
  }));
  return Object.freeze({ surface, packet: published.packet, bundle, handle, created: published.created,
    closureContext });
}

export const runCliOwnerReview = (service: CampaignService, admission: CampaignRunAdmission,
  input: OwnerReviewLifecycleInput) => service.runOwnerReview('cli', admission, input);
export const runStudioOwnerReview = (service: CampaignService, admission: CampaignRunAdmission,
  input: OwnerReviewLifecycleInput) => service.runOwnerReview('studio', admission, input);
