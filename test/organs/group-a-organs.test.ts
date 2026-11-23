/**
 * Group A organs (the ones that shape the art): each test changes the organ's input or state and asserts the
 * output the downstream consumer reads changes with it, so a bypassed organ fails the test.
 */
import { describe, expect, it } from 'vitest';
import { MapElites } from '../../src/evolution/MapElites.js';
import { NoveltyArchive } from '../../src/evolution/NoveltyArchive.js';
import { SelfReflectionEngine, type QualityTrend } from '../../src/improvement/SelfReflection.js';
import { applyReverseBrief, buildReverseBrief } from '../../src/reverse/ReverseBrief.js';
import { meetsQualityFloor, ADMISSION_BROKEN_FLOOR } from '../../src/aesthetic/qualityFloor.js';

const trend = (i: number, s: number): QualityTrend => ({ iteration: i, timestamp: i, overallScore: s, technicalScore: s, aestheticScore: s, noveltyScore: s, domain: 'p5' });

describe('organ: evolution (MapElites + NoveltyArchive)', () => {
  it('a fitter piece in the same behaviour cell replaces the elite; a weaker one does not', () => {
    const m = new MapElites([4, 4]);
    expect(m.insert('a', [0.1, 0.1], 0.5)).toBe(true);
    expect(m.insert('weak', [0.1, 0.1], 0.2)).toBe(false);
    expect(m.insert('strong', [0.1, 0.1], 0.9)).toBe(true);
    expect(m.getAllCells().map(c => c.creationId)).toEqual(['strong']);
    expect(m.insert('elsewhere', [0.9, 0.9], 0.1)).toBe(true);
    expect(m.coverage()).toBeCloseTo(2 / 16);
  });
  it('novelty score falls for behaviour the archive already holds (the loop uses this to favour new directions)', () => {
    const a = new NoveltyArchive(50, 2);
    for (const b of [[0.1, 0.1], [0.12, 0.1], [0.1, 0.12]]) a.add(b);
    expect(a.noveltyScore([0.11, 0.11])).toBeLessThan(a.noveltyScore([0.9, 0.9]));
    expect(a.add([0.5])).toBe(false);                       // wrong width is refused, nothing archived
  });
});

describe('organ: improvement (SelfReflection)', () => {
  it('a flat score history raises a plateau suggestion with an action; a climbing one does not', () => {
    const flat = new SelfReflectionEngine(); const climbing = new SelfReflectionEngine();
    for (let i = 0; i < 10; i++) { flat.recordScore(trend(i, 0.55)); climbing.recordScore(trend(i, 0.1 + i * 0.09)); }
    const s = flat.analyze().find(x => x.type === 'plateau');
    expect(s?.suggestedAction).toMatch(/plateau|novel/i);
    expect(climbing.analyze().find(x => x.type === 'plateau')).toBeUndefined();
  });
});

describe('organ: reverse (ReverseBrief)', () => {
  const arcA = { sections: [{ t_start: 0, t_end: 10, energy: 0.2, label: 'calm' }, { t_start: 10, t_end: 20, energy: 0.9, label: 'peak' }], cues: [{ t: 10, kind: 'drop' as const }] };
  it('the reference arc and duration are written into the prompt the generator receives; a different arc changes it', () => {
    const a = buildReverseBrief({ cards: [], arc: arcA, arcSource: 'test', durationSec: 20 });
    const b = buildReverseBrief({ cards: [], arc: { ...arcA, sections: [{ ...arcA.sections[0], label: 'hush' }, arcA.sections[1]] }, arcSource: 'test', durationSec: 20 });
    const pa = applyReverseBrief('a song', a); const pb = applyReverseBrief('a song', b);
    expect(pa).toContain('drop at 10s'); expect(pa).toContain('exactly 20 seconds');
    expect(pa).not.toBe(pb); expect(pb).toContain('hush');
  });
});

describe('organ: aesthetic (quality floor shared by judge and admission)', () => {
  it('the floor admits a decent score and refuses a broken one', () => {
    expect(meetsQualityFloor(ADMISSION_BROKEN_FLOOR + 0.01)).toBe(true);
    expect(meetsQualityFloor(ADMISSION_BROKEN_FLOOR - 0.01)).toBe(false);
  });
});
