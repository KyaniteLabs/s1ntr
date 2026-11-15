import { describe, expect, it } from 'vitest';
import {
  candidateSetDigest,
  createCreativeJudgmentProfile,
  learnCreativeJudgment,
  scoreCreativeJudgment,
  type CreativeJudgmentCandidate,
} from '../../../src/learning/CreativeJudgmentCalibration.js';

const evidenceDigest = (digit: string) => digit.repeat(64);
const candidates: CreativeJudgmentCandidate[] = [
  {
    id: 'A', evidenceDigest: evidenceDigest('a'),
    dimensions: { cohesion: 0.75, structuralDepth: 0.9, spatialEmbodiment: 0.93, materiality: 0.92, motionPurpose: 0.8,
      composition: 0.8, palette: 0.75, finish: 0.78 },
  },
  {
    id: 'B', evidenceDigest: evidenceDigest('b'),
    dimensions: { cohesion: 0.92, structuralDepth: 0.82, spatialEmbodiment: 0.84, materiality: 0.84, motionPurpose: 0.9,
      composition: 0.88, palette: 0.94, finish: 0.86 },
  },
  {
    id: 'C', evidenceDigest: evidenceDigest('c'),
    dimensions: { cohesion: 0.7, structuralDepth: 0.45, spatialEmbodiment: 0.4, materiality: 0.5, motionPurpose: 0.62,
      composition: 0.72, palette: 0.8, finish: 0.74 },
  },
];

function comparison() {
  return {
    schema: 'sinter.creative-judgment-comparison' as const,
    candidateSetDigest: candidateSetDigest(candidates),
    referenceRanking: ['B', 'A', 'C'],
    evaluatorRanking: ['B', 'C', 'A'],
    candidates,
  };
}

describe('CreativeJudgmentCalibration', () => {
  it('corrects a rank inversion by learning general craft weights', () => {
    const baseline = createCreativeJudgmentProfile();
    const learned = learnCreativeJudgment(comparison(), baseline);

    expect(learned.weights.structuralDepth).toBeGreaterThan(baseline.weights.structuralDepth);
    expect(learned.weights.spatialEmbodiment).toBeGreaterThan(baseline.weights.spatialEmbodiment);
    expect(scoreCreativeJudgment(candidates[1].dimensions, learned))
      .toBeGreaterThan(scoreCreativeJudgment(candidates[2].dimensions, learned));
    expect(scoreCreativeJudgment(candidates[0].dimensions, learned))
      .toBeGreaterThan(scoreCreativeJudgment(candidates[2].dimensions, learned));
    expect(learned.sourceCandidateSetDigests).toEqual([comparison().candidateSetDigest]);
  });

  it('does not change weights when rankings already agree', () => {
    const baseline = createCreativeJudgmentProfile();
    const learned = learnCreativeJudgment({
      ...comparison(), evaluatorRanking: ['B', 'A', 'C'],
    }, baseline);
    expect(learned.weights).toEqual(baseline.weights);
  });

  it('rejects evidence that is not bound to the candidate set', () => {
    expect(() => learnCreativeJudgment({
      ...comparison(), candidateSetDigest: evidenceDigest('f'),
    })).toThrow('CREATIVE_JUDGMENT_CANDIDATE_SET_DIGEST_MISMATCH');
  });

  it('learns hierarchy guidance instead of overfitting non-separable dimensions', () => {
    const dominated = candidates.map(candidate => candidate.id === 'A'
      ? { ...candidate, dimensions: { cohesion: 0.4, structuralDepth: 0.4, spatialEmbodiment: 0.4, materiality: 0.4,
        motionPurpose: 0.4, composition: 0.4, palette: 0.4, finish: 0.4 } }
      : candidate.id === 'C'
        ? { ...candidate, dimensions: { cohesion: 0.8, structuralDepth: 0.8, spatialEmbodiment: 0.8, materiality: 0.8,
          motionPurpose: 0.8, composition: 0.8, palette: 0.8, finish: 0.8 } }
        : candidate);
    const learned = learnCreativeJudgment({
      ...comparison(), candidates: dominated, candidateSetDigest: candidateSetDigest(dominated),
    });
    expect(learned.weights).toEqual(createCreativeJudgmentProfile().weights);
    expect(learned.guidance).toEqual([
      expect.stringContaining('first exclude visibly flat, unembodied work'),
    ]);
  });
});
