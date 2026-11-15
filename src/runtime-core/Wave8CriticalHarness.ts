/**
 * Wave 8 critical harness identity.
 *
 * Owner direction 2026-08-07: Kimi K3 replaces Sol for Wave 8 completion.
 * Sol-high is not required; do not invent Sol approvals.
 */

/** Canonical model id for seats / freezes. */
export const WAVE8_CRITICAL_HARNESS_MODEL = 'kimi-k3' as const;

/** Accepted aliases (cliproxy bare id vs gateway-prefixed id). */
const CRITICAL_HARNESS_MODELS = new Set<string>([
  'kimi-k3',
  'moonshotai/kimi-k3',
]);

export function isWave8CriticalHarnessModel(model: string): boolean {
  return CRITICAL_HARNESS_MODELS.has(model);
}

/** Normalize aliases to the canonical freeze id. */
export function canonicalWave8CriticalHarnessModel(model: string): string {
  if (!isWave8CriticalHarnessModel(model)) {
    throw new Error(`not a Wave 8 critical harness model: ${model}`);
  }
  return WAVE8_CRITICAL_HARNESS_MODEL;
}

/** Dispatch / collaboration receipt executor labels that bind to Kimi harness. */
export function wave8CriticalHarnessModelFromExecutor(
  executor: unknown,
  reviewerModel: string,
): string | undefined {
  const ex = String(executor ?? '');
  if (ex === 'kimi-k3' || ex === 'cliproxy-kimi' || ex === 'kimi-cli' || ex === 'kimi-k3-cli') {
    return isWave8CriticalHarnessModel(reviewerModel)
      ? reviewerModel
      : WAVE8_CRITICAL_HARNESS_MODEL;
  }
  if (isWave8CriticalHarnessModel(ex)) return ex;
  return undefined;
}
