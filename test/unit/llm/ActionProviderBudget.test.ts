import { describe, expect, it } from 'vitest';
import { ActionProviderBudget } from '../../../src/llm/ActionProviderBudget.js';

const plan = { maxProviderCalls: 1, stages: ['generate'] as const,
  plannedMinimumCalls: 1, plannedMaximumCalls: 1 };

describe('ActionProviderBudget', () => {
  it('aborts before call N+1 and reports counters', () => {
    const budget = new ActionProviderBudget(plan);
    budget.guard();
    expect(() => budget.guard()).toThrow('blocked before call 2');
    expect(budget.snapshot()).toMatchObject({ attemptedCalls: 1, remainingCalls: 0 });
  });

  it('rejects a plan that exceeds its cap', () => {
    expect(() => new ActionProviderBudget({ ...plan, maxProviderCalls: 0 }))
      .toThrow('Planned provider calls (1) exceed action cap (0)');
  });
});
