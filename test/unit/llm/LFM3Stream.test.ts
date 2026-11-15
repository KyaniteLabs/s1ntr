import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';
import type { StreamEvent } from '../../../src/llm/ProviderTypes.js';

afterEach(() => vi.unstubAllGlobals());

function sse(chunks: string[]): Response {
  const lines = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  lines.push('data: [DONE]\n\n');
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  }));
}

async function streamed(model: string, chunks: string[]): Promise<{ text: string; events: StreamEvent[] }> {
  vi.stubGlobal('fetch', vi.fn(async () => sse(chunks)));
  const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:46407/v1', model });
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({ systemPrompt: 'Code only', userPrompt: 'p5' })) events.push(event);
  const text = events.filter(e => e.type === 'content').map(e => (e as { content: string }).content).join('');
  return { text, events };
}

it('streams only the final LFM3 answer when the think tags split across chunks', async () => {
  const { text, events } = await streamed('LFM3-1.7B', ['<thi', 'nk>plan the ', 'rings</th', 'ink>fill(0,0,', '255);']);
  expect(text).toBe('fill(0,0,255);');
  expect(events.at(-1)?.type).toBe('done');
});

it('streams nothing from an LFM3 answer that never leaves its think span', async () => {
  const { text } = await streamed('LFM3-1.7B', ['<think>still ', 'planning']);
  expect(text).toBe('');
});

it('passes other models through chunk by chunk', async () => {
  const { events } = await streamed('other-model', ['<think>a</think>', 'b']);
  expect(events.filter(e => e.type === 'content').map(e => (e as { content: string }).content))
    .toEqual(['<think>a</think>', 'b']);
});
