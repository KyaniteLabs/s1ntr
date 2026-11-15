import { describe, expect, it } from 'vitest';
import { reduceDreamResearch } from '../../../src/dreaming/research/DreamResearchReducer.js';
import type { DreamResearchEvent, DreamResearchEventType } from '../../../src/dreaming/research/DreamResearchTypes.js';

const ID = 'dream-1';

function ev(revision: number, type: DreamResearchEventType, payload: Record<string, unknown> = {}): DreamResearchEvent {
  return { aggregateId: ID, revision, commandId: `c${revision}`, type, payload,
    previousDigest: 'p', eventDigest: 'e', createdAt: '2026-11-14T00:00:00Z' };
}

const plan = (over: Record<string, unknown> = {}) => ({
  aggregateId: ID, schemaVersion: 1, budget: { maximumAttempts: 3 }, ...over,
});
const planned = (over: Record<string, unknown> = {}) => ev(1, 'experiment-planned', { plan: plan(over) });

/** planned -> variants-observed (revisions 1..4) */
const toVariants = () => [
  planned(),
  ev(2, 'experiment-frozen'),
  ev(3, 'baseline-observed'),
  ev(4, 'variants-observed'),
];

describe('reduceDreamResearch planning', () => {
  it('starts from the plan with zero attempts', () => {
    expect(reduceDreamResearch([planned()])).toEqual({
      aggregateId: ID, revision: 1, state: 'planned', finding: 'none',
      maximumAttempts: 3, attemptsStarted: 0, hasUnknownAttempt: false, leaseCancelled: false,
    });
  });

  it('rejects an empty log or one that does not start with a plan', () => {
    expect(() => reduceDreamResearch([])).toThrow('DREAM_NOT_PLANNED');
    expect(() => reduceDreamResearch([ev(1, 'experiment-frozen')])).toThrow('DREAM_NOT_PLANNED');
  });

  it.each([
    ['a missing plan', {}],
    ['an aggregate mismatch', { plan: plan({ aggregateId: 'other' }) }],
    ['schema version 2', { plan: plan({ schemaVersion: 2 }) }],
    ['a negative budget', { plan: plan({ budget: { maximumAttempts: -1 } }) }],
    ['a fractional budget', { plan: plan({ budget: { maximumAttempts: 1.5 } }) }],
  ])('rejects %s with DREAM_PLAN_INVALID', (_name, payload) => {
    expect(() => reduceDreamResearch([ev(1, 'experiment-planned', payload)])).toThrow('DREAM_PLAN_INVALID');
  });

  it('accepts a zero-attempt budget', () => {
    expect(reduceDreamResearch([planned({ budget: { maximumAttempts: 0 } })]).maximumAttempts).toBe(0);
  });

  it('rejects planning twice', () => {
    expect(() => reduceDreamResearch([planned(), ev(2, 'experiment-planned', { plan: plan() })]))
      .toThrow('DREAM_ALREADY_PLANNED');
  });
});

describe('reduceDreamResearch lifecycle', () => {
  it('walks planned to variants-observed', () => {
    const s = reduceDreamResearch(toVariants());
    expect(s).toMatchObject({ state: 'variants-observed', revision: 4, finding: 'none' });
  });

  it.each(['experiment-rejected', 'experiment-inconclusive'] as const)('%s completes without a finding', type => {
    expect(reduceDreamResearch([...toVariants(), ev(5, type)])).toMatchObject({ state: 'completed', finding: 'none', revision: 5 });
  });

  it('proposes a finding then validates it after transfer', () => {
    const s = reduceDreamResearch([
      ...toVariants(), ev(5, 'finding-proposed'),
      ev(6, 'transfer-frozen'), ev(7, 'transfer-observed'), ev(8, 'finding-validated'),
    ]);
    expect(s).toMatchObject({ state: 'completed', finding: 'validated', revision: 8 });
  });

  it.each([['finding-falsified', 'falsified'], ['finding-inconclusive', 'inconclusive']] as const)(
    '%s completes with finding %s', (type, finding) => {
      const s = reduceDreamResearch([
        ...toVariants(), ev(5, 'finding-proposed'), ev(6, 'transfer-frozen'), ev(7, 'transfer-observed'), ev(8, type),
      ]);
      expect(s).toMatchObject({ state: 'completed', finding });
    });

  it('shows a proposed finding mid-flight', () => {
    expect(reduceDreamResearch([...toVariants(), ev(5, 'finding-proposed')]))
      .toMatchObject({ state: 'finding-proposed', finding: 'proposed' });
  });

  it('rejects out-of-order transitions with DREAM_STATE_INVALID', () => {
    expect(() => reduceDreamResearch([planned(), ev(2, 'baseline-observed')])).toThrow('DREAM_STATE_INVALID');
    expect(() => reduceDreamResearch([planned(), ev(2, 'finding-proposed')])).toThrow('DREAM_STATE_INVALID');
    expect(() => reduceDreamResearch([...toVariants(), ev(5, 'finding-validated')])).toThrow('DREAM_STATE_INVALID');
  });

  it('rejects revision gaps and repeats with DREAM_EVENT_SEQUENCE_INVALID', () => {
    expect(() => reduceDreamResearch([planned(), ev(3, 'experiment-frozen')])).toThrow('DREAM_EVENT_SEQUENCE_INVALID');
    expect(() => reduceDreamResearch([planned(), ev(1, 'experiment-frozen')])).toThrow('DREAM_EVENT_SEQUENCE_INVALID');
    expect(() => reduceDreamResearch([planned(), ev(3, 'lease-cancelled')])).toThrow('DREAM_EVENT_SEQUENCE_INVALID');
  });
});

describe('reduceDreamResearch bookkeeping events', () => {
  it('counts metered transport attempts but not metered:false ones', () => {
    const s = reduceDreamResearch([
      planned(), ev(2, 'transport-started'), ev(3, 'transport-started', { metered: false }), ev(4, 'transport-started', { metered: true }),
    ]);
    expect(s.attemptsStarted).toBe(2);
    expect(s.revision).toBe(4);
    expect(s.state).toBe('planned');
  });

  it('tracks an unknown outcome until it is resolved', () => {
    const unknown = reduceDreamResearch([planned(), ev(2, 'operation-outcome-unknown')]);
    expect(unknown.hasUnknownAttempt).toBe(true);
    expect(reduceDreamResearch([planned(), ev(2, 'operation-outcome-unknown'), ev(3, 'operation-outcome-resolved')]).hasUnknownAttempt).toBe(false);
  });

  it('records lease cancellation', () => {
    expect(reduceDreamResearch([planned(), ev(2, 'lease-cancelled')]).leaseCancelled).toBe(true);
  });

  it('abandoning completes the experiment from any state', () => {
    expect(reduceDreamResearch([planned(), ev(2, 'experiment-abandoned')])).toMatchObject({ state: 'completed', finding: 'none' });
  });

  it.each(['operation-reserved', 'operation-completed', 'holdout-accessed', 'historical-imported'] as const)(
    '%s only advances the revision', type => {
      expect(reduceDreamResearch([planned(), ev(2, type)])).toEqual({
        ...reduceDreamResearch([planned()]), revision: 2,
      });
    });
});
