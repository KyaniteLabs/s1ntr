/** `sinter gui-evolve` argument and retry rules (Sol F12): validate before any bootstrap, retry only transient faults. */

export type GuiEvolveSub = 'run' | 'report';

export function parseGuiEvolveArgs(sub: string | undefined, n: unknown): { sub: GuiEvolveSub; cycles: number } {
  if (sub !== undefined && sub !== 'run' && sub !== 'report') {
    throw new Error(`gui-evolve: unknown subcommand "${sub}" (use: run | report)`);
  }
  const raw = n === undefined ? '1' : String(n).trim();
  if (!/^[1-9]\d{0,2}$/.test(raw)) throw new Error(`gui-evolve: --n must be a whole number from 1 to 999, got "${raw}"`);
  return { sub: sub ?? 'run', cycles: Number(raw) };
}

const TRANSIENT = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_[A-Z_]+)\b|timed? ?out|socket hang up|fetch failed|\b(429|500|502|503|504)\b|rate.?limit|overloaded/i;

/** True only for network, rate-limit and 5xx style faults; deterministic failures (authority, validation, parse) are not retried. */
export function isTransientTransportError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message} ${(error as { code?: string }).code ?? ''}` : String(error);
  if (/EXECUTOR_|AUTHORITY|metered funding|IDENTITY_MISMATCH|validation|SyntaxError/i.test(text)) return false;
  return TRANSIENT.test(text);
}
