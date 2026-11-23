/**
 * RAN proof, machine-checked: a spawned `bin/sinter generate` (fake HTTP provider, real renderer) runs under
 * NODE_V8_COVERAGE. Every registry module whose proof.ran starts with "spawned-cli" must have executed at least
 * one function of its own dist files in that child process.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, LIVELY_HTML } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000, hookTimeout: 280_000 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(readFileSync(path.join(root, 'test/organs/registry.json'), 'utf8')) as { modules: Record<string, { proof?: { ran?: string } }> };
let work: string; const executed = new Map<string, number>(); let status: number | null = null;

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'organ-cov-'));
  const cov = path.join(work, 'cov'); mkdirSync(cov);
  const fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) });
  try {
    const env = { ...fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') }), NODE_V8_COVERAGE: cov };
    status = (await runSinterAsync(['generate', '-o', path.join(work, 'out'), '--domain', 'html', 'a calm study in two shapes'], env)).status;
  } finally { await fake.close(); }
  for (const f of readdirSync(cov)) {
    const j = JSON.parse(readFileSync(path.join(cov, f), 'utf8')) as { result: Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> };
    for (const s of j.result) {
      const m = /\/dist\/([^/]+)\//.exec(s.url); if (!m) continue;
      // functionName '' with the widest range is the module wrapper; count named/inner functions that ran.
      const ran = s.functions.filter(fn => fn.functionName && fn.ranges[0]?.count > 0).length;
      executed.set(m[1], (executed.get(m[1]) ?? 0) + ran);
    }
  }
});
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

describe('RAN proof: spawned generate executes the organs the registry claims', () => {
  it('the spawned run itself succeeded', () => { expect(status).toBe(0); });
  it('every module claiming spawned-cli RAN executed functions in the child', () => {
    const claimed = Object.entries(registry.modules).filter(([, e]) => e.proof?.ran?.startsWith('spawned-cli')).map(([k]) => k);
    expect(claimed.length).toBeGreaterThan(0);
    for (const m of claimed) expect(executed.get(m) ?? 0, `${m} claims spawned-cli RAN but executed no functions`).toBeGreaterThan(0);
  });
  it('prints the per-module executed-function table (evidence for the registry)', () => {
    const rows = [...executed.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`SPAWNED_COVERAGE ${rows}`);
    expect(executed.size).toBeGreaterThan(5);
  });
});
