import { JUDGING_PHASES, dimensionsForPhase } from './dimensions.js';
import { ProviderPool } from './ProviderPool.js';
import type {
  DimensionScores,
  JudgeTransportResult,
  JudgeVerdict,
  JudgementOutcome,
  JudgementRequest,
  JudgingSense,
  OrganStats,
  QuotaLadderStep,
} from './types.js';

const INSUFFICIENT_QUORUM = 'insufficient_quorum';
const DEFERRED_REASON = 'no healthy lane available; judgement deferred';

function blankScores(sense: JudgingSense): Record<string, null> {
  return Object.fromEntries(dimensionsForPhase(sense).map((dimension) => [dimension.id, null]));
}

function failureVerdict(sense: JudgingSense, reason: string): JudgeVerdict {
  return { lane: null, scores: blankScores(sense), notApplicable: {}, failureReason: reason };
}

function responseScores(response: JudgeTransportResult): DimensionScores {
  if (
    typeof response === 'object'
    && response !== null
    && 'scores' in response
    && typeof response.scores === 'object'
    && response.scores !== null
  ) {
    return response.scores as DimensionScores;
  }
  return response as DimensionScores;
}

function responseNotApplicable(response: JudgeTransportResult): Readonly<Record<string, string>> {
  if (
    typeof response === 'object'
    && response !== null
    && 'scores' in response
    && typeof response.notApplicable === 'object'
    && response.notApplicable !== null
  ) {
    return response.notApplicable as Readonly<Record<string, string>>;
  }
  return {};
}

function completeScores(
  sense: JudgingSense,
  scores: DimensionScores,
  notApplicable: Readonly<Record<string, string>>,
): boolean {
  return dimensionsForPhase(sense).every((dimension) => {
    const score = scores[dimension.id];
    const naReason = notApplicable[dimension.id];
    return Object.prototype.hasOwnProperty.call(scores, dimension.id)
      && (typeof score === 'number' && score >= 1 && score <= 10
        || score === null && typeof naReason === 'string' && naReason.trim().length > 0);
  });
}

function normalizedScores(sense: JudgingSense, scores: DimensionScores): DimensionScores {
  return Object.fromEntries(dimensionsForPhase(sense).map((dimension) => [dimension.id, scores[dimension.id] ?? null]));
}

export class JudgingOrgan {
  private readonly requiredSenses: readonly JudgingSense[];
  private counters: OrganStats = { requested: 0, scored: 0, deferred: 0, insufficientQuorum: 0 };

  constructor(private readonly pool: ProviderPool) {
    this.requiredSenses = JUDGING_PHASES;
  }

  async judge(request: JudgementRequest): Promise<JudgementOutcome> {
    this.counters = { ...this.counters, requested: this.counters.requested + 1 };
    const requiredSenses = this.requiredSenses;
    const verdicts = {} as Record<JudgingSense, JudgeVerdict>;
    const ladder: QuotaLadderStep[] = [];
    const missingSenses: JudgingSense[] = [];
    const attemptedFailure: JudgingSense[] = [];

    for (const sense of requiredSenses) {
      const result = await this.judgeSense(request, sense, ladder);
      verdicts[sense] = result.verdict;
      if (!result.scored) missingSenses.push(sense);
      if (result.attemptedFailure) attemptedFailure.push(sense);
    }

    if (missingSenses.length === 0) {
      this.counters = { ...this.counters, scored: this.counters.scored + 1 };
      return this.outcome(request, verdicts, false, 'complete', missingSenses, ladder, null);
    }
    if (attemptedFailure.length > 0) {
      for (const sense of attemptedFailure) {
        ladder.push({ sense, action: 'defer', lane: null, reason: 'quota lanes exhausted; requeue attempted' });
      }
      this.counters = { ...this.counters, insufficientQuorum: this.counters.insufficientQuorum + 1 };
      return this.insufficientOutcome(request, requiredSenses, missingSenses, ladder);
    }
    this.counters = { ...this.counters, deferred: this.counters.deferred + 1 };
    return this.outcome(request, verdicts, true, 'deferred', missingSenses, ladder, DEFERRED_REASON);
  }

  stats(): OrganStats {
    return { ...this.counters };
  }

  private async judgeSense(
    request: JudgementRequest,
    sense: JudgingSense,
    ladder: QuotaLadderStep[],
  ): Promise<{ verdict: JudgeVerdict; scored: boolean; attemptedFailure: boolean }> {
    const candidates = this.pool.lookup(sense);
    if (candidates.length === 0) {
      ladder.push({ sense, action: 'defer', lane: null, reason: DEFERRED_REASON });
      return { verdict: failureVerdict(sense, DEFERRED_REASON), scored: false, attemptedFailure: false };
    }
    for (const [index, lane] of candidates.entries()) {
      const action = index === 0 ? 'primary' : 'substitute';
      ladder.push({ sense, action, lane });
      const transport = this.pool.transportFor(lane);
      if (!transport) {
        this.pool.recordFailure(lane);
        continue;
      }
      try {
        const response = await transport(request, lane);
        const scores = responseScores(response);
        const notApplicable = responseNotApplicable(response);
        if (!completeScores(sense, scores, notApplicable)) throw new Error('transport returned incomplete or invalid dimensions');
        this.pool.recordSuccess(lane);
        return {
          verdict: { lane, scores: normalizedScores(sense, scores), notApplicable, failureReason: null },
          scored: true,
          attemptedFailure: false,
        };
      } catch (error) {
        this.pool.recordFailure(lane);
        ladder[ladder.length - 1] = { sense, action, lane, reason: error instanceof Error ? error.message : 'transport failed' };
      }
    }
    return { verdict: failureVerdict(sense, 'all healthy quota lanes failed'), scored: false, attemptedFailure: true };
  }

  private insufficientOutcome(
    request: JudgementRequest,
    requiredSenses: readonly JudgingSense[],
    missingSenses: readonly JudgingSense[],
    ladder: readonly QuotaLadderStep[],
  ): JudgementOutcome {
    const verdicts = {} as Record<JudgingSense, JudgeVerdict>;
    for (const sense of requiredSenses) {
      verdicts[sense] = failureVerdict(sense, `${INSUFFICIENT_QUORUM}: a required judge failed`);
    }
    return this.outcome(request, verdicts, false, INSUFFICIENT_QUORUM, missingSenses, ladder, INSUFFICIENT_QUORUM);
  }

  private outcome(
    request: JudgementRequest,
    verdicts: Record<JudgingSense, JudgeVerdict>,
    deferred: boolean,
    quorumStatus: JudgementOutcome['quorumStatus'],
    missingSenses: readonly JudgingSense[],
    ladder: readonly QuotaLadderStep[],
    failureReason: string | null,
  ): JudgementOutcome {
    return {
      requestId: request.id,
      verdicts,
      deferred,
      quorumStatus,
      judgeAlert: quorumStatus === INSUFFICIENT_QUORUM,
      failureReason,
      missingSenses,
      ladder,
    };
  }
}

export function canPromote(outcome: JudgementOutcome): boolean {
  if (outcome.deferred || outcome.quorumStatus !== 'complete') return false;
  return JUDGING_PHASES.every((sense) => {
    const verdict = outcome.verdicts[sense];
    return verdict !== undefined && dimensionsForPhase(sense).every((dimension) => {
      const score = verdict.scores[dimension.id];
      return typeof score === 'number' && score >= 1 && score <= 10;
    });
  });
}
