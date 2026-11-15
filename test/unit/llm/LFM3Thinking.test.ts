import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['<think>unfinished reasoning', '', false],
  ['<think>private planning</think>function setup() {}', 'function setup() {}', true],
])('separates inline LFM3 reasoning from usable final content', async (raw, final, success) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{
    finish_reason: 'stop', message: { content: raw },
  }] }))));
  const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:46407/v1', model: 'LFM3-1.7B' });
  const result = await provider.generate({ systemPrompt: 'Code only', userPrompt: 'p5' });
  expect(result.isOk() && result.value.content).toBe(final);
  expect(result.isOk() && result.value.success).toBe(success);
});

it('gets final code from local LFM3 without spending the whole budget on reasoning', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const direct = body.chat_template_kwargs?.enable_thinking === false;
    return new Response(JSON.stringify({ choices: [{
      finish_reason: direct ? 'stop' : 'length',
      message: { content: direct ? 'function setup() {}' : '', reasoning_content: 'analysis' },
    }] }), { headers: { 'Content-Type': 'application/json' } });
  }));
  const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:46407/v1', model: 'LFM3-1.7B-Q4_K_M.gguf' });
  const result = await provider.generate({ systemPrompt: 'Code only', userPrompt: 'p5', maxTokens: 256 });
  expect(result.isOk() && result.value.success).toBe(true);
  expect(result.isOk() && result.value.content).toBe('function setup() {}');
});

it('keeps reasoning separate when the caller explicitly requests it', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).chat_template_kwargs?.enable_thinking).not.toBe(false);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'length',
      message: { content: '', reasoning_content: 'unfinished code is not an artifact' },
    }] }));
  }));
  const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:46407/v1', model: 'LFM3-1.7B' });
  const result = await provider.generate({ systemPrompt: 'Code only', userPrompt: 'p5', thinking: { enabled: true } });
  expect(result.isOk() && result.value.success).toBe(false);
  expect(result.isOk() && result.value.content).toBe('');
});
