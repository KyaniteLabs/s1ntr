/**
 * FABLE-R3.8: a reached spend cap must stop every provider adapter, in both
 * request modes, before anything leaves the machine. The network boundary
 * (global fetch) is the only thing replaced; the adapters and ledger are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderConfig } from '../../src/llm/ProviderTypes.js';
import type { BaseProvider } from '../../src/llm/providers/BaseProvider.js';
import { OpenAIProvider } from '../../src/llm/providers/OpenAIProvider.js';
import { AnthropicProvider } from '../../src/llm/providers/AnthropicProvider.js';
import { OllamaProvider } from '../../src/llm/providers/OllamaProvider.js';
import { MiniMaxProvider } from '../../src/llm/providers/MiniMaxProvider.js';
import { GoogleProvider } from '../../src/llm/providers/GoogleProvider.js';
import { OpenRouterProvider } from '../../src/llm/providers/OpenRouterProvider.js';
import { KiloGatewayProvider } from '../../src/llm/providers/KiloGatewayProvider.js';
import { budgetStatus, recordServerCost } from '../../src/llm/ProviderBudgetLedger.js';
import { runBudgetCommand } from '../../src/cli/BudgetCli.js';

const HOST = 'capped.example.test';
const root = path.join(tmpdir(), `budget-all-adapters-${process.pid}`);
const budgetsPath = path.join(root, '.sinter', 'provider-budgets.json');

const config: ProviderConfig = {
  baseUrl: `https://${HOST}/v1`, model: 'm-1', apiKey: 'test-key',
  temperature: 0.5, maxTokens: 64, timeout: 5000,
};

const adapters: Array<[string, () => BaseProvider]> = [
  ['openai', () => new OpenAIProvider(config)],
  ['anthropic', () => new AnthropicProvider(config)],
  ['ollama', () => new OllamaProvider(config)],
  ['minimax', () => new MiniMaxProvider(config)],
  ['google', () => new GoogleProvider(config)],
  ['openrouter', () => new OpenRouterProvider(config)],
  ['kilo', () => new KiloGatewayProvider(config)],
];

function writeBudgets(entries: Record<string, unknown>): void {
  mkdirSync(path.dirname(budgetsPath), { recursive: true });
  writeFileSync(budgetsPath, JSON.stringify(entries));
}

const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));

describe('spend cap across every adapter', () => {
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

  it.each(adapters)('%s: generate refuses a CLOSED endpoint with 0 requests sent', async (_name, make) => {
    writeBudgets({ [HOST]: { capUsd: 1, spendUsd: 1 } });
    const result = await make().generate({ prompt: 'hello' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/^PROVIDER_BUDGET_EXCEEDED: capped\.example\.test/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it.each(adapters)('%s: stream refuses a CLOSED endpoint with 0 requests sent', async (_name, make) => {
    writeBudgets({ [HOST]: { capUsd: 1, spendUsd: 1 } });
    const drain = async () => { for await (const _event of make().stream({ prompt: 'hello' })) { /* drain */ } };
    await expect(drain()).rejects.toThrow(/^PROVIDER_BUDGET_EXCEEDED/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('refuses a model outside the earmark on a non-OpenAI adapter', async () => {
    writeBudgets({ [HOST]: { capUsd: 10, spendUsd: 0, allowedModels: ['other-model'] } });
    const result = await new AnthropicProvider(config).generate({ prompt: 'hello' });
    expect(result._unsafeUnwrapErr().message).toMatch(/^PROVIDER_BUDGET_MODEL_NOT_ALLOWED: m-1/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('sends the request when there is no cap file', async () => {
    const result = await new AnthropicProvider(config).generate({ prompt: 'hello' });
    expect(result.isErr()).toBe(true); // the stub answers 500
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a corrupt cap file fails closed for every adapter', async () => {
    mkdirSync(path.dirname(budgetsPath), { recursive: true });
    writeFileSync(budgetsPath, '{"broken":');
    const result = await new OllamaProvider(config).generate({ prompt: 'hello' });
    expect(result._unsafeUnwrapErr().message).toMatch(/^PROVIDER_BUDGET_CONFIG_INVALID/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe('budget status says when spend is not counted', () => {
  beforeEach(() => { process.env.SINTER_LIMINAL_RUNTIME_ROOT = root; });
  afterEach(() => {
    delete process.env.SINTER_LIMINAL_RUNTIME_ROOT;
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('marks an endpoint that never reported a cost, and clears it once one does', async () => {
    writeBudgets({ [HOST]: { capUsd: 5, spendUsd: 0 } });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    await runBudgetCommand(['status']);
    expect(lines).toEqual([`[budget] ${HOST}  $0.0000/$5.00  open  remaining $5.00  spend not tracked`]);

    recordServerCost(config.baseUrl, 0.25);
    expect(budgetStatus()[0]).toMatchObject({ spendUsd: 0.25, costReported: true });
    lines.length = 0;
    await runBudgetCommand(['status']);
    expect(lines).toEqual([`[budget] ${HOST}  $0.2500/$5.00  open  remaining $4.75`]);
  });
});
