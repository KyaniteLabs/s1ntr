import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';
import {
  UNDICI_LIMIT_MARGIN_MS,
  dispatcherFor,
  dispatcherLimits,
  describeUndiciTimeout,
  resolveProviderTimeoutMs,
} from '../../../src/llm/providerFetch.js';
import { LLMTimeoutError } from '../../../src/llm/errors.js';
import { TIMEOUT_DEFAULT_MS, TIMEOUT_EVALUATOR_MS } from '../../../src/constants/limits.js';
import { loadModelConfig } from '../../../src/llm/ModelConfig.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { bootstrapExecutorAuthority } from '../../../src/identity/executorAuthorityBootstrap.js';
import * as urlValidator from '../../../src/security/UrlValidator.js';

const UNDICI_DEFAULT_MS = 300_000;

function makeProvider(baseUrl: string, timeout: number): OpenAIProvider {
  return new OpenAIProvider({ baseUrl, model: 'glm-5.3', apiKey: 'k', timeout } as never);
}

const okBody = JSON.stringify({
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

describe('provider timeouts (#708): dispatcher limits', () => {
  it('raises undici headers/body limits above the configured timeout, past the 300 s default', () => {
    const limits = dispatcherLimits(TIMEOUT_DEFAULT_MS);
    expect(limits.headersTimeout).toBe(TIMEOUT_DEFAULT_MS + UNDICI_LIMIT_MARGIN_MS);
    expect(limits.bodyTimeout).toBe(TIMEOUT_DEFAULT_MS + UNDICI_LIMIT_MARGIN_MS);
    expect(limits.headersTimeout).toBeGreaterThan(UNDICI_DEFAULT_MS);
  });

  it('defaults reasoning-model timeouts to 12 minutes and the evaluator to 3 minutes', () => {
    expect(TIMEOUT_DEFAULT_MS).toBe(720_000);
    expect(TIMEOUT_EVALUATOR_MS).toBe(180_000);
  });
});

describe('provider timeouts (#708): configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets LIMINAL_<PROVIDER>_TIMEOUT_MS override the configured timeout for one provider', () => {
    vi.stubEnv('LIMINAL_OPENAI_TIMEOUT_MS', '900000');
    expect(resolveProviderTimeoutMs('openai', 120_000)).toBe(900_000);
    expect(resolveProviderTimeoutMs('anthropic', 120_000)).toBe(120_000);
  });

  it('ignores a malformed per-provider override', () => {
    vi.stubEnv('LIMINAL_OPENAI_TIMEOUT_MS', 'soon');
    expect(resolveProviderTimeoutMs('openai', 120_000)).toBe(120_000);
  });

  it('sizes role defaults for reasoning models', () => {
    vi.stubEnv('LIMINAL_ALLOW_LOCALHOST', 'true');
    vi.stubEnv('LIMINAL_LLM_BASE_URL', 'http://localhost:1234/v1');
    vi.stubEnv('LIMINAL_LLM_MODEL', 'glm-5.3');
    vi.stubEnv('LIMINAL_EVALUATOR_BASE_URL', 'http://localhost:1234/v1');
    vi.stubEnv('LIMINAL_EVALUATOR_MODEL', 'glm-5.3-flash');
    vi.stubEnv('LIMINAL_LLM_TIMEOUT', '');
    vi.stubEnv('LIMINAL_HARNESS_TIMEOUT', '');
    vi.stubEnv('LIMINAL_EVALUATOR_TIMEOUT', '');
    const config = loadModelConfig();
    expect(config.generation.timeout).toBe(TIMEOUT_DEFAULT_MS);
    expect(config.harness.timeout).toBe(TIMEOUT_DEFAULT_MS);
    expect(config.evaluator.timeout).toBe(TIMEOUT_EVALUATOR_MS);
  });

  it('still honours explicit role timeouts', () => {
    vi.stubEnv('LIMINAL_ALLOW_LOCALHOST', 'true');
    vi.stubEnv('LIMINAL_LLM_BASE_URL', 'http://localhost:1234/v1');
    vi.stubEnv('LIMINAL_LLM_MODEL', 'glm-5.3');
    vi.stubEnv('LIMINAL_LLM_TIMEOUT', '1500000');
    expect(loadModelConfig().generation.timeout).toBe(1_500_000);
  });
});

describe('provider timeouts (#708): configured timeout is honoured past 300 s', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('honors a completion deadline at fetch without changing the next call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(okBody));
    vi.stubGlobal('fetch', fetch);
    const client = new LLMClient({
      baseUrl: 'http://127.0.0.1:1234/v1', model: 'glm-5.3', apiKey: 'test-only', timeout: 720_000,
    });

    await expect(client.complete({ prompt: 'long attempt', providerTimeoutMs: 1_200_000 }))
      .resolves.toMatchObject({ success: true });
    await expect(client.complete({ prompt: 'ordinary attempt' })).resolves.toMatchObject({ success: true });

    const completions = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(completions).toHaveLength(2);
    expect(completions[0][1]).toMatchObject({ dispatcher: dispatcherFor(1_200_000) });
    expect(completions[1][1]).toMatchObject({ dispatcher: dispatcherFor(720_000) });
  });

  it('validates the per-call provider once across transport retries', async () => {
    vi.stubEnv('SINTER_LLM_MAX_RETRIES', '1');
    vi.stubEnv('SINTER_LLM_RETRY_BASE_DELAY_MS', '0');
    const validateUrl = vi.spyOn(urlValidator, 'validateUrl');
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method !== 'POST') return Response.json({ data: [{ id: 'glm-5.3' }] });
      return new Response(okBody, { status: fetch.mock.calls.length === 2 ? 503 : 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new LLMClient({
      baseUrl: 'http://127.0.0.1:1234/v1', model: 'glm-5.3', timeout: 720_000,
    });

    try {
      await expect(client.complete({ prompt: 'retry', providerTimeoutMs: 60_000 }))
        .resolves.toMatchObject({ success: true });
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
      expect(validateUrl.mock.calls.filter(([url]) => url === 'http://127.0.0.1:1234/v1')).toHaveLength(1);
    } finally {
      validateUrl.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('applies the per-call deadline to configured fallbacks without changing future calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fallback-deadline-'));
    try {
      const primary = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'gemini-3.6-flash-high' };
      const fallback = { baseUrl: 'http://127.0.0.1:8317/v1', model: 'gpt-5.6-luna', timeout: 180_000 };
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ roles: { generator: primary }, fallbacks: { generator: [fallback] } }));
      vi.stubEnv('SINTER_CONFIG_PATH', configPath);
      vi.stubEnv('SINTER_LLM_MAX_RETRIES', '0');
      await LLMClient.loadRoles(root);
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (init?.method !== 'POST') return Response.json({ data: [{ id: primary.model }] });
        return new Response(okBody, { status: String(url).includes(':1234/') ? 503 : 200 });
      });
      vi.stubGlobal('fetch', fetch);
      const client = new LLMClient({
        ...primary, role: 'generator', harnessTransportAuthority: bootstrapExecutorAuthority({ rootDir: join(root, 'authority') }),
      });

      await expect(client.complete({ prompt: 'bounded fallback', providerTimeoutMs: 60_000 }))
        .resolves.toMatchObject({ success: true, fallbackUsed: true });
      await expect(client.complete({ prompt: 'ordinary fallback' }))
        .resolves.toMatchObject({ success: true, fallbackUsed: true });
      const fallbackPosts = fetch.mock.calls.filter(([url, init]) => String(url).includes(':8317/') && init?.method === 'POST');
      expect(fallbackPosts).toHaveLength(2);
      expect(Reflect.get(fallbackPosts[0][1]!, 'dispatcher')).toBe(dispatcherFor(60_000));
      expect(Reflect.get(fallbackPosts[1][1]!, 'dispatcher')).toBe(dispatcherFor(180_000));
    } finally {
      LLMClient.clearGlobalCache();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets a 400 s response finish under a 720 s timeout and hands fetch a raised dispatcher', async () => {
    vi.useFakeTimers();
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', (_url: string, init: Record<string, unknown>) => {
      seen.push(init);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(okBody, { status: 200 })), 400_000);
        (init.signal as AbortSignal).addEventListener('abort', () => {
          clearTimeout(timer);
          reject((init.signal as AbortSignal).reason);
        });
      });
    });

    const pending = makeProvider('http://provider.test/v1', 720_000).generate({
      systemPrompt: 's', userPrompt: 'u',
    } as never);
    await vi.advanceTimersByTimeAsync(400_000);
    const result = await pending;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().content).toBe('hello');
    expect(seen).toHaveLength(1);
    expect(seen[0].dispatcher).toBe(dispatcherFor(720_000));
  });

  it('names the limit and its value when the configured timeout fires', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, init: Record<string, unknown>) => new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
    }));

    const pending = makeProvider('http://provider.test/v1', 500_000).generate({
      systemPrompt: 's', userPrompt: 'u',
    } as never);
    await vi.advanceTimersByTimeAsync(500_000);
    const result = await pending;

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('request timeout');
    expect(message).toContain('500000ms');
    expect(message).not.toBe('fetch failed');
  });
});

describe('provider timeouts (#708): real undici over a local slow server', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function slowServer(delayMs: number): Promise<string> {
    server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(okBody);
      }, delayMs);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }

  it('completes a delayed response inside the configured timeout', async () => {
    const baseUrl = await slowServer(300);
    const result = await makeProvider(baseUrl, 5_000).generate({ systemPrompt: 's', userPrompt: 'u' } as never);
    expect(result._unsafeUnwrap().content).toBe('hello');
  });

  it('reports a named timeout, not a bare "fetch failed", when the server outlasts the limit', async () => {
    const baseUrl = await slowServer(2_000);
    const result = await makeProvider(baseUrl, 400).generate({ systemPrompt: 's', userPrompt: 'u' } as never);
    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('request timeout');
    expect(message).toContain('400ms');
    expect(message).not.toBe('fetch failed');
  });
});

describe('provider timeouts (#708): undici limits are named', () => {
  it('turns a headers-timeout cause into an error naming headersTimeout and its value', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause });
    const described = describeUndiciTimeout(fetchFailed, 'openai', 720_000);
    expect(described).toBeInstanceOf(LLMTimeoutError);
    expect(described?.message).toContain('undici headersTimeout');
    expect(described?.message).toContain(`${720_000 + UNDICI_LIMIT_MARGIN_MS}ms`);
  });

  it('turns a body-timeout cause into an error naming bodyTimeout', () => {
    const cause = Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' });
    const described = describeUndiciTimeout(Object.assign(new TypeError('terminated'), { cause }), 'openai', 60_000);
    expect(described?.message).toContain('undici bodyTimeout');
  });

  it('leaves unrelated network errors alone', () => {
    const cause = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(describeUndiciTimeout(Object.assign(new TypeError('fetch failed'), { cause }), 'openai', 60_000)).toBeUndefined();
    expect(describeUndiciTimeout(undefined, 'openai', 60_000)).toBeUndefined();
  });
});
