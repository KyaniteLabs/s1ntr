import { describe, expect, it } from 'vitest';

import { calculateGaps, parseAssignments, planAttempts, scoreBucket } from '../../../scripts/quality/harvest-evaluator-score-bands.mjs';

describe('harvest-evaluator-score-bands', () => {
  it('maps scores into evaluator buckets', () => {
    expect(scoreBucket(0.9)).toBe('excellent');
    expect(scoreBucket(0.7)).toBe('good');
    expect(scoreBucket(0.5)).toBe('marginal');
    expect(scoreBucket(0.2)).toBe('poor');
  });

  it('calculates current evaluator gaps', () => {
    const gaps = calculateGaps({ rows: 198, buckets: { excellent: 66, good: 19, poor: 113 }, domains: { hydra: 18 } });
    expect(gaps.bucketGaps.marginal.need).toBe(75);
    expect(gaps.bucketGaps.good.need).toBe(56);
    expect(gaps.bucketGaps.excellent.need).toBe(9);
    expect(gaps.domainGaps.hydra.need).toBe(2);
  });

  it('plans attempts toward the largest gaps and domain gaps first', () => {
    const gaps = calculateGaps({ rows: 0, buckets: { good: 74 }, domains: { hydra: 18 } }, parseAssignments('marginal=2,good=75,excellent=0'), parseAssignments('hydra=20'));
    const plan = planAttempts(gaps, 4, ['p5']);
    expect(plan).toHaveLength(4);
    expect(plan[0].domain).toBe('hydra');
    expect(plan[0].targetBucket).toBe('marginal');
    expect(plan.some((item) => item.prompt.includes('Harvest target band'))).toBe(true);
  });
});
