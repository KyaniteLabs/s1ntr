/**
 * Pure decision logic for the `generate` CLI exit contract (Fault #7 guard).
 *
 * Extracted from `bin/sinter` so the empty-skeleton / degraded-evaluator rules
 * can be asserted behaviorally instead of via brittle source-text grep. The
 * boolean logic here is byte-for-byte equivalent to the original inline guard;
 * `bin/sinter` imports these functions so there is exactly one source of truth.
 */

import { isEvaluationDegraded } from '../core/fitnessHonesty.js';

/** Minimal shape of the generation result fields the exit decision reads. */
export interface GenerateExitInput {
  code: string;
  completed: boolean;
  finalScore: number;
  evaluationConfidence?: number;
  evaluationFailureClass?: string;
}

/**
 * A 0.00 score can be a legitimately degraded evaluator (offline scorer/infra,
 * or zeroed confidence), so it must NOT be treated as an empty skeleton.
 *
 * Canonical decision: `isEvaluationDegraded` in fitnessHonesty (shared with
 * CreativeIterationGate and the machine score-line contract).
 */
export function isDegradedResult(result: GenerateExitInput): boolean {
  // When confidence is omitted, treat as healthy default (1) unless failureClass
  // is an explicit degraded class — matches isEvaluationDegraded defaults.
  return isEvaluationDegraded(result.evaluationConfidence, result.evaluationFailureClass);
}

/**
 * True when the run produced no usable artifact: empty/whitespace code, or an
 * incomplete run with a zero score while the evaluator is healthy (Fault #7).
 * Such runs must exit 1, never report "Generation complete!" + exit 0.
 */
export function isEmptySkeleton(result: GenerateExitInput): boolean {
  const hasUsableCode = typeof result.code === 'string' && result.code.trim().length > 0;
  const degraded = isDegradedResult(result);
  return !hasUsableCode || (!result.completed && !degraded && result.finalScore <= 0);
}

/**
 * The single source of truth for the `⭐ Quality score:` stdout line.
 *
 * Degraded runs (evaluator offline / zeroed confidence) must NEVER print a
 * fabricated number — the score is not real fitness, so the line says
 * `unscored (judge could not score)` and carries the machine-parseable provenance
 * suffix `(failureClass=…, confidence=…)` that the self-improve ledger
 * (scripts/quality/self-improve-domains.mjs parseScoreLine) reads.
 *
 * Healthy runs keep the EXACT legacy `⭐ Quality score: X.XX` format — the
 * ledger parser and other tooling depend on that byte shape.
 */
export function formatScoreLine(result: GenerateExitInput): string {
  if (isDegradedResult(result)) {
    const failureClass = result.evaluationFailureClass ?? 'unknown';
    const confidence = (result.evaluationConfidence ?? 0).toFixed(2);
    return `⭐ Quality score: unscored (judge could not score) (failureClass=${failureClass}, confidence=${confidence})`;
  }
  return `⭐ Quality score: ${result.finalScore.toFixed(2)}`;
}

/** What a degraded governed run already knows about why it has no score. */
export interface DegradedWhyInput {
  readonly rejectionReasons?: readonly string[];
  readonly runtimeErrors?: readonly string[];
  readonly reasoning?: string;
}

/**
 * One line naming why a degraded run has no real score: the admission
 * rejection reasons, the first render runtime error, and the judge's own
 * reasoning. All three are persisted in the run journal but were never
 * printed, so a blank render read as `failureClass=unknown` (live matrix
 * 2026-11-10). Printed after the score line, whose byte shape stays fixed.
 */
export function formatDegradedWhy(input: DegradedWhyInput, maxChars = 240): string | null {
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
  };
  const parts: string[] = [];
  if (input.rejectionReasons?.length) parts.push(`reasons=${input.rejectionReasons.join(',')}`);
  const firstError = input.runtimeErrors?.find((error) => error.trim());
  if (firstError) parts.push(`render error: ${clip(firstError)}`);
  if (input.reasoning?.trim()) parts.push(`judge: ${clip(input.reasoning)}`);
  return parts.length > 0 ? `🔎 Why: ${parts.join(' | ')}` : null;
}

/** What the governed generate path knows when it prints its headline. */
export interface GovernedHeadlineInput {
  readonly admissionEligible: boolean;
  readonly degraded?: boolean;
  readonly identityValid?: boolean;
  readonly rejectionReasons?: readonly string[];
}

/**
 * The two lines above the score. A green "complete" is printed only when the
 * piece was admitted by a healthy evaluator; otherwise the run still saves its
 * files but says it was not accepted and why (judges' consensus 2026-11-11:
 * "✅ Generation complete!" printed at score 0.09).
 */
export function formatGovernedHeadline(input: GovernedHeadlineInput): [string, string] {
  if (input.admissionEligible && !input.degraded && input.identityValid !== false) {
    return ['✅ Generation complete!', '🎯 Reason: governed production Create completed'];
  }
  const reasons = input.rejectionReasons?.length
    ? input.rejectionReasons.join(', ')
    : input.degraded ? 'the evaluator could not score it' : 'it did not pass the quality gate';
  return ['⚠️  Generated, but not accepted', `🎯 Reason: ${reasons}`];
}

/**
 * Exit code for a generate run that saved files but was not accepted (admission
 * failed, degraded evaluator, or invalid identity). Distinct from 0 (accepted)
 * and 1 (error / empty skeleton) so batch tooling can tell "generated, rejected"
 * from both success and a crash.
 */
export const NOT_ACCEPTED_EXIT_CODE = 3;

/** 0 exactly when the headline prints "Generation complete!"; else NOT_ACCEPTED_EXIT_CODE. */
export function governedExitCode(input: GovernedHeadlineInput): number {
  return input.admissionEligible && !input.degraded && input.identityValid !== false ? 0 : NOT_ACCEPTED_EXIT_CODE;
}
