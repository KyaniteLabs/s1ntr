import { describe, expect, it } from 'vitest';
import { temporalVerdict, type TemporalResult } from '../../../src/atelier/TemporalProbe.js';

function tr(over: Partial<TemporalResult>): TemporalResult {
  return { frames: 4, stability: 0.8, motionEnergy: 0.3, flicker: 0.1, jankPct: 2, fpsApprox: 58, ...over };
}

describe('temporal verdict (keystone metrics)', () => {
  it('healthy motion scores high', () => {
    const v = temporalVerdict(tr({}));
    expect(v.temporalScore).toBeGreaterThan(0.5);
    expect(v.notes).toContain('fps');
  });
  it('static piece is penalized', () => {
    expect(temporalVerdict(tr({ motionEnergy: 0.01 })).temporalScore)
      .toBeLessThan(temporalVerdict(tr({})).temporalScore);
  });
  it('strobe and jank are penalized', () => {
    expect(temporalVerdict(tr({ flicker: 0.9 })).temporalScore)
      .toBeLessThan(temporalVerdict(tr({})).temporalScore);
    expect(temporalVerdict(tr({ jankPct: 30 })).temporalScore)
      .toBeLessThan(temporalVerdict(tr({})).temporalScore);
  });
  it('insufficient frames = zero, honestly', () => {
    expect(temporalVerdict(tr({ frames: 1 })).temporalScore).toBe(0);
  });
});
