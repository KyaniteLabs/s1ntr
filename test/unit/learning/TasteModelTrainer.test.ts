/**
 * Unit tests for TasteModelTrainer — Phase 15
 *
 * Tests margin-based SGD training over descriptor dimensions.
 */

import { describe, it, expect, vi } from 'vitest';
import { TasteModelTrainer, seededShuffle } from '../../../src/learning/TasteModelTrainer.js';
import type { PreferencePair } from '../../../src/learning/PreferenceDatasetBuilder.js';

function makePair(
  winnerDesc: number[], winnerQuality: number,
  loserDesc: number[], loserQuality: number,
  confidence: number = 0.9,
): PreferencePair {
  return {
    winner: { id: 'winner', descriptor: winnerDesc, quality: winnerQuality },
    loser: { id: 'loser', descriptor: loserDesc, quality: loserQuality },
    source: 'pairwise-a',
    channel: 'human',
    confidence,
    capturedAt: new Date().toISOString(),
  };
}

describe('TasteModelTrainer', () => {
  it('returns empty weights for zero pairs', () => {
    const trainer = new TasteModelTrainer();
    const weights = trainer.train([]);
    expect(weights.axisWeights).toEqual([]);
    expect(weights.qualityWeight).toBe(0.5);
    expect(weights.pairCount).toBe(0);
    expect(weights.trainingAgreement).toBe(0);
  });

  it('learns axis weights from training pairs', () => {
    const trainer = new TasteModelTrainer({ epochs: 200, learningRate: 0.3, regularization: 0.001 });
    // Equal quality forces model to learn from descriptors alone
    const pairs = Array.from({ length: 20 }, () =>
      makePair([0.9, 0.1], 0.5, [0.1, 0.9], 0.5),
    );
    const weights = trainer.train(pairs);
    expect(weights.axisWeights).toHaveLength(2);
    // First axis weight should exceed second (winner always high on dim 0)
    expect(weights.axisWeights[0]).toBeGreaterThan(weights.axisWeights[1]);
  });

  it('predict produces consistent scores', () => {
    const trainer = new TasteModelTrainer();
    const axisWeights = [0.6, 0.4];
    const qualityWeight = 0.3;
    const artifact = { descriptor: [0.8, 0.2], quality: 0.7 };
    const score = trainer.predict(axisWeights, qualityWeight, artifact);
    const expected = (0.6 * 0.8 + 0.4 * 0.2) * (1 - 0.3) + 0.7 * 0.3;
    expect(score).toBeCloseTo(expected, 5);
  });

  it('predict shows winner > loser after training', () => {
    const trainer = new TasteModelTrainer({ epochs: 100 });
    const pairs = Array.from({ length: 20 }, () =>
      makePair([0.9, 0.1], 0.9, [0.1, 0.9], 0.1),
    );
    const weights = trainer.train(pairs);
    const predW = trainer.predict(weights.axisWeights, weights.qualityWeight, pairs[0].winner);
    const predL = trainer.predict(weights.axisWeights, weights.qualityWeight, pairs[0].loser);
    expect(predW).toBeGreaterThan(predL);
  });

  it('trainingAgreement reflects correct predictions on training data', () => {
    const trainer = new TasteModelTrainer({ epochs: 100 });
    const pairs = Array.from({ length: 20 }, () =>
      makePair([0.9, 0.1], 0.9, [0.1, 0.9], 0.1),
    );
    const weights = trainer.train(pairs);
    expect(weights.trainingAgreement).toBeGreaterThan(0.5);
  });

  it('applies regularization to prevent overfitting', () => {
    const trainer = new TasteModelTrainer({ epochs: 50, regularization: 0.1 });
    const pairs = Array.from({ length: 10 }, () =>
      makePair([0.8, 0.2], 0.7, [0.2, 0.8], 0.4),
    );
    const weights = trainer.train(pairs);
    // With strong regularization, weights should stay moderate
    for (const w of weights.axisWeights) {
      expect(w).toBeLessThanOrEqual(1);
      expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it('zero-confidence pairs have minimal impact', () => {
    const trainer = new TasteModelTrainer({ epochs: 50 });
    const pairs = Array.from({ length: 10 }, () =>
      makePair([0.9, 0.1], 0.9, [0.1, 0.9], 0.1, 0.0),
    );
    const weights = trainer.train(pairs);
    // With zero confidence, weights should remain near uniform
    expect(weights.axisWeights[0]).toBeCloseTo(weights.axisWeights[1], 1);
  });

  describe('seeded shuffle (#1240)', () => {
    // Conflicting pairs make the learned weights depend on visit order.
    const conflicting = [
      makePair([0.9, 0.1, 0.4], 0.5, [0.1, 0.9, 0.6], 0.5, 0.9),
      makePair([0.2, 0.8, 0.3], 0.6, [0.7, 0.3, 0.5], 0.4, 0.6),
      makePair([0.5, 0.5, 0.9], 0.5, [0.4, 0.6, 0.1], 0.5, 0.8),
      makePair([0.1, 0.3, 0.2], 0.7, [0.8, 0.2, 0.9], 0.3, 0.7),
      makePair([0.6, 0.4, 0.5], 0.4, [0.3, 0.7, 0.4], 0.6, 0.5),
    ];

    it('same seed and pairs produce identical weights', () => {
      const a = new TasteModelTrainer({ seed: 42, epochs: 30 }).train(conflicting);
      const b = new TasteModelTrainer({ seed: 42, epochs: 30 }).train(conflicting);
      expect(a.axisWeights).toEqual(b.axisWeights);
      expect(a.qualityWeight).toBe(b.qualityWeight);
    });

    it('does not draw from Math.random', () => {
      const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('unseeded randomness');
      });
      try {
        const w = new TasteModelTrainer({ epochs: 5 }).train(conflicting);
        expect(w.pairCount).toBe(5);
      } finally {
        spy.mockRestore();
      }
    });

    it('seededShuffle returns a permutation and leaves the input intact', () => {
      const input = [1, 2, 3, 4, 5, 6, 7, 8];
      let x = 0;
      const out = seededShuffle(input, () => ((x = (x * 9301 + 49297) % 233280) / 233280));
      expect([...out].sort((p, q) => p - q)).toEqual(input);
      expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('seededShuffle is unbiased: each position of 3 items sees each value ~1/3 of the time', () => {
      let state = 7;
      const rand = () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
      };
      const firstCounts = [0, 0, 0];
      const trials = 30000;
      for (let i = 0; i < trials; i++) firstCounts[seededShuffle([0, 1, 2], rand)[0]]++;
      for (const c of firstCounts) expect(Math.abs(c / trials - 1 / 3)).toBeLessThan(0.02);
    });

    it('seededShuffle handles empty and single-element input', () => {
      expect(seededShuffle([], () => 0.5)).toEqual([]);
      expect(seededShuffle(['only'], () => 0.5)).toEqual(['only']);
    });
  });

  it('does not count ties as agreement and reports them separately', () => {
    const trainer = new TasteModelTrainer({ epochs: 5, seed: 1 });
    // Identical winner/loser → every prediction is an exact tie.
    const pairs = Array.from({ length: 4 }, () => makePair([0.5, 0.5], 0.5, [0.5, 0.5], 0.5));
    const weights = trainer.train(pairs);
    expect(weights.trainingAgreement).toBe(0);
    expect(weights.trainingTieRate).toBe(1);
  });

  it('is reproducible under a fixed seed', () => {
    const pairs = [
      makePair([0.9, 0.1], 0.2, [0.1, 0.9], 0.8),
      makePair([0.2, 0.7], 0.9, [0.6, 0.3], 0.1),
      makePair([0.4, 0.4], 0.6, [0.8, 0.2], 0.5),
      makePair([0.1, 0.3], 0.7, [0.5, 0.9], 0.2),
    ];
    const a = new TasteModelTrainer({ epochs: 30, seed: 42 }).train(pairs);
    const b = new TasteModelTrainer({ epochs: 30, seed: 42 }).train(pairs);
    expect(b.axisWeights).toEqual(a.axisWeights);
    expect(b.qualityWeight).toBe(a.qualityWeight);
  });

  it('rejects non-finite and dimension-mismatched pairs instead of training on them', () => {
    const good = makePair([0.9, 0.1], 0.9, [0.1, 0.9], 0.1);
    const nan = makePair([Number.NaN, 0.1], 0.9, [0.1, 0.9], 0.1);
    const short = makePair([0.9], 0.9, [0.1, 0.9], 0.1);
    const weights = new TasteModelTrainer({ seed: 3 }).train([good, nan, short, good]);
    expect(weights.pairCount).toBe(2);
    expect(weights.rejectedPairCount).toBe(2);
    expect(weights.axisWeights.every(Number.isFinite)).toBe(true);
  });
});
