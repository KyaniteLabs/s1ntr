import { describe, expect, it } from 'vitest';
import { planReverseCalls, revisionCap } from '../../../src/cli/ProviderCallPlan.js';

describe('one provider cap over every charged step of a reverse generate (Sol F10/G04)', () => {
  it('no explicit cap keeps the default attempts for each Create', () => {
    expect(planReverseCalls(undefined, 1).createCap).toBe(2);
    expect(revisionCap(undefined, 1, 2)).toBe(2);
  });
  it('the image read is charged before the first Create', () => {
    expect(planReverseCalls(4, 1).createCap).toBe(3);
    expect(planReverseCalls(4, 0).createCap).toBe(4);
  });
  it('a cap the vision read alone spends is refused before any Create', () => {
    expect(() => planReverseCalls(1, 1)).toThrow(/PROVIDER_CAP_EXHAUSTED/);
  });
  it('the revision gets only what vision + Create left, and never runs when nothing is left', () => {
    expect(revisionCap(5, 1, 2)).toBe(2);
    expect(revisionCap(3, 1, 2)).toBeNull();
    expect(revisionCap(2, 0, 2)).toBeNull();
  });
  it('total charged never exceeds the cap', () => {
    for (let cap = 1; cap <= 8; cap++) for (const vision of [0, 1]) {
      if (cap - vision < 1) continue;
      const create = planReverseCalls(cap, vision).createCap;
      for (let used = 1; used <= create; used++) {
        const rev = revisionCap(cap, vision, used);
        expect(vision + used + (rev ?? 0)).toBeLessThanOrEqual(cap);
      }
    }
  });
});
