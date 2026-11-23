export type DreamModality = 'visual' | 'motion' | 'audio' | 'interaction' | 'multi-layer';

export type DreamExperimentState =
  | 'planned' | 'frozen' | 'baseline-observed' | 'variants-observed'
  | 'finding-proposed' | 'transfer-frozen' | 'transfer-observed' | 'completed';

export type DreamFindingState = 'none' | 'proposed' | 'validated' | 'falsified' | 'inconclusive';

export interface DreamHypothesis {
  id: string;
  statement: string;
  principle: string;
  expectedEffect: string;
}

export interface DreamFrozenContext {
  sourceDigests: string[];
  knowledgeProfileDigest: string;
  parentSetDigest: string;
  operatorDigest: string;
  policyDigest: string;
  rendererEnvironmentDigest: string;
  evaluatorManifestDigests: string[];
  transferCommitmentDigest: string;
  /** Canonical Create and owner-review lineage. Absent only on historical, non-admissible plans. */
  liminalParentBindings?: Array<{ createKey: string; ownerReviewKey: string;
    operationId: string; lineageId: string; createCommandDigest: string;
    createReceiptDigest: string; reviewCommandDigest: string;
    reviewDecisionDigest: string; reviewReceiptDigest: string;
    artifactDigest: string; evidenceDigest: string;
    /** What the parent artifact does (F09); absent when no source was readable. */
    parentTechniqueDigest?: string; parentTechnique?: string;
    /** Set when the judge's score, not an owner review, admitted this parent. */
    provenance?: 'judge-scoring-evidence' }>;
}

export interface DreamExperimentPlan {
  aggregateId: string;
  schemaVersion: 1;
  campaignId: string;
  hypothesis: DreamHypothesis;
  context: DreamFrozenContext;
  budget: { maximumAttempts: number };
  requiredModalities: DreamModality[];
  lease: { token: string; fencingSequence: number };
}

export type DreamComparisonOutcome = 'keeper' | 'rejected' | 'inconclusive';
export type DreamTransferOutcome = 'validated' | 'falsified' | 'inconclusive';

export interface DreamResearchSnapshot {
  aggregateId: string;
  revision: number;
  state: DreamExperimentState;
  finding: DreamFindingState;
  maximumAttempts: number;
  attemptsStarted: number;
  hasUnknownAttempt: boolean;
  leaseCancelled?: boolean;
}

export type DreamResearchEventType =
  | 'experiment-planned' | 'experiment-frozen' | 'baseline-observed'
  | 'variants-observed' | 'experiment-rejected' | 'experiment-inconclusive'
  | 'finding-proposed' | 'transfer-frozen' | 'transfer-observed'
  | 'finding-validated' | 'finding-falsified' | 'finding-inconclusive'
  | 'operation-reserved' | 'transport-started' | 'operation-completed'
  | 'operation-outcome-unknown' | 'operation-outcome-resolved'
  | 'holdout-accessed' | 'historical-imported' | 'lease-cancelled'
  | 'experiment-abandoned';

export interface DreamResearchEvent {
  aggregateId: string;
  revision: number;
  commandId: string;
  type: DreamResearchEventType;
  payload: Readonly<Record<string, unknown>>;
  previousDigest: string;
  eventDigest: string;
  createdAt: string;
}

export interface AppendDreamResearchEvent {
  aggregateId: string;
  expectedRevision: number;
  commandId: string;
  type: DreamResearchEventType;
  payload: Readonly<Record<string, unknown>>;
}

export interface DreamAttemptReservation {
  operationId: string;
  attempt: number;
  purpose: string;
  metered: boolean;
}
