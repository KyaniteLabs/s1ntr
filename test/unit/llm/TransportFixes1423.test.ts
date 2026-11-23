import { afterEach, describe, expect, it, vi } from 'vitest';

import { CacheManager } from '../../../src/llm/CacheManager.js';
import { DecisionModelClient, type DecisionRequest } from '../../../src/llm/DecisionModelClient.js';
import { isBreakerFailure, LLMClient } from '../../../src/llm/LLMClient.js';
import { LLMAuthError, LLMError, LLMReasoningExhaustedError, LLMRateLimitError, LLMTimeoutError } from '../../../src/llm/errors.js';
import { RetryManager } from '../../../src/llm/RetryManager.js';
import { SSRFError } from '../../../src/security/UrlValidator.js';
import { ProviderBudgetConfigInvalidError, ProviderBudgetExceededError } from '../../../src/llm/ProviderBudgetLedger.js';
import { failureLogger } from '../../../src/harness/FailureLogger.js';

// #1423 PR 6: the LLM transport stops lying about provider health, retries
// only what can recover, and says when a reply was cut at the token cap.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function stubClient(generate: () => Promise<unknown>) {
  const client = new LLMClient({ provider: 'lmstudio', model: 'primary-model' } as never);
  const internal = client as unknown as Record<string, unknown>;
  const provider = {
    name: 'lmstudio',
    getModel: vi.fn(() => 'primary-model'),
    getConfig: vi.fn(() => ({ baseUrl: 'http://localhost:1234/v1', model: 'primary-model' })),
    generate: vi.fn(generate),
  };
  internal.resolveModel = vi.fn(async () => 'primary-model');
  internal.syncResolvedModel = vi.fn();
  internal.detectProvider = vi.fn(() => 'lmstudio');
  internal.getProvider = vi.fn(async () => provider);
  internal.getFallbackProviders = vi.fn(() => []);
  const breakerStats = () => (internal.getBreaker as (p: string) => { getStats(): { failureCount: number } })
    .call(client, 'lmstudio').getStats();
  return { client, provider, breakerStats };
}

/** RetryManager with real classification but no backoff delay. */
function retryWithoutDelay(maxAttempts = 5) {
  return vi.spyOn(RetryManager, 'executeWithRetry').mockImplementation(async (fn: () => Promise<unknown>) => {
    let last: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await fn();
      } catch (error) {
        last = error;
        const retryable = error instanceof LLMTimeoutError || error instanceof LLMRateLimitError
          || (error instanceof LLMError && error.retryable);
        if (!retryable) throw error;
      }
    }
    throw last;
  });
}

describe('circuit breaker counts provider health only (bugs 6, 29)', () => {
  it('counts timeouts, transport failures and 5xx', () => {
    expect(isBreakerFailure(new LLMTimeoutError('p'))).toBe(true);
    // A reasoning model spending its whole budget thinking is not a provider fault.
    expect(isBreakerFailure(new LLMReasoningExhaustedError('kilo', 'reasoning-exhausted: network of thought, finish_reason=length'))).toBe(false);
    expect(isBreakerFailure(new LLMError('server', 'p', 502, true))).toBe(true);
    expect(isBreakerFailure(new LLMError('fetch failed: ECONNREFUSED', 'p'))).toBe(true);
    expect(isBreakerFailure(new TypeError('fetch failed'))).toBe(true);
  });

  it('ignores aborts, authority refusals, auth, rate limits and other 4xx', () => {
    const abort = new Error('Operation aborted');
    abort.name = 'AbortError';
    expect(isBreakerFailure(abort)).toBe(false);
    expect(isBreakerFailure(new LLMError('Harness executor blocked before transport: x', 'p', undefined, false))).toBe(false);
    expect(isBreakerFailure(new LLMAuthError('p', 401))).toBe(false);
    expect(isBreakerFailure(new LLMRateLimitError('p'))).toBe(false);
    expect(isBreakerFailure(new LLMError('bad request', 'p', 400))).toBe(false);
    expect(isBreakerFailure('not an error')).toBe(false);
  });

  it('one slow request that retries five times is one breaker failure, not an open breaker', async () => {
    retryWithoutDelay(5);
    const { client, provider, breakerStats } = stubClient(async () => ({
      isErr: () => true,
      error: new LLMTimeoutError('lmstudio'),
    }));

    await expect(client.generate('sys', 'user', undefined, true)).rejects.toThrow(/Timeout/);
    expect(provider.generate).toHaveBeenCalledTimes(5);
    expect(breakerStats().failureCount).toBe(1);
  });
});

describe('pre-transport refusals never count, even when their text names the network (#1736)', () => {
  const cases: Array<[string, unknown]> = [
    ['authority', new LLMError('Provider transport requires Liminal product command authority on the network lane', 'authority', undefined, false)],
    ['identity', new LLMError('Harness executor blocked before transport: network identity mismatch', 'glm', undefined, false)],
    ['funding binding', new Error('CAMPAIGN_FUNDING_TRANSPORT_PREFLIGHT_MISMATCH on network route')],
    ['SSRF guard (wrapped)', new LLMError('SSRF Protection: Access to network-lab.local is blocked', 'llm', undefined, false)],
    ['SSRF guard (raw)', new SSRFError('DNS lookup failed for network.example.com - potential SSRF attack')],
    ['provider budget cap', new ProviderBudgetConfigInvalidError('provider-budgets.json could not be read: ETIMEDOUT network share')],
    ['provider budget exceeded', new ProviderBudgetExceededError('network.example.com', { spendUsd: 5, capUsd: 5 } as never)],
    ['action budget', new Error('Action provider-call budget exhausted (3); blocked before call 4 on network lane')],
  ];
  for (const [kind, error] of cases) {
    it(`${kind} refusal is not a breaker failure`, () => {
      expect(isBreakerFailure(error)).toBe(false);
    });
  }
});

describe('breaker fast-fails write one record per open window (#1736)', () => {
  it('100 fast-fails after 5 real 5xx make one record with count=100 and the trigger', async () => {
    retryWithoutDelay(1);
    const { client, provider } = stubClient(async () => ({
      isErr: () => true,
      error: new LLMError('upstream exploded', 'lmstudio', 503, false),
    }));
    const logged: Array<Record<string, unknown>> = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    vi.spyOn(failureLogger, 'log').mockImplementation(((record: Record<string, unknown>) => {
      logged.push(record);
      return { written: true, path: '/dev/null', id: `rec-${logged.length}` };
    }) as never);
    vi.spyOn(failureLogger, 'update').mockImplementation(((id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      return true;
    }) as never);

    for (let i = 0; i < 5; i++) await expect(client.generate('sys', `u${i}`, undefined, true)).rejects.toThrow(/upstream exploded/);
    const realRecords = logged.length;
    for (let i = 0; i < 100; i++) await expect(client.generate('sys', `f${i}`, undefined, true)).rejects.toThrow(/Circuit breaker open/);

    expect(provider.generate).toHaveBeenCalledTimes(5);
    const windowRecords = logged.filter(r => /Circuit breaker/.test(String(r.error)));
    const windowId = `rec-${logged.indexOf(windowRecords[0]) + 1}`;
    expect(windowRecords).toHaveLength(1);
    expect(windowRecords[0]).toMatchObject({ trigger: { rule: '5xx' } });
    expect(String((windowRecords[0].trigger as { firstError: string }).firstError)).toMatch(/upstream exploded/);
    // No per-call records for the fast-fails.
    expect(logged.length).toBe(realRecords);
    const last = updates[updates.length - 1];
    expect(last.patch).toMatchObject({ count: 100 });
    expect(new Set(updates.map(u => u.id))).toEqual(new Set([windowId]));
  });
});

describe('a local authority-gate refusal is not a provider failure (#1736)', () => {
  it('40 gate refusals leave the glm breaker closed and a real call still goes out', async () => {
    const client = new LLMClient({ provider: 'glm', model: 'glm-5.3' } as never);
    const internal = client as unknown as Record<string, unknown>;
    const provider = {
      name: 'glm',
      getModel: vi.fn(() => 'glm-5.3'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3' })),
      generate: vi.fn(async () => ({
        isErr: () => false,
        value: { success: true, content: 'function setup() { createCanvas(10, 10); }', finishReason: 'stop' },
      })),
    };
    internal.resolveModel = vi.fn(async () => 'glm-5.3');
    internal.syncResolvedModel = vi.fn();
    internal.detectProvider = vi.fn(() => 'glm');
    internal.getProvider = vi.fn(async () => provider);
    internal.getFallbackProviders = vi.fn(() => []);
    const breaker = (internal.getBreaker as (p: string) => {
      canExecute(): boolean; getState(): string; getStats(): { failureCount: number };
    }).call(client, 'glm');

    // Production with no role and no product authority: the gate refuses locally.
    vi.stubEnv('NODE_ENV', 'production');
    for (let i = 0; i < 40; i++) {
      await expect(client.generate('sys', `refused ${i}`, undefined, true))
        .rejects.toThrow(/Roleless provider transport is forbidden/);
    }
    expect(provider.generate).not.toHaveBeenCalled();
    expect(breaker.getStats().failureCount).toBe(0);
    expect(breaker.getState()).toBe('closed');

    vi.stubEnv('NODE_ENV', 'test');
    await client.generate('sys', 'real call', undefined, true);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
});

describe('a gate refusal does not eat the half-open probe slot (#1736)', () => {
  it('after the breaker half-opens, a refusal leaves the probe for the next real call', async () => {
    const client = new LLMClient({ provider: 'glm', model: 'glm-5.3' } as never);
    const internal = client as unknown as Record<string, unknown>;
    const provider = {
      name: 'glm',
      getModel: vi.fn(() => 'glm-5.3'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3' })),
      generate: vi.fn(async () => ({
        isErr: () => false,
        value: { success: true, content: 'function setup() { createCanvas(10, 10); }', finishReason: 'stop' },
      })),
    };
    internal.resolveModel = vi.fn(async () => 'glm-5.3');
    internal.syncResolvedModel = vi.fn();
    internal.detectProvider = vi.fn(() => 'glm');
    internal.getProvider = vi.fn(async () => provider);
    internal.getFallbackProviders = vi.fn(() => []);
    const breaker = (internal.getBreaker as (p: string) => {
      recordFailure(): void; getState(): string; canExecute(): boolean;
    }).call(client, 'glm');

    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) breaker.recordFailure();
      expect(breaker.getState()).toBe('open');
      vi.setSystemTime(Date.now() + 31_000);

      vi.stubEnv('NODE_ENV', 'production');
      await expect(client.generate('sys', 'refused', undefined, true))
        .rejects.toThrow(/Roleless provider transport is forbidden/);
      expect(provider.generate).not.toHaveBeenCalled();

      vi.stubEnv('NODE_ENV', 'test');
      await client.generate('sys', 'real call', undefined, true);
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(breaker.getState()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('provider-declared failures retry only when transient (bug 30)', () => {
  it('does not retry a deterministic failure', async () => {
    retryWithoutDelay(5);
    const { client, provider, breakerStats } = stubClient(async () => ({
      isErr: () => false,
      value: { success: false, content: '', error: 'empty generation from provider' },
    }));

    await expect(client.generate('sys', 'user', undefined, true)).rejects.toThrow('empty generation from provider');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(breakerStats().failureCount).toBe(0);
  });

  it('retries a failure whose text names a transient network fault', async () => {
    retryWithoutDelay(3);
    const { client, provider } = stubClient(async () => ({
      isErr: () => false,
      value: { success: false, content: '', error: 'stream ended: ECONNRESET' },
    }));

    await expect(client.generate('sys', 'user', undefined, true)).rejects.toThrow('ECONNRESET');
    expect(provider.generate).toHaveBeenCalledTimes(3);
  });
});

describe('a reply cut at the token cap is a failure (bug 7)', () => {
  it('carries finishReason=length and reports success false', async () => {
    retryWithoutDelay(1);
    const { client } = stubClient(async () => ({
      isErr: () => false,
      value: {
        success: true,
        content: 'function setup() { createCanvas(10, 10); }\nfunction draw() { background(0); }',
        finishReason: 'length',
      },
    }));

    const result = await client.generate('sys', 'user', undefined, true);
    expect(result.success).toBe(false);
    expect(result.isComplete).toBe(false);
    expect(result.finishReason).toBe('length');
    expect(result.error).toMatch(/token cap/);
  });

  it('passes a normal stop through untouched', async () => {
    retryWithoutDelay(1);
    const { client } = stubClient(async () => ({
      isErr: () => false,
      value: { success: true, content: 'function setup() { createCanvas(10, 10); }', finishReason: 'stop' },
    }));

    const result = await client.generate('sys', 'user', undefined, true);
    expect(result.success).toBe(true);
    expect(result.finishReason).toBe('stop');
  });
});

describe('role timeout reaches the client (bugs 5/31, 32)', () => {
  it('the env-only role path honours SINTER_<ROLE>_TIMEOUT_MS', () => {
    vi.stubEnv('SINTER_EVALUATOR_BASE_URL', 'http://localhost:1234/v1');
    vi.stubEnv('SINTER_EVALUATOR_MODEL', 'judge-model');
    vi.stubEnv('SINTER_EVALUATOR_TIMEOUT_MS', '400000');
    const resolved = (LLMClient as unknown as { getRoleConfigSync(r: string): { timeout: number } | null })
      .getRoleConfigSync('evaluator');
    expect(resolved?.timeout).toBe(400_000);
  });

  it('a role timeout outranks the legacy global LIMINAL_LLM_TIMEOUT', () => {
    vi.stubEnv('LIMINAL_LLM_TIMEOUT', '5000');
    vi.stubEnv('SINTER_EVALUATOR_BASE_URL', 'http://localhost:1234/v1');
    vi.stubEnv('SINTER_EVALUATOR_MODEL', 'judge-model');
    vi.stubEnv('SINTER_EVALUATOR_TIMEOUT_MS', '400000');
    const client = new LLMClient({ role: 'evaluator' } as never);
    expect(client.getConfig().timeout).toBe(400_000);
  });

  it('the legacy global env still applies to a client with no role', () => {
    vi.stubEnv('LIMINAL_LLM_TIMEOUT', '5000');
    const client = new LLMClient({ provider: 'lmstudio', model: 'm', baseUrl: 'http://localhost:1234/v1' } as never);
    expect(client.getConfig().timeout).toBe(5000);
  });
});

describe('cache overwrite at capacity (bug 34)', () => {
  it('rewriting an existing key keeps every other entry', () => {
    const cache = new CacheManager({ enabled: true, maxEntries: 2 } as never);
    cache.set('s', 'a', 'A');
    cache.set('s', 'b', 'B');
    cache.set('s', 'a', 'A2');
    expect(cache.size).toBe(2);
    expect(cache.get('s', 'a')).toBe('A2');
    expect(cache.get('s', 'b')).toBe('B');
  });

  it('a new key at capacity still evicts the oldest', () => {
    const cache = new CacheManager({ enabled: true, maxEntries: 2 } as never);
    cache.set('s', 'a', 'A');
    cache.set('s', 'b', 'B');
    cache.set('s', 'c', 'C');
    expect(cache.get('s', 'a')).toBeNull();
    expect(cache.get('s', 'c')).toBe('C');
  });
});

describe('DecisionModelClient transport (bug 35)', () => {
  const request: DecisionRequest = {
    state: 'A calm blue gradient.',
    questions: { valid: { type: 'noul', instructions: 'Is the render coherent?' } },
  };
  const ok = () => new Response(JSON.stringify({ answers: { valid: { noul: 0.9 } } }), { status: 200 });
  const make = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    new DecisionModelClient({ baseUrl: 'http://127.0.0.1:9931', model: 'LiquidAI/d1-2B', fetchImpl,
      sleepImpl: async () => {}, ...extra });

  it('refuses plain http to a non-loopback host unless explicitly allowed', () => {
    expect(() => new DecisionModelClient({ baseUrl: 'http://10.0.0.5:9931', model: 'LiquidAI/d1-2B' }))
      .toThrow('DECISION_MODEL_BASE_URL_REMOTE_HTTP');
    expect(() => new DecisionModelClient({ baseUrl: 'http://10.0.0.5:9931', model: 'LiquidAI/d1-2B', allowRemoteHttp: true }))
      .not.toThrow();
    expect(() => new DecisionModelClient({ baseUrl: 'https://d1.example', model: 'LiquidAI/d1-2B' })).not.toThrow();
    expect(() => new DecisionModelClient({ baseUrl: 'http://localhost:9931', model: 'LiquidAI/d1-2B' })).not.toThrow();
    expect(() => new DecisionModelClient({ baseUrl: 'http://[::1]:9931', model: 'LiquidAI/d1-2B' })).not.toThrow();
  });

  it('retries a cold-start 503 and then answers', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('loading model', { status: 503 }))
      .mockResolvedValueOnce(ok());
    await expect(make(fetchImpl as unknown as typeof fetch).decide(request)).resolves.toMatchObject({ model: 'LiquidAI/d1-2B' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a refused connection, but not a 4xx', async () => {
    const refused = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(ok());
    await expect(make(refused as unknown as typeof fetch).decide(request)).resolves.toMatchObject({ model: 'LiquidAI/d1-2B' });
    expect(refused).toHaveBeenCalledTimes(2);

    const bad = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(make(bad as unknown as typeof fetch).decide(request)).rejects.toThrow('DECISION_TRANSPORT_FAILED: HTTP 400');
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget', async () => {
    const down = vi.fn().mockResolvedValue(new Response('loading', { status: 503 }));
    await expect(make(down as unknown as typeof fetch, { retries: 2 }).decide(request))
      .rejects.toThrow('DECISION_TRANSPORT_FAILED: HTTP 503');
    expect(down).toHaveBeenCalledTimes(3);
  });
});
