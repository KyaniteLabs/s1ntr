/**
 * Extracted from TuiBridgeService.ts: transfer promotion workflow and its checkpoints.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { resolveArtistReviewPromotionCheckpoint } from '../../creative-run/ArtistReviewExperience.js';
import type { TransferPromotionDecision } from '../../creative-run/TransferPromotionGate.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { IssuedBridgeActionCheckpoint, TransferPromotionCheckpointKind, TransferPromotionWorkflowState } from './bridgeTypes.js';
import { ACTION_CHECKPOINT_TTL_MS } from './constants.js';
import { randomBytes } from 'node:crypto';

export async function startTransferPromotion(host: TuiBridgeService, sessionId: string, ownerCredential?: string): Promise<TransferPromotionWorkflowState> {
    host.getStatus(sessionId);
    const owner = host.resolveHostActor(sessionId, ownerCredential ?? '', 'owner');
    const existing = host.transferPromotions.get(sessionId);
    if (existing) {
      if (owner.capability !== existing.ownerCapability) {
        throw new Error('TRANSFER_PROMOTION_CHECKPOINT_AUTHORITY_INVALID');
      }
      return host.getTransferPromotionState(sessionId);
    }
    const artist = host.authenticArtistReviews.get(sessionId);
    const reviewerCapability = host.promotionReviewers.get(sessionId);
    if (!artist || !reviewerCapability) {
      throw new Error('TRANSFER_PROMOTION_AUTHENTIC_REVIEW_REQUIRED');
    }
    const checkpoint = artist.promotionCheckpoint();
    const authority = resolveArtistReviewPromotionCheckpoint(checkpoint);
    if (owner.capability !== authority.ownerCapability) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_AUTHORITY_INVALID');
    }
    const experiment = await host.creativeRunCoordinator.openTransferPromotionExperiment(
      checkpoint,
      { renderGate: host.promotionRenderGates.get(sessionId) ?? true },
    );
    const reviewerSink = experiment.gate.openReviewerSink(reviewerCapability);
    host.transferPromotions.set(sessionId, {
      runId: experiment.runId,
      gate: experiment.gate,
      reviewerSink,
      reviewerCapability,
      ownerCapability: authority.ownerCapability,
      issuerCapability: authority.issuerCapability,
    });
    return host.getTransferPromotionState(sessionId);
  }

export function issueTransferPromotionCheckpointForHost(host: TuiBridgeService, sessionId: string, kind: TransferPromotionCheckpointKind, credential: string): IssuedBridgeActionCheckpoint {
    const workflow = host.transferPromotions.get(sessionId);
    if (!workflow) throw new Error(`Transfer promotion not found for session: ${sessionId}`);
    const role = kind === 'reviewer' ? 'reviewer' : 'owner';
    const actor = host.resolveHostActor(sessionId, credential, role);
    const expected = kind === 'reviewer'
      ? workflow.reviewerCapability : workflow.ownerCapability;
    if (actor.capability !== expected) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_AUTHORITY_INVALID');
    }
    const state = host.getTransferPromotionState(sessionId);
    if ((kind === 'reviewer' && workflow.reviewerJudgment)
      || (kind === 'owner' && workflow.ownerJudgment)
      || (kind === 'promote' && (!workflow.decision
        || workflow.decision.status !== 'preferred' || workflow.receipt))) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_STATE_INVALID');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = Date.parse(host.now()) + ACTION_CHECKPOINT_TTL_MS;
    host.transferPromotionCheckpoints.set(token, Object.freeze({
      sessionId, kind, principalId: actor.principalId,
      runId: workflow.runId, state: state.status, expiresAt: expiresAtMs,
    }));
    return Object.freeze({ token, expiresAt: new Date(expiresAtMs).toISOString() });
  }

export function executeTransferPromotionCheckpoint(host: TuiBridgeService, sessionId: string, input: {
    readonly token: string;
    readonly preferredBlindId?: string;
    readonly preferredArtifact?: 'treatment' | 'control';
    readonly claim?: string;
  }, credential: string): TransferPromotionWorkflowState {
    host.getStatus(sessionId);
    const workflow = host.transferPromotions.get(sessionId);
    const checkpoint = host.transferPromotionCheckpoints.get(input.token);
    if (!workflow || !checkpoint || checkpoint.sessionId !== sessionId) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_INVALID');
    }
    host.transferPromotionCheckpoints.delete(input.token);
    if (Date.parse(host.now()) >= checkpoint.expiresAt
      || checkpoint.runId !== workflow.runId
      || checkpoint.state !== host.getTransferPromotionState(sessionId).status) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_STALE');
    }
    const role = checkpoint.kind === 'reviewer' ? 'reviewer' : 'owner';
    const actor = host.resolveHostActor(sessionId, credential, role);
    if (actor.principalId !== checkpoint.principalId) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_ACTOR_MISMATCH');
    }
    if (checkpoint.kind === 'reviewer') {
      if (workflow.reviewerJudgment || typeof input.preferredBlindId !== 'string'
        || typeof input.claim !== 'string') {
        throw new Error('TRANSFER_PROMOTION_REVIEWER_CHECKPOINT_INVALID');
      }
      workflow.reviewerJudgment = workflow.reviewerSink.submit({
        preferredBlindId: input.preferredBlindId, claim: input.claim,
      });
    } else if (checkpoint.kind === 'owner') {
      if (workflow.ownerJudgment || (input.preferredArtifact !== 'treatment'
        && input.preferredArtifact !== 'control') || typeof input.claim !== 'string'
        || !input.claim.trim()) {
        throw new Error('TRANSFER_PROMOTION_OWNER_CHECKPOINT_INVALID');
      }
      workflow.ownerJudgment = Object.freeze({
        preferredArtifact: input.preferredArtifact, claim: input.claim.trim(),
      });
    } else {
      if (!workflow.decision || workflow.receipt) {
        throw new Error('TRANSFER_PROMOTION_PROMOTE_CHECKPOINT_INVALID');
      }
      workflow.receipt = workflow.gate.promote(workflow.decision, {
        ownerCapability: workflow.ownerCapability,
        sourceCapability: workflow.issuerCapability,
      });
      return host.getTransferPromotionState(sessionId);
    }
    if (workflow.reviewerJudgment && workflow.ownerJudgment && !workflow.decision) {
      workflow.decision = workflow.gate.evaluate({
        blindedJudgment: workflow.reviewerJudgment,
        ownerCapability: workflow.ownerCapability,
        ownerJudgment: workflow.ownerJudgment,
      });
    }
    return host.getTransferPromotionState(sessionId);
  }

export function getTransferPromotionState(host: TuiBridgeService, sessionId: string): TransferPromotionWorkflowState {
    host.getStatus(sessionId);
    const workflow = host.transferPromotions.get(sessionId);
    if (!workflow) throw new Error(`Transfer promotion not found for session: ${sessionId}`);
    const status: TransferPromotionWorkflowState['status'] = workflow.receipt
      ? workflow.receipt.status === 'promoted' ? 'promoted' : 'terminal'
      : workflow.decision
        ? workflow.decision.status === 'preferred' ? 'preferred' : 'rejected'
        : workflow.reviewerJudgment && !workflow.ownerJudgment
          ? 'awaiting-owner'
          : workflow.ownerJudgment && !workflow.reviewerJudgment
            ? 'awaiting-reviewer' : 'review-open';
    return Object.freeze({
      status, runId: workflow.runId, packet: workflow.reviewerSink.packet,
      ...(workflow.decision ? { decision: workflow.decision } : {}),
      ...(workflow.receipt ? { receipt: workflow.receipt } : {}),
    });
  }

export function getTransferPromotionDecision(host: TuiBridgeService, sessionId: string): TransferPromotionDecision {
    host.getStatus(sessionId);
    const decision = host.transferPromotions.get(sessionId)?.decision;
    if (!decision) throw new Error(`Transfer promotion decision not found for session: ${sessionId}`);
    return decision;
  }
