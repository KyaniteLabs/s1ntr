/**
 * HostConcurrencyGate - Per-host FIFO concurrency semaphore for rate-limited LLM gateways.
 *
 * Empirical finding (2026-11-23 hardcore dogfooding): Z.ai's Coding Plan
 * (`api.z.ai/api/anthropic`) rejects 2-way concurrent requests with HTTP 429
 * code 1302 ("Rate limit reached for requests") while serializing at
 * concurrency 1 succeeds reliably. Holding a per-host slot before starting
 * the per-request timeout lets concurrent callers queue cleanly without
 * burning their timeout budget or triggering 429 storms.
 */

export const DEFAULT_ZAI_MAX_CONCURRENCY = 1;

/** True when targeting Z.ai's gateway hosts (`api.z.ai` or `*.z.ai`). */
export function isZaiGatewayHost(urlOrBase: string): boolean {
  try {
    const host = new URL(urlOrBase).hostname.toLowerCase();
    return host === 'api.z.ai' || host.endsWith('.z.ai');
  } catch {
    return false;
  }
}

/** Resolve the concurrency limit for a target URL, or `undefined` when unlimited. */
export function resolveHostConcurrencyLimit(urlOrBase: string): number | undefined {
  if (!isZaiGatewayHost(urlOrBase)) return undefined;
  const raw = process.env.SINTER_ZAI_MAX_CONCURRENCY;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_ZAI_MAX_CONCURRENCY;
}

interface Waiter {
  grant: () => void;
  cleanup: () => void;
}

interface HostBucket {
  active: number;
  queue: Waiter[];
}

const hostBuckets = new Map<string, HostBucket>();

function hostKey(urlOrBase: string): string {
  try {
    return new URL(urlOrBase).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Acquire a concurrency slot for `urlOrBase`. Returns an idempotent `release()`
 * callback. When the host has no concurrency limit, resolves immediately with a
 * no-op releaser. Aborting `signal` while queued removes the waiter and rejects.
 */
export async function acquireHostSlot(
  urlOrBase: string,
  signal?: AbortSignal,
): Promise<() => void> {
  const limit = resolveHostConcurrencyLimit(urlOrBase);
  if (limit === undefined) return () => {};
  const key = hostKey(urlOrBase);
  if (!key) return () => {};

  if (signal?.aborted) {
    throw abortReason(signal);
  }

  let bucket = hostBuckets.get(key);
  if (!bucket) {
    bucket = { active: 0, queue: [] };
    hostBuckets.set(key, bucket);
  }

  const makeReleaser = (targetBucket: HostBucket): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const currentLimit = resolveHostConcurrencyLimit(urlOrBase) ?? 1;
      if (targetBucket.queue.length > 0 && targetBucket.active <= currentLimit) {
        const next = targetBucket.queue.shift()!;
        next.cleanup();
        next.grant();
        return;
      }
      targetBucket.active = Math.max(0, targetBucket.active - 1);
      if (targetBucket.active === 0 && targetBucket.queue.length === 0) {
        hostBuckets.delete(key);
      }
    };
  };

  if (bucket.active < limit) {
    bucket.active += 1;
    return makeReleaser(bucket);
  }

  const targetBucket = bucket;
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => resolve(),
      cleanup: () => {
        signal?.removeEventListener('abort', onAbort);
      },
    };
    const onAbort = () => {
      const idx = targetBucket.queue.indexOf(waiter);
      if (idx !== -1) targetBucket.queue.splice(idx, 1);
      waiter.cleanup();
      if (targetBucket.active === 0 && targetBucket.queue.length === 0) {
        hostBuckets.delete(key);
      }
      reject(abortReason(signal!));
    };
    targetBucket.queue.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  return makeReleaser(targetBucket);
}

/** Test-only reset to ensure clean isolation between cases. */
export function resetHostConcurrencyGateForTests(): void {
  hostBuckets.clear();
}
