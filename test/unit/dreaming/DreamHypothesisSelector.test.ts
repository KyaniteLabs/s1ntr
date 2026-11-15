import { describe, expect, it } from 'vitest';
import { DreamHypothesisSelector } from '../../../src/dreaming/research/DreamHypothesisSelector.js';

describe('Dream hypothesis selector', () => {
  const hypotheses = [
    { id: 'familiar', statement: 'repeat known motion', principle: 'motion', expectedEffect: 'flow',
      uncertainty: 0.2, novelty: 0.1, learningValue: 0.4, transferRelevance: 0.4, cost: 0.1,
      failureFamily: 'motion-repeat' },
    { id: 'depth', statement: 'test transparent depth', principle: 'depth', expectedEffect: 'hierarchy',
      uncertainty: 0.8, novelty: 0.9, learningValue: 0.9, transferRelevance: 0.8, cost: 0.3,
      failureFamily: 'depth-new' },
  ];

  it('ranks explainably without owning campaign policy', () => {
    const controller = new DreamHypothesisSelector({ maximumExperiments: 2,
      maximumFailureFamilyRepeats: 1 });
    const choice = controller.choose(hypotheses, { completedExperiments: 0,
      failureFamilyCounts: { 'motion-repeat': 1 }, remainingAttempts: 3 });
    expect(choice).toMatchObject({ kind: 'experiment', hypothesis: { id: 'depth' } });
    if (choice.kind === 'experiment') expect(choice.explanation.factors).toHaveLength(5);
  });

  it('leaves budget and saturation decisions to the durable controller', () => {
    const controller = new DreamHypothesisSelector({ maximumExperiments: 1,
      maximumFailureFamilyRepeats: 1 });
    for (const state of [{ completedExperiments: 0, failureFamilyCounts: {}, remainingAttempts: 0 },
      { completedExperiments: 9, failureFamilyCounts: { 'depth-new': 9 }, remainingAttempts: 9 }]) {
      expect(controller.choose(hypotheses, state))
        .toMatchObject({ kind: 'experiment', hypothesis: { id: 'depth' } });
    }
    expect(controller.choose([], { completedExperiments: 0,
      failureFamilyCounts: {}, remainingAttempts: 0 }))
      .toEqual({ kind: 'stop', reason: 'saturation' });
  });

  it('does not own outcome bookkeeping or convert it into ranking policy', () => {
    const controller = new DreamHypothesisSelector({ maximumExperiments: 3,
      maximumFailureFamilyRepeats: 1 });
    const next = controller.choose(hypotheses, { completedExperiments: 9,
      failureFamilyCounts: { 'depth-new': 9 }, remainingAttempts: 0 });
    expect(next).toMatchObject({ kind: 'experiment', hypothesis: { id: 'depth' } });
    expect('update' in controller).toBe(false);
  });
});
