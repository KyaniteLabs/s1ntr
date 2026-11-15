import { describe, it, expect } from 'vitest';
import { computeLevel, parseAxes, buildScorecard, fmt, configuredJudgeIdentity, requireIndependentJudges, judgeEyePlan, judgeFamily } from '../../../src/atelier/SpuScorer.js';

describe('SPU-2.0 Scorer (10-point scale, CEO-corrected standards)', () => {
  describe('computeLevel — honest gates on the 10-point scale', () => {
    it('below-S for competent-but-not-exceptional work (7.00 range)', () => {
      expect(computeLevel({ D: 7.0, A: 7.0, R: 7.0, N: 7.0 })).toBe('B'); // S=9.0 ladder: 7.0 craft = B
    });
    it('below-S for the old "S-threshold" work (7.48 = the old 3.74 champion)', () => {
      expect(computeLevel({ D: 7.48, A: 7.48, R: 7.48, N: 7.48 })).toBe('B'); // the old 3.74-era champion = B under S=9.0
    });
    it('S for genuinely excellent work (8.00+)', () => {
      expect(computeLevel({ D: 8.2, A: 7.8, R: 8.1, N: 7.0 })).toBe('A'); // 8.0-craft = A under S=9.0
    });
    it('S requires the full conjunctive — novelty lag caps at A', () => {
      expect(computeLevel({ D: 9.1, A: 8.7, R: 9.2, N: 7.8 })).toBe('A'); // N 7.8 < 8.0 gate: craft alone does not make S
    });
    it('SSS for world-class work', () => {
      expect(computeLevel({ D: 9.4, A: 9.2, R: 9.5, N: 8.8 })).toBe('SSS'); // 9.4+ craft holds
    });
    it('SSS+ for masterpiece work', () => {
      expect(computeLevel({ D: 9.7, A: 9.5, R: 9.7, N: 9.3 })).toBe('SSS+');
    });
    it('PU for epochal work', () => {
      expect(computeLevel({ D: 9.95, A: 9.85, R: 9.95, N: 9.85 })).toBe('PU');
    });
    it('one weak axis drops the level (conjunctive gates)', () => {
      expect(computeLevel({ D: 9.5, A: 9.5, R: 9.5, N: 3.0 })).toBe('A'); // S-band craft, N fails the conjunctive: one band down to A, not to the floor
    });
  });

  describe('parseAxes — preserves the declared ten-point scale', () => {
    it('accepts 10-point scores directly', () => {
      const r = parseAxes('{"D":8.5,"A":7.2,"R":9.1,"N":6.8,"level":"S"}');
      expect(r?.axes).toEqual({ D: 8.5, A: 7.2, R: 9.1, N: 6.8 });
    });
    it('keeps low scores low rather than inferring a legacy scale', () => {
      const r = parseAxes('{"D":3.7,"A":3.5,"R":3.9,"N":2.5,"level":"S"}');
      expect(r?.axes).toEqual({ D: 3.7, A: 3.5, R: 3.9, N: 2.5 });
    });
    it.each([-1, 11])('rejects out-of-range axes instead of clamping %s', D => {
      expect(parseAxes(JSON.stringify({ D, A: 3, R: 4, N: 2 }))).toBeNull();
    });
    it('preserves both endpoints of the canonical scale', () => {
      expect(parseAxes('{"D":0,"A":10,"R":0,"N":10}')?.axes)
        .toEqual({ D: 0, A: 10, R: 0, N: 10 });
    });
  });

  describe('display formatting', () => {
    it('formats to 2 decimal places', () => {
      expect(fmt(7.4123456)).toBe('7.41');
      expect(fmt(10)).toBe('10.00');
      expect(fmt(3.7 * 2)).toBe('7.40');
    });
  });

  describe('buildScorecard', () => {
    it('fails closed before persistence when fewer than two independent judges parse', () => {
      expect(() => buildScorecard({
        artifact: '/tmp/test', domain: 'p5',
        judges: [{ vendor: 'eye1', axes: { D: 8, A: 7, R: 9, N: 6 } }],
      })).toThrow('SSS_SCORE_INSUFFICIENT_JUDGES:1/2');
    });

    it('accepts two distinct judges and returns the ensemble', () => {
      expect(requireIndependentJudges([{ vendor: 'eye1' }, { vendor: 'eye2' }])).toEqual(['eye1', 'eye2']);
    });

    it('does not overweight a repeated model even when two unique models remain', () => {
      expect(() => buildScorecard({ artifact: '/tmp/test', domain: 'p5', judges: [
        { vendor: 'zai/GLM', axes: { D: 9, A: 9, R: 9, N: 9 } },
        { vendor: 'glm', axes: { D: 9, A: 9, R: 9, N: 9 } },
        { vendor: 'gemini', axes: { D: 1, A: 1, R: 1, N: 1 } },
      ] })).toThrow('SSS_SCORE_DUPLICATE_OR_INVALID_JUDGE');
    });

    it('does not infer identity when provider or model is absent, or count duplicate identities', () => {
      expect(configuredJudgeIdentity({ provider: 'google', model: 'google/gemini' })).toBe('gemini');
      expect(configuredJudgeIdentity({ provider: 'google' })).toBe('');
      expect(configuredJudgeIdentity({ provider: 'google\nsecret', model: 'gemini' })).toBe('');
      expect(configuredJudgeIdentity({ provider: 'zai', model: 'zai/glm-5.3-flash' })).toBe('glm-5.3-flash');
      expect(() => requireIndependentJudges([{ vendor: 'glm-5.3-flash' }, { vendor: 'glm-5.3-flash' }])).toThrow('1/2');
      expect(() => requireIndependentJudges([{ vendor: 'zai/glm-5.3-flash' }, { vendor: 'glm-5.3-flash' }])).toThrow('1/2');
      expect(() => requireIndependentJudges([{ vendor: 'google/gemini' }, { vendor: 'google/gemini' }])).toThrow('1/2');
    });

    it('computes ensemble mean rounded to 2 decimals with level', () => {
      const card = buildScorecard({
        artifact: '/tmp/test', domain: 'p5',
        judges: [
          { vendor: 'eye1', axes: { D: 8, A: 7, R: 9, N: 6 } },
          { vendor: 'eye2', axes: { D: 9, A: 8, R: 8, N: 7 } },
        ],
      });
      expect(card.ensemble.D).toBe(8.5);
      expect(card.scoreScale).toBe(10);
      expect(card.scoringContract).toBe('spu-2.0-literal-v1');
      expect(card.ensemble.A).toBe(7.5);
      expect(card.level).toBe('A'); // 8.5 craft = A under the S=9.0 ladder
    });
  });

  describe('judgeEyePlan — producer-requires-verifier (M-20261008-14)', () => {
    const fixed = { minimaxVendor: 'minimax-m3', glmFlashVendor: 'glm-5.3-flash' };

    it('art-host shape (minimax generator): minimax eye withheld, glm text eye reinforces', () => {
      const plan = judgeEyePlan({
        generatorIdentity: 'minimax/minimax-m3',
        evaluatorVendor: 'glm-5.3',
        ...fixed,
        evaluatorVisionCapable: false,
      });
      expect(plan.generatorFamily).toBe('minimax');
      expect(plan.familyExclusionApplied).toBe(true);
      const run = plan.eyes.filter(e => !e.skipReason);
      // both judges are glm — a different family than the minimax generator
      expect(run.map(e => e.vendor).sort()).toEqual(['glm-5.3', 'glm-5.3-flash']);
      expect(run.every(e => e.vendor !== 'minimax-m3')).toBe(true);
      // glm-5.3 flagship cannot see images — text contract, not pixels
      expect(run.find(e => e.vendor === 'glm-5.3')?.textMode).toBe(true);
      expect(run.find(e => e.vendor === 'glm-5.3-flash')?.textMode).toBe(false);
      // the ensemble still carries 2 DISTINCT judge vendors
      expect(new Set(run.map(e => e.vendor)).size).toBe(2);
    });

    it('gemini evaluator + minimax generator: no extra text eye needed', () => {
      const plan = judgeEyePlan({
        generatorIdentity: 'minimax/minimax-m3',
        evaluatorVendor: 'gemini-3.7-flash-high',
        ...fixed,
        evaluatorVisionCapable: true,
      });
      const run = plan.eyes.filter(e => !e.skipReason);
      expect(run.map(e => e.vendor).sort()).toEqual(['gemini-3.7-flash-high', 'glm-5.3-flash']);
      expect(plan.eyes.find(e => e.vendor === 'minimax-m3')?.skipReason).toBe('generator-family-exclusion');
      expect(run.some(e => e.lane === 'fixed-text')).toBe(false);
    });

    it('configurable non-minimax second eye: family-quorum skip still applies to the fixed eye', () => {
      // 2026-11-12: the fixed second eye now comes from sssScore.secondEye.
      // The quorum policy is unchanged — a non-minimax eye is withheld like any
      // other when it shares the generator family AND >= 2 alternates remain.
      const plan = judgeEyePlan({
        generatorIdentity: 'minimax/minimax-m3',
        evaluatorVendor: 'minimax-m3', // evaluator aliases the generator family here
        minimaxVendor: 'gemini-3.7-flash-high', // configured second eye (non-minimax)
        glmFlashVendor: 'glm-5.3-flash',
        evaluatorVisionCapable: true,
      });
      expect(plan.generatorFamily).toBe('minimax');
      expect(plan.familyExclusionApplied).toBe(true);
      expect(plan.eyes.find(e => e.vendor === 'minimax-m3')?.skipReason).toBe('generator-family-exclusion');
      const run = plan.eyes.filter(e => !e.skipReason);
      expect(run.map(e => e.vendor).sort()).toEqual(['gemini-3.7-flash-high', 'glm-5.3-flash']);
    });

    it('configurable non-minimax second eye runs as a normal eye for a foreign generator', () => {
      const plan = judgeEyePlan({
        generatorIdentity: 'minimax/minimax-m3',
        evaluatorVendor: '',
        minimaxVendor: 'glm-4.6v',
        glmFlashVendor: 'glm-5.3-flash',
      });
      expect(plan.familyExclusionApplied).toBe(false);
      expect(plan.eyes.filter(e => !e.skipReason).map(e => e.vendor).sort()).toEqual(['glm-4.6v', 'glm-5.3-flash']);
    });

    it('glm-family generator: glm flash eye withheld, minimax + evaluator keep the ensemble', () => {
      const plan = judgeEyePlan({
        generatorIdentity: 'glm/glm-5.3',
        evaluatorVendor: 'gemini-3.7-flash-high',
        ...fixed,
        evaluatorVisionCapable: true,
      });
      expect(plan.generatorFamily).toBe('glm');
      const run = plan.eyes.filter(e => !e.skipReason);
      expect(run.map(e => e.vendor).sort()).toEqual(['gemini-3.7-flash-high', 'minimax-m3']);
      expect(plan.eyes.find(e => e.vendor === 'glm-5.3-flash')?.skipReason).toBe('generator-family-exclusion');
    });

    it('degrades honestly: no alternates means the same-family eye still runs', () => {
      const plan = judgeEyePlan({
        generatorIdentity: 'minimax/minimax-m3',
        evaluatorVendor: '',
        ...fixed,
      });
      expect(plan.familyExclusionApplied).toBe(false);
      const run = plan.eyes.filter(e => !e.skipReason);
      expect(run.map(e => e.vendor).sort()).toEqual(['glm-5.3-flash', 'minimax-m3']);
    });

    it('duplicate evaluator (glm-flash mirrored) collapses to one call', () => {
      const plan = judgeEyePlan({
        generatorIdentity: 'minimax/minimax-m3',
        evaluatorVendor: 'glm-5.3-flash',
        ...fixed,
        evaluatorVisionCapable: true,
      });
      const run = plan.eyes.filter(e => !e.skipReason);
      expect(run.filter(e => e.vendor === 'glm-5.3-flash')).toHaveLength(1);
    });

    it('judgeFamily maps provider/model identities to coarse families', () => {
      expect(judgeFamily('minimax/minimax-m3')).toBe('minimax');
      expect(judgeFamily('glm/glm-5.3')).toBe('glm');
      expect(judgeFamily('kilo/gemini-3.7-flash-high')).toBe('google');
      expect(judgeFamily('google/gemini-2.5-flash')).toBe('google');
      expect(judgeFamily('glm-5.3-flash')).toBe('glm');
      expect(judgeFamily('xai/grok-4.5')).toBe('xai');
      expect(judgeFamily('')).toBe('');
    });
  });
});
