/**
 * Sol 6.2 lane 3 (L3-01..L3-03, L3-08): the whole governed Create (generate -> render -> perceive -> judge ->
 * admission -> exit code) through the REAL `bin/sinter` against the local fake provider. No network beyond
 * loopback, no paid call. Needs `pnpm build` (the binary runs from dist).
 *
 * Covers a browser visual domain (html), a text domain (svg), an audio domain (Tone), and the judge replies a
 * healthy-looking default used to hide: `{}`, wrong types, a truncated object.
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, LIVELY_HTML, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

// Mid-tone, structured, not clipped: passes the objective render gates so only the judge decides.
const SVG_ART = '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#223344"/><circle cx="70" cy="80" r="40" fill="#4a7a9a"/><rect x="100" y="90" width="70" height="70" fill="#8a5a6a" transform="rotate(20 135 125)"/><path d="M10 180 Q100 100 190 170" stroke="#d0b070" stroke-width="6" fill="none"/></svg>';
const TONE_AUDIBLE = `const synth = new Tone.Synth({ oscillator: { type: 'triangle' } }).toDestination();
const notes = ['C4', 'E4', 'G4', 'B4', 'A4', 'F4'];
let i = 0;
new Tone.Loop((time) => { synth.triggerAttackRelease(notes[i++ % notes.length], '8n', time); }, '8n').start(0);
Tone.Transport.bpm.value = 120;
Tone.Transport.start();`;
const TONE_SILENT = `const synth = new Tone.Synth().toDestination();
Tone.Transport.bpm.value = 90;`;

let work: string;
beforeAll(() => { work = mkdtempSync(path.join(tmpdir(), 'sinter-e2e-')); });
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

let seq = 0;
async function create(fake: FakeProvider, domain: string, brief: string) {
  const n = seq++;
  const env = fakeProviderEnv(fake, { home: path.join(work, `home${n}`), stateRoot: path.join(work, `state${n}`) });
  const out = path.join(work, `out${n}`);
  const run = await runSinterAsync(['generate', '-o', out, '--domain', domain, brief], env);
  const savedAt = /Saved: (\S+)/.exec(run.out)?.[1];
  return { ...run, savedAt };
}

describe('governed Create, html (browser visual)', () => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) }); });
  afterAll(async () => { await fake.close(); });

  it('accepts a rendered piece only after the judge saw its frames: exit 0, artifact on disk', async () => {
    const run = await create(fake, 'html', 'a slow orbit of colored light');
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/Generation complete/);
    expect(run.savedAt && existsSync(run.savedAt)).toBe(true);
    expect(fake.judged.length).toBeGreaterThan(0);
    expect(fake.judged[0].images).toBeGreaterThan(0);
  });
});

describe.each([
  ['an empty object', {}],
  ['string-typed score and confidence', { score: 'high', confidence: 'sure' }],
  ['a score with no confidence', { score: 0.9 }],
])('governed Create, a judge that replies %s (L3-02)', (_label, reply) => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => reply }); });
  afterAll(async () => { await fake.close(); });

  it('saves the files but never accepts: exit 3, no "complete", the verdict is named unscored', async () => {
    const run = await create(fake, 'html', 'drifting embers over dark water');
    expect(fake.judged.length).toBeGreaterThan(0);
    expect(run.status).toBe(3);
    expect(run.out).not.toMatch(/Generation complete/);
    expect(run.out).toMatch(/not accepted/i);
  });
});

describe.each([
  ['a truncated object', '{"score":0.8,"confidence":0.9,"reasoning":"a lovely pie'],
  ['prose with no JSON', 'It looks great to me, nine out of ten.'],
])('governed Create, a judge that replies with %s (L3-02)', (_label, text) => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => LIVELY_HTML, judgeText: () => text }); });
  afterAll(async () => { await fake.close(); });

  it('saves the files but never accepts: exit 3', async () => {
    const run = await create(fake, 'html', 'a lantern festival seen from a hill');
    expect(fake.judged.length).toBeGreaterThan(0);
    expect(run.status).toBe(3);
    expect(run.out).not.toMatch(/Generation complete/);
  });
});

describe('governed Create, svg (text domain)', () => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => SVG_ART, judge: () => goodJudgeReply(0.75) }); });
  afterAll(async () => { await fake.close(); });

  it('renders the markup, judges the frames, and accepts', async () => {
    const run = await create(fake, 'svg', 'an abstract composition of shapes and one curved line');
    expect(run.status).toBe(0);
    expect(run.savedAt && existsSync(run.savedAt)).toBe(true);
    expect(fake.judged[0]?.images).toBeGreaterThan(0);
  });
});

describe('governed Create, Tone (audio domain, L3-08)', () => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => TONE_AUDIBLE, judge: () => goodJudgeReply(0.8) }); });
  afterAll(async () => { await fake.close(); });

  it('captures real audio from the vendored Tone, judges it, and accepts', async () => {
    const run = await create(fake, 'tone', 'a slow arpeggio in a minor key');
    expect(run.status).toBe(0);
    expect(run.savedAt && existsSync(run.savedAt)).toBe(true);
    expect(fake.judged.length).toBeGreaterThan(0);
  });
});

describe('governed Create, a silent Tone piece (L3-08)', () => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => TONE_SILENT, judge: () => goodJudgeReply(0.95) }); });
  afterAll(async () => { await fake.close(); });

  it('is never admitted on a generous judge: exit 3', async () => {
    const run = await create(fake, 'tone', 'a quiet drone');
    expect(run.status).not.toBe(0);
    expect(run.out).not.toMatch(/Generation complete/);
  });
});

const TONE_NOISE = `const n = new Tone.Noise('white').toDestination();
n.volume.value = -6;
// white noise bed: flat spectrum, loud, never silent
n.start();
Tone.Transport.start();`;

describe('governed Create, audible but noise-like Tone (L3-08 floor before judge)', () => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => TONE_NOISE, judge: () => goodJudgeReply(0.95) }); });
  afterAll(async () => { await fake.close(); });

  it('fails the audio floor without spending a judge call: exit 3, zero judge requests', async () => {
    const run = await create(fake, 'tone', 'a wash of white noise');
    expect(run.status).toBe(3);
    expect(fake.judged.length).toBe(0);
  });
});

// L3-18: per-medium production-entry coverage of the evaluator deadline. The judge holds its reply far past the
// evaluator timeout; every medium must come back saved-not-accepted (exit 3), never accepted and never a hang.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#123"/><circle cx="50" cy="50" r="30" fill="#e94"/></svg>';
describe.each([
  ['html', LIVELY_HTML],
  ['svg', SVG],
  ['tone', TONE_AUDIBLE],
])('governed Create, %s with a judge that outlives the evaluator timeout (L3-18)', (domain, source) => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => source, judge: () => goodJudgeReply(0.9), judgeDelayMs: 30_000 }); });
  afterAll(async () => { await fake.close(); });

  it('is saved but not accepted: exit 3, no "complete"', async () => {
    const n = seq++;
    const env = { ...fakeProviderEnv(fake, { home: path.join(work, `home${n}`), stateRoot: path.join(work, `state${n}`) }),
      LIMINAL_EVALUATOR_TIMEOUT_MS: '4000' };
    const run = await runSinterAsync(['generate', '-o', path.join(work, `out${n}`), '--domain', domain as string, 'a short test piece'], env);
    expect(fake.judged.length).toBeGreaterThan(0);
    expect(run.status).toBe(3);
    expect(run.out).not.toMatch(/Generation complete/);
  }, 300_000);
});

// L3-18: degraded receipt per medium. The judge answers with prose instead of a verdict, so the evaluation is
// degraded; every medium must come back saved-not-accepted (exit 3) with the degradation named, never accepted.
describe.each([
  ['html', LIVELY_HTML],
  ['svg', SVG],
  ['tone', TONE_AUDIBLE],
])('governed Create, %s with an unparsable judge reply (L3-18 degraded)', (domain, source) => {
  let fake: FakeProvider;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => source, judgeText: () => 'I think it looks nice, no score.' }); });
  afterAll(async () => { await fake.close(); });

  it('is not accepted and says why: exit 3, degraded named', async () => {
    const n = seq++;
    const env = fakeProviderEnv(fake, { home: path.join(work, `home${n}`), stateRoot: path.join(work, `state${n}`) });
    const run = await runSinterAsync(['generate', '-o', path.join(work, `out${n}`), '--domain', domain as string, 'a short test piece'], env);
    if (run.status !== 3) console.log('[DEBUG]', domain, run.status, run.out.slice(-1200));
    expect(fake.judged.length).toBeGreaterThan(0);
    expect(run.status).toBe(3);
    expect(run.out).toMatch(/degraded/i);
  }, 300_000);
});
