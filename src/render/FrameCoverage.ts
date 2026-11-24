/**
 * Frame-coverage check (#1746): detects sparse renders where a tiny isolated
 * sprite or corner cluster floats in a mostly empty canvas.
 *
 * Samples opaque border pixels to estimate the dominant background RGB color,
 * then measures what share of sampled opaque frame pixels differ from that
 * background by at least FRAME_COVERAGE_COLOR_DISTANCE (Euclidean RGB).
 *
 * Returns undefined for tiny synthetic test fixtures (< 32x32) or fully
 * transparent frames so unit-test 1x1/4x4/8x8 fixtures stay unaffected.
 */
import type { DecodedImagePixels } from './DecodedImageVisibility.js';

export interface FrameCoverageMeasure {
  /** Fraction of sampled opaque pixels differing from the dominant border background (0..1). */
  coverageShare: number;
  /** Fraction of total frame area occupied by the bounding box of foreground pixels (0..1). */
  boundsCoverageShare: number;
  /** Dominant opaque border RGB color used as the background estimate. */
  backgroundRgb: readonly [number, number, number];
  /** True when foreground coverage is below SPARSE_COVERAGE_MIN_SHARE. */
  sparse: boolean;
}

export const FRAME_COVERAGE_MIN_DIMENSION = 32;
export const FRAME_COVERAGE_COLOR_DISTANCE = 28;
export const SPARSE_COVERAGE_MIN_SHARE = 0.06;

const MAX_INTERIOR_SAMPLES = 20_000;
const MAX_BORDER_SAMPLES_PER_EDGE = 400;

export function measureFrameCoverage(decoded: DecodedImagePixels): FrameCoverageMeasure | undefined {
  const { width, height, data } = decoded;
  const pixelCount = width * height;
  if (
    width < FRAME_COVERAGE_MIN_DIMENSION
    || height < FRAME_COVERAGE_MIN_DIMENSION
    || pixelCount <= 0
    || data.length < pixelCount * 4
  ) {
    return undefined;
  }

  // Quantize border pixels to 5 bits/channel (bin width 8) so slight gradient
  // or compression drift along the frame perimeter clusters into one mode.
  const binCounts = new Map<number, number>();
  const binSums = new Map<number, [number, number, number]>();
  let borderOpaque = 0;

  const recordBorder = (x: number, y: number): void => {
    const idx = (y * width + x) * 4;
    if ((data[idx + 3] ?? 255) <= 8) return;
    const r = data[idx] ?? 0;
    const g = data[idx + 1] ?? 0;
    const b = data[idx + 2] ?? 0;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    borderOpaque++;
    binCounts.set(key, (binCounts.get(key) ?? 0) + 1);
    const acc = binSums.get(key);
    if (acc) {
      acc[0] += r;
      acc[1] += g;
      acc[2] += b;
    } else {
      binSums.set(key, [r, g, b]);
    }
  };

  const borderStepX = Math.max(1, Math.floor(width / MAX_BORDER_SAMPLES_PER_EDGE));
  const borderStepY = Math.max(1, Math.floor(height / MAX_BORDER_SAMPLES_PER_EDGE));
  for (let x = 0; x < width; x += borderStepX) {
    recordBorder(x, 0);
    recordBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += borderStepY) {
    recordBorder(0, y);
    recordBorder(width - 1, y);
  }

  if (borderOpaque === 0) return undefined;

  let bestKey = 0;
  let bestCount = -1;
  for (const [key, count] of binCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  const bestSum = binSums.get(bestKey);
  if (!bestSum || bestCount <= 0) return undefined;

  const bgR = Math.round(bestSum[0] / bestCount);
  const bgG = Math.round(bestSum[1] / bestCount);
  const bgB = Math.round(bestSum[2] / bestCount);

  const stride = Math.max(1, Math.floor(Math.sqrt(pixelCount / MAX_INTERIOR_SAMPLES)));
  const distSqThreshold = FRAME_COVERAGE_COLOR_DISTANCE * FRAME_COVERAGE_COLOR_DISTANCE;
  let opaqueSamples = 0;
  let foregroundSamples = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y += stride) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += stride) {
      const idx = (rowOffset + x) * 4;
      if ((data[idx + 3] ?? 255) <= 8) continue;
      opaqueSamples++;
      const dr = (data[idx] ?? 0) - bgR;
      const dg = (data[idx + 1] ?? 0) - bgG;
      const db = (data[idx + 2] ?? 0) - bgB;
      if (dr * dr + dg * dg + db * db >= distSqThreshold) {
        foregroundSamples++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (opaqueSamples === 0) return undefined;

  const coverageShare = foregroundSamples / opaqueSamples;
  const boundsCoverageShare = foregroundSamples > 0
    ? Math.min(1, (Math.min(width, maxX - minX + stride) * Math.min(height, maxY - minY + stride)) / pixelCount)
    : 0;

  return {
    coverageShare,
    boundsCoverageShare,
    backgroundRgb: [bgR, bgG, bgB],
    sparse: coverageShare < SPARSE_COVERAGE_MIN_SHARE,
  };
}

export function frameCoverageSummary(m: FrameCoverageMeasure): string {
  return `coverage=${(m.coverageShare * 100).toFixed(1)}%, bounds=${(m.boundsCoverageShare * 100).toFixed(1)}%, bg=rgb(${m.backgroundRgb.join(',')})`;
}

export function sparseFrameRepairAdvice(m: FrameCoverageMeasure) {
  return {
    issue: `Sparse frame coverage: visible subject covers only ${(m.coverageShare * 100).toFixed(1)}% of the canvas (${frameCoverageSummary(m)}), leaving most of the frame empty.`,
    fix: 'Scale up the composition and distribute primary and secondary visual elements across the full viewport so the subject fills the frame instead of floating as a small isolated cluster.',
    constraint: `Non-background visual content should cover at least ${(SPARSE_COVERAGE_MIN_SHARE * 100).toFixed(0)}% of the frame with intentional negative space rather than empty margin.`,
  };
}
