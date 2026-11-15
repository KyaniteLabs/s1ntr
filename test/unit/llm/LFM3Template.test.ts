import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';

afterEach(() => vi.unstubAllGlobals());

it('selects the final LFM3 answer after an orphan closing thinking delimiter', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'draft: fill(255); Wait, use blue.</think>fill(0,0,255);' }, finish_reason: 'stop' }],
  }))));
  const result = await new OpenAIProvider({
    baseUrl: 'http://127.0.0.1:46517/v1', model: 'LFM3-1.7B',
  }).generate({ systemPrompt: 'Code only', userPrompt: 'Blue fill' });
  expect(result.isOk() && result.value.content).toBe('fill(0,0,255);');
});

it('requests a final answer from local LFM3 without spending its budget on thinking', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'function add(a,b){return a+b;}' }, finish_reason: 'stop' }],
  })));
  vi.stubGlobal('fetch', fetchImpl);
  const provider = new OpenAIProvider({
    baseUrl: 'http://127.0.0.1:46517/v1', model: 'LFM3-1.7B-QAD-Q4_0.gguf',
  });
  await provider.generate({ systemPrompt: 'Code only', userPrompt: 'add', maxTokens: 200 });
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
});

it.each([
  ['https://example.com/v1', 'LFM3-1.7B', false],
  ['http://127.0.0.1:46517/v1', 'other-model', false],
  ['http://127.0.0.1:46517/v1', 'LFM3-1.7B', true],
])('preserves the request for %s %s thinking=%s', async (baseUrl, model, enabled) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  })));
  vi.stubGlobal('fetch', fetchImpl);
  await new OpenAIProvider({ baseUrl, model }).generate({
    systemPrompt: 'Brief', userPrompt: 'Hello', thinking: { enabled },
  });
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(body.chat_template_kwargs).toBeUndefined();
});
