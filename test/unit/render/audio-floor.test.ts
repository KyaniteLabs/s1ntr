import { describe, it, expect } from 'vitest';
import { audioFloorFailure, measureAudio } from '../../../src/render/AudioFloor.js';
import { summarizeAudioCapture } from '../../../src/render/AudioEvidence.js';

const RATE = 44_100;
const seconds = (s: number) => new Float32Array(Math.round(RATE * s));

/** Deterministic pseudo-random, so the noise case never flakes. */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function chord(): Float32Array {
  const x = seconds(3);
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    const beat = Math.exp(-((t * 2) % 1) * 4); // a pulse every half second
    x[i] = 0.25 * beat * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
  }
  return x;
}

function whiteNoise(): Float32Array {
  const x = seconds(3);
  const r = rng(7);
  for (let i = 0; i < x.length; i++) x[i] = (r() * 2 - 1) * 0.5;
  return x;
}

describe('audio floor (#1631)', () => {
  it('lets tonal music through', () => {
    const m = measureAudio(chord());
    expect(m?.noisiness).toBeLessThan(0.3);
    expect(audioFloorFailure(m)).toBeNull();
  });

  it('rejects white noise', () => {
    const m = measureAudio(whiteNoise());
    expect(m?.noisiness).toBeGreaterThan(0.6);
    expect(audioFloorFailure(m)).toMatch(/^noise-like/);
  });

  it('rejects near-silence', () => {
    const x = seconds(3);
    x.fill(0.0001);
    const m = measureAudio(x);
    expect(m?.silentShare).toBe(1);
    expect(m?.noisiness).toBeNull();
    expect(audioFloorFailure(m)).toBe('silent 100% of the time');
  });

  it('does not judge a capture too short to measure', () => {
    expect(measureAudio(new Float32Array(100))).toBeNull();
    expect(audioFloorFailure(null)).toBeNull();
  });

  it('puts the measurements and verdict on the render evidence', () => {
    const evidence = summarizeAudioCapture({ samples: whiteNoise(), sampleRate: RATE, duration: 3, success: true });
    expect(evidence?.success).toBe(true);
    expect(evidence?.floorFailure).toMatch(/^noise-like/);
    expect(evidence?.silentShare).toBe(0);
  });
});
