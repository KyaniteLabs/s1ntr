/**
 * Sol L3-17 follow-up: `reverse` fit against a REAL headless capture (no preload, no synthetic signal).
 *
 * Bug this guards: the page held two AudioContexts (Tone's own plus the hook's) and both capture processors
 * appended to one array, so the take came out ~2x stretched. A note scheduled at 0, 1, 2 s was heard at
 * 0, 2, 4 s and no real piece could land inside FIT_LENGTH_TOLERANCE_SEC (50 ms), so `reverse` could never
 * report "fits" for a real operator. Only one context owns the capture now.
 *
 * Needs `pnpm build` (renderAudioWithBrowser imports the renderer from the same source tree via tsx here).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderAudioWithBrowser } from '../../src/cli/ReverseFit.js';
import { assessFit, FIT_LENGTH_TOLERANCE_SEC } from '../../src/reverse/RenderFit.js';

vi.setConfig({ testTimeout: 180_000 });

// Arpeggio every 0.25 s for 2.5 s, then a full chord hit at 2.8 s that rings out by ~2.95 s.
const ENDS_AT_THREE = `const syn = new Tone.PolySynth(Tone.Synth, { envelope: { attack: 0.005, decay: 0.1, sustain: 0.4, release: 0.15 } }).toDestination();
Tone.Transport.bpm.value = 120;
const notes = ['C4','E4','G4','B4'];
for (let i = 0; i < 10; i++) Tone.Transport.schedule((t) => syn.triggerAttackRelease(notes[i % 4], '16n', t), i * 0.25);
Tone.Transport.schedule((t) => syn.triggerAttackRelease(['C3','G3','C4','E4','G4','C5'], 0.12, t), 2.8);
Tone.Transport.start();`;

// Three short blips exactly 1 s apart, scheduled off the audio clock with no Transport at all.
const BLIPS_ONE_SECOND_APART = `const syn = new Tone.Synth({ envelope: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.1 } }).toDestination();
setTimeout(() => { const n = Tone.now(); for (const t of [0, 1, 2]) syn.triggerAttackRelease('C4', 0.1, n + t + 0.3); }, 1000);`;

function peakTimes(samples: Float32Array, sr: number): number[] {
  const hop = Math.floor(sr * 0.05);
  const out: number[] = [];
  let quietFor = 99;
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let m = 0;
    for (let j = i; j < i + hop; j += 1) m = Math.max(m, Math.abs(samples[j]));
    if (m > 0.2 && quietFor >= 4) out.push(i / sr);
    quietFor = m > 0.05 ? 0 : quietFor + 1;
  }
  return out;
}

describe('reverse fit on a real headless capture', () => {
  it('keeps real time: blips 1 s apart are captured 1 s apart, not 2 s', async () => {
    const r = await renderAudioWithBrowser(BLIPS_ONE_SECOND_APART, 'tone', 3);
    const hits = peakTimes(r.samples, r.sampleRate);
    expect(hits.length).toBe(3);
    expect(hits[1] - hits[0]).toBeGreaterThan(0.9);
    expect(hits[1] - hits[0]).toBeLessThan(1.1);
    expect(hits[2] - hits[1]).toBeGreaterThan(0.9);
    expect(hits[2] - hits[1]).toBeLessThan(1.1);
  });

  it('a piece that ends at 3 s measures 3 s and passes the fit inside the 50 ms tolerance', async () => {
    const r = await renderAudioWithBrowser(ENDS_AT_THREE, 'tone', 3);
    const fit = assessFit(r.samples, r.sampleRate, { arc: null, durationSec: 3, ending: 'hit' });
    expect(Math.abs(fit.lengthErrorSec)).toBeLessThanOrEqual(FIT_LENGTH_TOLERANCE_SEC);
    expect(fit.failures).toEqual([]);
    expect(fit.pass).toBe(true);
  });
});
