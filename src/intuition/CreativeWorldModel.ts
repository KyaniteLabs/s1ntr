/**
 * CreativeWorldModel — Predicts quality from code behavior vectors.
 *
 * A K-NN regressor that learns a mapping from "behavior vectors" (code
 * characteristics like technique diversity, interactivity, complexity) to
 * quality scores. Each time a real output is evaluated, its behavior vector
 * and score are recorded. Future predictions use the K nearest neighbors
 * in behavior space to estimate expected quality — no LLM call needed.
 *
 * This is the "world model" of the intuition system: it knows what kind
 * of code tends to score well in each domain, and can predict quality
 * without generating or evaluating anything.
 *
 * @module intuition/CreativeWorldModel
 */

import { Logger } from '../utils/Logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A code behavior vector — numerical features extracted from output. */
export interface BehaviorVector {
  /** Domain this vector belongs to */
  domain: string;
  /** Number of lines of code */
  lineCount: number;
  /** Number of distinct techniques used (0-6) */
  techniqueDiversity: number;
  /** Whether the code has interaction handling (0 or 1) */
  hasInteraction: number;
  /** Whether the code uses color (0 or 1) */
  hasColor: number;
  /** Whether the code uses loops (0 or 1) */
  hasLoops: number;
  /** Whether the code defines functions (0 or 1) */
  hasFunctions: number;
  /** Whether the code uses classes (0 or 1) */
  hasClasses: number;
  /** Comment density (comments / total lines, 0-1) */
  commentDensity: number;
}

/** A recorded observation in the world model. */
export interface WorldObservation {
  /** Behavior vector */
  behavior: BehaviorVector;
  /** Actual quality score (from evaluation) */
  qualityScore: number;
  /** When this was observed */
  timestamp: string;
  /** Optional domain tag for filtering */
  domain: string;
}

/** Prediction result from the world model. */
/**
 * Leave-one-out calibration of the K-NN surrogate on one domain's recorded
 * outcomes, compared with the constant baseline (mean of the other outcomes).
 */
export interface SurrogateCalibration {
  /** Mean absolute LOO error of the K-NN predictor */
  looMae: number;
  /** Mean absolute LOO error of predicting the mean of the other outcomes */
  baselineMae: number;
  /** Observations the calibration used */
  sampleSize: number;
}

export interface QualityPrediction {
  /** Predicted quality score (0-1) */
  predicted: number;
  /**
   * Skill over the constant baseline, 0-1: max(0, 1 - looMae / baselineMae).
   * 0 means static-code K-NN does no better than guessing the domain mean,
   * and callers must not act on `predicted`.
   */
  confidence: number;
  /**
   * What this prediction is: a static code-feature surrogate, not an
   * environment transition model or a reward. Never record it as quality.
   */
  basis: 'static-code-knn-surrogate';
  calibration: SurrogateCalibration;
  /** Number of neighbors used */
  neighborCount: number;
  /** Average distance to neighbors */
  avgDistance: number;
  /** Domain */
  domain: string;
}

/** World model configuration. */
export interface WorldModelConfig {
  /** Number of neighbors for K-NN. Default: 5 */
  kNeighbors?: number;
  /** Maximum observations to retain. Default: 500 */
  maxObservations?: number;
  /** Minimum observations before predictions activate. Default: 3 */
  minObservations?: number;
  /** Whether to normalize features before distance computation. Default: true */
  normalizeFeatures?: boolean;
}

/** Serialized world model state. */
export interface WorldModelState {
  version: number;
  observations: WorldObservation[];
  config: WorldModelConfig;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// CreativeWorldModel
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<WorldModelConfig> = {
  kNeighbors: 5,
  maxObservations: 500,
  minObservations: 3,
  normalizeFeatures: true,
};

export class CreativeWorldModel {
  private observations: WorldObservation[] = [];
  private calibrationCache = new Map<string, SurrogateCalibration>();
  private readonly config: Required<WorldModelConfig>;

  constructor(config?: WorldModelConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Learning
  // ---------------------------------------------------------------------------

  /**
   * Record an observation: behavior vector → quality score.
   * Call this whenever a real output is evaluated.
   */
  record(behavior: BehaviorVector, qualityScore: number): void {
    this.observations.push({
      behavior,
      qualityScore,
      timestamp: new Date().toISOString(),
      domain: behavior.domain,
    });
    this.calibrationCache.clear();

    // Evict oldest if at capacity
    if (this.observations.length > this.config.maxObservations) {
      this.observations = this.observations.slice(-this.config.maxObservations);
    }
  }

  /**
   * Extract a behavior vector from code output.
   * This is the "perceptual" step — turning code into numerical features.
   */
  static extractBehavior(code: string, domain: string): BehaviorVector {
    const lines = code.split('\n');
    const codeLines = lines.filter(l => l.trim().length > 0 && !l.trim().startsWith('//'));
    const commentLines = lines.filter(l => l.trim().startsWith('//'));

    const hasInteraction = /mouseX|mouseY|frameCount|keyIsPressed|millis|touches|deviceOrientation/.test(code) ? 1 : 0;
    const hasColor = /color\(|fill\(|stroke\(|background\(|lerpColor|colorMode/.test(code) ? 1 : 0;
    const hasLoops = /\bfor\s*\(|\bwhile\s*\(|\.forEach\(|\.map\(|\.filter\(/.test(code) ? 1 : 0;
    const hasFunctions = /\bfunction\s+\w+|\b=>\s*\{|const\s+\w+\s*=\s*\(/.test(code) ? 1 : 0;
    const hasClasses = /\bclass\s+\w+/.test(code) ? 1 : 0;

    const techniqueDiversity = [hasInteraction, hasColor, hasLoops, hasFunctions, hasClasses]
      .reduce((a, b) => a + b, 0);

    const commentDensity = lines.length > 0 ? commentLines.length / lines.length : 0;

    return {
      domain,
      lineCount: codeLines.length,
      techniqueDiversity,
      hasInteraction,
      hasColor,
      hasLoops,
      hasFunctions,
      hasClasses,
      commentDensity: Math.min(1, commentDensity),
    };
  }

  // ---------------------------------------------------------------------------
  // Prediction
  // ---------------------------------------------------------------------------

  /**
   * Predict quality for a behavior vector using K-NN regression.
   * Returns null if not enough data.
   */
  predict(behavior: BehaviorVector): QualityPrediction | null {
    // Filter to same domain
    const domainObs = this.observations.filter(o => o.domain === behavior.domain);

    if (domainObs.length < this.config.minObservations) {
      return null;
    }

    const { predicted, avgDistance, k } = this.knn(this.toFeatureVector(behavior), domainObs);
    const calibration = this.calibrate(behavior.domain, domainObs);
    const confidence = calibration.baselineMae > 0
      ? Math.max(0, Math.min(1, 1 - calibration.looMae / calibration.baselineMae))
      : 0;

    return {
      predicted: Math.min(1, Math.max(0, predicted)),
      confidence,
      basis: 'static-code-knn-surrogate',
      calibration,
      neighborCount: k,
      avgDistance,
      domain: behavior.domain,
    };
  }

  /** Inverse-distance-weighted K-NN over a pool of observations. */
  private knn(featureVec: number[], pool: WorldObservation[]): { predicted: number; avgDistance: number; k: number } {
    const k = Math.min(this.config.kNeighbors, pool.length);
    const neighbors = pool
      .map(obs => ({ obs, distance: this.euclideanDistance(featureVec, this.toFeatureVector(obs.behavior)) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);

    let totalWeight = 0;
    let weightedSum = 0;
    for (const { obs, distance } of neighbors) {
      const weight = distance === 0 ? 1e6 : 1 / (distance * distance);
      weightedSum += weight * obs.qualityScore;
      totalWeight += weight;
    }
    return {
      predicted: totalWeight > 0 ? weightedSum / totalWeight : 0.5,
      avgDistance: k > 0 ? neighbors.reduce((sum, n) => sum + n.distance, 0) / k : 0,
      k,
    };
  }

  /**
   * Leave-one-out error of K-NN versus the constant (mean-of-rest) baseline on
   * this domain's recorded outcomes. Cached until the observations change.
   */
  private calibrate(domain: string, domainObs: WorldObservation[]): SurrogateCalibration {
    const cached = this.calibrationCache.get(domain);
    if (cached) return cached;

    const n = domainObs.length;
    const total = domainObs.reduce((sum, o) => sum + o.qualityScore, 0);
    let knnErr = 0;
    let baseErr = 0;
    for (let i = 0; i < n; i++) {
      const held = domainObs[i];
      const rest = domainObs.filter((_, j) => j !== i);
      const { predicted } = this.knn(this.toFeatureVector(held.behavior), rest);
      knnErr += Math.abs(predicted - held.qualityScore);
      baseErr += Math.abs((total - held.qualityScore) / (n - 1) - held.qualityScore);
    }
    const calibration = { looMae: knnErr / n, baselineMae: baseErr / n, sampleSize: n };
    this.calibrationCache.set(domain, calibration);
    return calibration;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Check if the model has enough data for a domain. */
  isReady(domain: string): boolean {
    return this.observations.filter(o => o.domain === domain).length >= this.config.minObservations;
  }

  /** Get observation count for a domain. */
  getObservationCount(domain?: string): number {
    if (domain) return this.observations.filter(o => o.domain === domain).length;
    return this.observations.length;
  }

  /** Get domain-level stats. */
  getDomainStats(domain: string): { count: number; avgQuality: number; bestQuality: number } | null {
    const domainObs = this.observations.filter(o => o.domain === domain);
    if (domainObs.length === 0) return null;

    const qualities = domainObs.map(o => o.qualityScore);
    return {
      count: domainObs.length,
      avgQuality: qualities.reduce((a, b) => a + b, 0) / qualities.length,
      bestQuality: Math.max(...qualities),
    };
  }

  /** Get all domains with observations. */
  getDomains(): string[] {
    return [...new Set(this.observations.map(o => o.domain))];
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** Serialize for persistence. */
  serialize(): WorldModelState {
    return {
      version: 1,
      observations: this.observations,
      config: this.config,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Load from persisted state. */
  deserialize(state: WorldModelState): void {
    this.observations = state.observations;
    this.calibrationCache.clear();
    Logger.info('CreativeWorldModel', `Loaded ${this.observations.length} observations across ${this.getDomains().length} domains`);
  }

  /** Reset. */
  reset(): void {
    this.observations = [];
    this.calibrationCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Private: Feature extraction & distance
  // ---------------------------------------------------------------------------

  /**
   * Convert a BehaviorVector to a numerical feature array.
   * Feature ranges are normalized for K-NN distance computation.
   */
  private toFeatureVector(b: BehaviorVector): number[] {
    if (this.config.normalizeFeatures) {
      return [
        b.lineCount / 100,        // Normalize to ~100 lines
        b.techniqueDiversity / 5,  // Normalize to 5 techniques
        b.hasInteraction,
        b.hasColor,
        b.hasLoops,
        b.hasFunctions,
        b.hasClasses,
        b.commentDensity,          // Already 0-1
      ];
    }
    return [
      b.lineCount,
      b.techniqueDiversity,
      b.hasInteraction,
      b.hasColor,
      b.hasLoops,
      b.hasFunctions,
      b.hasClasses,
      b.commentDensity,
    ];
  }

  /** Euclidean distance between two feature vectors. */
  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }
}
