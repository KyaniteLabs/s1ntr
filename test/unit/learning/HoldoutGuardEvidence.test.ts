import { describe, expect, it } from 'vitest';
import { promotionGate } from '../../../src/learning/HoldoutGuard.js';

const mk = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const all = (ids: string[], v: number | null) => Object.fromEntries(ids.map(id => [id, v]));

/** F12: a candidate must not win on too little paired evidence, nor against an incumbent that did not run. */
describe('promotion gate evidence adequacy (F12)', () => {
  it('refuses a one-prompt schedule', () => {
    const ids = mk(1);
    expect(promotionGate(ids, all(ids, 0.3), all(ids, 0.9), { minGain: 0.03 }))
      .toMatchObject({ decision: 'error', reason: 'GATE_SCHEDULE_TOO_SMALL' });
  });
  it('refuses to promote against an incumbent whose runs mostly failed', () => {
    const ids = mk(12);
    const incumbent = { ...all(ids, null), p0: 0.5, p1: 0.5 };
    expect(promotionGate(ids, incumbent, all(ids, 0.9), { minGain: 0.03 }))
      .toMatchObject({ decision: 'error', reason: 'GATE_INCUMBENT_UNAVAILABLE' });
  });
});
