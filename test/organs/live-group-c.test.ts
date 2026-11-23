/**
 * Organ proofs that run the real modules (real HTTP server, real browser sandbox) with one input changed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TuiBridgeServer } from '../../src/tui-bridge/TuiBridgeServer.js';
import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';
import { validateLLMConfig } from '../../src/config/schema.js';
import { ConfigError } from '../../src/errors/ConfigError.js';
import { rerenderReevaluateProductRunCli } from '../../src/cli/LiminalRerenderReevaluate.js';
import { runInSandbox } from '../../src/sandbox/index.js';

vi.setConfig({ testTimeout: 120_000 });

async function statusCodes(limit: string, n: number): Promise<number[]> {
  process.env.LIMINAL_RATE_LIMIT_GENERAL = limit;
  const server = new TuiBridgeServer(new TuiBridgeService(), { port: 0 });
  try {
    await server.start();
    const codes: number[] = [];
    for (let i = 0; i < n; i++) codes.push((await fetch(`${server.address}/api/status`)).status);
    return codes;
  } finally { await server.stop(); }
}

describe('security + tui-bridge: the bridge answers through the shared rate limiter', () => {
  const saved = process.env.LIMINAL_RATE_LIMIT_GENERAL;
  afterEach(() => { if (saved === undefined) delete process.env.LIMINAL_RATE_LIMIT_GENERAL; else process.env.LIMINAL_RATE_LIMIT_GENERAL = saved; });
  it('limit 2: third request is 429; limit 50: all succeed (bypassing the limiter fails this)', async () => {
    const tight = await statusCodes('2', 4);
    expect(tight.slice(0, 2).every(c => c === 200)).toBe(true);
    expect(tight).toContain(429);
    const loose = await statusCodes('50', 4);
    expect(loose).not.toContain(429);
  });
});

describe('config + errors: validation failure surfaces as a typed ConfigError', () => {
  it('bad config throws ConfigError; good config passes', () => {
    expect(() => validateLLMConfig({ provider: 42 })).toThrow(ConfigError);
    expect(() => validateLLMConfig({})).not.toThrow(ConfigError);
  });
});

describe('cli: rerender-reevaluate refuses before touching a run', () => {
  it('relative paths and a missing grant fail with different, named errors', async () => {
    await expect(rerenderReevaluateProductRunCli('rel/run', 'rel/grant.json')).rejects.toThrow('REEVALUATION_PATH_NOT_ABSOLUTE');
    const dir = mkdtempSync(path.join(tmpdir(), 'organ-rr-'));
    try {
      const grant = path.join(dir, 'grant.json'); writeFileSync(grant, '{"not":"a grant"}');
      const err = await rerenderReevaluateProductRunCli(dir, grant).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toBe('REEVALUATION_PATH_NOT_ABSOLUTE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('sandbox: the real browser sandbox runs a sketch', () => {
  // This host blocks unprivileged user namespaces (AppArmor), so Chromium's own OS sandbox cannot start here;
  // the page-level sandbox (isolation + timeout + error capture) is what runs, via the documented opt-out.
  it('a clean sketch completes; a throwing sketch reports an error', async () => {
    process.env.LIMINAL_DISABLE_SANDBOX = 'true';
    const ok = await runInSandbox('function setup(){ createCanvas(50,50); noLoop(); } function draw(){ background(10); }', { timeoutMs: 60_000, disableSandbox: true });
    const bad = await runInSandbox('function setup(){ throw new Error("ORGAN_BOOM"); }', { timeoutMs: 60_000, disableSandbox: true });
    expect(ok.error, JSON.stringify(ok)).toBeUndefined();
    expect(ok.completed).toBe(true);
    delete process.env.LIMINAL_DISABLE_SANDBOX;
    expect(bad.error ?? '').toMatch(/ORGAN_BOOM/);
  });
});

import { CacheManager } from '../../src/llm/CacheManager.js';
import { ActionProviderBudget } from '../../src/llm/ActionProviderBudget.js';

describe('llm cache + budget (test only; src/llm is owned by #1423)', () => {
  it('cache: same prompt hits, other scope/system misses, disabled never serves', () => {
    const c = new CacheManager({ enabled: true });
    c.set('sys', 'user', 'CODE', 'a');
    expect(c.get('sys', 'user', 'a')).toBe('CODE');
    expect(c.get('sys', 'user', 'b')).toBeNull();
    expect(c.get('sys2', 'user', 'a')).toBeNull();
    const off = new CacheManager({ enabled: false });
    off.set('sys', 'user', 'CODE', 'a');
    expect(off.get('sys', 'user', 'a')).toBeNull();
  });
  it('budget: call N+1 is blocked before it leaves; a bigger cap lets it through', () => {
    const plan = (max: number) => ({ maxProviderCalls: max, stages: ['generate'] as const, plannedMinimumCalls: 1, plannedMaximumCalls: 1 });
    const tight = new ActionProviderBudget(plan(1)); tight.guard();
    expect(() => tight.guard()).toThrow(/budget exhausted/);
    const wide = new ActionProviderBudget(plan(2)); wide.guard();
    expect(() => wide.guard()).not.toThrow();
  });
});
