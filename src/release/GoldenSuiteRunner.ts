/**
 * GoldenSuiteRunner — Phase 11 Increment 6
 *
 * Runs a golden prompt suite end-to-end: generates a candidate for each
 * golden case, evaluates it, and returns per-case and aggregate results.
 *
 * Unlike EvaluationFabric.evaluateWithSuite() which evaluates a single
 * candidate against multiple thresholds, this runner generates a unique
 * candidate per golden case — each with its own prompt and domain.
 */

import { EvaluationFabric } from '../evaluation/EvaluationFabric.js';
import type {
  EvaluationCandidate,
  GoldenSuite,
  GoldenSuiteResult,
  GoldenCaseResult,
  EvaluationFabricResult,
} from '../evaluation/types.js';

export interface GoldenSuiteRunnerOptions {
  /** Quality threshold override (default: from EvaluationFabric config) */
  qualityThreshold?: number;
  /** Timeout per case in ms (default: 30000) */
  timeoutMs?: number;
  /** Callback for progress reporting */
  onCaseComplete?: (caseId: string, passed: boolean, score: number) => void;
}

export interface GoldenSuiteRunResult {
  /** The suite that was run */
  suiteName: string;
  /** Per-case results */
  caseResults: GoldenCaseResult[];
  /** Aggregate results */
  aggregate: GoldenSuiteResult;
  /** The raw evaluation results per case */
  fabricResults: EvaluationFabricResult[];
  /** Total wall-clock duration */
  durationMs: number;
  /** Timestamp */
  timestamp: string;
}

export class GoldenSuiteRunner {
  private fabric: EvaluationFabric;
  private timeoutMs: number;
  private onCaseComplete?: (caseId: string, passed: boolean, score: number) => void;

  constructor(options?: GoldenSuiteRunnerOptions) {
    this.fabric = new EvaluationFabric({
      qualityThreshold: options?.qualityThreshold,
    });
    this.timeoutMs = options?.timeoutMs ?? 30000;
    this.onCaseComplete = options?.onCaseComplete;
  }

  /**
   * Run a golden suite by evaluating each case independently.
   *
   * Since this runner doesn't have a generator, it evaluates the golden
   * case prompt as a candidate with placeholder code. In production, you'd
   * pass real generated code; this runner is designed for the CI gate
   * where code already exists and needs regression testing.
   *
   * @param suite The golden suite to run
   * @param candidates Optional pre-generated candidates indexed by case ID
   */
  async run(
    suite: GoldenSuite,
    candidates?: Map<string, EvaluationCandidate>,
  ): Promise<GoldenSuiteRunResult> {
    const start = Date.now();
    const caseResults: GoldenCaseResult[] = [];
    const fabricResults: EvaluationFabricResult[] = [];

    for (const goldenCase of suite.cases) {
      const candidate = candidates?.get(goldenCase.id);
      if (!candidate) {
        // Judging a placeholder comment certifies nothing about the product.
        throw new Error(`GOLDEN_SUITE_CANDIDATE_REQUIRED: no candidate supplied for case ${goldenCase.id}`);
      }

      const fabricResult = await this.evaluateWithTimeout(candidate);
      fabricResults.push(fabricResult);

      const judgment = fabricResult.judgment;
      const passed = judgment.score >= goldenCase.minScore;
      const margin = Math.round((judgment.score - goldenCase.minScore) * 1000) / 1000;

      const caseResult: GoldenCaseResult = {
        caseId: goldenCase.id,
        candidate,
        judgment,
        passed,
        margin,
      };
      caseResults.push(caseResult);

      this.onCaseComplete?.(goldenCase.id, passed, judgment.score);
    }

    const passedCount = caseResults.filter(r => r.passed).length;
    const failedCount = caseResults.length - passedCount;
    const averageScore = caseResults.length > 0
      ? Math.round((caseResults.reduce((sum, r) => sum + r.judgment.score, 0) / caseResults.length) * 1000) / 1000
      : 0;

    const aggregate: GoldenSuiteResult = {
      suiteName: suite.name,
      caseResults,
      passed: passedCount,
      failed: failedCount,
      total: caseResults.length,
      averageScore,
      suitePassed: caseResults.length > 0 && failedCount === 0,
      evaluationMode: 'per-case-execution',
    };

    return {
      suiteName: suite.name,
      caseResults,
      aggregate,
      fabricResults,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }

  /** Evaluate a single candidate with a timeout guard; the timer is always cleared so it cannot keep the process alive. */
  private async evaluateWithTimeout(candidate: EvaluationCandidate): Promise<EvaluationFabricResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Evaluation timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    try {
      return await Promise.race([this.fabric.evaluate(candidate), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
