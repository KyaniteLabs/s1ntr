import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_BATCH_PRICES, ANTHROPIC_BATCH_PRICES_VERIFIED, batchCostUsd, batchPriceFor, worstCaseRequestUsd } from '../../../src/llm/AnthropicBatchPrices.js';
import { AnthropicBatchClient, sanitizeBatchParams, assertBatchBodyClean } from '../../../src/llm/AnthropicBatchClient.js';
import { budgetRemainingUsd, ensureBudgetEntry, reserveBudget, settleBudget, ProviderBudgetExceededError } from '../../../src/llm/ProviderBudgetLedger.js';
import { AnthropicProvider, isAdaptiveClaude } from '../../../src/llm/providers/AnthropicProvider.js';
import { assertJudgesNotAnthropic, parseBatchFile, resolveAnthropicTarget, withSharedCache, worstCaseBodyUsd, estimateBody, BatchLaneRefusal } from '../../../src/cli/LiminalBatchLane.js';

import { assertProviderAttemptAllowed, withProviderAttemptLimit } from '../../../src/llm/LLMClient.js';

it('counts a batch retry against the remaining live requests', async () => {
  let retries = 0;
  const result = await withProviderAttemptLimit(3, async () => {
    await assertProviderAttemptAllowed();
    retries++;
    await assertProviderAttemptAllowed();
    expect(() => assertProviderAttemptAllowed()).toThrow('PROVIDER_CALL_LIMIT_EXHAUSTED');
  }, () => retries);
  expect(result.providerCallsUsed).toBe(3);
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'batch-units-')); vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', dir); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('batch price table', () => {
  it('holds the verified batch prices and says when they were verified', () => {
    expect(ANTHROPIC_BATCH_PRICES_VERIFIED).toBe('2026-11-18');
    const by = Object.fromEntries(ANTHROPIC_BATCH_PRICES.map((p) => [p.family, [p.inUsdPerMTok, p.outUsdPerMTok]]));
    expect(by).toEqual({ 'claude-fable-5-2': [4, 20], 'claude-opus-5-5': [2, 10], 'claude-sonnet-5-5': [1, 5], 'claude-haiku-5-5': [0.05, 0.25] });
  });
  it('refuses a model it cannot price', () => { expect(() => batchPriceFor('gpt-6.2-sol')).toThrow(/BATCH_MODEL_UNPRICED/); });
  it('costs real usage with cache writes at 2x and reads at 0.1x of the input rate', () => {
    const usd = batchCostUsd('claude-opus-5-5', { input_tokens: 10_000, output_tokens: 10_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 10_000 });
    expect(usd).toBeCloseTo((10_000 * 2 + 10_000 * 10 + 10_000 * 4 + 10_000 * 0.2) / 1e6, 8);
  });
  it('worst case assumes zero cache hits: the whole cached prefix is paid as a write, every output token is used', () => {
    const noCache = worstCaseRequestUsd('claude-opus-5-5', { inputTokens: 10_000, cachedPrefixTokens: 0, maxTokens: 32_000 });
    expect(noCache).toBeCloseTo((10_000 * 2 + 32_000 * 10) / 1e6, 8);
    const cached = worstCaseRequestUsd('claude-opus-5-5', { inputTokens: 10_000, cachedPrefixTokens: 4_000, maxTokens: 32_000 });
    expect(cached).toBeGreaterThan(noCache);
  });
  it('refuses a prompt past 100K tokens where no long-prompt price is verified, prices Haiku long prompts at the higher tier', () => {
    expect(() => worstCaseRequestUsd('claude-opus-5-5', { inputTokens: 150_000, cachedPrefixTokens: 0, maxTokens: 1000 })).toThrow(/BATCH_PROMPT_TOO_LONG/);
    expect(worstCaseRequestUsd('claude-haiku-5-5', { inputTokens: 150_000, cachedPrefixTokens: 0, maxTokens: 1000 })).toBeCloseTo((150_000 * 0.25 + 1000 * 1.25) / 1e6, 8);
  });
});

describe('request hygiene on the 5.x models', () => {
  const base = { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
  it('strips temperature/top_p/top_k/stream/speed/fallbacks/thinking/tool_choice and any assistant prefill', () => {
    const out = sanitizeBatchParams({ ...base, temperature: 0.2, top_p: 1, top_k: 5, stream: true, speed: 'fast', fallbacks: [], thinking: { type: 'enabled', budget_tokens: 99 }, tool_choice: { type: 'tool' },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '{' }] });
    expect(Object.keys(out).sort()).toEqual(['max_tokens', 'messages', 'model']);
    expect(out.messages).toHaveLength(1);
    expect(() => assertBatchBodyClean({ requests: [{ params: { budget_tokens: 1 } }] })).toThrow(/budget_tokens/);
  });
  it('refuses max_tokens below 1', () => { expect(() => sanitizeBatchParams({ ...base, max_tokens: 0 })).toThrow(/max_tokens >= 1/); });
  it('puts the same 1-hour cache_control block on the shared system prefix', () => {
    const a = withSharedCache({ ...base, system: 'SYSTEM A' }); const b = withSharedCache({ ...base, system: 'SYSTEM B' });
    expect((a.system as any)[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((a.system as any)[0].cache_control).toEqual((b.system as any)[0].cache_control);
  });
  it('the live AnthropicProvider no longer sends temperature or budget_tokens to a 5.x model and maps effort to output_config', async () => {
    expect(isAdaptiveClaude('claude-opus-5-5')).toBe(true); expect(isAdaptiveClaude('claude-3-7-sonnet')).toBe(false);
    let sent: any = null;
    const p = new AnthropicProvider({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-opus-5-5', maxTokens: 500, temperature: 0.7, timeout: 5000 } as any);
    (p as any).limitedFetch = async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }); };
    await (p as any).generateImpl({ systemPrompt: 's', userPrompt: 'u', thinking: { enabled: true, effort: 'xhigh', budgetTokens: 4000 } });
    expect(sent.temperature).toBeUndefined(); expect(sent.thinking).toBeUndefined(); expect(JSON.stringify(sent)).not.toContain('budget_tokens');
    expect(sent.output_config).toEqual({ effort: 'xhigh' });
  });
  it('a refusal stop_reason is not read as content', async () => {
    const p = new AnthropicProvider({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-opus-5-5', maxTokens: 500, timeout: 5000 } as any);
    (p as any).limitedFetch = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'refusal', usage: {} }), { status: 200 });
    const r = await (p as any).generateImpl({ systemPrompt: 's', userPrompt: 'u' });
    expect(r.isOk() ? r.value.success : null).toBe(false);
  });
});

describe('batch transport', () => {
  it('retries a 429 at submit with backoff instead of failing the wave, and sends the key only in x-api-key', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []; let n = 0; const waits: number[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return ++n < 3 ? new Response('{"error":"rl"}', { status: 429, headers: { 'retry-after': '1' } }) : new Response(JSON.stringify({ id: 'msgbatch_x', processing_status: 'in_progress', request_counts: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new AnthropicBatchClient({ baseUrl: 'http://x.test', apiKey: 'sk-ant-SECRET', fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    const r = await c.submit([{ custom_id: 'a', params: { model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] } }]);
    expect(r.id).toBe('msgbatch_x'); expect(n).toBe(3); expect(waits).toEqual([1000, 1000]);
    expect(seen.every((s) => s.headers['x-api-key'] === 'sk-ant-SECRET' && !s.body.includes('SECRET') && !s.url.includes('SECRET'))).toBe(true);
  });
  it('does not retry a 400 and never puts the key in the error', async () => {
    const fetchImpl = (async () => new Response('{"error":"bad sk-ant-SECRET"}', { status: 400 })) as unknown as typeof fetch;
    const c = new AnthropicBatchClient({ baseUrl: 'http://x.test', apiKey: 'sk-ant-SECRET', fetchImpl, sleep: async () => {} });
    await expect(c.submit([{ custom_id: 'a', params: { model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] } }])).rejects.toThrow(/HTTP_400/);
    await c.submit([{ custom_id: 'a', params: { model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] } }]).catch((e: Error) => expect(e.message).not.toContain('SECRET'));
  });
});

describe('cumulative budget ledger', () => {
  it('holds worst case, settles actual, and stays cumulative across calls (a second run sees the first run\'s spend)', () => {
    const base = 'https://api.anthropic.com';
    ensureBudgetEntry(base, 55);
    expect(budgetRemainingUsd(base)).toBe(55);
    reserveBudget(base, 'w1', 30); expect(budgetRemainingUsd(base)).toBe(25);
    expect(() => reserveBudget(base, 'w2', 26)).toThrow(ProviderBudgetExceededError);
    settleBudget(base, 'w1', 12.5); settleBudget(base, 'w1', 99); // second settle books nothing
    expect(budgetRemainingUsd(base)).toBe(42.5);
    ensureBudgetEntry(base, 100); // a bigger --budget-usd cannot raise the cap
    expect(budgetRemainingUsd(base)).toBe(42.5);
    ensureBudgetEntry(base, 40); // a smaller one lowers it
    expect(budgetRemainingUsd(base)).toBe(27.5);
  });
  it('reserving the same id twice holds it once', () => {
    ensureBudgetEntry('https://api.anthropic.com', 10); reserveBudget('https://api.anthropic.com', 'k', 4); reserveBudget('https://api.anthropic.com', 'k', 4);
    expect(budgetRemainingUsd('https://api.anthropic.com')).toBe(6);
  });
});

describe('guards', () => {
  it('refuses a base URL that is not api.anthropic.com (the z.ai/GLM entry) and a key that is not an Anthropic key', () => {
    expect(() => resolveAnthropicTarget({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' })).toThrow(/BATCH_BASE_URL_NOT_ANTHROPIC/);
    expect(() => resolveAnthropicTarget({ ANTHROPIC_API_KEY: 'glm.zai-key' })).toThrow(/BATCH_KEY_NOT_ANTHROPIC/);
    expect(resolveAnthropicTarget({ ANTHROPIC_API_KEY: 'sk-ant-ok' }).baseUrl).toBe('https://api.anthropic.com');
    // a loopback URL passes only when the test env names that exact URL
    expect(() => resolveAnthropicTarget({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })).toThrow(/BATCH_BASE_URL_NOT_ANTHROPIC/);
    const testTarget = resolveAnthropicTarget({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      SINTER_BATCH_TEST_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant-test-placeholder' });
    expect(testTarget).toMatchObject({ test: true, apiKey: 'batch-lane-test' });
    expect(() => resolveAnthropicTarget({ ANTHROPIC_BASE_URL: 'https://evil.example', SINTER_BATCH_TEST_BASE_URL: 'https://evil.example' })).toThrow(/BATCH_BASE_URL_NOT_ANTHROPIC/);
  });
  it('refuses a config that would send a judge call to Anthropic', async () => {
    vi.stubEnv('LIMINAL_EVALUATOR_PROVIDER', 'anthropic');
    vi.stubEnv('LIMINAL_EVALUATOR_BASE_URL', 'https://api.anthropic.com');
    vi.stubEnv('LIMINAL_EVALUATOR_MODEL', 'claude-opus-5-5');
    vi.stubEnv('LIMINAL_EVALUATOR_API_KEY', 'sk-ant-judge');
    vi.stubEnv('HOME', dir);
    await expect(assertJudgesNotAnthropic('sk-ant-judge')).rejects.toThrow(/BATCH_JUDGE_ON_ANTHROPIC/);
  });
});

describe('prompt file and estimate', () => {
  it('parses the prompt-family format and rejects duplicate or unsafe ids', () => {
    const f = path.join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ prompts: [{ id: 'a', domain: 'p5', prompt: 'x', loops: 3 }, { id: 'b', prompt: 'y' }] }));
    expect(parseBatchFile(f).map((p) => [p.id, p.domain, p.loops])).toEqual([['a', 'p5', 3], ['b', 'p5', undefined]]);
    writeFileSync(f, JSON.stringify([{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }]));
    expect(() => parseBatchFile(f)).toThrow(BatchLaneRefusal);
    for (const id of ['../x', '.', '..', 'batch-lane', 'Batch-Lane.JSON', '.batch-lane.lock']) {
      writeFileSync(f, JSON.stringify([{ id, prompt: 'x' }]));
      expect(() => parseBatchFile(f)).toThrow(/BATCH_FILE_BAD_ID/);
    }
    writeFileSync(f, JSON.stringify([{ id: 'a', prompt: 'x' }, { id: 'A', prompt: 'y' }]));
    expect(() => parseBatchFile(f)).toThrow(/BATCH_FILE_DUPLICATE_ID/);
  });
  it('the estimate counts max_tokens, UTF-8 bytes, the margin, and images at a fixed cost', () => {
    const body = { model: 'claude-opus-5-5', max_tokens: 32000, system: 'x'.repeat(3000), messages: [{ role: 'user', content: [{ type: 'text', text: 'é'.repeat(1500) }, { type: 'image', source: {} }] }] };
    const e = estimateBody(body as any);
    expect(e.inputTokens).toBe(3000 + 3000 + 1600 + 32); expect(e.cachedPrefixTokens).toBe(3000);
    const usd = worstCaseBodyUsd('claude-opus-5-5', body as any, 10);
    expect(usd).toBeCloseTo(((e.inputTokens - 3000) * 2 + 3000 * 4 + 32000 * 10) / 1e6 * 1.1, 8);
  });
});
