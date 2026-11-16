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
