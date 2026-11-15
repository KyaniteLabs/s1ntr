import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ArcValidationError, arcEnergyAt, arcProblems, curveToSections, parseArcJson,
  parseCuesJson, validateArc } from '../../../src/reverse/Arc.js';

const fixture = (n: string) => readFileSync(`test/fixtures/reverse/${n}`, 'utf8');

describe('reverse arc schema', () => {
  it('accepts the arc.json fixture and returns its three sections and two cues', () => {
    const arc = parseArcJson(fixture('arc.json'), 'arc.json');
    expect(arc.sections.map((s) => s.label)).toEqual(['intro', 'peak', 'outro']);
    expect(arc.cues).toEqual([{ t: 20, kind: 'drop' }, { t: 60, kind: 'hit' }]);
  });

  it('defaults cues to an empty list', () => {
    const arc = validateArc({ sections: [{ t_start: 0, t_end: 5, energy: 0.5, label: 'a' }] });
    expect(arc.cues).toEqual([]);
  });

  it('reports every problem with a path, not just the first', () => {
    const problems = arcProblems({
      sections: [
        { t_start: 0, t_end: 10, energy: 1.4, label: 'x' },
        { t_start: 5, t_end: 4, energy: 0.2, label: '' },
      ],
      cues: [{ t: -1, kind: 'boom' }],
    });
    expect(problems).toEqual([
      'sections[0].energy must be a number from 0 to 1',
      'sections[1].t_end must be greater than t_start',
      'sections[1] overlaps the previous section',
      'sections[1].label must be a non-empty string',
      'cues[0].t must be a number >= 0',
      'cues[0].kind must be one of hit|drop|cut',
    ]);
  });

  it('rejects overlapping sections', () => {
    expect(arcProblems({ sections: [
      { t_start: 0, t_end: 10, energy: 0.5, label: 'a' },
      { t_start: 8, t_end: 12, energy: 0.5, label: 'b' }] }))
      .toEqual(['sections[1] overlaps the previous section']);
  });

  it('rejects empty, non-object and malformed JSON input loudly', () => {
    expect(arcProblems(null)).toEqual(['arc must be an object']);
    expect(arcProblems({ sections: [] })).toEqual(['sections must be a non-empty array']);
    expect(() => parseArcJson('{nope', 'bad.json')).toThrow(/REVERSE_ARC_INVALID: bad\.json: not valid JSON/);
    expect(() => validateArc({ sections: [] }, 'x')).toThrow(ArcValidationError);
  });

  it('parses a cues file as a bare array or {cues}', () => {
    expect(parseCuesJson('[{"t":3,"kind":"cut"}]', 'c.json')).toEqual([{ t: 3, kind: 'cut' }]);
    expect(parseCuesJson('{"cues":[{"t":9,"kind":"hit"}]}', 'c.json')).toEqual([{ t: 9, kind: 'hit' }]);
    expect(() => parseCuesJson('{"x":1}', 'c.json')).toThrow(/cues must be an array/);
    expect(() => parseCuesJson('[{"t":1,"kind":"zap"}]', 'c.json')).toThrow(/kind must be one of/);
  });

  it('looks up the energy at a time, clamping past the end', () => {
    const arc = parseArcJson(fixture('arc.json'), 'arc.json');
    expect(arcEnergyAt(arc, 5)).toBe(0.2);
    expect(arcEnergyAt(arc, 30)).toBe(0.9);
    expect(arcEnergyAt(arc, 99)).toBe(0.3);
  });

  it('splits an energy curve into sections at level steps', () => {
    const curve = [0.2, 0.2, 0.2, 0.9, 0.9, 0.9, 0.5, 0.5, 0.5];
    const sections = curveToSections(curve, 2);
    expect(sections.map((s) => [s.t_start, s.t_end])).toEqual([[0, 6], [6, 12], [12, 18]]);
    expect(sections.map((s) => s.energy)).toEqual([0.222, 1, 0.556]);
    expect(curveToSections([], 1)).toEqual([]);
  });
});
