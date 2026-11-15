import { describe, expect, it } from 'vitest';
import {
  analyzeSvg,
  analyzeText,
  curveToArcSections,
  pathPoints,
} from '../../../src/reverse/DocumentFeatures.js';

describe('pathPoints', () => {
  it('reads absolute move/line endpoints', () => {
    expect(pathPoints('M 0 10 L 20 30 L 40 5')).toEqual([[0, 10], [20, 30], [40, 5]]);
  });

  it('applies relative commands from the running position', () => {
    expect(pathPoints('M 10 10 l 5 5 h 10 v -5')).toEqual([[10, 10], [15, 15], [25, 15], [25, 10]]);
  });

  it('takes the last pair of a cubic curve as its endpoint', () => {
    expect(pathPoints('M0 0 C 1 1 2 2 3 4')).toEqual([[0, 0], [3, 4]]);
  });

  it('treats extra pairs after a move as implicit line-tos and ignores close', () => {
    expect(pathPoints('M 0 0 5 5 10 0 Z')).toEqual([[0, 0], [5, 5], [10, 0]]);
  });

  it('stops on a truncated command instead of inventing points', () => {
    expect(pathPoints('M 0 0 L 5')).toEqual([[0, 0]]);
    expect(pathPoints('')).toEqual([]);
  });
});

describe('analyzeSvg', () => {
  it('rejects text with no svg root', () => {
    expect(() => analyzeSvg('<div>hi</div>')).toThrow('no <svg> root element');
  });

  it('collects decoded labels and counts shapes by tag', () => {
    const svg = '<svg><rect/><rect/><circle/><text>Intro &amp; build</text><text><tspan>Drop</tspan></text><text>  </text></svg>';
    const out = analyzeSvg(svg);
    expect(out.labels).toEqual(['Intro & build', 'Drop']);
    expect(out.shapes).toEqual({ rect: 2, circle: 1 });
    expect(out.curve).toBeNull();
  });

  it('reads a polyline as an energy curve where low y means high energy', () => {
    const out = analyzeSvg('<svg><polyline points="0,100 50,0 100,100"/></svg>');
    expect(out.curve).toEqual([
      { x: 0, energy: 0 },
      { x: 0.5, energy: 1 },
      { x: 1, energy: 0 },
    ]);
  });

  it('falls back to a path when no usable polyline exists', () => {
    const out = analyzeSvg('<svg><polyline points="0,0 1,1"/><path d="M 0 80 L 10 20 L 20 80"/></svg>');
    expect(out.curve).toEqual([
      { x: 0, energy: 0 },
      { x: 0.5, energy: 1 },
      { x: 1, energy: 0 },
    ]);
  });

  it('gives a flat curve a neutral 0.5 energy', () => {
    const out = analyzeSvg('<svg><polyline points="0,5 1,5 2,5"/></svg>');
    expect(out.curve!.map(p => p.energy)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('curveToArcSections', () => {
  const ramp = [{ x: 0, energy: 0 }, { x: 1, energy: 1 }];

  it('makes one section per label across the duration', () => {
    const sections = curveToArcSections(ramp, ['low', 'high'], 40);
    expect(sections).toEqual([
      { t_start: 0, t_end: 20, energy: 0.25, label: 'low' },
      { t_start: 20, t_end: 40, energy: 0.75, label: 'high' },
    ]);
  });

  it('uses numbered even slices (at most 8) when there are no labels', () => {
    const curve = Array.from({ length: 20 }, (_, i) => ({ x: i / 19, energy: 0.5 }));
    const sections = curveToArcSections(curve, [], 80);
    expect(sections).toHaveLength(8);
    expect(sections[0]).toMatchObject({ t_start: 0, t_end: 10, label: 'section 1', energy: 0.5 });
    expect(sections[7].t_end).toBe(80);
  });

  it('makes a single section for a two-point curve with no labels', () => {
    expect(curveToArcSections(ramp, [], 10)).toHaveLength(1);
  });
});

describe('analyzeText', () => {
  it('extracts headings with levels, word count and line count', () => {
    const out = analyzeText('# Title\n\nSome words here\n## Sub ##\nend\n');
    expect(out.headings).toEqual([{ level: 1, text: 'Title' }, { level: 2, text: 'Sub' }]);
    expect(out.words).toBe(7);
    expect(out.lines).toBe(5);
  });

  it('normalises CRLF and handles empty input', () => {
    expect(analyzeText('a b\r\nc')).toEqual({ headings: [], words: 3, lines: 2 });
    expect(analyzeText('')).toEqual({ headings: [], words: 0, lines: 0 });
  });

  it('does not treat a hash without a space as a heading', () => {
    expect(analyzeText('#hashtag').headings).toEqual([]);
  });
});
