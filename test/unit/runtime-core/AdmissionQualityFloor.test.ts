import { describe, expect, it } from 'vitest';
import { RenderedAdmissionAuthority, type BoundRenderedEvidence, type EvaluatorResult } from '../../../src/runtime-core/LiminalCommandService';
import { ADMISSION_BROKEN_FLOOR } from '../../../src/aesthetic/qualityFloor';

/**
 * #1777: admission ignored the judge's score, so near-black hydra frames the
 * judge rated 0.02-0.06 ("broken — blank, black") were accepted. Everything
 * else in these fixtures is clean, so the score alone decides.
 */
const evidence: BoundRenderedEvidence = {
  status: 'rendered', rendererIdentity: 'renderer', earlyFrameDigest: 'a', lateFrameDigest: 'b',
  runtimeErrors: [], audio: { relevant: false } as BoundRenderedEvidence['audio'], evidenceDigest: 'd',
};
const judged = (score: number, degraded = false): EvaluatorResult => ({
  score, degraded, identityValid: true, evaluatorIdentity: 'judge', evidenceDigest: 'd',
});
const decide = (evaluation: EvaluatorResult) => new RenderedAdmissionAuthority().decide({
  mode: 'strict-browser', evidence, evaluation, expectedRenderer: 'renderer',
  expectedEvaluator: 'judge', renderAuthorization: 'test-fake',
});

describe('admission quality floor (#1777)', () => {
  it.each([0, 0.02, 0.04, 0.39])('rejects a clean render the judge scored %s as broken', (score) => {
    const result = decide(judged(score));
    expect(result.admissionEligible).toBe(false);
    expect(result.rejectionReasons).toEqual(['below-quality-floor']);
  });

  it.each([ADMISSION_BROKEN_FLOOR, 0.58, 0.6, 0.82, 1])('admits a clean render the judge scored %s', (score) => {
    expect(decide(judged(score)).admissionEligible).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])('never admits a nonsense score (%s)', (score) => {
    expect(decide(judged(score)).rejectionReasons).toContain('below-quality-floor');
  });

  it('admits a piece the judge calls poor but the operator loves (hy4f hydra-buffers-xhigh-r1, 0.58)', () => {
    expect(decide(judged(0.58)).admissionEligible).toBe(true);
  });

  it('reports a degraded judge as degraded, not as a low score', () => {
    expect(decide(judged(0, true)).rejectionReasons).toEqual(['evaluation-degraded']);
  });
});
