import { describe, expect, it } from 'vitest';
import { promotionGate } from '../../../src/learning/HoldoutGuard.js';

const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
const arm = (value: number, jitter = 0.01) => Object.fromEntries(ids.map((id, i) => [id, value + (i % 2 ? jitter : -jitter)]));
const opts = { minGain: 0.03 };

describe('promotion gate fails closed', () => {
  it('promotes only a clear predeclared gain with a lower bound above zero', () => {
    const v = promotionGate(ids, arm(0.5), arm(0.6), opts);
    expect(v).toMatchObject({ decision: 'promote', scheduled: 12 });
    expect(v.lowerBound95).toBeGreaterThan(0);
  });
  it('keeps the incumbent on a drop, a tie, and a gain below the margin', () => {
    expect(promotionGate(ids, arm(0.6), arm(0.5), opts).decision).toBe('keep-incumbent');
    expect(promotionGate(ids, arm(0.5), arm(0.5), opts).decision).toBe('keep-incumbent');
    expect(promotionGate(ids, arm(0.5), arm(0.52), opts)).toMatchObject({ decision: 'keep-incumbent', reason: 'GAIN_BELOW_PREDECLARED_MARGIN' });
  });
  it('keeps the incumbent when the gain is real on average but noisy (lower bound not above zero)', () => {
    const incumbent = arm(0.5, 0);
    const candidate = Object.fromEntries(ids.map((id, i) => [id, i < 3 ? 0.95 : 0.45]));
    const v = promotionGate(ids, incumbent, candidate, opts);
    expect(v.meanGain).toBeGreaterThan(0.03);
    expect(v).toMatchObject({ decision: 'keep-incumbent', reason: 'LOWER_BOUND_NOT_ABOVE_ZERO' });
  });
  it('scores a failed or missing candidate prompt as 0 instead of dropping it', () => {
    const candidate: Record<string, number | null> = { ...arm(0.9) };
    candidate.p0 = null;
    delete candidate.p1;
    const v = promotionGate(ids, arm(0.5), candidate, opts);
    expect(v.candidateFailures).toBe(2);
    expect(v.scheduled).toBe(12);
    const survivorsOnly = promotionGate(ids.slice(2), arm(0.5), arm(0.9), opts);
    expect(v.meanGain).toBeLessThan(survivorsOnly.meanGain);
  });
  it('a candidate that crashes on every prompt can never win', () => {
    const dead = Object.fromEntries(ids.map(id => [id, null]));
    expect(promotionGate(ids, arm(0.5), dead, opts).decision).toBe('keep-incumbent');
  });
  it('errors, never promotes, on malformed input', () => {
    expect(promotionGate([], arm(0.5), arm(0.9), opts).decision).toBe('error');
    expect(promotionGate(['a', 'a'], arm(0.5), arm(0.9), opts).decision).toBe('error');
    expect(promotionGate(ids, arm(0.5), arm(0.9), { minGain: 0 }).decision).toBe('error');
    expect(promotionGate(ids, undefined as never, arm(0.9), opts).decision).toBe('error');
    expect(promotionGate(ids, arm(0.5), { ...arm(0.9), p0: NaN }, opts).candidateFailures).toBe(1);
  });
});
