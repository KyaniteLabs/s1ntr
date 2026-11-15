import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertWithinBudget,
  recordServerCost,
  budgetStatus,
  hostOf,
  ProviderBudgetExceededError,
  ProviderBudgetModelNotAllowedError,
  ProviderBudgetConfigInvalidError,
} from '../../src/llm/ProviderBudgetLedger.js';

const root = path.join(tmpdir(), `budget-ledger-test-${process.pid}`);
const budgetsPath = path.join(root, '.sinter', 'provider-budgets.json');

function writeBudgets(entries: Record<string, unknown>): void {
  mkdirSync(path.dirname(budgetsPath), { recursive: true });
  writeFileSync(budgetsPath, JSON.stringify(entries));
}

describe('ProviderBudgetLedger', () => {
  beforeEach(() => {
    process.env.SINTER_LIMINAL_RUNTIME_ROOT = root;
  });
  afterEach(() => {
    delete process.env.SINTER_LIMINAL_RUNTIME_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it('hostOf extracts the endpoint host', () => {
    expect(hostOf('https://api.deepinfra.com/v1/openai')).toBe('api.deepinfra.com');
    expect(hostOf('https://token-plan-sgp.xiaomimimo.com/v1')).toBe('token-plan-sgp.xiaomimimo.com');
  });


  it('fails closed when the ledger is corrupt', () => {
    mkdirSync(path.dirname(budgetsPath), { recursive: true });
    writeFileSync(budgetsPath, '{"api.deepinfra.com":');
    expect(() => assertWithinBudget('https://api.deepinfra.com/v1', 'deepseek'))
      .toThrow(ProviderBudgetConfigInvalidError);
  });

  it('does not take down a completed response when the ledger cannot be read', () => {
    mkdirSync(path.dirname(budgetsPath), { recursive: true });
    writeFileSync(budgetsPath, 'not json');
    expect(() => recordServerCost('https://api.deepinfra.com/v1', 0.01)).not.toThrow();
  });

  it('unmetered endpoints pass through untouched', () => {
    writeBudgets({});
    expect(() => assertWithinBudget('https://api.minimax.io/v1', 'minimax-m3')).not.toThrow();
  });

  it('blocks the model when outside the earmark (the $40 is for ONE model)', () => {
    writeBudgets({
      'api.deepinfra.com': {
        capUsd: 40, spendUsd: 0,
        allowedModels: ['deepseek-ai/DeepSeek-V4-Flash-0731'],
      },
    });
    expect(() => assertWithinBudget('https://api.deepinfra.com/v1/openai', 'meta/Llama-4-405B')).toThrow(
      ProviderBudgetModelNotAllowedError,
    );
    expect(() => assertWithinBudget('https://api.deepinfra.com/v1/openai', 'deepseek-ai/DeepSeek-V4-Flash-0731')).not.toThrow();
  });

  it('fail-closes the endpoint once server-reported spend reaches the cap', () => {
    writeBudgets({ 'api.deepinfra.com': { capUsd: 40, spendUsd: 39.9999 } });
    recordServerCost('https://api.deepinfra.com/v1/openai', 0.01);
    const onDisk = JSON.parse(readFileSync(budgetsPath, 'utf8'));
    expect(onDisk['api.deepinfra.com'].spendUsd).toBeGreaterThanOrEqual(40);
    expect(() => assertWithinBudget('https://api.deepinfra.com/v1/openai', 'deepseek-ai/DeepSeek-V4-Flash-0731')).toThrow(
      ProviderBudgetExceededError,
    );
  });

  it('accumulates server-reported cost on metered hosts only', () => {
    writeBudgets({ 'api.deepinfra.com': { capUsd: 40, spendUsd: 1 } });
    recordServerCost('https://api.deepinfra.com/v1/openai', 0.25);
    recordServerCost('https://api.minimax.io/v1', 99); // unmetered host — ignored
    const status = budgetStatus().find(s => s.host === 'api.deepinfra.com');
    expect(status?.spendUsd).toBe(1.25);
    expect(status?.remainingUsd).toBeCloseTo(38.75, 4);
    expect(status?.closed).toBe(false);
    expect(budgetStatus().find(s => s.host === 'api.minimax.io')).toBeUndefined();
  });

  it('ignores non-positive or non-finite cost reports', () => {
    writeBudgets({ 'api.deepinfra.com': { capUsd: 40, spendUsd: 2 } });
    recordServerCost('https://api.deepinfra.com/v1/openai', 0);
    recordServerCost('https://api.deepinfra.com/v1/openai', Number.NaN);
    expect(budgetStatus()[0].spendUsd).toBe(2);
  });
});
