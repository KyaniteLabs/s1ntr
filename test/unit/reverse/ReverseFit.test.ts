import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { validateArc } from '../../../src/reverse/Arc.js';
import { buildReverseBrief } from '../../../src/reverse/ReverseBrief.js';
import { describeFit, runReverseFit, shouldFit } from '../../../src/cli/ReverseFit.js';
import { writeReverseProvenance } from '../../../src/cli/ReverseCli.js';

const SR = 8000;
const tmp = mkdtempSync(path.join(tmpdir(), 'reverse-fit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ARC = validateArc({ sections: [{ t_start: 0, t_end: 3, energy: 0.3, label: 'low' },
  { t_start: 3, t_end: 6, energy: 1, label: 'high' }], cues: [] });
const brief = (arc = ARC, durationSec: number | null = 6) =>
  buildReverseBrief({ cards: [], arc, arcSource: 'file:arc.json', durationSec });

function tone(out: Float32Array, from: number, to: number, hz: number, gain: number, decay = 0) {
  for (let i = Math.round(from * SR); i < Math.min(out.length, Math.round(to * SR)); i++) {
    const t = i / SR - from;
    out[i] += gain * Math.sin(2 * Math.PI * hz * t) * Math.exp(-decay * t);
  }
}
function good(): Float32Array {
  const o = new Float32Array(6 * SR);
  tone(o, 0, 3, 200, 0.1); tone(o, 0, 3, 600, 0.05);
  tone(o, 3, 5.8, 200, 0.4); tone(o, 3, 5.8, 600, 0.25); tone(o, 3, 5.8, 1500, 0.1);
  for (const [hz, g] of [[110, 1], [220, 0.7], [440, 0.6], [880, 0.5], [1760, 0.4], [3300, 0.3]] as const) {
    tone(o, 5.8, 6, hz, g * 0.8, 20);
  }
  return o;
}
function tooLong(): Float32Array { const o = new Float32Array(9 * SR); tone(o, 0, 7.5, 200, 0.5); return o; }

describe('shouldFit', () => {
  it('runs only for tone/strudel with a duration', () => {
    expect(shouldFit('tone', brief())).toBe(true);
    expect(shouldFit('strudel', brief())).toBe(true);
    expect(shouldFit('p5', brief())).toBe(false);
    expect(shouldFit('tone', brief(ARC, null))).toBe(false);
    expect(shouldFit('tone', null)).toBe(false);
  });
});

describe('runReverseFit', () => {
  it('L3-17: hands back the revised take with its own Create result, so callers report and exit from it', async () => {
    const first = path.join(tmp, 'c-source.txt');
    const second = path.join(tmp, 'd-source.txt');
    writeFileSync(first, 'old code');
    writeFileSync(second, 'new code');
    const secondTake = { sourcePath: second, result: { receipt: { signature: 'second-create' }, evaluation: { score: 0.8 } } };
    const render = async (code: string) => ({ samples: code === 'old code' ? tooLong() : good(), sampleRate: SR });
    const out = await runReverseFit({ domain: 'tone', brief: brief(), sourcePath: first,
      regenerate: async () => secondTake, render });
    expect(out.revisedTake).toBe(secondTake);
    // no revision needed: nothing to switch to
    const kept = await runReverseFit({ domain: 'tone', brief: brief(), sourcePath: second,
      regenerate: async () => secondTake, render });
    expect(kept.revisedTake).toBeUndefined();
  });

  it('revises once with the measured critique, switches to the revised source, and records the fit', async () => {
    const first = path.join(tmp, 'a-source.txt');
    const second = path.join(tmp, 'b-source.txt');
    writeFileSync(first, 'old code');
    writeFileSync(second, 'new code');
    const seen: string[] = [];
    const regenerate = vi.fn(async (critique: string) => { void critique; return { sourcePath: second }; });
    const render = vi.fn(async (code: string) => {
      seen.push(code);
      return { samples: code === 'old code' ? tooLong() : good(), sampleRate: SR };
    });
    const out = await runReverseFit({ domain: 'tone', brief: brief(), sourcePath: first, regenerate, render });
    expect(seen).toEqual(['old code', 'new code']);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate.mock.calls[0][0]).toContain('measured length 7.5');
    // the critique says "your previous attempt", so the model must see that attempt
    expect(regenerate.mock.calls[0][0]).toContain('The previous attempt, to revise:\n```\nold code\n```');
    expect(out.fit.critique).not.toContain('old code');
    expect(out.sourcePath).toBe(second);
    expect(out.fit.passed).toBe(true);
    expect(out.fit.attempts.map((a) => a.pass)).toEqual([false, true]);

    const file = await writeReverseProvenance(tmp, out.provenance);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.fit.schema).toBe('sinter-reverse-fit-v1');
    expect(saved.fit.attempts[0].lengthSec).toBeCloseTo(7.5, 1);
    expect(saved.fit.attempts[1].pass).toBe(true);
    expect(describeFit(out.fit)).toBe('fits: length 6 s (target 6 s), envelope r = 1, ending ok, revised once');
  });

  it('does not call regenerate when the first render already fits', async () => {
    const src = path.join(tmp, 'c-source.txt');
    writeFileSync(src, 'code');
    const regenerate = vi.fn();
    const out = await runReverseFit({ domain: 'strudel', brief: brief(), sourcePath: src, regenerate,
      render: async () => ({ samples: good(), sampleRate: SR }) });
    expect(regenerate).not.toHaveBeenCalled();
    expect(out.fit.revised).toBe(false);
    expect(out.sourcePath).toBe(src);
  });

  it('honours a phrase-out arc: no final hit is demanded', async () => {
    const arc = validateArc({ sections: [{ t_start: 0, t_end: 6, energy: 0.5, label: 'all' }], cues: [], ending: 'phrase-out' });
    const src = path.join(tmp, 'd-source.txt');
    writeFileSync(src, 'code');
    const fade = new Float32Array(6 * SR);
    tone(fade, 0, 6, 200, 0.6, 0.9);
    tone(fade, 0, 6, 700, 0.3, 0.9);
    const out = await runReverseFit({ domain: 'tone', brief: brief(arc), sourcePath: src,
      regenerate: async () => ({ sourcePath: src }), render: async () => ({ samples: fade, sampleRate: SR }) });
    expect(out.fit.ending).toBe('phrase-out');
    expect(out.fit.attempts[0].finalTransient).toBeNull();
  });

  it('refuses to run without --duration', async () => {
    await expect(runReverseFit({ domain: 'tone', brief: brief(ARC, null), sourcePath: 'x',
      regenerate: async () => ({ sourcePath: 'x' }) })).rejects.toThrow('REVERSE_FIT_NEEDS_DURATION');
  });
});

describe('brief wording for the ending', () => {
  it('asks for a full decaying hit by default and for a fade with phrase-out', () => {
    expect(brief().promptBlock).toContain('on a final hit: a full, naturally decaying');
    const arc = validateArc({ sections: [{ t_start: 0, t_end: 6, energy: 0.5, label: 'a' }], cues: [], ending: 'phrase-out' });
    expect(brief(arc).promptBlock).toContain('by phrasing out: no final hit');
  });
  it('rejects an unknown ending in an arc', () => {
    expect(() => validateArc({ sections: [{ t_start: 0, t_end: 1, energy: 0.5, label: 'a' }], ending: 'bang' }))
      .toThrow('ending must be one of hit|phrase-out');
  });
});
