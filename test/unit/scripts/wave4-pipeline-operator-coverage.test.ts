import { describe, expect, it } from 'vitest';
import {
  classifyLivePass,
  classifyOperatorCoverage,
} from '../../../scripts/rotation/wave4-full-pipeline-dogfood.mjs';

describe('wave4 operator coverage claims', () => {
  it.each([
    [{ ok: false }, { ok: true }],
    [{ ok: true }, { ok: false }],
  ])('fails full livePass when either operator flank is red', (studio, bridge) => {
    const coverage = classifyOperatorCoverage(false, studio, bridge);

    expect(classifyLivePass(true, coverage)).toEqual({
      livePass: false,
      partialLivePass: false,
    });
    expect(coverage).toEqual({ mode: 'full', partial: false, fullL6: false });
  });

  it('labels skipped operator coverage as partial and never full L6', () => {
    const coverage = classifyOperatorCoverage(
      true,
      { ok: false, skipped: true },
      { ok: false, skipped: true },
    );

    expect(classifyLivePass(true, coverage)).toEqual({
      livePass: false,
      partialLivePass: true,
    });
    expect(coverage).toEqual({
      mode: 'partial-skipped',
      partial: true,
      fullL6: false,
    });
  });
});
