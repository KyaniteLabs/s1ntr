import { describe, expect, it } from 'vitest';
import type { DecodedImagePixels } from '../../../src/render/DecodedImageVisibility.js';
import {
  FRAME_COVERAGE_MIN_DIMENSION,
  SPARSE_COVERAGE_MIN_SHARE,
  frameCoverageSummary,
  measureFrameCoverage,
  sparseFrameRepairAdvice,
} from '../../../src/render/FrameCoverage.js';

function createCanvas(
  width: number,
  height: number,
  bg: readonly [number, number, number],
  alpha = 255,
): DecodedImagePixels {
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = alpha;
  }
  return { width, height, data };
}

function fillRect(
  img: DecodedImagePixels,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: readonly [number, number, number],
): void {
  const xEnd = Math.min(img.width, x0 + w);
  const yEnd = Math.min(img.height, y0 + h);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
}

describe('FrameCoverage (#1746)', () => {
  it('flags a centered 40x40 sprite on an 800x600 dark canvas as sparse', () => {
    const img = createCanvas(800, 600, [10, 12, 18]);
    fillRect(img, 380, 280, 40, 40, [255, 220, 80]);

    const measure = measureFrameCoverage(img);
    if (!measure) throw new Error('expected a coverage measure for an 800x600 frame');
    expect(measure!.sparse).toBe(true);
    expect(measure!.backgroundRgb).toEqual([10, 12, 18]);
    expect(measure!.coverageShare).toBeLessThan(SPARSE_COVERAGE_MIN_SHARE);
    expect(measure!.coverageShare).toBeCloseTo(1600 / (800 * 600), 3);
    expect(measure!.boundsCoverageShare).toBeCloseTo(1600 / (800 * 600), 3);
  });

  it('flags a centered 40x40 dark sprite on an 800x600 light canvas as sparse', () => {
    const img = createCanvas(800, 600, [245, 240, 230]);
    fillRect(img, 380, 280, 40, 40, [20, 25, 35]);

    const measure = measureFrameCoverage(img);
    if (!measure) throw new Error('expected a coverage measure for an 800x600 frame');
    expect(measure!.sparse).toBe(true);
    expect(measure!.backgroundRgb).toEqual([245, 240, 230]);
    expect(measure!.coverageShare).toBeLessThan(SPARSE_COVERAGE_MIN_SHARE);
    expect(measure!.coverageShare).toBeCloseTo(1600 / (800 * 600), 3);
  });

  it('passes a full-frame field on 800x600', () => {
    const img = createCanvas(800, 600, [18, 22, 32]);
    fillRect(img, 40, 40, 720, 260, [215, 110, 65]);
    fillRect(img, 80, 320, 640, 240, [70, 185, 175]);

    const measure = measureFrameCoverage(img);
    if (!measure) throw new Error('expected a coverage measure for an 800x600 frame');
    expect(measure!.sparse).toBe(false);
    expect(measure!.coverageShare).toBeGreaterThan(0.5);
    expect(measure!.boundsCoverageShare).toBeGreaterThan(0.7);
  });

  it('returns undefined for tiny synthetic test fixtures (< 32x32) and transparent frames', () => {
    expect(FRAME_COVERAGE_MIN_DIMENSION).toBe(32);
    expect(measureFrameCoverage(createCanvas(1, 1, [0, 0, 0]))).toBeUndefined();
    expect(measureFrameCoverage(createCanvas(4, 4, [120, 120, 120]))).toBeUndefined();
    expect(measureFrameCoverage(createCanvas(8, 8, [255, 255, 255]))).toBeUndefined();
    expect(measureFrameCoverage(createCanvas(31, 31, [40, 40, 40]))).toBeUndefined();
    expect(measureFrameCoverage(createCanvas(64, 64, [0, 0, 0], 0))).toBeUndefined();
  });

  it('formats summary and actionable sparse repair advice', () => {
    const img = createCanvas(800, 600, [10, 12, 18]);
    fillRect(img, 380, 280, 40, 40, [255, 220, 80]);
    const measure = measureFrameCoverage(img)!;

    expect(frameCoverageSummary(measure)).toContain('coverage=0.3%');
    expect(frameCoverageSummary(measure)).toContain('bg=rgb(10,12,18)');

    const advice = sparseFrameRepairAdvice(measure);
    expect(advice.issue).toContain('Sparse frame coverage');
    expect(advice.fix).toContain('full viewport');
    expect(advice.constraint).toContain('6%');
  });
});
