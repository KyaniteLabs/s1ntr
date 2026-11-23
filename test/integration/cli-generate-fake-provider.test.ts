/**
 * Sol audit F04/G01/F06 through the REAL binary: bin/sinter talks to a local fake provider over HTTP (no paid call).
 */
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

let fake: FakeProvider; let work: string;
beforeAll(async () => { fake = await startFakeProvider(); work = mkdtempSync(path.join(tmpdir(), 'sinter-fake-')); });
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

const saved = (out: string) => /Saved: (\S+)/.exec(out)?.[1];

describe('F04/G01: Saved is only ever printed for artifacts that exist', () => {
  it('fresh run saves real files; a replay into a new -o root says so, exits 4 and spends no provider call', async () => {
    const home = path.join(work, 'home'); const state = path.join(work, 'state');
    const env = fakeProviderEnv(fake, { home, stateRoot: state });
    const args = (o: string) => ['generate', '-o', o, '--domain', 'html', 'a slow orbit of colored light'];

    const first = await runSinterAsync(args(path.join(work, 'out1')), env);
    expect(first.status).toBe(0);
    const firstSaved = saved(first.out);
    expect(firstSaved && existsSync(firstSaved)).toBe(true);
    const callsAfterFirst = fake.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const replay = await runSinterAsync(args(path.join(work, 'out2')), env);
    expect(fake.calls.length).toBe(callsAfterFirst); // idempotent replay: no new provider traffic
    // the new -o root holds nothing, so the CLI must not claim a save there
    const out2Artifacts = path.join(work, 'out2', 'artifacts');
    expect(existsSync(out2Artifacts) && readdirSync(out2Artifacts).length > 0).toBe(false);
    expect(replay.status).toBe(4);
    expect(replay.out).not.toMatch(/Saved: /);
    expect(replay.out).toContain(path.dirname(firstSaved as string)); // points at where the artifacts really are
  });
});

describe('F06: best-of through the real binary', () => {
  // The scoring step (`sss-score`) is a two-vendor vision ensemble with fixed external endpoints and needs a
  // ~/.sinter/config.json, so the loser-reference rule is proven at unit level (BestOfTournament.test.ts) with an
  // injected scorer. Here the real children run against the fake provider and the real scorer step fails closed.
  it('children save real artifacts; an unscorable round exits 4 without moving or deleting any artifact', async () => {
    const home = path.join(work, 'home-b'); const state = path.join(work, 'state-b'); const cwd = path.join(work, 'cwd-b');
    mkdirSync(cwd, { recursive: true });
    const run = await runSinterAsync(['best-of', '2', '--domain', 'html', 'a field of drifting embers'],
      fakeProviderEnv(fake, { home, stateRoot: state }), cwd);
    const variants = [...run.out.matchAll(/\[best-of\] variant \d: saved (\S+)/g)].map(m => m[1]);
    expect(variants).toHaveLength(2);
    for (const dir of variants) expect(existsSync(path.join(dir, 'source.txt'))).toBe(true);
    expect(run.status).toBe(4);
    expect(run.out).toMatch(/BEST_OF_NO_CANDIDATES/);
    expect(existsSync(path.join(cwd, '.omx', 'atelier', 'tournament-rejects'))).toBe(false);
    for (const dir of variants) expect(existsSync(path.join(dir, 'source.txt'))).toBe(true); // still there after the round
  });
});
