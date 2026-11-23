/**
 * Organ proofs through the REAL spawned binary against a local fake provider (no paid call).
 * Each test changes one input and asserts on what the fake provider received or the binary printed.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { P5_SKETCH } from './p5Sketch.js';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });
let fake: FakeProvider; let work: string;
beforeAll(async () => { fake = await startFakeProvider(); work = mkdtempSync(path.join(tmpdir(), 'organ-spawn-c-')); });
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

describe('daemon: living-site cycle runs through the spawned CLI with a fake analytics key', () => {
  it('no key: the cycle is a no-op and the provider is never called; fake key: the cycle runs', async () => {
    const home = path.join(work, 'home-d'); const state = path.join(work, 'state-d');
    const env = { ...fakeProviderEnv(fake, { home, stateRoot: state }), LIMINAL_LOG_LEVEL: 'info' };
    const seeded = await runSinterAsync(['site', 'seed', '--slots', '1'], env);
    expect(seeded.status, seeded.out).toBe(0);
    const before = fake.calls.length;
    const off = await runSinterAsync(['site', 'evolve', '--once', '--dry-run'], env);
    expect(off.out).toMatch(/PostHog not configured/);
    expect(fake.calls.length).toBe(before);
    const on = await runSinterAsync(['site', 'evolve', '--once', '--dry-run'],
      { ...env, LIMINAL_POSTHOG_KEY: 'phc_fake_organ_key', LIMINAL_POSTHOG_HOST: fake.baseUrl.replace('/v1', '') });
    expect(on.out).not.toMatch(/PostHog not configured/);
    expect(on.out).toMatch(/Running single evolution cycle/);
    // The cycle reaches generation (RalphLoop starts) under the governed per-call grant: the old refusal is gone.
    expect(on.out).toMatch(/\[RalphLoop\]/);
    expect(off.out).not.toMatch(/\[RalphLoop\]/);
    expect(on.out).not.toMatch(/Provider transport requires Liminal product command authority/);
  });
});


describe('daemon: a challenger is created, evaluated and promoted end to end on fakes', () => {
  it('cycle 1 creates a challenger, cycle 2 promotes it (fake analytics host, fake provider)', async () => {
    const p5fake = await startFakeProvider({ generate: () => P5_SKETCH });
    const asked: string[] = [];
    const ph = createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.includes('/query/')) {
          const id = JSON.parse(body).query.values.variantId as string; asked.push(id);
          const strong = id !== asked[0];
          res.end(JSON.stringify({ results: [[500, strong ? 0.9 : 0.1, strong ? 0.9 : 0.1, strong ? 0.9 : 0.1, strong ? 0.9 : 0.1]] }));
        } else res.end('{"status":1}');
      });
    });
    await new Promise<void>(r => ph.listen(0, '127.0.0.1', () => r()));
    const phUrl = `http://127.0.0.1:${(ph.address() as { port: number }).port}`;
    try {
      const home = path.join(work, 'home-e2e'); const state = path.join(work, 'state-e2e');
      const env = { ...fakeProviderEnv(p5fake, { home, stateRoot: state }), LIMINAL_LOG_LEVEL: 'info',
        LIMINAL_POSTHOG_KEY: 'phc_fake_organ_key', LIMINAL_POSTHOG_HOST: phUrl, LIMINAL_POSTHOG_API_HOST: phUrl,
        LIMINAL_POSTHOG_PERSONAL_API_KEY: 'phx_fake', LIMINAL_POSTHOG_PROJECT_ID: '1', LIMINAL_DISABLE_SANDBOX: 'true', SINTER_SITE_ASSET_DIR: path.join(work, 'site-assets') };
      expect((await runSinterAsync(['site', 'seed', '--slots', '1'], env)).status).toBe(0);
      const slotsFile = path.join(home, '.sinter', 'site', 'slots.json');
      const one = await runSinterAsync(['site', 'evolve', '--once'], env);
      expect(one.out).not.toMatch(/Provider transport requires/);
      expect(one.status, one.out.slice(-800)).toBe(0);   // the journal digests the (void) cycle result AFTER the work; side effects alone missed that crash
      expect(one.out).not.toMatch(/data. argument must be of type string/);
      expect(existsSync(slotsFile), one.out).toBe(true);
      const afterOne = JSON.parse(readFileSync(slotsFile, 'utf8'));
      const slot1 = (afterOne.slots ?? afterOne)[0];
      expect(slot1.challenger, one.out.slice(-1500)).toMatchObject({ experimentId: expect.any(String) });
      const activeBefore = slot1.active.experimentId; const challengerId = slot1.challenger.experimentId;
      const two = await runSinterAsync(['site', 'evolve', '--once'], env);
      expect(two.status, two.out.slice(-800)).toBe(0);
      const parsed2 = JSON.parse(readFileSync(slotsFile, 'utf8')); const slot2 = (parsed2.slots ?? parsed2)[0];
      expect(two.out).toMatch(/Promoted challenger|Rejected challenger/);
      expect(slot2.active.experimentId, two.out.slice(-1500)).toBe(challengerId);
      expect(slot2.active.experimentId).not.toBe(activeBefore);
    } finally { await new Promise(r => ph.close(r)); await p5fake.close(); }
  });
});

describe('daemon + ledger: `ledger run` runs a task under the same governed grant', () => {
  it('runs a task end to end against the fake provider with no authority refusal', async () => {
    const home = path.join(work, 'home-ledger'); const state = path.join(work, 'state-ledger'); const proj = path.join(work, 'proj-ledger');
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, 'tasks.json'), JSON.stringify([{ id: 'ORG-1', title: 'Orbit sketch', description: 'a slow orbit of colored light',
      taskClass: 'leaf', files: { allowlist: ['src/**'], denylist: [] }, verifyCommand: 'true', scoringCriteria: ['technical'], lane: 1, maxAttempts: 2 }]));
    const p5 = await startFakeProvider({ generate: () => P5_SKETCH });
    const env = { ...fakeProviderEnv(p5, { home, stateRoot: state }), LIMINAL_LOG_LEVEL: 'info', LIMINAL_DISABLE_SANDBOX: 'true' };
    try {
    expect((await runSinterAsync(['ledger', 'load', path.join(proj, 'tasks.json')], env, proj)).status).toBe(0);
    const run = await runSinterAsync(['ledger', 'run', 'ORG-1'], env, proj);
    expect(run.out).not.toMatch(/Provider transport requires/);
    expect(run.status, run.out.slice(-800)).toBe(0);
    expect(run.out).toMatch(/Attempt:\s+att-/);
    expect(p5.generated.length).toBeGreaterThan(0);
    } finally { await p5.close(); }
  });
});

const gen = (out: string, domain: string, prompt = 'a slow orbit of colored light') =>
  ['generate', '-o', out, '--domain', domain, prompt];

describe('config + cli + types: one changed input moves what the provider receives', () => {
  it('config: LLM base URL decides which provider is called', async () => {
    const other = await startFakeProvider();
    try {
      const a = await runSinterAsync(gen(path.join(work, 'cfg-a'), 'html'), fakeProviderEnv(fake, { home: path.join(work, 'h-cfg-a'), stateRoot: path.join(work, 's-cfg-a') }));
      expect(a.status, a.out).toBe(0);
      const aOther = other.calls.length;
      const before = fake.calls.length;
      await runSinterAsync(gen(path.join(work, 'cfg-b'), 'html', 'a different still harbor at dusk'), fakeProviderEnv(other, { home: path.join(work, 'h-cfg-b'), stateRoot: path.join(work, 's-cfg-b') }));
      expect(aOther).toBe(0);
      expect(other.calls.length).toBeGreaterThan(0);
      expect(fake.calls.length).toBe(before);
    } finally { await other.close(); }
  });

  it('cli + types: the --domain flag changes the generator brief the provider receives', async () => {
    const start = fake.generated.length;
    await runSinterAsync(gen(path.join(work, 'dom-html'), 'html', 'a ring of drifting lanterns'), fakeProviderEnv(fake, { home: path.join(work, 'h-dh'), stateRoot: path.join(work, 's-dh') }));
    const html = fake.generated[start]; expect(html, 'no generator call for html').toMatchObject({ system: expect.any(String), user: expect.stringContaining('a ring of drifting lanterns') });
    const mid = fake.generated.length;
    await runSinterAsync(gen(path.join(work, 'dom-svg'), 'svg', 'a ring of drifting lanterns'), fakeProviderEnv(fake, { home: path.join(work, 'h-ds'), stateRoot: path.join(work, 's-ds') }));
    const svg = fake.generated[mid]; expect(svg, 'no generator call for svg').toMatchObject({ system: expect.any(String), user: expect.stringContaining('a ring of drifting lanterns') });
    expect(svg.system + svg.user).not.toBe(html.system + html.user);
  });
});

describe('fs: the content store decides whether a repeat prompt spends a provider call', () => {
  it('same state root: replay spends nothing; fresh state root: the provider is called again', async () => {
    const home = path.join(work, 'h-fs'); const s1 = path.join(work, 's-fs1'); const s2 = path.join(work, 's-fs2');
    await runSinterAsync(gen(path.join(work, 'fs-o1'), 'html', 'a lattice of slow fireflies'), fakeProviderEnv(fake, { home, stateRoot: s1 }));
    const n1 = fake.calls.length;
    await runSinterAsync(gen(path.join(work, 'fs-o2'), 'html', 'a lattice of slow fireflies'), fakeProviderEnv(fake, { home, stateRoot: s1 }));
    expect(fake.calls.length, 'store did not short-circuit the replay').toBe(n1);
    await runSinterAsync(gen(path.join(work, 'fs-o3'), 'html', 'a lattice of slow fireflies'), fakeProviderEnv(fake, { home: path.join(work, 'h-fs2'), stateRoot: s2 }));
    expect(fake.calls.length).toBeGreaterThan(n1);
  });
});

describe('fix: the error text and file reach the provider', () => {
  it('two different --error strings produce two different provider requests', async () => {
    const dir = path.join(work, 'fixdir'); mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, 'src'), { recursive: true }); const file = path.join(dir, 'src', 'bug.js'); writeFileSync(file, 'function add(a,b){ return a - b }\nmodule.exports = add\n');
    const env = fakeProviderEnv(fake, { home: path.join(work, 'h-fix'), stateRoot: path.join(work, 's-fix') });
    const start = fake.calls.length;
    const r1 = await runSinterAsync(['fix', file, '--error', 'ORGAN_ERR_ALPHA add(1,2) returned -1', '--confirm', 'never'], env, dir);
    const c1 = fake.calls.slice(start);
    const mid = fake.calls.length;
    await runSinterAsync(['fix', file, '--error', 'ORGAN_ERR_BETA add(2,2) returned 0', '--confirm', 'never'], env, dir);
    const c2 = fake.calls.slice(mid);
    expect(c1.length, r1.out).toBeGreaterThan(0);
    expect(c1.map(c => c.user + c.system).join('')).toContain('ORGAN_ERR_ALPHA');
    expect(c2.map(c => c.user + c.system).join('')).toContain('ORGAN_ERR_BETA');
    expect(c2.map(c => c.user + c.system).join('')).not.toContain('ORGAN_ERR_ALPHA');
  });
});
