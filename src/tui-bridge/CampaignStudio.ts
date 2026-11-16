import type {
  CampaignRunAdmission, CoordinatedCampaignResult, CreativeRunRequest,
} from '../creative-run/CreativeRunCoordinatorBase.js';
import type { CampaignExecutionPlan, CampaignManifest } from '../creative-run/CampaignManifest.js';
import type { CampaignActualCandidateManifest } from '../creative-run/CandidateHypothesisProduction.js';
import {
  CampaignService, type CampaignProjection, type CampaignRevisionClosureInput,
  type CampaignOwnerDecisionFinalizationInput,
  type CampaignContinuationProjection, type CampaignTransferTarget,
} from '../creative-run/CampaignService.js';
import type { CampaignClosureReceipt } from '../creative-run/CampaignClosure.js';
import { bootstrapProductionOwnerReviewHost, type OwnerReviewLifecycleInput, type OwnerReviewLifecycleResult } from '../creative-run/OwnerReviewLifecycle.js';
import type { CampaignEvidenceCheckpoint } from '../creative-run/CreativeRunCoordinatorBase.js';
import type { DreamQueue } from '../dreaming/DreamQueue.js';
import type { DreamAssimilationGovernance, DreamAssimilationRunner } from '../dreaming/DreamTaskRunner.js';
import { ensureWave8LivePreSpendInterlockConfigured } from '../llm/PreSpendInterlock.js';

/** Studio projection for an admitted campaign; no parallel Studio-only truth. */
export function runCampaignStudioJourney(
  service: CampaignService,
  admission: CampaignRunAdmission,
): { readonly admission: CampaignRunAdmission; readonly projection: CampaignProjection } {
  return Object.freeze({ admission, projection: service.project(admission) });
}

export async function runGovernedCampaignStudioJourney(
  service: CampaignService, request: CreativeRunRequest, manifest: CampaignManifest,
  plan: CampaignExecutionPlan, governed: {
    readonly input: Parameters<CampaignService['assertGovernedInput']>[2];
    readonly ownerReviewBriefIds: readonly string[];
    readonly ownerReviews: (admission: CampaignRunAdmission,
      manifests: readonly CampaignActualCandidateManifest[]) =>
      Promise<readonly OwnerReviewLifecycleInput[]> | readonly OwnerReviewLifecycleInput[];
    /** Host-authenticated terminal actions, resolved after owner review publication. */
    readonly ownerDecisionClosures?: (input: {
      readonly admission: CampaignRunAdmission;
      readonly manifest: CampaignManifest;
      readonly reviews: readonly OwnerReviewLifecycleResult[];
    }) => Promise<readonly CampaignOwnerDecisionFinalizationInput[]> | readonly CampaignOwnerDecisionFinalizationInput[];
  },
  installLiveAuthority: () => void = ensureWave8LivePreSpendInterlockConfigured,
): Promise<{ readonly admission: CampaignRunAdmission; readonly projection: CampaignProjection;
  readonly result: CoordinatedCampaignResult; readonly ownerReviews: readonly OwnerReviewLifecycleResult[];
  readonly closure?: CampaignClosureReceipt }> {
  if (request.entryPoint !== 'studio-layers') throw new Error('Campaign Studio requires studio-layers');
  installLiveAuthority();
  service.assertGovernedInput(manifest, plan, governed.input);
  service.assertOwnerReviewBriefCoverage(manifest, governed.ownerReviewBriefIds);
  if (process.env.NODE_ENV !== 'test') bootstrapProductionOwnerReviewHost();
  const admission = await service.startCampaign(request, manifest, plan);
  service.preflightOwnerReview(admission, manifest, manifest.briefs.map((brief) => brief.id));
  let ownerReviews: readonly OwnerReviewLifecycleResult[] | undefined;
  const result = await service.runGovernedCampaign(admission, manifest, governed.input,
    { ...request, entryPoint: 'studio-layers', requestKey: admission.creativeRun.requestKey },
    async (actual) => {
      const inputs = await governed.ownerReviews(admission, actual);
      service.assertOwnerReviewCoverage(manifest, inputs);
      const completed: OwnerReviewLifecycleResult[] = [];
      for (const input of inputs) completed.push(await service.runOwnerReview('studio', admission, input));
      ownerReviews = Object.freeze(completed);
      return ownerReviews.map((review, index) => Object.freeze({ briefId: inputs[index]!.briefId,
        packetDigest: review.packet.packetDigest,
        reviewBundleDigest: review.bundle.reviewDigest }));
    });
  if (!ownerReviews) throw new Error('OWNER_REVIEW_DEPENDENT_EVIDENCE_MISSING');
  const decisions = governed.ownerDecisionClosures
    ? await governed.ownerDecisionClosures({ admission, manifest, reviews: ownerReviews }) : undefined;
  const closure = decisions
    ? await service.finalizeGovernedOwnerDecisionClosures(admission, manifest, decisions) : undefined;
  return Object.freeze({ admission, projection: service.project(admission), result,
    ownerReviews, ...(closure ? { closure } : {}) });
}

/**
 * Run the shared owner-review lifecycle from the Studio surface. The admission
 * binds the owner-review to the exact host-funded campaign reservation; the
 * opaque `OwnerReviewAdmission` is the only trust anchor and external callers
 * cannot forge it.
 */
export async function runCampaignStudioOwnerReview(
  service: CampaignService,
  admission: CampaignRunAdmission,
  input: OwnerReviewLifecycleInput,
): Promise<OwnerReviewLifecycleResult> {
  if (process.env.NODE_ENV !== 'test') bootstrapProductionOwnerReviewHost();
  return service.runOwnerReview('studio', admission, input);
}

/** Studio delegates campaign closure to the identical shared service boundary. */
export function recordCampaignStudioRevisionClosure(
  service: CampaignService,
  admission: CampaignRunAdmission,
  manifest: CampaignManifest,
  input: CampaignRevisionClosureInput,
) {
  return service.recordRevisionClosure(admission, manifest, input);
}

export function closeCampaignStudioClosure(
  service: CampaignService,
  admission: CampaignRunAdmission,
  manifest: CampaignManifest,
): Promise<CampaignClosureReceipt> {
  return service.closeCampaignClosure(admission, manifest);
}

/** Studio uses the identical shared continuation projection as CLI. */
export function continueCampaignStudioJourney(
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
