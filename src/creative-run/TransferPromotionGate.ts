/**
 * W8-16 / Forgejo #686 — Transfer Promotion Gate.
 *
 * Interface surface only. Implementation lives in CreativeRunCoordinator.ts,
 * following the same separation as OwnerLearningAuthority.ts.
 *
 * Acceptance summary:
 * - Freeze rule, applicability, experimental scope, evidence protocol, owner
 *   authorization, and sealed unseen brief before transfer opens.
 * - Compare authorized treatment against no-learning control with blinded
 *   independent review and a separate owner review.
 * - Prefer treatment only when evidence supports it and similarity checks
 *   reject copying of palette, motif, geometry, rhythm, source, and graph
 *   topology.
 * - Transfer success remains provisional. Ordinary Creates must remain
 *   unchanged until a separate exact owner/source promotion event.
 * - Rejection or missing/invalid/replayed/cross-run promotion leaves ordinary
 *   Creates unchanged; rollback is verified.
 * - Bind all records by canonical digests and fail closed on stale,
 *   cross-artifact, copied, and replayed inputs.
 */

export const TRANSFER_PROMOTION_SCHEMA_VERSION = 1 as const;

/** Production persistence is unsupported; promotions are in-memory only. */
export const TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY
  = 'in-memory-transaction-only' as const;

export const SIMILARITY_DIMENSIONS = [
  'palette', 'motif', 'geometry', 'rhythm', 'source', 'graph-topology',
] as const;

export type SimilarityDimension = (typeof SIMILARITY_DIMENSIONS)[number];

export interface SimilarityFingerprint {
  readonly dimensions: Readonly<Record<SimilarityDimension, string>>;
  readonly fingerprintDigest: string;
}

export interface SimilarityDimensionAssessment {
  readonly dimension: SimilarityDimension;
  readonly score: number;
  readonly threshold: number;
  readonly status: 'distinct' | 'near-copy' | 'unassessable';
  readonly evidenceDigest: string;
}

export interface TransferPromotionFreeze {
  readonly schema: 'sinter.transfer-promotion-freeze';
  readonly schemaVersion: typeof TRANSFER_PROMOTION_SCHEMA_VERSION;
  readonly ruleId: string;
  readonly ruleValue: import('./AttributableRevision.js').RevisionScalar;
  readonly runId: string;
  readonly gateSessionId: string;
  readonly applicability: string;
  readonly experimentalScope: string;
  readonly evidenceProtocol: string;
  readonly ownerAuthorizationDigest: string;
  readonly sealedBriefDigest: string;
  readonly routeDigest: string;
  readonly budgetDigest: string;
  readonly treatmentCausalInputDigest: string;
  readonly controlCausalInputDigest: string;
  readonly transferReceiptDigest: string;
  readonly planDigest: string;
  readonly revisionReceiptDigest: string;
  readonly freezeDigest: string;
}

export interface PromotionComparisonCandidate {
  readonly blindId: string;
  /** Random review binding; deliberately unrelated to source or artifact hashes. */
  readonly evidenceBinding: string;
  readonly media: readonly import('./BlindReviewEvidence.js').CanonicalMediaReference[];
}

export interface PromotionComparisonPacket {
  readonly schema: 'sinter.promotion-comparison-packet';
  readonly schemaVersion: typeof TRANSFER_PROMOTION_SCHEMA_VERSION;
  readonly freezeDigest: string;
  readonly gateSessionId: string;
  readonly candidateSetDigest: string;
  readonly candidates: readonly PromotionComparisonCandidate[];
  readonly contactSheetHtml: string;
  readonly packetDigest: string;
}

export type PromotionReviewOutcome = 'treatment-preferred' | 'control-preferred' | 'inconclusive';

export interface BlindedComparisonJudgment {
  readonly schema: 'sinter.blinded-promotion-review';
  readonly reviewer: import('./CreativeRunCoordinator.js').AuthorityIdentity;
  readonly preferredBlindId: string;
  readonly packetDigest: string;
  readonly evidenceBinding: string;
  readonly claim: string;
  readonly reviewDigest: string;
}

export interface OwnerComparisonJudgment {
  readonly preferredArtifact: 'treatment' | 'control';
  readonly treatmentArtifactDigest: string;
  readonly controlArtifactDigest: string;
  readonly evidenceDigest: string;
  readonly claim: string;
}

export interface TransferPromotionComparison {
  readonly treatmentArtifactDigest: string;
  readonly controlArtifactDigest: string;
  readonly treatmentFingerprint: SimilarityFingerprint;
  readonly controlFingerprint: SimilarityFingerprint;
  readonly copiedDimensions: readonly SimilarityDimension[];
  readonly dimensionAssessments: readonly SimilarityDimensionAssessment[];
  readonly aggregateSimilarity: number;
  readonly houseStyleCollapse: boolean;
  readonly copyingDetected: boolean;
  readonly blindedReviewOutcome: PromotionReviewOutcome;
  readonly ownerReviewOutcome: PromotionReviewOutcome;
  readonly evidenceSupportsTreatment: boolean;
  readonly comparisonDigest: string;
}

export type TransferPromotionDecisionReason =
  | 'TREATMENT_PREFERRED'
  | 'COPYING_DETECTED'
  | 'EVIDENCE_INCONCLUSIVE'
  | 'EVIDENCE_REJECTED_TREATMENT'
  | 'OWNER_REJECTED_TREATMENT'
  | 'BLINDED_REVIEW_REJECTED_TREATMENT';

export interface TransferPromotionDecision {
  readonly schema: 'sinter.transfer-promotion-decision';
  readonly schemaVersion: typeof TRANSFER_PROMOTION_SCHEMA_VERSION;
  readonly status: 'preferred' | 'rejected';
  readonly reason: TransferPromotionDecisionReason;
  readonly freezeDigest: string;
  readonly comparison: TransferPromotionComparison;
  readonly persistenceBoundary: typeof TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY;
  readonly runId: string;
  readonly gateSessionId: string;
  readonly decidedAt: string;
  readonly decisionDigest: string;
}

export type TransferPromotionTerminalReason =
  | 'DECISION_PROVENANCE_INVALID' | 'DECISION_STALE'
  | 'DECISION_REJECTED' | 'PROMOTION_REPLAYED'
  | 'PROMOTION_CROSS_RUN' | 'OWNER_CAPABILITY_INVALID'
  | 'SOURCE_CAPABILITY_INVALID' | 'FREEZE_DIGEST_MISMATCH'
  | 'LEARNING_TRANSFER_FAILED';

export interface TransferPromotionReceipt {
  readonly schema: 'sinter.transfer-promotion-receipt';
  readonly schemaVersion: typeof TRANSFER_PROMOTION_SCHEMA_VERSION;
  readonly status: 'promoted' | 'terminal';
  readonly reason: 'PROMOTED' | TransferPromotionTerminalReason;
  readonly persistenceBoundary: typeof TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY;
  readonly decisionDigest: string;
  readonly freezeDigest: string;
  readonly runId: string;
  readonly gateSessionId: string;
  readonly owner: import('./CreativeRunCoordinator.js').AuthorityIdentity;
  readonly source: import('./CreativeRunCoordinator.js').AuthorityIdentity;
  readonly promotedAt: string;
  readonly learningTransfer?: import('./CreativeRunCoordinator.js').LearningTransferReceipt;
  readonly promotionDigest: string;
}

export interface TransferPromotionGateSession {
  readonly freeze: TransferPromotionFreeze;
  openReviewerSink(
    reviewerCapability: import('./CreativeRunCoordinator.js').OwnerAuthorityCapability,
  ): TransferPromotionReviewerSink;
  evaluate(input: {
    readonly blindedJudgment: BlindedComparisonJudgment;
    readonly ownerCapability: import('./CreativeRunCoordinator.js').OwnerAuthorityCapability;
    readonly ownerJudgment: Pick<OwnerComparisonJudgment, 'preferredArtifact' | 'claim'>;
  }): TransferPromotionDecision;
  latestDecision(): TransferPromotionDecision | undefined;
  promote(
    decision: TransferPromotionDecision,
    capabilities: {
      readonly ownerCapability: import('./CreativeRunCoordinator.js').OwnerAuthorityCapability;
      readonly sourceCapability: import('./CreativeRunCoordinator.js').OwnerAuthorityCapability;
    },
  ): TransferPromotionReceipt;
}

declare const TRANSFER_OWNER_SESSION_BRAND: unique symbol;
/** Opaque coordinator-minted handle to an authentic W8-15 owner session. */
export interface TransferPromotionOwnerSessionHandle {
  readonly [TRANSFER_OWNER_SESSION_BRAND]: true;
}

declare const SEALED_PROMOTION_BRIEF_BRAND: unique symbol;
/** Opaque coordinator-minted brief bound to an owner session and experiment run. */
export interface SealedPromotionBrief {
  readonly [SEALED_PROMOTION_BRIEF_BRAND]: true;
  readonly briefDigest: string;
  readonly runId: string;
}

declare const PROMOTION_ARTIFACT_BRAND: unique symbol;
/** Opaque artifact emitted by the coordinator's real Create path. */
export interface TransferPromotionArtifact {
  readonly [PROMOTION_ARTIFACT_BRAND]: true;
  readonly artifactDigest: string;
  readonly createRunId: string;
  /** Digest of the coordinator-owned brief, route, budget, source and arm treatment. */
  readonly causalInputDigest: string;
}

export interface TransferPromotionReviewerSink {
  readonly packet: PromotionComparisonPacket;
  submit(input: {
    readonly preferredBlindId: string;
    readonly claim: string;
  }): BlindedComparisonJudgment;
}

export interface TransferPromotionGateOptions {
  readonly ownerSession: TransferPromotionOwnerSessionHandle;
  readonly sealedBrief: SealedPromotionBrief;
  readonly treatmentArtifact: TransferPromotionArtifact;
  readonly controlArtifact: TransferPromotionArtifact;
  readonly applicability: string;
  readonly experimentalScope: string;
  readonly evidenceProtocol: string;
}
