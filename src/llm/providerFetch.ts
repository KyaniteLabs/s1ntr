/**
 * Provider HTTP timeouts.
 *
 * Node's fetch (undici) cuts a request off after 300 s without response headers
 * (headersTimeout) or between body chunks (bodyTimeout) and reports only
 * "fetch failed". A reasoning model that thinks for ten minutes before it
 * answers a non-streaming call therefore died at 300 s no matter what
 * `ProviderConfig.timeout` said (#708). Each request now gets a dispatcher whose
 * limits sit just above the configured timeout, so the configured timeout is the
 * one that fires, and it fires with an error that names it.
 */
import { Agent } from 'undici';
import { LLMTimeoutError } from './errors.js';

/** The dispatcher limits sit this far above the configured timeout. */
export const UNDICI_LIMIT_MARGIN_MS = 5_000;

export function dispatcherLimits(timeoutMs: number): { headersTimeout: number; bodyTimeout: number } {
  const limit = Math.max(0, timeoutMs) + UNDICI_LIMIT_MARGIN_MS;
  return { headersTimeout: limit, bodyTimeout: limit };
}

const MAX_DISPATCHERS = 32;
const dispatchers = new Map<number, Agent>();

/** One pooled Agent per distinct timeout (bounded LRU to prevent socket/Agent leaks). */
export function dispatcherFor(timeoutMs: number): Agent {
  const existing = dispatchers.get(timeoutMs);
  if (existing) {
    // Refresh recency order.
    dispatchers.delete(timeoutMs);
    dispatchers.set(timeoutMs, existing);
    return existing;
  }
  const agent = new Agent(dispatcherLimits(timeoutMs));
  dispatchers.set(timeoutMs, agent);
  if (dispatchers.size > MAX_DISPATCHERS) {
    const oldestKey = dispatchers.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = dispatchers.get(oldestKey);
      dispatchers.delete(oldestKey);
      void oldest?.close().catch(() => {});
    }
  }
  return agent;
}

function timeoutEnvKey(provider: string): string {
  return `LIMINAL_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TIMEOUT_MS`;
}

/**
 * Per-provider timeout override: `LIMINAL_<PROVIDER>_TIMEOUT_MS` (for example
 * `LIMINAL_OPENAI_TIMEOUT_MS`) wins over the role or config timeout.
 */
export function resolveProviderTimeoutMs(provider: string, configuredMs: number): number {
  const override = Number.parseInt(process.env[timeoutEnvKey(provider)] ?? '', 10);
  return Number.isFinite(override) && override > 0 ? override : configuredMs;
}

/** The error a provider timeout signal aborts with; its message names the limit. */
export function configuredTimeoutError(provider: string, timeoutMs: number): LLMTimeoutError {
  return new LLMTimeoutError(
    provider,
    `request timeout of ${timeoutMs}ms exceeded (ProviderConfig.timeout; raise the role's LIMINAL_*_TIMEOUT or ${timeoutEnvKey(provider)})`,
  );
}

const UNDICI_LIMIT_NAMES: Record<string, string> = {
  UND_ERR_HEADERS_TIMEOUT: 'headersTimeout',
  UND_ERR_BODY_TIMEOUT: 'bodyTimeout',
  UND_ERR_CONNECT_TIMEOUT: 'connectTimeout',
};

/**
 * Name the undici limit behind a bare "fetch failed" / "terminated". Only the
 * headers and body limits are ours to size; the connect limit keeps undici's own.
 */
export function describeUndiciTimeout(
  error: unknown,
  provider: string,
  timeoutMs: number,
): LLMTimeoutError | undefined {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  if (typeof code !== 'string' || !(code in UNDICI_LIMIT_NAMES)) return undefined;
  const limit = UNDICI_LIMIT_NAMES[code];
  const value = limit === 'connectTimeout' ? 10_000 : dispatcherLimits(timeoutMs)[limit as 'headersTimeout' | 'bodyTimeout'];
  return new LLMTimeoutError(provider, `undici ${limit} of ${value}ms exceeded (${code})`);
}
