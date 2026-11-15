import type { GenerationEvaluation } from './types/GenerationEvaluation.js';

/**
 * Failure classes that mean the evaluator did not produce real fitness evidence.
 * Shared by CLI exit, CreativeIterationGate, and the self-improve score-line contract.
 */
export const DEGRADED_EVAL_FAILURE_CLASSES = ['scorer', 'infra', 'parse'] as const;
export type DegradedEvalFailureClass = (typeof DEGRADED_EVAL_FAILURE_CLASSES)[number];

/**
 * Canonical structured decision: was evaluation evidence degraded?
 *
 * True when:
 * - confidence is present and ≤ 0 (no usable evaluator confidence), OR
 * - failureClass is an explicit evaluator-offline class (`scorer` / `infra` / `parse`).
 *
 * This is the single source of truth for CLI exit, CreativeIterationGate stop, and
 * `formatScoreLine` / ledger provenance. Human-readable Reason prose is display-only
 * and must never be required to recover these fields.
 */
export function isEvaluationDegraded(
  confidence: number | undefined,
  failureClass: GenerationEvaluation['failureClass'] | string | undefined,
): boolean {
  const c = confidence ?? 1;
  if (c <= 0) return true;
  const fc = failureClass ?? 'none';
  return (DEGRADED_EVAL_FAILURE_CLASSES as readonly string[]).includes(fc);
}

/**
 * A fitness score is HONEST — safe to persist as a quality exemplar or to drive selection —
 * only when the evaluator actually produced it: positive confidence AND a non-degraded
 * failure class.
 *
 * - `none`      — clean evaluator score (real signal).
 * - `render`    — deterministic luminance/render measure applied (real signal).
 * - `scorer` / `infra` — the LLM evaluator failed; the score is a keyword/neutral fallback.
 * - `validator` — the artifact failed validation (broken code).
 * - `legacy`    — heuristic ScoringEngine path (audio domains, LIMINAL_EVAL_MODE=legacy);
 *                 the score displays but is never banked as an exemplar or acted on.
 *
 * Admitting a `scorer`/`infra`/`validator` score (which readily clears the 0.65 admission
 * bar when the evaluator is offline) as a few-shot exemplar biases every future generation
 * toward fabricated or broken work — the core dishonest-fitness defect. `legacy` heuristic
 * scores are proxies, not evaluator evidence, so they are rejected the same way. Only
 * `none`/`render` with positive confidence are trustworthy.
 *
 * Note: `isEvaluationDegraded` is the narrower runtime "stop/emit provenance" signal.
 * `isHonestFitnessScore` additionally rejects `validator`/`legacy` for banking even when
 * confidence is positive.
 */
export function isHonestFitnessScore(
  confidence: number | undefined,
  failureClass: GenerationEvaluation['failureClass'] | undefined,
): boolean {
  const c = confidence ?? 1;
  const fc = failureClass ?? 'none';
  return c > 0 && (fc === 'none' || fc === 'render');
}
