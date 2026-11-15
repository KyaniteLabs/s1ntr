/**
 * TasteModelEvaluator — Phase 15
 *
 * Evaluates taste model quality using held-out preference pairs.
 * Measures ranking correlation, agreement rate, and calibration.
 */

import type { ArchiveEntry } from '../emergence/types.js';
import type { PreferencePair } from './PreferenceDatasetBuilder.js';
import type { TasteModelWeights } from './TasteModelTrainer.js';
import { TasteModelRuntime } from './TasteModelRuntime.js';

export interface TasteEvaluationResult {
  /** Fraction of held-out pairs strictly predicted (ties are not correct) */
  agreement: number;
  /** Fraction of held-out pairs the model scores as an exact tie */
  tieRate: number;
  /** Kendall tau rank correlation between predicted and actual preferences */
  kendallTau: number;
  /** How many high-confidence predictions were correct */
  calibration: number;
  /** Number of evaluation pairs */
  pairCount: number;
  /** Whether the model is better than baseline (quality-only ranking) */
  beatsBaseline: boolean;
}

export interface TasteModelEvaluatorConfig {
  /** Fraction of data to hold out for evaluation (default: 0.2) */
  holdoutFraction?: number;
}

const DEFAULT_HOLDOUT = 0.2;

const EMPTY_RESULT: TasteEvaluationResult = {
  agreement: 0, tieRate: 0, kendallTau: 0, calibration: 0, pairCount: 0, beatsBaseline: false,
};

/** Walk first-parent lineage inside the entry set to the oldest known ancestor. */
export function lineageRootOf(entry: ArchiveEntry, byId: Map<string, ArchiveEntry>): string {
  let current = entry;
  const seen = new Set<string>([current.id]);
  for (;;) {
    const parentId = current.lineage?.parentIds?.[0];
    if (!parentId) return current.id;
    const parent = byId.get(parentId);
    if (!parent) return parentId;
    if (seen.has(parent.id)) return current.id;
    seen.add(parent.id);
    current = parent;
  }
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Split archive entries by lineage root BEFORE pair construction, so no root's
 * descendants appear on both sides. Roots are ordered by a stable hash and the
 * first `holdoutFraction` of them are held out. Fewer than `minRoots` → no
 * held-out set (an honest "cannot evaluate", never an in-sample stand-in).
 */
export function splitEntriesByRoot(
  entries: ArchiveEntry[],
  holdoutFraction: number = DEFAULT_HOLDOUT,
  minRoots = 2,
): { train: ArchiveEntry[]; test: ArchiveEntry[]; rootCount: number } {
  const byId = new Map(entries.map(e => [e.id, e]));
  const rootOf = new Map(entries.map(e => [e.id, lineageRootOf(e, byId)]));
  const roots = [...new Set(rootOf.values())].sort((a, b) => fnv1a(a) - fnv1a(b) || a.localeCompare(b));
  if (roots.length < Math.max(2, minRoots)) return { train: entries, test: [], rootCount: roots.length };
  const testCount = Math.min(roots.length - 1, Math.max(1, Math.round(roots.length * holdoutFraction)));
  const testRoots = new Set(roots.slice(0, testCount));
  return {
    train: entries.filter(e => !testRoots.has(rootOf.get(e.id)!)),
    test: entries.filter(e => testRoots.has(rootOf.get(e.id)!)),
    rootCount: roots.length,
  };
}

export class TasteModelEvaluator {
  private readonly holdoutFraction: number;

  constructor(config: TasteModelEvaluatorConfig = {}) {
    this.holdoutFraction = config.holdoutFraction ?? DEFAULT_HOLDOUT;
  }

  /**
   * Split pairs into train/test, evaluate model on test set.
   */
  evaluate(
    pairs: PreferencePair[],
    weights: TasteModelWeights,
  ): TasteEvaluationResult {
    if (pairs.length < 4) return { ...EMPTY_RESULT };
    return this.evaluatePairs(this.split(pairs).test, weights);
  }

  /**
   * Evaluate every given pair as held-out data. Callers are responsible for the
   * pairs being genuinely unseen (see {@link splitEntriesByRoot}).
   */
  evaluatePairs(
    testPairs: PreferencePair[],
    weights: TasteModelWeights,
  ): TasteEvaluationResult {
    if (testPairs.length === 0) return { ...EMPTY_RESULT };

    const runtime = new TasteModelRuntime();
    runtime.load(weights);

    let modelCorrect = 0;
    let ties = 0;
    let baselineCorrect = 0;
    let highConfCorrect = 0;
    let highConfTotal = 0;
    let concordant = 0;
    let discordant = 0;

    for (const pair of testPairs) {
      const predW = runtime.score({
        descriptor: { values: pair.winner.descriptor.map((v) => ({ axis: 'order-chaos' as const, value: v })), source: 'eval', extractedAt: '' },
        qualityScore: pair.winner.quality,
      });
      const predL = runtime.score({
        descriptor: { values: pair.loser.descriptor.map((v) => ({ axis: 'order-chaos' as const, value: v })), source: 'eval', extractedAt: '' },
        qualityScore: pair.loser.quality,
      });

      if (predW > predL) { modelCorrect++; concordant++; }
      else if (predW < predL) discordant++;
      else ties++;

      // Baseline: quality-only prediction, also strict
      if (pair.winner.quality > pair.loser.quality) baselineCorrect++;

      const margin = Math.abs(predW - predL);
      if (margin > 0.1) {
        highConfTotal++;
        if (predW > predL) highConfCorrect++;
      }
    }

    const agreement = modelCorrect / testPairs.length;
    const baselineAgreement = baselineCorrect / testPairs.length;
    const decided = concordant + discordant;

    return {
      agreement,
      tieRate: ties / testPairs.length,
      kendallTau: decided > 0 ? (concordant - discordant) / decided : 0,
      calibration: highConfTotal > 0 ? highConfCorrect / highConfTotal : 0,
      pairCount: testPairs.length,
      beatsBaseline: agreement > baselineAgreement,
    };
  }

  /**
   * Get the holdout split for external training.
   */
  split(pairs: PreferencePair[]): { train: PreferencePair[]; test: PreferencePair[] } {
    const test: PreferencePair[] = [];
    const train: PreferencePair[] = [];
    const step = Math.round(1 / this.holdoutFraction);

    for (let i = 0; i < pairs.length; i++) {
      if (i % step === 0) test.push(pairs[i]);
      else train.push(pairs[i]);
    }

    return { train, test };
  }
}
