// ── LLM Error Hierarchy ──

export interface LLMErrorDetails {
  model?: string;
  endpoint?: string;
  statusText?: string;
  responseBody?: string;
}

const ERROR_BODY_LIMIT = 1200;

export function sanitizeLLMErrorBody(body: string, maxLength = ERROR_BODY_LIMIT): string {
  return body
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/("(?:api[_-]?key|authorization|token|secret)"\s*:\s*")[^"]+/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}

export function sanitizeLLMEndpoint(endpoint: string): string {
  return endpoint.replace(/([?&](?:key|api[_-]?key|token|secret)=)[^&]+/gi, '$1[REDACTED]');
}

export class LLMError extends Error {
  public readonly model?: string;
  public readonly endpoint?: string;
  public readonly statusText?: string;
  public readonly responseBody?: string;

  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false,
    details: LLMErrorDetails = {},
  ) {
    super(message);
    this.name = 'LLMError';
    this.model = details.model;
    this.endpoint = details.endpoint;
    this.statusText = details.statusText;
    this.responseBody = details.responseBody;
  }
}

// Node fetch surfaces a connection-level failure (server down, port closed,
// DNS failure) as a TypeError with one of these messages — distinct from a
// transient mid-stream reset on an otherwise live connection. Retrying a hard
// connection failure just burns the backoff budget (the endpoint is down, not
// momentarily flaky), so providers classify these as non-retryable.
const TRANSIENT_NETWORK_ERROR_PATTERNS = [
  'econnreset',        // connection reset mid-stream (live peer, transient)
  'socket hang up',    // peer closed keep-alive between requests (transient)
  'etimedout',         // network-level timeout (transient under load)
];

const HARD_CONNECTION_FAILURE_PATTERNS = [
  'fetch failed',      // Node's generic wrapper — see cause for the real error
  'econnrefused',      // nothing listening on the host:port (server is down)
  'enotfound',         // DNS did not resolve (misconfig / offline)
];

function messageMatchesAny(message: string, patterns: readonly string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Name the server when a request never reached it. Node's fetch reports only
 * "fetch failed" and hides the real code (ECONNREFUSED, ENOTFOUND) in
 * error.cause, so a stopped local model read like a generation bug.
 * The result keeps "fetch failed" and the code, so retry and fallback
 * classification, which match on those words, does not change.
 */
export function describeUnreachableEndpoint(error: unknown, baseUrl: string | undefined): string | null {
  if (!(error instanceof Error) || !baseUrl) return null;
  if (!messageMatchesAny(error.message, HARD_CONNECTION_FAILURE_PATTERNS)) return null;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl;
  }
  const detail = code && !error.message.includes(code) ? `${error.message}: ${code}` : error.message;
  return `Could not reach the model server at ${host}. Is it running? (${detail})`;
}

/**
 * Classify whether a thrown error from a provider's fetch is genuinely worth
 * retrying. Hard connection failures (server down / refused / DNS NXDOMAIN) are
 * NOT transient: the endpoint won't recover during a short backoff, so retrying
 * only delays the inevitable failure. Mid-stream resets and timeouts on an
 * established connection ARE transient.
 *
 * Used by providers to set the `retryable` flag on the LLMError they throw from
 * their catch blocks, so RetryManager only retries errors with a real chance of
 * succeeding on the next attempt.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return false;
  // Explicit transient signals win (mid-stream reset / timeout).
  if (messageMatchesAny(message, TRANSIENT_NETWORK_ERROR_PATTERNS)) return true;
  // Hard-down signals are never retryable, even when wrapped in "fetch failed".
  if (messageMatchesAny(message, HARD_CONNECTION_FAILURE_PATTERNS)) return false;
  // Unknown / unmapped errors: be conservative and don't retry. The caller can
  // still surface the failure; we just avoid spending backoff budget on it.
  return false;
}

const QUOTA_EXHAUSTED_PATTERNS = [
  'usage limit',
  'insufficient_quota',
  'insufficient balance',
  'exceeded your current quota',
  'quota exceeded',
];

/** A 429 body that reports an exhausted plan/quota rather than a burst limit. */
export function isQuotaExhaustedBody(body: string): boolean {
  return messageMatchesAny(body, QUOTA_EXHAUSTED_PATTERNS);
}

export async function createLLMHttpError(args: {
  provider: string;
  model: string;
  endpoint: string;
  response: Response;
  label?: string;
}): Promise<LLMError> {
  const status = args.response.status;
  const responseBody = sanitizeLLMErrorBody(await args.response.text().catch(() => args.response.statusText));
  // A 429 that says the plan's quota is spent (MiniMax "usage limit (2067)",
  // OpenAI insufficient_quota) will not clear inside a backoff window:
  // retrying it only delays the fallback seat.
  const retryable = (status === 429 && !isQuotaExhaustedBody(responseBody)) || status >= 500;
  const label = args.label ?? `${args.provider} API error`;
  const message = `${label} ${status}: ${responseBody}`;
  const details: LLMErrorDetails = {
    model: args.model,
    endpoint: sanitizeLLMEndpoint(args.endpoint),
    statusText: args.response.statusText,
    responseBody,
  };

  // 401/403 must be LLMAuthError so LLMClient.isFallbackableError() engages
  // provider fallback chains (plain LLMError is not fallbackable for auth).
  if (status === 401 || status === 403) {
    return new LLMAuthError(args.provider, status, details, message);
  }

  return new LLMError(message, args.provider, status, retryable, details);
}

/** Fast-fail raised while a provider's circuit breaker is open (#1736). */
export class LLMCircuitOpenError extends LLMError {
  constructor(provider: string) {
    super(`Circuit breaker open for provider: ${provider}. Too many recent failures.`, provider, undefined, false);
    this.name = 'LLMCircuitOpenError';
  }
}

/**
 * The model spent its whole output budget on reasoning (finish_reason=length,
 * empty visible content), even after one lower-effort recovery attempt. A
 * model-side budget failure, not a provider fault: never retryable as-is and
 * never counted against the circuit breaker.
 */
export class LLMReasoningExhaustedError extends LLMError {
  readonly failureClass = 'reasoning-exhausted' as const;
  constructor(provider: string, message: string, details: LLMErrorDetails = {}) {
    super(message, provider, undefined, false, details);
    this.name = 'LLMReasoningExhaustedError';
  }
}

/**
 * A request that cannot be answered without pixels reached a model with no vision. Raised by
 * LLMClient.generate when the caller sets requireVision, before any provider call, so a blind
 * pixel evaluator can never answer from text alone (RCA 2026-11-18, Dream keeper).
 */
export class LLMVisionRequiredError extends LLMError {
  readonly failureClass = 'vision-required' as const;
  constructor(provider: string, readonly role: string | undefined, model: string, readonly imageCount: number) {
    super(`Vision required: model ${model} (role ${role ?? 'unset'}) is not vision-capable but the request carries ${imageCount} image input(s)`,
      provider, undefined, false, { model });
    this.name = 'LLMVisionRequiredError';
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(provider: string, detail?: string) {
    super(detail ? `Timeout calling ${provider} API: ${detail}` : `Timeout calling ${provider} API`, provider, undefined, true);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(provider: string, retryAfterSeconds?: number) {
    super(`Rate limited by ${provider} API`, provider, 429, true);
    this.name = 'LLMRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
  retryAfterSeconds?: number;
}

export class LLMAuthError extends LLMError {
  /**
   * Auth / authorization failure (HTTP 401 or 403).
   * Not retryable on the same provider; isFallbackableError() returns true so
   * LLMClient can try configured fallback providers.
   */
  constructor(
    provider: string,
    statusCode: number = 401,
    details: LLMErrorDetails = {},
    message?: string,
  ) {
    super(
      message ?? `Authentication failed for ${provider}`,
      provider,
      statusCode,
      false,
      details,
    );
    this.name = 'LLMAuthError';
  }
}
