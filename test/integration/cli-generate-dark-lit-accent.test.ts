/**
 * Dogfood finding 3: two wall pieces the wall judge scored 0.76/0.79 came back 0.29 "below-quality-floor" through
 * the real binary. They are not static (the traces draw themselves); the overmixed value-structure cap fired because a
 * dark scene lit by thin bright lines never reaches the 98th-percentile light. A real light under 2% of the frame
 * must not be read as mud camo.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });
let work: string; let fake: FakeProvider; let reply = '';
beforeAll(async () => { work = mkdtempSync(path.join(tmpdir(), 'sinter-darklit-')); fake = await startFakeProvider({ generate: () => reply }); });
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

const fixture = (name: string) => readFileSync(new URL(`../fixtures/dark-lit/${name}.html`, import.meta.url), 'utf8');

describe('dark scene with a lit accent is judged on what is on screen', () => {
  it('circuit board with self-drawing traces is accepted at the judge score, not capped to 0.29', async () => {
    reply = fixture('trace-router');
    const run = await runSinterAsync(['generate', '-o', path.join(work, 'out-svg'), '--domain', 'svg',
      'An animated circuit board seen from above: copper traces route themselves across the board one by one'],
    fakeProviderEnv(fake, { home: path.join(work, 'h1'), stateRoot: path.join(work, 's1') }));
    expect(run.out).toContain('Quality score: 0.80');
    expect(run.out).not.toContain('below-quality-floor');
    expect(run.status).toBe(0);
  });

  it('CSS-native kinetic orrery is accepted at the judge score, not capped to 0.29', async () => {
    reply = fixture('d9-kinetic');
    const run = await runSinterAsync(['generate', '-o', path.join(work, 'out-kin'), '--domain', 'kinetic',
      'CSS-native kinetic art of a mechanical orrery: nested rotating rings with tick marks'],
    fakeProviderEnv(fake, { home: path.join(work, 'h2'), stateRoot: path.join(work, 's2') }));
    expect(run.out).toContain('Quality score: 0.80');
    expect(run.status).toBe(0);
  });
});
