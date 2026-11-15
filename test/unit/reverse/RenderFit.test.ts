import { describe, expect, it, vi } from 'vitest';
import { validateArc, type Arc } from '../../../src/reverse/Arc.js';
import {
  assessFit, buildFitCritique, correlateWithArc, endingQuality, finalTransient, fitWithOneRevision,
  measureLength, pearson,
} from '../../../src/reverse/RenderFit.js';

const SR = 8000;

/** Silent buffer of `seconds` with helpers to paint synthetic sound into it. */
function buffer(seconds: number): Float32Array { return new Float32Array(Math.round(seconds * SR)); }

function tone(out: Float32Array, from: number, to: number, hz: number, gain: number, decayPerSec = 0) {
  for (let i = Math.round(from * SR); i < Math.min(out.length, Math.round(to * SR)); i++) {
    const t = i / SR - from;
    out[i] += gain * Math.sin(2 * Math.PI * hz * t) * Math.exp(-decayPerSec * t);
  }
}

/** Rich hit: several partials, fast attack, exponential decay. */
function richHit(out: Float32Array, at: number, gain: number, decay = 12) {
  for (const [hz, g] of [[110, 1], [220, 0.7], [440, 0.6], [880, 0.5], [1760, 0.4], [3300, 0.3]] as const) {
    tone(out, at, at + 0.4, hz, gain * g * 0.4, decay);
  }
}

const ARC: Arc = validateArc({ sections: [
  { t_start: 0, t_end: 2, energy: 0.2, label: 'low' },
  { t_start: 2, t_end: 4, energy: 1, label: 'high' },
  { t_start: 4, t_end: 6, energy: 0.4, label: 'out' }], cues: [] });

/** A 6 s piece whose loudness follows ARC and that ends on a rich hit at 5.85 s. */
function goodPiece(): Float32Array {
  const out = buffer(6);
  tone(out, 0, 2, 200, 0.2); tone(out, 0, 2, 600, 0.1);
  tone(out, 2, 4, 200, 0.7); tone(out, 2, 4, 600, 0.4); tone(out, 2, 4, 1500, 0.2);
  tone(out, 4, 5.8, 200, 0.3); tone(out, 4, 5.8, 600, 0.15);
  richHit(out, 5.8, 1, 20);
  return out;
}

describe('pearson', () => {
  it('is 1 for a scaled copy, -1 for the inverse, null for a flat series', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe('measureLength', () => {
  it('finds the end of the last audible sound to within one sample step', () => {
    const b = buffer(10);
    tone(b, 0, 7.5, 300, 0.5);
    expect(measureLength(b, SR)).toBeCloseTo(7.5, 2);
  });
  it('ignores a near-silent tail below -40 dB of the peak', () => {
    const b = buffer(10);
    tone(b, 0, 4, 300, 0.8);
    tone(b, 4, 9, 300, 0.001);
    expect(measureLength(b, SR)).toBeCloseTo(4, 2);
  });
  it('returns 0 for silence and for an empty buffer', () => {
    expect(measureLength(buffer(3), SR)).toBe(0);
    expect(measureLength(new Float32Array(0), SR)).toBe(0);
  });
});

describe('finalTransient', () => {
  it('detects a hit that starts inside the last 250 ms', () => {
    const b = buffer(6);
    tone(b, 0, 5.8, 200, 0.2);
    richHit(b, 5.85, 1);
    const t = finalTransient(b, SR, 6);
    expect(t.present).toBe(true);
    expect(t.riseRatio).toBeGreaterThan(3);
  });
  it('reports none when the sound is steady up to the end', () => {
    const b = buffer(6);
    tone(b, 0, 6, 200, 0.5);
    expect(finalTransient(b, SR, 6).present).toBe(false);
  });
  it('reports none when the only hit landed before the last 250 ms', () => {
    const b = buffer(6);
    richHit(b, 5.2, 1, 8);
    expect(finalTransient(b, SR, 6).present).toBe(false);
  });
  it('reports none for silence', () => {
    expect(finalTransient(buffer(6), SR, 6)).toEqual({ present: false, riseRatio: 0 });
  });
});

describe('correlateWithArc', () => {
  it('is high when loudness follows the arc', () => {
    const r = correlateWithArc(goodPiece(), SR, ARC, 6);
    expect(r).toBeGreaterThan(0.9);
  });
  it('is negative when loudness runs against the arc', () => {
    const b = buffer(6);
    tone(b, 0, 2, 200, 0.8); tone(b, 2, 4, 200, 0.1); tone(b, 4, 6, 200, 0.6);
    expect(correlateWithArc(b, SR, ARC, 6) as number).toBeLessThan(0);
  });
  it('is null when the arc is flat (nothing to correlate)', () => {
    const flat = validateArc({ sections: [{ t_start: 0, t_end: 6, energy: 0.5, label: 'flat' }], cues: [] });
    expect(correlateWithArc(goodPiece(), SR, flat, 6)).toBeNull();
  });
});

describe('endingQuality', () => {
  it('passes a rich hit that decays naturally', () => {
    const q = endingQuality(goodPiece(), SR, 6, 'hit');
    expect(q.ok).toBe(true);
    expect(q.decayDb).toBeGreaterThan(12);
    expect(q.bands).toBeGreaterThanOrEqual(3);
  });
  it('fails the cheap-MIDI ending: one sine blip chopped off at the end', () => {
    const b = buffer(6);
    tone(b, 0, 5.75, 200, 0.4); tone(b, 0, 5.75, 600, 0.3); tone(b, 0, 5.75, 1500, 0.2);
    tone(b, 5.75, 6, 880, 0.9); // sustained single sine, hard cut at 6 s
    const q = endingQuality(b, SR, 6, 'hit');
    expect(q.ok).toBe(false);
    expect(q.problems.join(' ')).toMatch(/decay|abrupt|spectrally thin/);
  });
  it('phrase-out passes a fade and fails a loud stop', () => {
    const fade = buffer(6);
    tone(fade, 0, 6, 200, 0.5, 1.2);
    const loud = buffer(6);
    tone(loud, 0, 6, 200, 0.5);
    expect(endingQuality(fade, SR, 6, 'phrase-out').ok).toBe(true);
    expect(endingQuality(loud, SR, 6, 'phrase-out').ok).toBe(false);
  });
});

describe('assessFit', () => {
  it('passes a piece with the right length, a final hit, and the arc shape', () => {
    const m = assessFit(goodPiece(), SR, { arc: ARC, durationSec: 6, ending: 'hit' });
    expect(m.failures).toEqual([]);
    expect(m.pass).toBe(true);
    expect(m.lengthSec).toBeGreaterThan(5.95);
    expect(m.lengthSec).toBeLessThan(6.05);
  });
  it('fails length outside +/-50 ms and names the measured number', () => {
    const b = buffer(8);
    tone(b, 0, 6.3, 200, 0.5);
    const m = assessFit(b, SR, { arc: null, durationSec: 6, ending: 'hit' });
    expect(m.pass).toBe(false);
    expect(m.lengthSec).toBeCloseTo(6.3, 1);
    expect(m.failures.join(' ')).toMatch(/length 6\.\d+ s/);
  });
  it('accepts a length 40 ms off and rejects one 70 ms off', () => {
    const near = buffer(7);
    tone(near, 0, 5.96, 200, 0.5);
    const far = buffer(7);
    tone(far, 0, 6.07, 200, 0.5);
    expect(assessFit(near, SR, { arc: null, durationSec: 6, ending: 'phrase-out' }).lengthOk).toBe(true);
    expect(assessFit(far, SR, { arc: null, durationSec: 6, ending: 'phrase-out' }).lengthOk).toBe(false);
  });
  it('fails on a low envelope correlation', () => {
    const b = buffer(6);
    tone(b, 0, 2, 200, 0.8); tone(b, 2, 4, 200, 0.1); tone(b, 4, 5.8, 200, 0.6);
    richHit(b, 5.8, 1, 20);
    const m = assessFit(b, SR, { arc: ARC, durationSec: 6, ending: 'hit' });
    expect(m.correlation as number).toBeLessThan(0.6);
    expect(m.failures.join(' ')).toMatch(/correlation/);
  });
});

describe('buildFitCritique', () => {
  it('contains the measured numbers the writer needs', () => {
    const b = buffer(8);
    tone(b, 0, 2, 200, 0.8); tone(b, 2, 4, 200, 0.1); tone(b, 4, 6.3, 200, 0.6);
    const m = assessFit(b, SR, { arc: ARC, durationSec: 6, ending: 'hit' });
    const text = buildFitCritique(m, 6);
    expect(text).toContain(`${m.lengthSec} s`);
    expect(text).toContain('target 6 s');
    expect(text).toMatch(/correlation r = -?\d/);
  });
});

describe('fitWithOneRevision', () => {
  const pass = goodPiece();
  const fail = (() => { const b = buffer(8); tone(b, 0, 6.5, 200, 0.5); return b; })();
  const opts = { arc: ARC, durationSec: 6, ending: 'hit' as const };

  it('keeps the first render when it fits and never revises', async () => {
    const revise = vi.fn();
    const rec = await fitWithOneRevision({ render: async () => ({ samples: pass, sampleRate: SR }), revise, ...opts });
    expect(rec.passed).toBe(true);
    expect(rec.revised).toBe(false);
    expect(rec.attempts).toHaveLength(1);
    expect(revise).not.toHaveBeenCalled();
  });

  it('revises exactly once with the measured critique, then stops even if still failing', async () => {
    let calls = 0;
    const revise = vi.fn(async (critique: string) => { void critique; });
    const rec = await fitWithOneRevision({
      render: async () => { calls++; return { samples: fail, sampleRate: SR }; }, revise, ...opts });
    expect(calls).toBe(2);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0][0]).toContain(`${rec.attempts[0].lengthSec} s`);
    expect(rec.revised).toBe(true);
    expect(rec.passed).toBe(false);
    expect(rec.critique).toBe(revise.mock.calls[0][0]);
    expect(rec.attempts.map((a) => a.pass)).toEqual([false, false]);
  });

  it('passes after one revision and records both measurements', async () => {
    const renders = [fail, pass];
    const rec = await fitWithOneRevision({
      render: async () => ({ samples: renders.shift()!, sampleRate: SR }), revise: async () => {}, ...opts });
    expect(rec.passed).toBe(true);
    expect(rec.revised).toBe(true);
    expect(rec.attempts.map((a) => a.pass)).toEqual([false, true]);
  });

  it('surfaces a render failure instead of swallowing it', async () => {
    await expect(fitWithOneRevision({
      render: async () => { throw new Error('REVERSE_RENDER_FAILED: no audio'); }, revise: async () => {}, ...opts,
    })).rejects.toThrow('REVERSE_RENDER_FAILED');
  });
});
