/** G07: concurrent settlements must not lose a debit; F10/G04: a provider-call cap of 0 is rejected up front. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'sinter-budget-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function settle(env: NodeJS.ProcessEnv, count: number): Promise<number> {
  const modulePath = path.join(repoRoot, 'dist/llm/ProviderBudgetLedger.js');
  const code = `import(${JSON.stringify(modulePath)}).then(m => { for (let i = 0; i < ${count}; i++) m.recordServerCost('http://127.0.0.1:9/v1', 0.01); });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (status) => resolve(status ?? -1));
  });
}

describe('provider budget ledger', () => {
  it('keeps every debit when several processes settle at the same time', async () => {
    const file = path.join(root, '.sinter', 'provider-budgets.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ '127.0.0.1:9': { capUsd: 100, spendUsd: 0 } }));
    const env = { PATH: process.env.PATH, HOME: root, SINTER_LIMINAL_RUNTIME_ROOT: root } as NodeJS.ProcessEnv;
    const statuses = await Promise.all(Array.from({ length: 6 }, () => settle(env, 20)));
    expect(statuses).toEqual([0, 0, 0, 0, 0, 0]);
    const spend = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { spendUsd: number }>)['127.0.0.1:9'].spendUsd;
    expect(spend).toBeCloseTo(6 * 20 * 0.01, 6);
  });
});

describe('--max-provider-calls', () => {
  it('rejects 0 at parse time instead of failing later inside command creation', () => {
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/sinter'), 'generate', '--prompt', 'x', '--max-provider-calls', '0'],
      { cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('--max-provider-calls');
    expect(`${r.stdout}${r.stderr}`).toContain('positive integer');
  });
});
