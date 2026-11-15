import type { DreamHypothesis } from './DreamResearchTypes.js';

export interface DreamResearchHypothesis extends DreamHypothesis {
  uncertainty: number;
  novelty: number;
  learningValue: number;
  transferRelevance: number;
  cost: number;
  failureFamily: string;
}

export interface DreamResearchControllerState {
  completedExperiments: number;
  failureFamilyCounts: Readonly<Record<string, number>>;
  remainingAttempts: number;
}

export type DreamResearchChoice =
  | { kind: 'stop'; reason: 'budget' | 'campaign-limit' | 'saturation' }
  | { kind: 'experiment'; hypothesis: DreamResearchHypothesis;
      explanation: { score: number; factors: Array<{ name: string; value: number }> } };

export class DreamHypothesisSelector {
  /** @deprecated Pure ranking helper; DreamResearchController owns policy and budgets. */
  constructor(_legacyPolicy?: {
    maximumExperiments: number;
    maximumFailureFamilyRepeats: number;
  }) {}

  choose(hypotheses: readonly DreamResearchHypothesis[],
    _legacyState?: DreamResearchControllerState): DreamResearchChoice {
    if (hypotheses.length === 0) return { kind: 'stop', reason: 'saturation' };
    const ranked = hypotheses.map(hypothesis => {
      const factors = [
        { name: 'uncertainty', value: bounded(hypothesis.uncertainty) * 0.2 },
        { name: 'novelty', value: bounded(hypothesis.novelty) * 0.2 },
        { name: 'learning-value', value: bounded(hypothesis.learningValue) * 0.3 },
        { name: 'transfer-relevance', value: bounded(hypothesis.transferRelevance) * 0.2 },
        { name: 'cost', value: -bounded(hypothesis.cost) * 0.1 },
      ];
      return { hypothesis, factors,
        score: factors.reduce((sum, factor) => sum + factor.value, 0) };
    }).sort((left, right) => right.score - left.score
      || left.hypothesis.id.localeCompare(right.hypothesis.id));
    const winner = ranked[0];
    return { kind: 'experiment', hypothesis: winner.hypothesis,
      explanation: { score: winner.score, factors: winner.factors } };
  }

}

function bounded(value: number): number {
  if (!Number.isFinite(value)) throw new Error('DREAM_RESEARCH_FACTOR_INVALID');
  return Math.min(1, Math.max(0, value));
}
