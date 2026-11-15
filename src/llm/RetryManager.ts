import { LLMError, LLMTimeoutError, LLMRateLimitError } from './LLMClient.js';

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

type RetryTimingOptions = Required<Omit<RetryOptions, 'signal'>>;

/**
 * Resolve retry budget defaults. An operator (or test) can bound total retry
 * time via `SINTER_LLM_MAX_RETRIES` (count) and `SINTER_LLM_RETRY_BASE_DELAY_MS`
 * (first backoff; later delays double, capped at maxDelayMs). This keeps the
 * production default generous (5 × 2s base) while letting tests force fast
 * failure and operators clamp retry time on fragile links. Both env vars are
 * read at call time, so changing them takes effect on the next request.
 */
function resolveDefaultOptions(): RetryTimingOptions {
  const maxRetries = parseIntEnv(process.env.SINTER_LLM_MAX_RETRIES, 5);
  const baseDelayMs = parseIntEnv(process.env.SINTER_LLM_RETRY_BASE_DELAY_MS, 2000);
  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs: 60000,
  };
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class RetryManager {
  /**
   * Execute a function with exponential backoff retry logic.
   * Retries bounded transient LLM failures.
   * Non-retryable errors throw immediately.
   */
  static async executeWithRetry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions
  ): Promise<T> {
    const opts = { ...resolveDefaultOptions(), ...options };
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      this.throwIfAborted(opts.signal);
      try {
        return await fn();
      } catch (error) {
        if (!this.isRetryableError(error)) {
          throw error;
        }

        lastError = error as Error;

        if (attempt >= opts.maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff
        let delay = opts.baseDelayMs * Math.pow(2, attempt);

        // Respect retryAfterSeconds from rate limit errors
        if (error instanceof LLMRateLimitError && error.retryAfterSeconds) {
          delay = Math.max(delay, error.retryAfterSeconds * 1000);
        }

        // Cap at max delay
        delay = Math.min(delay, opts.maxDelayMs);

        await this.abortableDelay(delay, opts.signal);
      }
    }

    throw lastError;
  }

  private static abortError(signal?: AbortSignal): Error {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    return error;
  }

  private static isRetryableError(error: unknown): boolean {
    return error instanceof LLMTimeoutError ||
      error instanceof LLMRateLimitError ||
      (error instanceof LLMError && error.retryable);
  }

  private static throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.abortError(signal);
  }

  private static async abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);

      function cleanup(): void {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      }

      function onAbort(): void {
        cleanup();
        reject(RetryManager.abortError(signal));
      }

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Run tasks with a concurrency limit, collecting allSettled results.
   */
  static async mapSettled<T>(
    items: T[],
    fn: (item: T, index: number) => Promise<unknown>,
    concurrency: number,
  ): Promise<PromiseSettledResult<unknown>[]> {
    const results: PromiseSettledResult<unknown>[] = [];
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        try {
          const value = await fn(items[i], i);
          results[i] = { status: 'fulfilled', value };
        } catch (err) {
          results[i] = { status: 'rejected', reason: err };
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }
}
