/**
 * #1652: on the Anthropic messages wire, max_tokens counts thinking AND the
 * answer. A thinking budget at or above max_tokens leaves no room for text:
 * GLM 5.3 on z.ai spent all 4096 output tokens thinking and returned no code.
 * maxTokens is the answer budget, so the wire cap must add the thinking budget.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderConfig, ProviderRequest } from '../../../src/llm/ProviderTypes.js';
import { AnthropicProvider } from '../../../src/llm/providers/AnthropicProvider.js';

const root = path.join(tmpdir(), `anthropic-thinking-cap-${process.pid}`);
const config: ProviderConfig = {
  baseUrl: 'https://anthropic.example.test', model: 'claude-sonnet-4-5', apiKey: 'test-key',
  temperature: 0.5, maxTokens: 4096, timeout: 5000,
};
const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));

function sentBody(): { max_tokens: number; thinking?: { budget_tokens: number } } {
  const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
  return JSON.parse(String(init.body));
}

const glm = (model: string): ProviderConfig => ({ ...config, baseUrl: 'https://zai.example.test/api/anthropic', model });

const req = (thinking?: ProviderRequest['thinking']): ProviderRequest =>
  ({ systemPrompt: '', userPrompt: 'draw', maxTokens: 4096, thinking }) as ProviderRequest;

describe('Anthropic wire: thinking never eats the answer budget (#1652)', () => {
  beforeEach(() => {
    process.env.SINTER_LIMINAL_RUNTIME_ROOT = root;
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SINTER_LIMINAL_RUNTIME_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['high effort (16k budget)', { enabled: true, effort: 'high', budgetTokens: 16_000 }],
    ['default budget', { enabled: true }],
  ] as const)('generate, %s: max_tokens = thinking budget + 4096 answer tokens', async (_n, thinking) => {
    await new AnthropicProvider(config).generate(req(thinking));
    const body = sentBody();
    expect(body.thinking?.budget_tokens).toBeGreaterThan(0);
    expect(body.max_tokens - (body.thinking?.budget_tokens ?? 0)).toBe(4096);
  });

  it('stream: the same wire cap', async () => {
    const drain = async () => {
      for await (const _e of new AnthropicProvider(config).stream(req({ enabled: true, budgetTokens: 16_000 }))) { /* drain */ }
    };
    await drain().catch(() => undefined);
    const body = sentBody();
    expect(body.max_tokens - (body.thinking?.budget_tokens ?? 0)).toBe(4096);
  });

  it('thinking off: max_tokens is the answer budget unchanged', async () => {
    await new AnthropicProvider(config).generate(req({ enabled: false }));
    const body = sentBody();
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });

  // z.ai GLM 5.3 thinks unasked and ignores budget_tokens, so only max_tokens
  // bounds it: v16 canaries 2026-11-16 spent all 32000 tokens thinking with no text.
  it.each(['glm-5.3', 'glm-5.3-flash'])('%s: thinking off still gets the 131072 output ceiling', async (model) => {
    await new AnthropicProvider(glm(model)).generate(req({ enabled: false }));
    const body = sentBody();
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(131_072);
  });

  it('glm-5.3: thinking on keeps budget_tokens and the same ceiling, generate and stream', async () => {
    await new AnthropicProvider(glm('glm-5.3')).generate(req({ enabled: true, budgetTokens: 16_000 }));
    expect(sentBody()).toMatchObject({ max_tokens: 131_072, thinking: { budget_tokens: 16_000 } });
    fetchSpy.mockClear();
    const drain = async () => {
      for await (const _e of new AnthropicProvider(glm('glm-5.3')).stream(req({ enabled: false }))) { /* drain */ }
    };
    await drain().catch(() => undefined);
    expect(sentBody().max_tokens).toBe(131_072);
  });

  // t_86865e92: api.z.ai/api/anthropic rejects max_tokens outside [1, 131072] or
  // non-integer values with HTTP 400 code 1210, and rejects vendor-prefixed model
  // ids like glm/glm-5.3 with code 1211.
  it.each(['glm-5.1', 'glm-5.2', 'glm-5.3'])('%s: clamps wire max_tokens to integer [1, 131072] to prevent Z.ai 400 code 1210', async (model) => {
    await new AnthropicProvider({ ...glm(model), baseUrl: 'https://api.z.ai/api/anthropic', maxTokens: 131_072 })
      .generate({ systemPrompt: '', userPrompt: 'draw', maxTokens: 131_072, thinking: { enabled: true, budgetTokens: 16_000 } } as ProviderRequest);
    const body = sentBody();
    expect(Number.isInteger(body.max_tokens)).toBe(true);
    expect(body.max_tokens).toBe(131_072);
  });

  it('normalizes fractional or non-positive max_tokens and strips glm/ prefix on api.z.ai', async () => {
    await new AnthropicProvider({ ...glm('glm/glm-5.2'), baseUrl: 'https://api.z.ai/api/anthropic', temperature: Number.NaN })
      .generate({ systemPrompt: '', userPrompt: 'draw', maxTokens: 0, thinking: { enabled: false } } as ProviderRequest);
    const body = sentBody() as Record<string, unknown>;
    expect(body.model).toBe('glm-5.2');
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBeUndefined();

    fetchSpy.mockClear();
    await new AnthropicProvider({ ...glm('glm-5.1'), baseUrl: 'https://api.z.ai/api/anthropic' })
      .generate({ systemPrompt: '', userPrompt: 'draw', maxTokens: 4096.7, thinking: { enabled: true, budgetTokens: 8000.9 } } as ProviderRequest);
    const second = sentBody();
    expect(second.max_tokens).toBe(12_096);
    expect(second.thinking?.budget_tokens).toBe(8000);
  });
});
