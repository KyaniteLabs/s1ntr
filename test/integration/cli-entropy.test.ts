/** Dogfood finding 6 (entropy): the organ had no operator call site on the generate path. `sinter entropy` and best-of now use it. */
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runTournament } from '../../src/cli/BestOfTournament.js';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000, hookTimeout: 280_000 });
let work: string; let fake: FakeProvider; let env: NodeJS.ProcessEnv; let proj: string;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-entropy-')); fake = await startFakeProvider();
  proj = path.join(work, 'proj'); mkdirSync(proj, { recursive: true });
  env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });
const seedOf = (out: string) => /seed:\s+(\d+)/.exec(out)?.[1];

describe('sinter entropy', () => {
  it('says there is nothing to harvest in an empty project, then harvests after a governed generate and the seed moves', async () => {
    const empty = await runSinterAsync(['entropy'], env, proj);
    expect(empty.status).toBe(0);
    expect(empty.out).toMatch(/Entropy: degraded/);
    expect(empty.out).toContain('Nothing in this project to harvest yet');
    const g = await runSinterAsync(['generate', '-o', path.join(work, 'out'), '--domain', 'html', 'a slow orbit of colored light'], env, proj);
    expect(g.status).toBe(0);
    appendFileSync(path.join(proj, '.omx', 'atelier', 'lessons', 'trend.jsonl'), 'null\n42\n');
    const after = await runSinterAsync(['entropy'], { ...env, SINTER_PROJECT_ROOT: proj }, work);
    expect(after.out).toMatch(/Entropy: harvested \(metabolic\)/);
    expect(after.out).toMatch(/from:\s+[1-9]\d* trend rows/);
    expect(seedOf(after.out)).not.toBe(seedOf(empty.out));
    const again = await runSinterAsync(['entropy'], env, proj);
    expect(seedOf(again.out)).toBe(seedOf(after.out));
  });
});

describe('best-of uses the harvested phrase', () => {
  it('appends it to every variant prompt, and omits it when none is given', async () => {
    const seen: string[] = [];
    const deps = { runChild: (p: string) => { seen.push(p); return { status: 3, stdout: '' }; }, score: () => null, rejectDir: path.join(tmpdir(), 'x'), log: () => {} };
    await runTournament('a prompt', 2, { ...deps, entropyPhrase: 'ash ember loom' });
    expect(seen).toHaveLength(2);
    for (const p of seen) expect(p).toContain('— entropy: ash ember loom');
    seen.length = 0;
    await runTournament('a prompt', 2, deps);
    for (const p of seen) expect(p).not.toContain('entropy:');
  });
});
