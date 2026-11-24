import { describe, expect, it } from 'vitest';
import type { DecodedImagePixels } from '../../../src/render/DecodedImageVisibility.js';
import {
  buildTakeSeedDirective,
  computeVisualFingerprint,
  selectDiverseTakes,
  visualSimilarity,
} from '../../../src/evaluation/VisualDiversity.js';

function makePattern(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): DecodedImagePixels {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('VisualDiversity (#1855)', () => {
  it('scores identical or near-identical frames above 0.9 and distinct frames below 0.4', () => {
    const leftBand = makePattern(64, 64, (x, y) =>
      x < 32 ? [245, 190, 40] : [12, 16, 28 + (y % 8)],
    );
    const leftBandTwin = makePattern(64, 64, (x, y) =>
      x < 31 ? [242, 188, 42] : [14, 18, 30 + (y % 8)],
    );
    const rightCyan = makePattern(64, 64, (x, y) =>
      x >= 32 && y >= 16 && y < 48 ? [30, 220, 240] : [220, 40, 120],
    );

    const fpA = computeVisualFingerprint(leftBand);
    const fpTwin = computeVisualFingerprint(leftBandTwin);
    const fpDistinct = computeVisualFingerprint(rightCyan);

    expect(fpA.lumaGrid.length).toBe(64);
    expect(fpA.colorHistogram.length).toBe(64);
    expect(fpA.dHashHex.length).toBe(16);

    expect(visualSimilarity(fpA, fpA)).toBe(1);
    expect(visualSimilarity(fpA, fpTwin)).toBeGreaterThan(0.9);
    expect(visualSimilarity(fpA, fpDistinct)).toBeLessThan(0.4);
  });

  it('fireflies scenario: picks best take + visually distinct take instead of two near-clones', () => {
    const makeFireflyClone = (jitter: number) =>
      computeVisualFingerprint(makePattern(64, 64, (x, y) => {
        const d = Math.hypot(x - (32 + jitter), y - 32);
        return d < 14 ? [250, 230, 80] : [8, 14, 24];
      }));

    const distinctLook = computeVisualFingerprint(makePattern(64, 64, (x, y) =>
      y < 24 ? [230, 120, 40] : x > 40 ? [40, 210, 190] : [35, 20, 60],
    ));

    const takes = [
      { id: 'clone-1', score: 0.85, fingerprint: makeFireflyClone(0) },
      { id: 'clone-2', score: 0.84, fingerprint: makeFireflyClone(1) },
      { id: 'clone-3', score: 0.83, fingerprint: makeFireflyClone(-1) },
      { id: 'distinct-right', score: 0.80, fingerprint: distinctLook },
    ];

    const selected = selectDiverseTakes(takes, 2);
    expect(selected.map(t => t.id)).toEqual(['clone-1', 'distinct-right']);
    expect(selected[0].diversityPenalty).toBe(0);
    expect(selected[1].maxSimilarityToSelected).toBeLessThan(0.45);
    expect(selected[1].diversityPenalty).toBe(0);
  });

  it('generates distinct seed directives across takes 0..4 and incorporates prior hints', () => {
    const directives = [0, 1, 2, 3, 4].map(i =>
      buildTakeSeedDirective('fireflies over a misty pond', i, i > 0 ? ['centered golden orb'] : undefined),
    );

    const unique = new Set(directives);
    expect(unique.size).toBe(5);
    expect(directives[0]).toContain('Take 1');
    expect(directives[1]).toContain('centered golden orb');
    expect(directives[4]).toContain('Take 5');
  });
});
