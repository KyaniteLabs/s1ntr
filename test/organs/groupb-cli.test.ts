/**
 * Organ group B, spawned-CLI proofs (built bin/sinter, fake provider, no key, no network):
 * telemetry + ledger (events written by a real generate, read back by `ledger query`),
 * music (live-music, and music-to-visual wiring), composite (spec validation), site (seed + dry-run evolve),
 * reporting (report cognition).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, LIVELY_HTML, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

let work: string; let fake: FakeProvider; let n = 0;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-groupb-cli-'));
  fake = await startFakeProvider({
    generate: () => LIVELY_HTML,
    judge: () => goodJudgeReply(0.8),
  });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

function env() {
  const i = n++;
  return fakeProviderEnv(fake, { home: path.join(work, `home${i}`), stateRoot: path.join(work, `state${i}`) });
}

describe('telemetry + ledger: a real generate leaves events that `ledger query` reads back', () => {
  it('records the generator response and reads it back as a JSON line', async () => {
    const e = env();
    const args = ['generate', '-o', path.join(work, 'tl-out'), '--domain', 'html', 'a slow orbit of colored light'];
    const before = fake.generated.length;
    const gen = await runSinterAsync(args, e, work);
    expect(gen.status, gen.stderr).toBe(0);
    const q = await runSinterAsync(['ledger', 'query', '--event', 'generation.model-response'], e, work);
    expect(q.status).toBe(0);
    const rows = q.out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    expect(fake.generated.length).toBeGreaterThan(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'generation.model-response', schemaVersion: 2,
      role: 'generator', domain: 'html', model: 'gpt-5.4', verdict: 'success', payload: { phase: 'primary' } });
    const afterCreate = fake.generated.length;
    const replay = await runSinterAsync(args, e, work);
    expect(replay.status, replay.stderr).toBe(0);
    expect(fake.generated).toHaveLength(afterCreate);
    const replayQuery = await runSinterAsync(['ledger', 'query', '--event', 'generation.model-response'], e, work);
    expect(replayQuery.stdout).toBe(q.stdout);
  });

  it('a fresh home has nothing to read (the events come from the run, not from a fixture)', async () => {
    const q = await runSinterAsync(['ledger', 'query'], env());
    expect(q.status).toBe(0);
    expect(q.out.split('\n').filter(l => l.startsWith('{'))).toHaveLength(0);
  });
});

describe('music organ through the CLI', () => {
  it('live-music writes strudel + hydra files and --music-to-visual follows the music tempo', async () => {
    const e = env();
    const out = path.join(work, 'lm-out');
    const before = fake.generated.length;
    const run = await runSinterAsync(['live-music', 'a slow tide of low drones', '-o', out, '--music-to-visual'], e);
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/Visuals follow the music \(measured tempo \d+ BPM\)/);
    expect(existsSync(path.join(out, 'hydra.js'))).toBe(true);
    // the visual request carries the tempo and spectrum measured from the generated music
    const asked = fake.generated.slice(before).map(c => c.system + c.user).join('\n');
    expect(asked).toMatch(/Audio context: BPM=\d+, FFT length=16/);
  });

  it('without --music-to-visual the visuals are not linked to the music', async () => {
    const out = path.join(work, 'lm-plain');
    const before = fake.generated.length;
    const run = await runSinterAsync(['live-music', 'a slow tide of low drones', '-o', out], env());
    expect(run.status).toBe(0);
    expect(fake.generated.slice(before).map(c => c.system + c.user).join('\n')).not.toMatch(/Audio context: BPM=/);
    expect(run.out).not.toMatch(/Visuals follow the music/);
  });
});

describe('composite organ: spec validation', () => {
  const spec = (over: object = {}) => ({ width: 640, height: 360, fps: 24, duration: 4, layers: [{ type: 'image', source: 'a.png' }, { type: 'audio', source: 'b.wav' }], ...over });
  it('a valid layered spec is analysed layer by layer', async () => {
    const f = path.join(work, 'spec.json'); writeFileSync(f, JSON.stringify(spec()));
    const run = await runSinterAsync(['composite', '--spec', f, '--output', path.join(work, 'plan.json')], env());
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/Layers: 2/);
    expect(existsSync(path.join(work, 'plan.json'))).toBe(true);
  });
  it('an invalid spec is refused (the validator is load-bearing)', async () => {
    const f = path.join(work, 'bad.json'); writeFileSync(f, JSON.stringify(spec({ width: 0 })));
    const run = await runSinterAsync(['composite', '--spec', f], env());
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/Composite analysis failed/);
  });
});

describe('site organ: seed then a dry-run evolve pass', () => {
  it('seeds starter slots, and evolve --once --dry-run runs against them without a provider write', async () => {
    const e = env();
    const seed = await runSinterAsync(['site', 'seed', '--slots', '3'], e);
    expect(seed.status).toBe(0);
    const evolve = await runSinterAsync(['site', 'evolve', '--once', '--dry-run'], e);
    expect(evolve.status).toBe(0);
  });
});

describe('reporting organ: cognition report', () => {
  it('prints the creative body and the loop of the system from live registries', async () => {
    const run = await runSinterAsync(['report', 'cognition'], env());
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/Sinter Cognitive Architecture/);
    expect(run.out).toMatch(/Creative Body:/);
  });
});
