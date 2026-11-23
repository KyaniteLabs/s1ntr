/**
 * `generate --loops N` through the REAL built binary, a local fake HTTP provider and the REAL renderer.
 * Loop k+1's generator request must contain loop k's code and the judge's critique of loop k; three artifacts on disk;
 * the manifest carries loop numbers and marks the best loop. Red on the old code (`--loops` unknown / one Create only).
 */
import { mkdtempSync, existsSync, readFileSync, rmSync, renameSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, LIVELY_HTML, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 290_000 });
const SCORES = [0.6, 0.9, 0.7];
let fake: FakeProvider; let work: string;
beforeAll(async () => {
  fake = await startFakeProvider({
    generate: (c) => LIVELY_HTML.replace('<title>Orbit</title>', `<title>Orbit v${c.index + 1}</title>`),
    // the judge may be called more than once per loop; key the verdict on the loop being judged (= generator calls so far)
    judge: () => { const n = fake.generated.length; return { ...goodJudgeReply(SCORES[n - 1] ?? 0.5), reasoning: `CRITIQUE-OF-LOOP-${n}-xyzzy` }; },
  });
  work = mkdtempSync(path.join(tmpdir(), 'sinter-loops-'));
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

describe('generate --loops 3', () => {
  it('chains three governed loops: code + critique carried, three artifacts, loop numbers, best marked, budget scaled', async () => {
    const out = path.join(work, 'out');
    const env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
    const args = ['generate', '-o', out, '--medium', 'html', '--loops', '3', 'a slow orbit of colored light'];
    const run = await runSinterAsync([...args, '--retry-unknown'], env);
    expect(run.status, run.out).toBe(0);
    expect(fake.generated).toHaveLength(3);
    expect(fake.generated[0].user).not.toContain('This is loop');
    expect(fake.generated[1].user).toContain('This is loop 2 of 3');
    expect(fake.generated[1].user).toContain('<title>Orbit v1</title>');
    expect(fake.generated[1].user).toContain('CRITIQUE-OF-LOOP-1-xyzzy');
    expect(fake.generated[2].user).toContain('This is loop 3 of 3');
    expect(fake.generated[2].user).toContain('<title>Orbit v2</title>');
    expect(fake.generated[2].user).toContain('CRITIQUE-OF-LOOP-2-xyzzy');
    expect(fake.generated[2].user).not.toContain('CRITIQUE-OF-LOOP-1-xyzzy');
    expect(fake.generated[1].user).toMatch(/S1NTR-REVISION-META .*early-frame\.png/); // loop 1's rendered frames are named in the brief
    const manifest = JSON.parse(readFileSync(path.join(out, 'loops-manifest.json'), 'utf8'));
    expect(manifest.loops).toBe(3);
    expect(manifest.records.map((r: { loop: number }) => r.loop)).toEqual([1, 2, 3]);
    manifest.records.forEach((r: { score: number }, i: number) => expect(r.score).toBeCloseTo(SCORES[i], 6));
    expect(manifest.bestLoop).toBe(2);
    expect(manifest.records.filter((r: { best: boolean }) => r.best).map((r: { loop: number }) => r.loop)).toEqual([2]);
    expect(manifest.providerCallBudget).toBe(6);
    for (const r of manifest.records) { expect(r.providerCalls).toBeGreaterThan(0); expect(r.providerCalls).toBeLessThanOrEqual(r.providerCallsMaximum); }
    expect(manifest.providerCallsConsumed).toBe(manifest.records.reduce((n: number, r: { providerCalls: number }) => n + r.providerCalls, 0));
    for (const r of manifest.records) expect(existsSync(path.join(r.artifactDirectory, 'source.txt'))).toBe(true);
    expect(new Set(manifest.records.map((r: { artifactDirectory: string }) => r.artifactDirectory)).size).toBe(3);
    expect(run.out).toMatch(/Best loop: r2/);
    expect(manifest.retryNamespace).toMatch(/^[0-9a-f-]{36}$/);
    const calls = fake.calls.length;
    const replay = await runSinterAsync(args, env);
    expect(replay.status, replay.out).toBe(0);
    expect(replay.out).toMatch(/Best loop: r2/);
    expect(fake.calls).toHaveLength(calls);
  });
});

it('writes validated SVG fragments for each loop and restores a missing fragment on replay', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100" aria-hidden="true">'
    + '<rect width="400" height="100" fill="var(--paper, currentColor)"/>'
    + '<circle cx="200" cy="50" r="35" fill="var(--ink, currentColor)"/></svg>';
  const fragmentProvider = await startFakeProvider({ generate: () => svg });
  try {
    const out = path.join(work, 'svg-loops');
    const env = fakeProviderEnv(fragmentProvider, { home: path.join(work, 'svg-home'), stateRoot: path.join(work, 'svg-state') });
    const args = ['generate', '-o', out, '--domain', 'svg', '--loops', '2', '--output-mode', 'fragment',
      '--tokens', 'paper,ink', 'an inset circular ornament'];
    const run = await runSinterAsync(args, env);
    expect(run.status, run.out).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(out, 'loops-manifest.json'), 'utf8'));
    const fragments = manifest.records.map((record: { artifactDirectory: string }) =>
      path.join(record.artifactDirectory, 'fragment.svg'));
    expect(fragments).toHaveLength(2);
    for (const fragment of fragments) expect(readFileSync(fragment, 'utf8')).toContain('aria-hidden="true"');
    expect(run.out).toContain(`Fragment: ${fragments[manifest.bestLoop - 1]}`);
    const bestFragment = fragments[manifest.bestLoop - 1];
    rmSync(bestFragment);
    const calls = fragmentProvider.calls.length;
    const replay = await runSinterAsync(args, env);
    expect(replay.status, replay.out).toBe(0);
    expect(fragmentProvider.calls).toHaveLength(calls);
    expect(readFileSync(bestFragment, 'utf8')).toContain('aria-hidden="true"');
  } finally {
    await fragmentProvider.close();
  }
});

describe('generate --loops: crash after the journal write, before the -o mirror', () => {
  it('a rerun completes the mirror (no new provider call for that loop) and continues; moved bytes are adopted, not reported as a replay', async () => {
    const out = path.join(work, 'out-crash');
    const state = path.join(work, 'state-crash');
    const env = fakeProviderEnv(fake, { home: path.join(work, 'home-crash'), stateRoot: state });
    const args = ['generate', '-o', out, '--medium', 'html', '--loops', '2', 'a drowned television humming under green water'];
    const first = await runSinterAsync(args, env);
    expect(first.status, first.out).toBe(0);
    const callsAfterFirst = fake.generated.length;
    const resume = await runSinterAsync([...args, '--retry-unknown'], env);
    expect(resume.status, resume.out).toBe(0);
    expect(fake.generated).toHaveLength(callsAfterFirst);
    // (a) crash before loop 2's projection mirror: bytes in -o, no product-projections.json, loop 2 absent from the manifest
    const r2 = path.join(out, 'loops', 'r2');
    rmSync(path.join(r2, 'product-projections.json'));
    rmSync(path.join(out, 'loops-manifest.json'));
    const wrongState = await runSinterAsync(args, { ...env,
      SINTER_LIMINAL_RUNTIME_ROOT: path.join(work, 'state-wrong') });
    expect(wrongState.status, wrongState.out).toBe(1);
    expect(wrongState.out).toContain('LOOPS_RESUME_EFFECT_MISMATCH');
    expect(fake.generated).toHaveLength(callsAfterFirst);
    const originalState = state + '-original';
    renameSync(state, originalState);
    const replacedState = await runSinterAsync(args, env);
    expect(replacedState.status, replacedState.out).toBe(1);
    expect(replacedState.out).toContain('LOOPS_RESUME_EFFECT_MISMATCH');
    expect(fake.generated).toHaveLength(callsAfterFirst);
    rmSync(state, { recursive: true, force: true });
    renameSync(originalState, state);
    const second = await runSinterAsync(args, env);
    expect(second.status, second.out).toBe(0);
    expect(fake.generated.length).toBe(callsAfterFirst); // journaled Creates replay: no new provider traffic
    expect(existsSync(path.join(r2, 'product-projections.json'))).toBe(true);
    const m = JSON.parse(readFileSync(path.join(out, 'loops-manifest.json'), 'utf8'));
    expect(m.records.map((r: { loop: number }) => r.loop)).toEqual([1, 2]);
    expect(m.records[1].artifactDirectory).toMatch(/[/]artifacts[/][a-f0-9]{64}$/);
    // (b) the loop folder is gone but the bytes survive elsewhere and the location pointer says where: adopt them
    const moved = path.join(out, 'loops', 'r2-moved');
    renameSync(r2, moved);
    const locDir = path.join(state, 'artifact-locations');
    for (const f of readdirSync(locDir)) {
      const p = path.join(locDir, f);
      const v = readFileSync(p, 'utf8');
      if (v.includes(`${path.sep}r2${path.sep}`)) writeFileSync(p, v.replace(`${path.sep}r2${path.sep}`, `${path.sep}r2-moved${path.sep}`));
    }
    const directory = m.records[1].artifactDirectory as string;
    const movedDirectory = path.join(moved, path.relative(r2, directory));
    const movedSource = path.join(movedDirectory, 'source.txt');
    const source = readFileSync(movedSource);
    writeFileSync(path.join(movedDirectory, 'unrelated.txt'), 'not part of the signed artifact');
    writeFileSync(movedSource, 'tampered source');
    rmSync(path.join(out, 'loops-manifest.json'));
    const rejected = await runSinterAsync(args, env);
    expect(rejected.status, rejected.out).toBe(1);
    expect(rejected.out).toContain('LIMINAL_ARTIFACT_DIGEST_MISMATCH');
    expect(fake.generated.length).toBe(callsAfterFirst);
    expect(existsSync(path.join(r2, 'product-projections.json'))).toBe(false);
    writeFileSync(movedSource, source);
    rmSync(path.join(out, 'loops-manifest.json'));
    const third = await runSinterAsync(args, env);
    expect(third.status, third.out).toBe(0);
    expect(fake.generated.length).toBe(callsAfterFirst);
    expect(existsSync(path.join(r2, 'product-projections.json'))).toBe(true);
    expect(third.out).not.toMatch(/LOOP_REPLAY_NO_ARTIFACT/);
    expect(readFileSync(path.join(directory, 'source.txt'))).toEqual(source);
    expect(existsSync(path.join(directory, 'unrelated.txt'))).toBe(false);

    // A completed loop with a manifest must verify bytes before serving as the next revision base.
    const manifestPath = path.join(out, 'loops-manifest.json');
    const manifest = readFileSync(manifestPath);
    writeFileSync(path.join(directory, 'early-frame.png'), 'tampered frame');
    const fourth = await runSinterAsync(args, env);
    expect(fourth.status, fourth.out).toBe(1);
    expect(fourth.out).toContain('LOOP_RECOVERY_FRAME_DIGEST_MISMATCH');
    expect(readFileSync(manifestPath)).toEqual(manifest);
    expect(fake.generated.length).toBe(callsAfterFirst);

    // A bad first Create with no manifest must terminate before loop 2 can mint a new prompt.
    const firstSourcePath = path.join(m.records[0].artifactDirectory, 'source.txt');
    const firstSource = readFileSync(firstSourcePath);
    writeFileSync(firstSourcePath, 'tampered first loop');
    rmSync(manifestPath);
    const fifth = await runSinterAsync(args, env);
    expect(fifth.status, fifth.out).toBe(1);
    expect(fifth.out).toContain('LIMINAL_ARTIFACT_DIGEST_MISMATCH');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      records: [], bestLoop: null, providerCallsConsumed: 0,
    });
    expect(fake.generated.length).toBe(callsAfterFirst);

    const initialCheckpoint = readFileSync(manifestPath);
    writeFileSync(firstSourcePath, firstSource);
    const projectionFile = path.join(state, 'product-projections.json');
    const projections = JSON.parse(readFileSync(projectionFile, 'utf8')) as Record<string, {
      result?: { operationId: string }; commandDigest: string;
    }>;
    const firstProjection = Object.values(projections).find(
      value => value.result?.operationId && firstSourcePath.includes(
        path.join('r1', 'artifacts', createHash('sha256').update(value.result.operationId).digest('hex'))),
    );
    expect(firstProjection?.commandDigest).toMatch(/^[0-9a-f]{64}$/);
    const originalCommand = firstProjection!.commandDigest;
    firstProjection!.commandDigest = '0'.repeat(64);
    writeFileSync(projectionFile, JSON.stringify(projections));
    const rebound = await runSinterAsync(args, env);
    expect(rebound.status, rebound.out).toBe(1);
    expect(rebound.out).toContain('LOOP_REPLAY_PROJECTION_MISSING_OR_WRONG_COMMAND');
    expect(readFileSync(manifestPath)).toEqual(initialCheckpoint);
    expect(fake.generated.length).toBe(callsAfterFirst);

    firstProjection!.commandDigest = originalCommand;
    delete firstProjection!.result;
    writeFileSync(projectionFile, JSON.stringify(projections));
    const malformed = await runSinterAsync(args, env);
    expect(malformed.status, malformed.out).toBe(1);
    expect(malformed.out).toContain('LIMINAL_CREATE_PROJECTION_INVALID');
    expect(readFileSync(manifestPath)).toEqual(initialCheckpoint);
    expect(fake.generated.length).toBe(callsAfterFirst);
  });
});
