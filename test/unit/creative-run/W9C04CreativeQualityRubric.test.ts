import { describe, expect, it } from 'vitest';
import {
  RUBRIC_V1_DIMENSIONS,
  RUBRIC_DIMENSIONS,
  computeEligibility,
  createQualityReview,
  type CreativeQualityReview,
} from '../../../src/creative-run/CreativeQualityRubric.js';

function score(dim: string, s: number, digest = 'a'): { dimension: typeof RUBRIC_DIMENSIONS[number]; score: number; evidenceDigest: string } {
  return { dimension: dim as typeof RUBRIC_DIMENSIONS[number], score: s, evidenceDigest: digest.repeat(64).slice(0, 64) };
}

function makeReview(role: 'specialist' | 'holistic', scores: ReturnType<typeof score>[], flaws: any[] = []): CreativeQualityReview {
  return createQualityReview({
    reviewerRole: role, reviewerModel: role === 'specialist' ? 'minimax-m3' : 'glm-4-flash',
    candidateId: 'c1', briefId: 'b1', scores, criticalFlaws: flaws, audioPresent: true,
  });
}

describe('W9C-04: CreativeQualityRubric v1', () => {
  it('defines exactly seven dimensions', () => {
    expect(RUBRIC_DIMENSIONS.length).toBe(7);
    expect(RUBRIC_V1_DIMENSIONS.length).toBe(7);
  });

  it('has three hard-floor dimensions: coherence, specificity, intentionality', () => {
    const hard = RUBRIC_V1_DIMENSIONS.filter((d) => d.hardFloor).map((d) => d.id);
    expect(hard).toEqual(['coherence', 'specificity', 'intentionality']);
  });

  it('has three holistic-minimum dimensions with threshold 4', () => {
    const min4 = RUBRIC_V1_DIMENSIONS.filter((d) => d.holisticMinimum === 4).map((d) => d.id);
    expect(min4).toEqual(['coherence', 'specificity', 'intentionality']);
  });

  it('has anchors at levels 1, 3, 5 for every dimension', () => {
    for (const dim of RUBRIC_V1_DIMENSIONS) {
      const levels = dim.anchors.map((a) => a.level).sort();
      expect(levels).toEqual([1, 3, 5]);
    }
  });

  it('marks crossModalCausality as audio-required', () => {
    const xmodal = RUBRIC_V1_DIMENSIONS.find((d) => d.id === 'crossModalCausality');
    expect(xmodal?.requiresAudio).toBe(true);
  });

  it('passes eligibility when all thresholds met', () => {
    const specialist = makeReview('specialist', [
      score('coherence', 5), score('specificity', 4), score('surprise', 4),
      score('emotionalTemporalArc', 4), score('crossModalCausality', 3),
      score('intentionality', 5), score('desireToRevisit', 4),
    ]);
    const holistic = makeReview('holistic', [
      score('coherence', 5), score('specificity', 4), score('surprise', 3),
      score('emotionalTemporalArc', 3), score('crossModalCausality', 3),
      score('intentionality', 4), score('desireToRevisit', 3),
    ]);
    const result = computeEligibility(specialist, holistic, true);
    expect(result.eligible).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when specialist is missing', () => {
    const holistic = makeReview('holistic', RUBRIC_DIMENSIONS.map((d) => score(d, 5)));
    const result = computeEligibility(undefined, holistic, true);
    expect(result.eligible).toBe(false);
    expect(result.failures).toContain('missing-specialist-review');
  });

  it('fails when holistic is missing', () => {
    const specialist = makeReview('specialist', RUBRIC_DIMENSIONS.map((d) => score(d, 5)));
    const result = computeEligibility(specialist, undefined, true);
    expect(result.eligible).toBe(false);
    expect(result.failures).toContain('missing-holistic-review');
  });

  it('fails when a hard-floor dimension scores below 3 from both reviewers', () => {
    const specialist = makeReview('specialist', [
      score('coherence', 2), score('specificity', 5), score('surprise', 5),
      score('emotionalTemporalArc', 5), score('crossModalCausality', 5),
      score('intentionality', 5), score('desireToRevisit', 5),
    ]);
    const holistic = makeReview('holistic', [
      score('coherence', 2), score('specificity', 5), score('surprise', 5),
      score('emotionalTemporalArc', 5), score('crossModalCausality', 5),
      score('intentionality', 5), score('desireToRevisit', 5),
    ]);
    const result = computeEligibility(specialist, holistic, true);
    expect(result.eligible).toBe(false);
    expect(result.failures.some((f) => f.includes('hard-floor-failed:coherence'))).toBe(true);
  });

  it('fails when holistic coherence below 4', () => {
    const specialist = makeReview('specialist', RUBRIC_DIMENSIONS.map((d) => score(d, 5)));
    const holistic = makeReview('holistic', [
      score('coherence', 3), score('specificity', 5), score('surprise', 5),
      score('emotionalTemporalArc', 5), score('crossModalCausality', 5),
      score('intentionality', 5), score('desireToRevisit', 5),
    ]);
    const result = computeEligibility(specialist, holistic, true);
    expect(result.eligible).toBe(false);
    expect(result.failures.some((f) => f.includes('holistic-below-minimum:coherence'))).toBe(true);
  });

  it('fails when a critical flaw exists', () => {
    const specialist = makeReview('specialist', RUBRIC_DIMENSIONS.map((d) => score(d, 5)));
    const holistic = makeReview('holistic', RUBRIC_DIMENSIONS.map((d) => score(d, 5)),
      [{ dimension: 'coherence', reason: 'Broken interaction', evidenceDigest: 'd'.repeat(64) }]);
    const result = computeEligibility(specialist, holistic, true);
    expect(result.eligible).toBe(false);
    expect(result.failures.some((f) => f.startsWith('critical-flaw'))).toBe(true);
  });

  it('skips crossModalCausality when audio is not required', () => {
    const specialist = makeReview('specialist', RUBRIC_DIMENSIONS
      .filter((d) => d !== 'crossModalCausality').map((d) => score(d, 5)));
    const holistic = makeReview('holistic', RUBRIC_DIMENSIONS
      .filter((d) => d !== 'crossModalCausality').map((d) => score(d, 5)));
    const result = computeEligibility(specialist, holistic, false);
    expect(result.eligible).toBe(true);
  });

  it('creates frozen review objects with correct schema', () => {
    const review = makeReview('specialist', [score('coherence', 4)]);
    expect(review.schema).toBe('sinter.creative-quality-review');
    expect(review.schemaVersion).toBe(1);
    expect(review.rubricVersion).toBe('creative-quality-rubric-v1');
    expect(Object.isFrozen(review)).toBe(true);
    expect(Object.isFrozen(review.scores)).toBe(true);
  });
});
