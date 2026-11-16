import type {
  CreativeRunRequest, CampaignRunAdmission, CoordinatedCampaignResult,
} from '../creative-run/CreativeRunCoordinatorBase.js';
import { CreativeRunCoordinator, type CreativeRunCoordinatorOptions } from '../creative-run/CreativeRunCoordinator.js';
import type { CampaignExecutionPlan, CampaignManifest } from '../creative-run/CampaignManifest.js';
import type { CampaignActualCandidateManifest } from '../creative-run/CandidateHypothesisProduction.js';
import {
  CampaignService, type CampaignExecutionInputV1, type CampaignProjection,
  type CampaignOwnerDecisionFinalizationInput, type CampaignRevisionClosureInput,
  type CampaignContinuationProjection, type CampaignTransferTarget,
} from '../creative-run/CampaignService.js';
import type { CampaignClosureReceipt } from '../creative-run/CampaignClosure.js';
import type { CampaignClosureEvidenceAuthority } from '../creative-run/CampaignClosure.js';
import type { CampaignLedgerPersistence } from '../creative-run/CampaignPersistence.js';
import type { CampaignFundingReservationAuthority } from '../creative-run/CampaignExecutionAuthority.js';
import type { CampaignOriginReceiptVerifier } from '../creative-run/CampaignProgressJournal.js';
import type { CampaignTransferEvaluator } from '../creative-run/CampaignContinuation.js';
import {
  bootstrapProductionOwnerReviewHost, type OwnerReviewLifecycleInput, type OwnerReviewLifecycleResult,
} from '../creative-run/OwnerReviewLifecycle.js';
import type { DreamQueue } from '../dreaming/DreamQueue.js';
import type { DreamAssimilationGovernance, DreamAssimilationRunner } from '../dreaming/DreamTaskRunner.js';
import type { CampaignEvidenceCheckpoint } from '../creative-run/CreativeRunCoordinatorBase.js';
import { ensureWave8LivePreSpendInterlockConfigured } from '../llm/PreSpendInterlock.js';
import { createGLMCodingPlanAdapterRegistry } from '../llm/GLMCodingPlanHostAdapter.js';

export function installCampaignLiveAuthority(): void {
  const configPath = process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
  const trustPath = process.env.SINTER_WAVE8_LIVE_TRUST_STORE;
  const adapters = configPath ? createGLMCodingPlanAdapterRegistry(configPath) : undefined;
  ensureWave8LivePreSpendInterlockConfigured(configPath, trustPath, adapters);
}

export interface CampaignOwnerDecisionCliInput {
  readonly bridgeUrl: string;
  readonly ownerCredential: string;
  readonly sessionId: string;
  readonly campaignRunId: string;
  readonly briefId: string;
}

export interface CampaignOwnerDecisionStartCliInput {
  readonly bridgeUrl: string;
  readonly ownerCredential: string;
  readonly sessionId: string;
  readonly campaignRunId: string;
  readonly briefId: string;
  readonly revisionEvidenceId: string;
}

export interface CampaignContinuationCliInput {
  readonly bridgeUrl: string;
  readonly ownerCredential: string;
  readonly sessionId: string;
  readonly campaignRunId: string;
}

type CampaignOwnerDecisionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function campaignContinuationEndpoint(input: CampaignContinuationCliInput): URL {
  let bridge: URL;
  try { bridge = new URL(input.bridgeUrl); } catch {
    throw new Error('CAMPAIGN_CONTINUATION_CLI_BRIDGE_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(bridge.protocol) || bridge.username || bridge.password) {
    throw new Error('CAMPAIGN_CONTINUATION_CLI_BRIDGE_URL_INVALID');
  }
  const base = bridge.pathname.replace(/\/$/, '');
  return new URL(base + '/api/tui/session/' + encodeURIComponent(input.sessionId)
    + '/governed-campaign/' + encodeURIComponent(input.campaignRunId) + '/continuation', bridge);
}

function campaignOwnerDecisionEndpoint(
  input: Pick<CampaignOwnerDecisionStartCliInput, 'bridgeUrl' | 'sessionId' | 'campaignRunId' | 'briefId'>,
): URL {
  let bridge: URL;
  try {
    bridge = new URL(input.bridgeUrl);
  } catch {
    throw new Error('CAMPAIGN_OWNER_DECISION_CLI_BRIDGE_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(bridge.protocol) || bridge.username || bridge.password) {
    throw new Error('CAMPAIGN_OWNER_DECISION_CLI_BRIDGE_URL_INVALID');
  }
  const base = bridge.pathname.replace(/\/$/, '');
  return new URL(base + '/api/tui/session/' + encodeURIComponent(input.sessionId)
    + '/governed-campaign/' + encodeURIComponent(input.campaignRunId)
    + '/owner-decisions/' + encodeURIComponent(input.briefId), bridge);
}

async function parseCampaignOwnerDecisionResponse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => undefined) as { readonly error?: unknown } | undefined;
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : 'CAMPAIGN_OWNER_DECISION_CLI_REQUEST_FAILED');
  }
  return body;
}

/** Start the server-owned authentic comparison before any owner action is issued. */
export async function runCampaignCliOwnerDecisionStart(
  input: CampaignOwnerDecisionStartCliInput,
  fetchImpl: CampaignOwnerDecisionFetch = fetch,
): Promise<unknown> {
  const required = [input.ownerCredential, input.sessionId, input.campaignRunId, input.briefId,
    input.revisionEvidenceId];
  if (required.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('CAMPAIGN_OWNER_DECISION_CLI_INPUT_INVALID');
  }
  const endpoint = campaignOwnerDecisionEndpoint(input);
  endpoint.pathname += '/comparison';
  return parseCampaignOwnerDecisionResponse(await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + input.ownerCredential, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revisionEvidenceId: input.revisionEvidenceId }),
  }));
}

/**
 * Actual CLI transport for the same host-authenticated Studio finalizer.
 * It deliberately owns no closure logic: the bridge remains the only place
 * that resolves campaign/session bindings and seals the owner decision.
 */
export async function runCampaignCliOwnerDecision(
  input: CampaignOwnerDecisionCliInput,
  fetchImpl: CampaignOwnerDecisionFetch = fetch,
): Promise<unknown> {
  const required = [input.ownerCredential, input.sessionId, input.campaignRunId, input.briefId];
  if (required.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('CAMPAIGN_OWNER_DECISION_CLI_INPUT_INVALID');
  }
  const endpoint = campaignOwnerDecisionEndpoint(input);
  return parseCampaignOwnerDecisionResponse(await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + input.ownerCredential, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }));
}

/** Actual CLI transport; all target, learning, Dream, and origin state remains server-owned. */
export async function runCampaignCliContinuation(
  input: CampaignContinuationCliInput,
  fetchImpl: CampaignOwnerDecisionFetch = fetch,
): Promise<unknown> {
  const required = [input.ownerCredential, input.sessionId, input.campaignRunId];
  if (required.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('CAMPAIGN_CONTINUATION_CLI_INPUT_INVALID');
  }
  const response = await fetchImpl(campaignContinuationEndpoint(input), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + input.ownerCredential,
      'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return parseCampaignOwnerDecisionResponse(response);
}

/**
 * Production CLI composition keeps owner authentication and closure evidence
 * at the host boundary; CLI request payloads never receive these capabilities.
 */
export function createCampaignCliService(options: {
  readonly coordinatorOptions: CreativeRunCoordinatorOptions;
  readonly fundingAuthority?: CampaignFundingReservationAuthority;
  readonly closureEvidenceAuthority?: CampaignClosureEvidenceAuthority;
  readonly closurePersistence?: CampaignLedgerPersistence;
  readonly progressPersistence?: CampaignLedgerPersistence;
  readonly originVerifier?: CampaignOriginReceiptVerifier;
  readonly transferEvaluator?: CampaignTransferEvaluator;
}): CampaignService {
  const coordinator = new CreativeRunCoordinator(options.coordinatorOptions);
  return CampaignService.shared(coordinator, {
    fundingAuthority: options.fundingAuthority,
    closureEvidenceAuthority: options.closureEvidenceAuthority,
    closurePersistence: options.closurePersistence,
    progressPersistence: options.progressPersistence,
    originVerifier: options.originVerifier,
    transferEvaluator: options.transferEvaluator,
  });
}

/** Dry, inspectable CLI journey over the same campaign service used by Studio. */
export async function runCampaignCliJourney(
  service: CampaignService,
  request: CreativeRunRequest,
  manifest: CampaignManifest,
  plan: CampaignExecutionPlan,
  governed?: {
    readonly input: CampaignExecutionInputV1;
    readonly ownerReviewBriefIds: readonly string[];
    readonly ownerReviews: (
      admission: CampaignRunAdmission,
      manifests: readonly CampaignActualCandidateManifest[],
    ) => Promise<readonly OwnerReviewLifecycleInput[]> | readonly OwnerReviewLifecycleInput[];
    /** Called after host-authenticated owner actions create opaque checkpoints. */
    readonly ownerDecisionClosures?: (input: {
      readonly admission: CampaignRunAdmission;
      readonly manifest: CampaignManifest;
      readonly reviews: readonly OwnerReviewLifecycleResult[];
    }) => Promise<readonly CampaignOwnerDecisionFinalizationInput[]> | readonly CampaignOwnerDecisionFinalizationInput[];
  },
  installLiveAuthority: () => void = installCampaignLiveAuthority,
): Promise<{ readonly admission: CampaignRunAdmission; readonly projection: CampaignProjection;
  readonly result?: CoordinatedCampaignResult; readonly ownerReviews?: readonly OwnerReviewLifecycleResult[];
  readonly closure?: CampaignClosureReceipt }> {
  if (request.entryPoint !== 'cli-compose') throw new Error('Campaign CLI requires the cli-compose entry point');
  if (governed) installLiveAuthority();
  if (governed) service.assertGovernedInput(manifest, plan, governed.input);
  if (governed) service.assertOwnerReviewBriefCoverage(manifest, governed.ownerReviewBriefIds);
  if (governed && process.env.NODE_ENV !== 'test') bootstrapProductionOwnerReviewHost();
  const admission = await service.startCampaign(request, manifest, plan);
  if (!governed) return Object.freeze({ admission, projection: service.project(admission) });
  try {
    service.preflightOwnerReview(admission, manifest, manifest.briefs.map((brief) => brief.id));
    let ownerReviews: readonly OwnerReviewLifecycleResult[] | undefined;
    const result = await service.runGovernedCampaign(admission, manifest, governed.input,
      { ...request, entryPoint: 'cli-compose', requestKey: admission.creativeRun.requestKey },
      async (actual) => {
        const inputs = await governed.ownerReviews(admission, actual);
        service.assertOwnerReviewCoverage(manifest, inputs);
        const completed: OwnerReviewLifecycleResult[] = [];
        for (const input of inputs) completed.push(await service.runOwnerReview('cli', admission, input));
        ownerReviews = Object.freeze(completed);
        return ownerReviews.map((review, index) => Object.freeze({ briefId: inputs[index]!.briefId,
          packetDigest: review.packet.packetDigest, reviewBundleDigest: review.bundle.reviewDigest }));
      });
    if (!ownerReviews) throw new Error('OWNER_REVIEW_DEPENDENT_EVIDENCE_MISSING');
    const decisions = governed.ownerDecisionClosures
      ? await governed.ownerDecisionClosures({ admission, manifest, reviews: ownerReviews }) : undefined;
    const closure = decisions
      ? await service.finalizeGovernedOwnerDecisionClosures(admission, manifest, decisions) : undefined;
    return Object.freeze({ admission, projection: service.project(admission), result,
      ownerReviews, ...(closure ? { closure } : {}) });
  } catch (error) {
    await service.releaseUnusedFunding(admission).catch(() => undefined);
    throw error;
  }
}

/**
 * Run the shared owner-review lifecycle from the CLI surface. The admission
 * binds the owner-review to the exact host-funded campaign reservation; the
 * opaque `OwnerReviewAdmission` is the only trust anchor and external callers
 * cannot forge it.
 */
export async function runCampaignCliOwnerReview(
  service: CampaignService,
  admission: CampaignRunAdmission,
  input: OwnerReviewLifecycleInput,
): Promise<OwnerReviewLifecycleResult> {
  if (process.env.NODE_ENV !== 'test') bootstrapProductionOwnerReviewHost();
  return service.runOwnerReview('cli', admission, input);
}

/** CLI writes the same closure record as Studio; no surface-local release truth. */
export function recordCampaignCliRevisionClosure(
  service: CampaignService,
  admission: CampaignRunAdmission,
  manifest: CampaignManifest,
  input: CampaignRevisionClosureInput,
) {
  return service.recordRevisionClosure(admission, manifest, input);
}

export function closeCampaignCliClosure(
  service: CampaignService,
  admission: CampaignRunAdmission,
  manifest: CampaignManifest,
): Promise<CampaignClosureReceipt> {
  return service.closeCampaignClosure(admission, manifest);
}

/** CLI projection delegates the complete continuation to the shared service. */
export function continueCampaignCliJourney(
  service: CampaignService, admission: CampaignRunAdmission, manifest: CampaignManifest,
  checkpoint: CampaignEvidenceCheckpoint, learningEvidenceId: string,
  target: CampaignTransferTarget, queue: DreamQueue,
  runner: DreamAssimilationRunner,
  governance: Omit<DreamAssimilationGovernance, 'campaignDreamAdmission'>,
): Promise<CampaignContinuationProjection> {
  return service.continueGovernedCampaign(
    admission, manifest, checkpoint, learningEvidenceId, target, queue, runner, governance,
  );
}
