/**
 * Extracted from TuiBridgeService.ts: governed campaign continuation and owner decision closure.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import type { ArtistReviewState } from '../../creative-run/ArtistReviewExperience.js';
import { exportCampaignTransferTargetSeal, restoreCampaignTransferTarget } from '../../creative-run/CampaignContinuation.js';
import type { CampaignExecutionPlan, CampaignManifest } from '../../creative-run/CampaignManifest.js';
import { CampaignService, type CampaignTransferTarget } from '../../creative-run/CampaignService.js';
import type { CampaignEvidenceCheckpoint } from '../../creative-run/CreativeRunCoordinator.js';
import type { CampaignRunAdmission } from '../../creative-run/CreativeRunCoordinatorBase.js';
import { type OwnerReviewLifecycleResult, resolveOwnerReviewClosureContext } from '../../creative-run/OwnerReviewLifecycle.js';
import { continueCampaignStudioJourney } from '../CampaignStudio.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import { createHash } from 'node:crypto';

/** Host-only governed handoff; each result must carry a real sealed owner-review context. */
export function registerGovernedOwnerReviewResults(host: TuiBridgeService, admission: CampaignRunAdmission, manifest: CampaignManifest, reviews: readonly OwnerReviewLifecycleResult[], alreadyClosed = false): void {
    const expected = manifest.briefs.map((brief) => brief.id);
    if (reviews.length !== expected.length
      || new Set(reviews.map((review) => review.packet.briefId)).size !== expected.length
      || expected.some((briefId) => !reviews.some((review) => review.packet.briefId === briefId))) {
      throw new Error('GOVERNED_OWNER_CLOSURE_REVIEW_COVERAGE_INVALID');
    }
    for (const review of reviews) {
      const context = resolveOwnerReviewClosureContext(review.closureContext);
      if (context.briefId !== review.packet.briefId || context.packetDigest !== review.packet.packetDigest) {
        throw new Error('GOVERNED_OWNER_CLOSURE_REVIEW_PROVENANCE_INVALID');
      }
    }
    const existing = host.governedOwnerClosures.get(manifest.campaignRunId);
    if (existing && (existing.admission !== admission || existing.manifest !== manifest)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_IMMUTABLE');
    }
    host.governedOwnerClosures.set(manifest.campaignRunId, {
      admission, manifest, reviews: new Map(reviews.map((review) => [review.packet.briefId, review])),
      completedBriefIds: new Set(alreadyClosed ? expected : []),
    });
  }

/** Host-only registration seam. Private target bytes are persisted but never returned. */
export async function registerGovernedCampaignContinuationForHost(host: TuiBridgeService, input: {
    readonly sessionId: string;
    readonly ownerCredential: string;
    readonly manifest: CampaignManifest;
    readonly plan: CampaignExecutionPlan;
    readonly checkpoint: CampaignEvidenceCheckpoint;
    readonly learningEvidenceId: string;
    readonly target: CampaignTransferTarget;
  }): Promise<void> {
    if (!host.governedContinuations) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_PERSISTENCE_REQUIRED');
    }
    host.getStatus(input.sessionId);
    const owner = host.resolveHostActor(input.sessionId, input.ownerCredential, 'owner');
    if (owner.principalId !== input.manifest.owner.authorityId) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_OWNER_MISMATCH');
    }
    await host.persistGovernedCampaignContinuation({ manifest: input.manifest, plan: input.plan,
      checkpoint: input.checkpoint, learningEvidenceId: input.learningEvidenceId,
      target: input.target, ownerPrincipalId: owner.principalId });
  }

export async function persistGovernedCampaignContinuation(host: TuiBridgeService, input: {
    readonly manifest: CampaignManifest;
    readonly plan: CampaignExecutionPlan;
    readonly checkpoint: CampaignEvidenceCheckpoint;
    readonly learningEvidenceId: string;
    readonly ownerPrincipalId: string;
    readonly target: CampaignTransferTarget;
  }): Promise<void> {
    if (!host.governedContinuations) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_PERSISTENCE_REQUIRED');
    }
    await host.governedContinuations.register({ manifest: input.manifest, plan: input.plan,
      checkpoint: input.checkpoint, learningEvidenceId: input.learningEvidenceId,
      ownerPrincipalId: input.ownerPrincipalId,
      targetSeal: exportCampaignTransferTargetSeal(input.target) });
  }

/** Authenticated product surface for the exact server-registered continuation. */
export async function continueGovernedCampaign(host: TuiBridgeService, sessionId: string, ownerCredential: string, campaignRunId: string) {
    host.getStatus(sessionId);
    const owner = host.resolveHostActor(sessionId, ownerCredential, 'owner');
    if (!host.governedContinuations) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_MISSING');
    }
    const context = await host.governedContinuations.resolve(campaignRunId);
    if (owner.principalId !== context.ownerPrincipalId
      || owner.principalId !== context.ownerAuthorityId) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_OWNER_MISMATCH');
    }
    if (!host.campaignDreamGovernance) {
      throw new Error('GOVERNED_STUDIO_CAMPAIGN_DREAM_CONTEXT_REQUIRED');
    }
    const admission = await host.campaignService.startCampaign({ entryPoint: 'studio-layers',
      requestKey: context.campaignRunId }, context.manifest, context.plan);
    if (admission.creativeRun.rootRunId !== context.rootRunId
      || admission.manifestDigest !== context.manifestDigest
      || admission.planDigest !== context.planDigest
      || admission.fundingReservation.reservationDigest !== context.fundingReservationDigest) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_INVALID');
    }
    const target = restoreCampaignTransferTarget(context.manifest, context.targetSeal);
    return continueCampaignStudioJourney(host.campaignService, admission,
      context.manifest, context.checkpoint, context.learningEvidenceId, target,
      host.campaignDreamQueue, host.creativeRunCoordinator, host.campaignDreamGovernance);
  }

/**
 * Finish one registered governed brief after its real host-authenticated
 * two-artifact revision-comparison actions.
 */
export async function finalizeGovernedCampaignOwnerDecision(host: TuiBridgeService, sessionId: string, ownerCredential: string, input: { readonly campaignRunId: string; readonly briefId: string }): Promise<Readonly<{ readonly closed: boolean;
    readonly record: Awaited<ReturnType<CampaignService['recordRevisionClosure']>>;
    readonly closure?: Awaited<ReturnType<CampaignService['closeCampaignClosure']>> }>> {
    host.getStatus(sessionId);
    host.resolveHostActor(sessionId, ownerCredential, 'owner');
    const artist = host.authenticArtistReviews.get(sessionId);
    const governed = host.governedOwnerClosures.get(input.campaignRunId);
    const registered = host.governedRevisionDecisionSessions
      .get(input.campaignRunId)?.get(input.briefId);
    if (!artist || !governed || !governed.reviews.has(input.briefId)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
    }
    if (!registered || registered.sessionId !== sessionId) {
      throw new Error('GOVERNED_OWNER_CLOSURE_SESSION_BINDING_INVALID');
    }
    const originalReview = governed.reviews.get(input.briefId)!;
    const record = await host.campaignService.finalizeOwnerDecisionClosure(
      governed.admission, governed.manifest, {
        briefId: input.briefId, revisionEvidenceId: registered.revisionEvidenceId,
        ownerDecisionEvidenceId: registered.ownerDecisionEvidenceId, checkpoint: artist.closureCheckpoint(),
        originalOwnerReview: originalReview.closureContext,
      },
    );
    governed.completedBriefIds.add(input.briefId);
    const complete = governed.completedBriefIds.size === governed.manifest.briefs.length;
    const closure = complete
      ? await host.campaignService.closeCampaignClosure(governed.admission, governed.manifest) : undefined;
    return Object.freeze({ closed: complete, record, ...(closure ? { closure } : {}) });
  }

/**
 * Start the real two-artifact owner comparison from the host-sealed
 * attributable revision input. Transport callers name an evidence ID only;
 * this bridge resolves the opaque live witness and keeps the resulting
 * ArtistReviewSession entirely server-side.
 */
export async function startGovernedCampaignOwnerDecisionComparison(host: TuiBridgeService, sessionId: string, ownerCredential: string, input: { readonly campaignRunId: string; readonly briefId: string;
      readonly revisionEvidenceId: string }): Promise<ArtistReviewState> {
    host.getStatus(sessionId);
    host.resolveHostActor(sessionId, ownerCredential, 'owner');
    const governed = host.governedOwnerClosures.get(input.campaignRunId);
    if (!governed || !governed.reviews.has(input.briefId)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
    }
    const existing = host.governedRevisionDecisionSessions
      .get(input.campaignRunId)?.get(input.briefId);
    if (existing && existing.sessionId !== sessionId) {
      throw new Error('GOVERNED_OWNER_CLOSURE_SESSION_IMMUTABLE');
    }
    const existingReview = host.authenticArtistReviews.get(sessionId);
    if (existing || existingReview) {
      if (!existing || existing.revisionEvidenceId !== input.revisionEvidenceId || !existingReview) {
        throw new Error('GOVERNED_OWNER_CLOSURE_REVISION_IMMUTABLE');
      }
      return existingReview.state();
    }
    const revision = await host.campaignService.resolveRevisionDecisionInput(
      governed.admission, governed.manifest, {
        briefId: input.briefId, revisionEvidenceId: input.revisionEvidenceId,
      },
    );
    const artist = host.creativeRunCoordinator.createRevisionDecisionArtistReviewSession({
      sessionId, plan: revision.plan, revision: revision.revision,
      independentBlindPreference: revision.blindPreference,
    });
    const state = host.registerArtistReview(sessionId, artist);
    const ownerDecisionEvidenceId = 'owner-decision-' + createHash('sha256')
      .update(input.campaignRunId + '\u0000' + input.briefId + '\u0000' + input.revisionEvidenceId)
      .digest('hex');
    const sessions = host.governedRevisionDecisionSessions.get(input.campaignRunId) ?? new Map();
    sessions.set(input.briefId, Object.freeze({
      sessionId, revisionEvidenceId: input.revisionEvidenceId, ownerDecisionEvidenceId,
    }));
    host.authenticArtistReviews.set(sessionId, artist);
    host.governedRevisionDecisionSessions.set(input.campaignRunId, sessions);
    return state;
  }

/** @deprecated Production callers must use startGovernedCampaignOwnerDecisionComparison. */
export function registerGovernedRevisionDecisionSession(host: TuiBridgeService, sessionId: string, campaignRunId: string, briefId: string): void {
    host.getStatus(sessionId);
    if (!host.authenticArtistReviews.has(sessionId)
      || !host.governedOwnerClosures.get(campaignRunId)?.reviews.has(briefId)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
    }
    const sessions = host.governedRevisionDecisionSessions.get(campaignRunId) ?? new Map();
    const existing = sessions.get(briefId);
    if (existing && existing.sessionId !== sessionId) throw new Error('GOVERNED_OWNER_CLOSURE_SESSION_IMMUTABLE');
    if (!existing) throw new Error('GOVERNED_OWNER_CLOSURE_START_REQUIRED');
    host.governedRevisionDecisionSessions.set(campaignRunId, sessions);
  }
