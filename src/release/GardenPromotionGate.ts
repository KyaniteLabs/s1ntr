/**
 * GardenPromotionGate — Phase 16
 *
 * Gates promotion of creative runtime improvements.
 * Requires positive metrics delta and no regressions.
 */

import { comparablePolicyMetrics } from './PolicyChangeManifest.js';
import type { RuntimeCandidate } from './CreativeRuntimeCandidateBuilder.js';

export interface PromotionResult {
  candidateId: string;
  passed: boolean;
  regressions: string[];
  improvements: string[];
  summary: string;
}

export interface GardenPromotionGateConfig {
  /** Maximum allowed metric regressions (default: 0) */
  maxRegressions?: number;
  /** Minimum improvement for a metric to count (default: 0.01) */
  improvementThreshold?: number;
}

export class GardenPromotionGate {
  private readonly maxRegressions: number;
  private readonly improvementThreshold: number;

  constructor(config: GardenPromotionGateConfig = {}) {
    this.maxRegressions = config.maxRegressions ?? 0;
    this.improvementThreshold = config.improvementThreshold ?? 0.01;
  }

  /**
   * Check whether a candidate passes the promotion gate.
   */
  check(candidate: RuntimeCandidate): PromotionResult {
    const regressions: string[] = [];
    const improvements: string[] = [];
    let complete = candidate.changes.length > 0;

    for (const change of candidate.changes) {
      const names = comparablePolicyMetrics(change.metricsBefore, change.metricsAfter);
      if (!names) {
        complete = false;
        break;
      }
      for (const key of names) {
        const before = change.metricsBefore[key];
        const after = change.metricsAfter[key];
        const delta = after - before;

        if (delta < -this.improvementThreshold) {
          regressions.push(`${key}: ${before.toFixed(3)} → ${after.toFixed(3)} (${delta.toFixed(3)})`);
        } else if (delta > this.improvementThreshold) {
          improvements.push(`${key}: ${before.toFixed(3)} → ${after.toFixed(3)} (+${delta.toFixed(3)})`);
        }
      }
    }

    const passed = complete && candidate.passed && regressions.length <= this.maxRegressions;

    return {
      candidateId: candidate.id,
      passed,
      regressions,
      improvements,
      summary: !complete ? 'Blocked: missing or invalid comparison metrics' : passed
        ? `Passed with ${improvements.length} improvements`
        : `Blocked: ${regressions.length} regressions detected`,
    };
  }
}
