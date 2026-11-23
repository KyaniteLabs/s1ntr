/** G09: a fallback request carries the fallback seat's own temperature / maxTokens / thinking. */
import { describe, it, expect } from 'vitest';
import { LLMClient } from '../../../src/llm/LLMClient.js';

type Internals = {
  requestForFallback(fb: unknown, req: Record<string, unknown>): Record<string, unknown>;
  fallbackThinking: WeakMap<object, unknown>;
};

describe('G09: fallback seat controls', () => {
  const client = new LLMClient({ baseUrl: 'http://127.0.0.1:9/v1', model: 'primary', apiKey: 'k', temperature: 0.2, maxTokens: 100 });
  const internals = client as unknown as Internals;
  const primaryReq = (over: Record<string, unknown> = {}) => ({
    systemPrompt: 's', userPrompt: 'u', temperature: 0.2, maxTokens: 100, thinking: { enabled: false }, ...over,
  });

  it('uses the fallback seat\'s own controls instead of the primary\'s', () => {
    const fb = { getConfig: () => ({ temperature: 0.9, maxTokens: 4000 }) };
    internals.fallbackThinking.set(fb, { enabled: true, effort: 'high' });
    const out = internals.requestForFallback(fb, primaryReq());
    expect(out.temperature).toBe(0.9);
    expect(out.maxTokens).toBe(4000);
    expect(out.thinking).toEqual({ enabled: true, effort: 'high' });
  });

  it('keeps a value the caller set explicitly for this call, and primary controls when the seat sets none', () => {
    const fb = { getConfig: () => ({ temperature: 0.9, maxTokens: 4000 }) };
    const explicit = internals.requestForFallback(fb, primaryReq({ maxTokens: 777, temperature: 0.5 }));
    expect(explicit.maxTokens).toBe(777);
    expect(explicit.temperature).toBe(0.5);
    const bare = internals.requestForFallback({ getConfig: () => ({}) }, primaryReq());
    expect(bare.temperature).toBe(0.2);
    expect(bare.maxTokens).toBe(100);
    expect(bare.thinking).toEqual({ enabled: false });
  });
});
