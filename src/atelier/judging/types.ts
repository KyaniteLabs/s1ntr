import type { JudgingPhase } from './dimensions.js';

export type JudgingSense = JudgingPhase;
export type DimensionScore = number | null;
export type DimensionScores = Readonly<Record<string, DimensionScore>>;

export interface LaneDescriptor {
  readonly sense: JudgingSense;
  readonly provider: string;
  readonly model: string;
  readonly transport: string;
  readonly priority?: number;
}

export interface JudgeResponse {
  readonly scores: DimensionScores;
  readonly notApplicable?: Readonly<Record<string, string>>;
  readonly failureReason?: string;
}

export type JudgeTransportResult = JudgeResponse | DimensionScores;
export type JudgeTransport = (
  request: JudgementRequest,
  lane: LaneDescriptor,
) => Promise<JudgeTransportResult>;

export interface JudgeVerdict {
  readonly lane: LaneDescriptor | null;
  readonly scores: DimensionScores;
  readonly notApplicable: Readonly<Record<string, string>>;
  readonly failureReason: string | null;
}

export interface JudgementRequest {
  readonly id: string;
  readonly artifact: unknown;
}

export type QuorumStatus = 'complete' | 'deferred' | 'insufficient_quorum';

export interface JudgementOutcome {
  readonly requestId: string;
  readonly verdicts: Readonly<Record<JudgingSense, JudgeVerdict>>;
  readonly deferred: boolean;
  readonly quorumStatus: QuorumStatus;
  readonly judgeAlert: boolean;
  readonly failureReason: string | null;
  readonly missingSenses: readonly JudgingSense[];
  readonly ladder: readonly QuotaLadderStep[];
}

export type QuotaLadderAction = 'primary' | 'substitute' | 'defer';

export interface QuotaLadderStep {
  readonly sense: JudgingSense;
  readonly action: QuotaLadderAction;
  readonly lane: LaneDescriptor | null;
  readonly reason?: string;
}

export interface LaneHealth {
  readonly key: string;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
}

export interface OrganStats {
  readonly requested: number;
  readonly scored: number;
  readonly deferred: number;
  readonly insufficientQuorum: number;
}
