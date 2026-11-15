/**
 * K-NN weighted average prediction from human feedback.
 * Predicts quality [0, 1] for a behavior vector based on similar rated creations.
 */

import fs from 'fs/promises';
import { Logger } from '../utils/Logger.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';

export interface AestheticDataPoint {
  behavior: number[];
  rating: number;    // 0-5
  domain: string;
}

type AestheticLoadState = 'unloaded' | 'ok' | 'missing' | 'corrupt';

export class AestheticModel {
  private data: AestheticDataPoint[];
  private kNeighbors: number;
  private loadState: AestheticLoadState = 'unloaded';

  constructor(kNeighbors?: number) {
    this.kNeighbors = kNeighbors ?? 5;
    this.data = [];
  }

  /** Euclidean distance between two vectors, with zero-padding for dimension mismatch */
  private distance(a: number[], b: number[]): number {
    const dim = Math.max(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < dim; i++) {
      const ai = i < a.length ? a[i] : 0;
      const bi = i < b.length ? b[i] : 0;
      const diff = ai - bi;
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  /**
   * Predict quality [0, 1] for a behavior vector based on similar rated creations.
   * Uses inverse-distance weighted average of k nearest neighbors' ratings.
   * Domain bonus: matching domain multiplies weight by 1.5.
   */
  predict(behavior: number[], metadata: { domain: string }): number {
    if (this.data.length === 0) return 0.5;

    const k = Math.min(this.kNeighbors, this.data.length);
    const distances = this.data.map((point) => ({
      point,
      dist: this.distance(behavior, point.behavior),
    }));
    distances.sort((a, b) => a.dist - b.dist);

    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < k; i++) {
      const { point, dist } = distances[i];
      let weight = dist === 0 ? 1.0 : 1.0 / dist;
      if (point.domain === metadata.domain) {
        weight *= 1.5;
      }
      weightedSum += weight * point.rating;
      totalWeight += weight;
    }

    return (weightedSum / totalWeight) / 5;
  }

  /** Add training data from human feedback */
  update(feedbacks: AestheticDataPoint[]): void {
    this.data.push(...feedbacks);
  }

  /** Save model data to JSON file (atomically; refuses after a corrupt load). */
  async save(path: string): Promise<void> {
    if (this.loadState === 'corrupt') {
      Logger.warn('AestheticModel', `Refusing to overwrite ${path}: the previous load was corrupt and has been quarantined.`);
      return;
    }
    await writeFileAtomic(path, JSON.stringify(this.data), { mode: 0o600 });
  }

  /** Load model data from JSON file; quarantine corrupt state instead of wiping it. */
  async load(path: string): Promise<void> {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((point) => (
        point !== null && typeof point === 'object'
        && Array.isArray((point as AestheticDataPoint).behavior)
        && typeof (point as AestheticDataPoint).rating === 'number'
        && typeof (point as AestheticDataPoint).domain === 'string'
      ))) {
        throw new Error('expected an array of { behavior, rating, domain }');
      }
      this.data = parsed as AestheticDataPoint[];
      this.loadState = 'ok';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = [];
        this.loadState = 'missing';
        return;
      }
      const quarantined = `${path}.corrupt.${Date.now()}`;
      await fs.rename(path, quarantined).catch(() => undefined);
      this.data = [];
      this.loadState = 'corrupt';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`AESTHETIC_MODEL_CORRUPT: ${path} (${message}); moved to ${quarantined}`);
    }
  }

  /** Get number of training data points */
  size(): number {
    return this.data.length;
  }

  /** Clear all training data */
  clear(): void {
    this.data = [];
  }
}
