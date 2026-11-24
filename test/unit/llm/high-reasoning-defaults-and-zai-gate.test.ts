import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effortReasoningWireMaxTokens } from '../../../src/llm/providers/BaseProvider.js';
import {
  DEFAULT_ZAI_MAX_CONCURRENCY,
  acquireHostSlot,
  isZaiGatewayHost,
  resetHostConcurrencyGateForTests,
  resolveHostConcurrencyLimit,
} from '../../../src/llm/hostConcurrency.js';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';
import { OpenRouterProvider } from '../../../src/llm/providers/OpenRouterProvider.js';
import { AnthropicProvider } from '../../../src/llm/providers/AnthropicProvider.js';
import { isGLMCodingPlanModel } from '../../../src/identity/GLMCodingPlanSeat.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  resetHostConcurrencyGateForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetHostConcurrencyGateForTests();
});

describe('effortReasoningWireMaxTokens', () => {
  const neonCaps = { thinking: true, thinkingStyle: 'effort_level' as const };

  it('adds effort-scaled reasoning headroom for effort_level models when thinking is enabled', () => {
    expect(effortReasoningWireMaxTokens(16_384, { enabled: true, effort: 'high' }, neonCaps)).toBe(32_768);
    expect(effortReasoningWireMaxTokens(4_096, { enabled: true, effort: 'high' }, neonCaps)).toBe(20_480);
    expect(effortReasoningWireMaxTokens(4_096, { enabled: true, effort: 'medium' }, neonCaps)).toBe(12_288);
    expect(effortReasoningWireMaxTokens(4_096, { enabled: true, effort: 'low' }, neonCaps)).toBe(8_192);
    expect(effortReasoningWireMaxTokens(8_192, { enabled: true, effort: 'xhigh' }, neonCaps)).toBe(32_768);
    expect(effortReasoningWireMaxTokens(8_192, { enabled: true, effort: 'max' }, neonCaps)).toBe(32_768);
  });

  it('clamps to capabilities.maxOutputTokens when set', () => {
    expect(
      effortReasoningWireMaxTokens(
        16_384,
        { enabled: true, effort: 'high' },
        { ...neonCaps, maxOutputTokens: 24_000 },
      ),
    ).toBe(24_000);
  });

  it('leaves non-thinking, disabled-thinking, and non-effort_level models untouched', () => {
    expect(effortReasoningWireMaxTokens(16_384, { enabled: false, effort: 'high' }, neonCaps)).toBe(16_384);
    expect(effortReasoningWireMaxTokens(16_384, undefined, neonCaps)).toBe(16_384);
    expect(
      effortReasoningWireMaxTokens(4_096, { enabled: true, effort: 'high' }, { thinking: false, thinkingStyle: 'none' }),
    ).toBe(4_096);
    expect(
      effortReasoningWireMaxTokens(4_096, { enabled: true, effort: 'high' }, { thinking: true, thinkingStyle: 'reasoning_content' }),
    ).toBe(4_096);
    expect(effortReasoningWireMaxTokens(undefined, { enabled: true, effort: 'high' }, neonCaps)).toBeUndefined();
  });

  it('sends 32768 max_tokens for google/gemini-4-neon at high reasoning on OpenAIProvider and OpenRouterProvider', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'google/gemini-4-neon',
        choices: [{ message: { content: 'function setup(){}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    });

    const openai = new OpenAIProvider({
      baseUrl: 'https://api.kilo.ai/api/gateway',
      apiKey: 'test-key',
      model: 'google/gemini-4-neon',
      maxTokens: 16_384,
    });
    const res1 = await openai.generate({
      systemPrompt: 'sys',
      userPrompt: 'draw',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(res1.isOk()).toBe(true);
    const body1 = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body1.max_tokens).toBe(32_768);
    expect(body1.reasoning_effort).toBe('high');

    const openrouter = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'google/gemini-4-neon',
      maxTokens: 16_384,
    });
    const res2 = await openrouter.generate({
      systemPrompt: 'sys',
      userPrompt: 'draw',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(res2.isOk()).toBe(true);
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body2.max_tokens).toBe(32_768);
    expect(body2.reasoning).toEqual({ effort: 'high' });
  });
});

describe('HostConcurrencyGate & Z.ai serialization', () => {
  it('detects api.z.ai hosts and defaults concurrency to 1 with env override', () => {
    expect(isZaiGatewayHost('https://api.z.ai/api/anthropic/v1/messages')).toBe(true);
    expect(isZaiGatewayHost('https://sub.z.ai/v1/chat/completions')).toBe(true);
    expect(isZaiGatewayHost('https://api.kilo.ai/api/gateway/chat/completions')).toBe(false);
    expect(resolveHostConcurrencyLimit('https://api.z.ai/api/anthropic')).toBe(DEFAULT_ZAI_MAX_CONCURRENCY);
    expect(resolveHostConcurrencyLimit('https://api.kilo.ai/api/gateway')).toBeUndefined();

    vi.stubEnv('SINTER_ZAI_MAX_CONCURRENCY', '3');
    expect(resolveHostConcurrencyLimit('https://api.z.ai/api/anthropic')).toBe(3);
  });

  it('serializes concurrent AnthropicProvider calls to api.z.ai in FIFO order', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const events: string[] = [];
    const resolvers: Array<() => void> = [];

    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      const label = parsed.messages[0].content;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      events.push(`start:${label}`);
      return new Promise((resolve) => {
        resolvers.push(() => {
          events.push(`end:${label}`);
          inFlight -= 1;
          resolve({
            ok: true,
            json: async () => ({
              model: 'glm-5.4',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: `ok:${label}` }],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
          });
        });
      });
    });

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'test-key',
      model: 'glm-5.4',
    });

    const p1 = provider.generate({ systemPrompt: 'sys', userPrompt: 'first' });
    const p2 = provider.generate({ systemPrompt: 'sys', userPrompt: 'second' });

    await new Promise((r) => setTimeout(r, 10));
    expect(peakInFlight).toBe(1);
    expect(events).toEqual(['start:first']);

    resolvers[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(peakInFlight).toBe(1);
    expect(events).toEqual(['start:first', 'end:first', 'start:second']);

    resolvers[1]();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.isOk() && r1.value.content).toBe('ok:first');
    expect(r2.isOk() && r2.value.content).toBe('ok:second');
    expect(peakInFlight).toBe(1);
  });

  it('aborts queued callers without leaking the slot', async () => {
    const releaseFirst = await acquireHostSlot('https://api.z.ai/api/anthropic/v1/messages');
    const controller = new AbortController();
    const queued = acquireHostSlot('https://api.z.ai/api/anthropic/v1/messages', controller.signal);
    controller.abort(new Error('caller cancelled'));
    await expect(queued).rejects.toThrow('caller cancelled');
    releaseFirst();

    const releaseNext = await acquireHostSlot('https://api.z.ai/api/anthropic/v1/messages');
    releaseNext();
  });

  it('registers glm-5.4 on the GLM Coding Plan model list', () => {
    expect(isGLMCodingPlanModel('glm-5.4')).toBe(true);
    expect(isGLMCodingPlanModel('glm-5.3')).toBe(true);
    expect(isGLMCodingPlanModel('glm-5.3-flash')).toBe(true);
  });
});
