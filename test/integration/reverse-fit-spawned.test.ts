// NOTE: the "reverse fit that passes" case REPLACES browser capture with a synthetic signal
// (test/helpers/fitCapturePreload.mjs) so the spawned-CLI exit path is deterministic. It is not evidence that a
// real capture fits; that is test/integration/reverse-fit-real-capture.test.ts, which drives the real headless
// browser (and guards the double-AudioContext capture stretch that made a real fit impossible).
// Sol L3-17: reverse mode through the REAL bin/sinter on the fake provider. The first take misses the length, the
// revision fits, and the operator-facing report and exit code must come from the REVISED take's Create.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer';

// One short note then silence for the rest: far shorter than the requested 3 s -> the fit misses.
const TOO_SHORT = `const s = new Tone.Synth().toDestination();
Tone.Transport.bpm.value = 120;
Tone.Transport.schedule((t) => s.triggerAttackRelease('C4', '16n', t), 0);
Tone.Transport.start();`;
// Steady arpeggio across the whole window.
const FULL = `const s = new Tone.Synth({ oscillator: { type: 'triangle' } }).toDestination();
const notes = ['C4','E4','G4','B4'];
let i = 0;
new Tone.Loop((t) => { s.triggerAttackRelease(notes[i++ % 4], '8n', t); }, '8n').start(0);
Tone.Transport.bpm.value = 120;
Tone.Transport.start();`;

let work: string;
let fake: FakeProvider;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-rev-'));
  // the first take is judged 0.1 (not accepted); once the revision exists, 0.8 (accepted)
  fake = await startFakeProvider({
    generate: ({ index }) => (index === 0 ? TOO_SHORT : FULL),
    judge: () => goodJudgeReply(fake.generated.length >= 2 ? 0.8 : 0.1),   // judge calls per Create vary: key on the take
  });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

describe('reverse fit through the spawned CLI (L3-17)', () => {
  it('reports "Final take (revised)" and exits from the revised take, not the first', async () => {
    const env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
    const run = await runSinterAsync(['generate', '-o', path.join(work, 'out'), '--domain', 'tone',
      '--duration', '3', 'a bright arpeggio'], env);
    expect(run.out).toMatch(/Fit check/);
    expect(fake.generated.length).toBe(2);               // first take + exactly one revision
    expect(run.out).toMatch(/Final take \(revised\)/);
    // The revised take's own headline is printed after "Final take (revised)": it was judged 0.8, so it is not the
    // first take's "below-quality-floor" verdict.
    const afterFinal = run.out.slice(run.out.indexOf('Final take (revised)'));
    expect(afterFinal.split('Fit:')[0]).not.toMatch(/below-quality-floor/);
    // The FULL take is a steady loop with no final hit and no arc, so the fit honestly fails and the CLI says so and exits 1.
    // (A real capture that does fit is the third case below.) (The fit-passes exit path is the unit test in ReverseFit.test.ts.)
    expect(run.out).toMatch(/does not fit the brief after one revision/);
    expect(run.status).toBe(1);
  }, 300_000);
});

// The fit-passes exit path through the real CLI. Only the reverse-fit's real-time browser capture is replaced (see the
// preload), by a synthetic 3 s signal that matches the arc, length and final hit; the CLI then reports the fit and
// goes on to the Create verdict, with no revision.
// The audible Tone piece the Create audio floor accepts (same as create-render-judge-admission.test.ts).
const AUDIBLE = `const synth = new Tone.Synth({ oscillator: { type: 'triangle' } }).toDestination();
const notes = ['C4', 'E4', 'G4', 'B4', 'A4', 'F4'];
let i = 0;
new Tone.Loop((time) => { synth.triggerAttackRelease(notes[i++ % notes.length], '8n', time); }, '8n').start(0);
Tone.Transport.bpm.value = 120;
Tone.Transport.start();`;
describe('reverse fit that passes, through the spawned CLI (L3-17)', () => {
  it('reports "fits", makes no revision, and exits from the Create verdict (0)', async () => {
    const arcPath = path.join(work, 'arc.json');
    writeFileSync(arcPath, JSON.stringify({ sections: [{ t_start: 0, t_end: 1.5, energy: 0.3, label: 'low' },
      { t_start: 1.5, t_end: 3, energy: 1, label: 'high' }], cues: [] }));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.join(here, '../../dist');
    const preload = path.join(here, '../helpers/fitCapturePreload.mjs');
    const okFake = await startFakeProvider({ generate: () => AUDIBLE, judge: () => goodJudgeReply(0.8) });
    try {
    const env = { ...fakeProviderEnv(okFake, { home: path.join(work, 'home2'), stateRoot: path.join(work, 'state2') }),
      FIT_PRELOAD_DIST: dist, NODE_OPTIONS: `--import ${preload}` };
    const run = await runSinterAsync(['generate', '-o', path.join(work, 'out2'), '--domain', 'tone',
      '--duration', '3', '--arc', arcPath, 'a bright arpeggio'], env);
    if (run.status !== 0) console.log('[DEBUG]', run.status, run.out.slice(0, 2500));
    expect(run.out).toMatch(/Fit: fits/);
    expect(run.out).not.toMatch(/Fit check missed|Final take \(revised\)|does not fit the brief/);
    expect(okFake.generated.length).toBe(1);        // the first take stood
    expect(run.out).toMatch(/Signed receipt: [0-9a-f]{64}/);
    expect(run.status).toBe(0);
    } finally { await okFake.close(); }
  }, 300_000);
});

// No preload at all: the REAL headless capture feeds the fit. Before the capture-owner fix a real take was ~2x
// stretched and this could never report "fits".
const ENDS_AT_THREE = `const syn = new Tone.PolySynth(Tone.Synth, { envelope: { attack: 0.005, decay: 0.1, sustain: 0.4, release: 0.15 } }).toDestination();
Tone.Transport.bpm.value = 120;
const notes = ['C4','E4','G4','B4'];
for (let i = 0; i < 10; i++) Tone.Transport.schedule((t) => syn.triggerAttackRelease(notes[i % 4], '16n', t), i * 0.25);
Tone.Transport.schedule((t) => syn.triggerAttackRelease(['C3','G3','C4','E4','G4','C5'], 0.12, t), 2.8);
Tone.Transport.start();`;
describe('reverse fit with REAL capture, through the spawned CLI (no preload)', () => {
  it('a piece that ends at 3 s reports "fits" from a real headless capture', async () => {
    const arcPath = path.join(work, 'arc3.json');
    writeFileSync(arcPath, JSON.stringify({ sections: [{ t_start: 0, t_end: 3, energy: 1, label: 'high' }], cues: [] }));
    const realFake = await startFakeProvider({ generate: () => ENDS_AT_THREE, judge: () => goodJudgeReply(0.8) });
    try {
      const env = fakeProviderEnv(realFake, { home: path.join(work, 'home3'), stateRoot: path.join(work, 'state3') });
      expect(env.NODE_OPTIONS ?? '').not.toMatch(/fitCapturePreload/);
      const run = await runSinterAsync(['generate', '-o', path.join(work, 'out3'), '--domain', 'tone',
        '--duration', '3', '--arc', arcPath, 'a bright arpeggio'], env);
      expect(run.out, run.out.slice(0, 2500)).toMatch(/Fit: fits/);
      expect(run.out).not.toMatch(/does not fit the brief/);
      expect(realFake.generated.length).toBe(1);
      expect(run.status).toBe(0);
    } finally { await realFake.close(); }
  }, 600_000);
});
