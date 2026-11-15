import { describe, expect, it } from 'vitest';
import { parseAnthropicStream, parseOpenAIStream } from '../../../src/llm/StreamParser.js';

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<{ type: string; content?: string; error?: string }>) {
  const events: Array<{ type: string; content?: string; error?: string }> = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('stream parser termination', () => {
  it('reports truncation when an OpenAI stream closes without [DONE]', async () => {
    const events = await collect(parseOpenAIStream(streamOf(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    )));

    expect(events[0]).toEqual({ type: 'content', content: 'partial' });
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });


  it('accepts a trailing [DONE] with no newline or with CRLF', async () => {
    const noNewline = await collect(parseOpenAIStream(streamOf(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]',
    )));
    expect(noNewline.map((event) => event.type)).toEqual(['content', 'done']);

    const crlf = await collect(parseOpenAIStream(streamOf(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    )));
    expect(crlf.map((event) => event.type)).toEqual(['content', 'done']);
  });

  it('does not double-yield done when message_stop is followed by [DONE]', async () => {
    const events = await collect(parseAnthropicStream(streamOf(
      'data: {"type":"message_stop"}\n\ndata: [DONE]\n\n',
    )));
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('propagates an Anthropic upstream error instead of calling it truncation', async () => {
    const events = await collect(parseAnthropicStream(streamOf(
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    )));
    expect(events).toEqual([{ type: 'error', error: 'Overloaded' }]);
  });

  it('accepts [DONE] as a terminal signal', async () => {
    const events = await collect(parseOpenAIStream(streamOf(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    )));

    expect(events.map((event) => event.type)).toEqual(['content', 'done']);
  });

  it('accepts finish_reason as a terminal signal without [DONE]', async () => {
    const events = await collect(parseOpenAIStream(streamOf(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    )));

    expect(events.map((event) => event.type)).toEqual(['content', 'done']);
  });

  it('reports truncation when Anthropic closes before message_stop', async () => {
    const events = await collect(parseAnthropicStream(streamOf(
      'data: {"type":"content_block_delta","delta":{"text":"partial"}}\n\n',
    )));

    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('emits exactly one done on a complete Anthropic stream', async () => {
    const events = await collect(parseAnthropicStream(streamOf(
      'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n',
    )));

    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});
