/**
 * TasteModelTrainer — Phase 15
 *
 * Trains a local taste model from preference pairs.
 * Uses a simple weighted distance model (no ML framework dependency).
 *
 * The model learns a weight vector over descriptor axes that
 * maximizes agreement with observed preferences. This is essentially
 * learning which descriptor dimensions matter most to the user.
 */

import type { PreferencePair } from './PreferenceDatasetBuilder.js';

export interface TasteModelWeights {
  /** Per-axis weights (aligned with descriptor values order) */
  axisWeights: number[];
  /** Quality weight (how much quality score matters vs descriptor) */
  qualityWeight: number;
  /** Training metadata */
  trainedAt: string;
  /** Number of training pairs */
  pairCount: number;
  /** Strict agreement rate on training data (in-sample; ties are NOT correct) */
  trainingAgreement: number;
  /** Fraction of training pairs the model scores as an exact tie */
  trainingTieRate?: number;
  /** Pairs dropped for non-finite values or descriptor-dimension mismatch */
  rejectedPairCount?: number;
  /** Strict agreement on root-held-out pairs; absent when no held-out set existed */
  heldOutAgreement?: number;
  /** Tie rate on root-held-out pairs */
  heldOutTieRate?: number;
  /** Number of root-held-out pairs evaluated */
  heldOutPairCount?: number;
}

export interface TasteModelTrainerConfig {
  /** Learning rate (default: 0.1) */
  learningRate?: number;
  /** Number of training epochs (default: 50) */
  epochs?: number;
  /** Regularization to prevent overfitting (default: 0.01) */
  regularization?: number;
  /** Seed for the per-epoch shuffle; same seed + same pairs = same model (default: 1) */
  seed?: number;
}

/** Strict pairwise agreement: ties are counted separately, never as correct. */
export interface PairAgreement {
  agreement: number;
  tieRate: number;
}

export function scorePairAgreement(
  pairs: PreferencePair[],
  predict: (artifact: { descriptor: number[]; quality: number }) => number,
): PairAgreement {
  if (pairs.length === 0) return { agreement: 0, tieRate: 0 };
  let correct = 0;
  let ties = 0;
  for (const pair of pairs) {
    const predW = predict(pair.winner);
    const predL = predict(pair.loser);
    if (predW > predL) correct++;
    else if (predW === predL) ties++;
  }
  return { agreement: correct / pairs.length, tieRate: ties / pairs.length };
}

function isUsablePair(pair: PreferencePair, dimCount: number): boolean {
  const side = (a: { descriptor: number[]; quality: number }) =>
    a.descriptor.length === dimCount
    && a.descriptor.every(Number.isFinite)
    && Number.isFinite(a.quality);
  return side(pair.winner) && side(pair.loser) && Number.isFinite(pair.confidence);
}

const DEFAULT_LR = 0.1;
const DEFAULT_EPOCHS = 50;
const DEFAULT_REG = 0.01;
const DEFAULT_SEED = 1;

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unbiased Fisher-Yates shuffle (returns a new array). */
export function seededShuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class TasteModelTrainer {
  private readonly lr: number;
  private readonly epochs: number;
  private readonly reg: number;
  private readonly seed: number;

  constructor(config: TasteModelTrainerConfig = {}) {
    this.lr = config.learningRate ?? DEFAULT_LR;
    this.epochs = config.epochs ?? DEFAULT_EPOCHS;
    this.reg = config.regularization ?? DEFAULT_REG;
    this.seed = config.seed ?? DEFAULT_SEED;
  }

  /**
   * Train a taste model from preference pairs.
   * Returns learned weights over descriptor dimensions.
   */
  train(inputPairs: PreferencePair[]): TasteModelWeights {
    const dimCount = inputPairs[0]?.winner.descriptor.length ?? 0;
    const pairs = inputPairs.filter(p => isUsablePair(p, dimCount));
    const rejectedPairCount = inputPairs.length - pairs.length;
    if (pairs.length === 0) {
      return {
        axisWeights: [],
        qualityWeight: 0.5,
        trainedAt: new Date().toISOString(),
        pairCount: 0,
        trainingAgreement: 0,
        trainingTieRate: 0,
        rejectedPairCount,
      };
    }

    const axisWeights = new Array(dimCount).fill(1 / dimCount);
    let qualityWeight = 0.5;
    const rand = mulberry32(this.seed);

    for (let epoch = 0; epoch < this.epochs; epoch++) {
      // Seeded, unbiased shuffle each epoch so training is replayable
      const shuffled = seededShuffle(pairs, rand);

      for (const pair of shuffled) {
        const predW = this.predict(axisWeights, qualityWeight, pair.winner);
        const predL = this.predict(axisWeights, qualityWeight, pair.loser);

        // Margin-based loss: we want predW > predL
        const margin = predW - predL;
        if (margin > 0.1) continue; // Already correct with margin

        // Gradient update: push weights toward preferring winner's dimensions
        const grad = Math.min(1, (0.1 - margin)) * pair.confidence;
        for (let i = 0; i < dimCount; i++) {
          const diff = pair.winner.descriptor[i] - pair.loser.descriptor[i];
          axisWeights[i] += this.lr * grad * diff;
          // L2 regularization
          axisWeights[i] -= this.reg * axisWeights[i];
        }

        // Quality weight gradient
        const qDiff = pair.winner.quality - pair.loser.quality;
        qualityWeight += this.lr * grad * qDiff;
        qualityWeight -= this.reg * (qualityWeight - 0.5);
      }

      // Normalize weights to sum to 1 (keep quality separate)
      const sum = axisWeights.reduce((a, b) => a + Math.abs(b), 0);
      if (sum > 0) {
        for (let i = 0; i < dimCount; i++) axisWeights[i] /= sum;
      }
      qualityWeight = Math.max(0, Math.min(1, qualityWeight));
    }

    const { agreement, tieRate } = scorePairAgreement(
      pairs, a => this.predict(axisWeights, qualityWeight, a),
    );

    return {
      axisWeights,
      qualityWeight,
      trainedAt: new Date().toISOString(),
      pairCount: pairs.length,
      trainingAgreement: agreement,
      trainingTieRate: tieRate,
      rejectedPairCount,
    };
  }

  predict(
    axisWeights: number[],
    qualityWeight: number,
    artifact: { descriptor: number[]; quality: number },
  ): number {
    const descScore = axisWeights.reduce(
      (sum, w, i) => sum + w * (artifact.descriptor[i] ?? 0), 0,
    );
    return (descScore * (1 - qualityWeight)) + (artifact.quality * qualityWeight);
  }
}
