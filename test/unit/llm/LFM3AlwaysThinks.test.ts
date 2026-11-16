import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIProvider, LFM3_THINK_BUDGET, LFM3_THINK_MIN } from '../../../src/llm/providers/OpenAIProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

/**
 * Every LFM3 call thinks with a large budget, then answers with its own budget
 * (Simon, 2026-11-16). No caller can turn the thought off or starve it.
 */
afterEach(() => vi.unstubAllGlobals());

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: string }> };

/** A llama.cpp server: /props reports the per-slot context when `slot` is set. */
function capture(reply: string, slot?: number) {
  const bodies: Body[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/props')) {
      return slot === undefined
        ? new Response('not found', { status: 404 })
        : Response.json({ default_generation_settings: { n_ctx: slot } });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(reply, { headers: { 'Content-Type': 'application/json' } });
  }));
  return bodies;
}

const answer = JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
  reasoning_content: 'Draw a circle that follows the mouse.', content: 'function draw() { circle(mouseX, mouseY, 20); }',
} }] });

async function send(model: string, req: Partial<ProviderRequest>, baseUrl = 'http://127.0.0.1:47851/v1', slot?: number) {
  const bodies = capture(answer, slot);
  const result = await new OpenAIProvider({ baseUrl, model }).generate({ systemPrompt: 'Code only', userPrompt: 'p5', ...req });
  return { body: bodies[0], result };
}

it('thinks with the default budget, and the answer keeps its own budget', async () => {
  const { body, result } = await send('LFM3-1.7B-Q8_0.gguf', { maxTokens: 2048 });
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  expect(body.thinking_budget_tokens).toBe(LFM3_THINK_BUDGET);
  expect(body.max_tokens).toBe(LFM3_THINK_BUDGET + 2048);
  expect(body.messages[0].content).toContain(`up to ${LFM3_THINK_BUDGET} tokens`);
  expect(body.messages[0].content).toContain('up to 2048 tokens');
  expect(result.isOk() && result.value.content).toBe('function draw() { circle(mouseX, mouseY, 20); }');
});

it.each([
  ['thinking off', { enabled: false }],
  ['a zero budget', { enabled: true, budgetTokens: 0 }],
  ['a small budget', { enabled: true, budgetTokens: 4000 }],
])('still thinks with the large budget when the caller asks for %s', async (_, thinking) => {
  const { body } = await send('lfm3-1.7b', { thinking, maxTokens: 512 });
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  expect(body.thinking_budget_tokens).toBe(LFM3_THINK_BUDGET);
});

const promptTokens = (body: Body) => Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 3);

it('fits prompt, thought and answer inside the slot the server reports, keeping the answer budget', async () => {
  const { body } = await send('LFM3-1.7B', { thinking: { enabled: true, budgetTokens: 16000 }, maxTokens: 4096 }, undefined, 16384);
  expect(Number(body.max_tokens) + promptTokens(body)).toBeLessThanOrEqual(16384);
  expect(Number(body.max_tokens) - Number(body.thinking_budget_tokens)).toBe(4096);
  expect(body.thinking_budget_tokens).toBeGreaterThan(LFM3_THINK_BUDGET);
});

it('a crowded slot still thinks a little and still leaves room to answer', async () => {
  const { body } = await send('LFM3-1.7B', { userPrompt: 'x'.repeat(45000), maxTokens: 4096 }, undefined, 16384);
  expect(body.thinking_budget_tokens).toBeGreaterThanOrEqual(LFM3_THINK_MIN);
  expect(Number(body.max_tokens) - Number(body.thinking_budget_tokens)).toBeGreaterThan(0);
  expect(Number(body.max_tokens) + promptTokens(body)).toBeLessThanOrEqual(16384);
});

it('a d1 decision model gets no thought fields', async () => {
  const { body } = await send('LFM3-d1-2B', { maxTokens: 64 });
  expect(body.chat_template_kwargs).toBeUndefined();
  expect(body.thinking_budget_tokens).toBeUndefined();
});

it('tells the model its budgets on the default system prompt too', async () => {
  const { body } = await send('LFM3-1.7B', { systemPrompt: '', maxTokens: 700 });
  expect(body.messages[0].content).toMatch(/^You are a helpful assistant\.\n\nThink first, for up to 8192 tokens\. Your answer then has up to 700 tokens\.$/);
});

it('takes a larger budget from the caller', async () => {
  const { body } = await send('LFM3-VL-2B', { thinking: { enabled: true, budgetTokens: 12000 }, maxTokens: 1000 });
  expect(body.thinking_budget_tokens).toBe(12000);
  expect(body.max_tokens).toBe(13000);
});

it('thinks on a remote LFM3 server too', async () => {
  const { body } = await send('LFM3-1.7B', {}, 'https://lfm3.example.com/v1');
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  expect(body.max_tokens).toBeUndefined();
});

it('the stream thinks the same way', async () => {
  const bodies = capture('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:47851/v1', model: 'LFM3-1.7B' });
  for await (const _ of provider.stream({ systemPrompt: 'Code only', userPrompt: 'p5', maxTokens: 300 })) { /* drain */ }
  expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: true });
  expect(bodies[0].thinking_budget_tokens).toBe(LFM3_THINK_BUDGET);
  expect(bodies[0].max_tokens).toBe(LFM3_THINK_BUDGET + 300);
});

it('leaves other models alone', async () => {
  const { body } = await send('qwen3-coder', { maxTokens: 400 });
  expect(body.chat_template_kwargs).toBeUndefined();
  expect(body.thinking_budget_tokens).toBeUndefined();
  expect(body.max_tokens).toBe(400);
  expect(body.messages[0].content).toBe('Code only');
});
