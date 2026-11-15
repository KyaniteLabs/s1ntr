/**
 * Extracted from TuiBridgeService.ts: shared bridge types.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import type { ArtistReviewSessionOptions } from '../../creative-run/ArtistReviewExperience.js';
import type { OwnerAuthorityCapability } from '../../creative-run/CreativeRunCoordinator.js';
import type { BlindedComparisonJudgment, PromotionComparisonPacket, TransferPromotionDecision, TransferPromotionGateSession, TransferPromotionReceipt, TransferPromotionReviewerSink } from '../../creative-run/TransferPromotionGate.js';

export type ArtistReviewBootstrapOptions = Omit<ArtistReviewSessionOptions, 'sessionId'> & {
  /** Verified application capability; retained server-side and never accepted over HTTP. */
  readonly promotionReviewerCapability?: OwnerAuthorityCapability;
  /** Test/no-browser host policy; the HTTP client cannot set it. */
  readonly promotionRenderGate?: boolean;
};

export interface ArtistReviewBootstrapGrant {
  readonly options: Omit<ArtistReviewSessionOptions, 'sessionId'>;
  readonly promotionReviewerCapability?: OwnerAuthorityCapability;
  readonly promotionRenderGate?: boolean;
  readonly expiresAt: number;
}

export interface TransferPromotionWorkflowState {
  readonly status: 'review-open' | 'awaiting-reviewer' | 'awaiting-owner'
    | 'preferred' | 'rejected' | 'promoted' | 'terminal';
  readonly runId: string;
  readonly packet: PromotionComparisonPacket;
  readonly decision?: TransferPromotionDecision;
  readonly receipt?: TransferPromotionReceipt;
}

export interface TransferPromotionWorkflow {
  readonly runId: string;
  readonly gate: TransferPromotionGateSession;
  readonly reviewerSink: TransferPromotionReviewerSink;
  readonly reviewerCapability: OwnerAuthorityCapability;
  readonly ownerCapability: OwnerAuthorityCapability;
  readonly issuerCapability: OwnerAuthorityCapability;
  reviewerJudgment?: BlindedComparisonJudgment;
  ownerJudgment?: { readonly preferredArtifact: 'treatment' | 'control'; readonly claim: string };
  decision?: TransferPromotionDecision;
  receipt?: TransferPromotionReceipt;
}

export type TransferPromotionCheckpointKind = 'reviewer' | 'owner' | 'promote';

export interface AuthenticatedBridgeActor {
  readonly principalId: string;
  readonly role: 'owner' | 'issuer' | 'reviewer';
  readonly capability: OwnerAuthorityCapability;
}

/** Production adapter to the host application's authenticated session registry. */
export interface BridgeHostAuthorityRegistry {
  resolveActor(input: {
    readonly sessionId: string;
    readonly credential: string;
  }): AuthenticatedBridgeActor | undefined;
}

export interface IssuedBridgeActionCheckpoint {
  readonly token: string;
  readonly expiresAt: string;
}
