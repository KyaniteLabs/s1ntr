/**
 * Glitch-alive check: separates "broken" from "glitchy but alive".
 *
 * An LLM judge reads datamosh / pixel-sort / feedback blow-up frames as
 * "corrupted", "static", "artifacts" and scores them 0.1-0.3, which the
 * admission floor then rejects as broken. The owner thumbed two of those up
 * ("they are glitches... but to me it's REAL beauty": mimo
 * hydra-organic-xhigh-r2 0.10, hydra-feedback-high-r2 0.31). Broken means a
 * blank or near-uniform frame, a page error, a crash, no render or a frozen
 * frame. A saturated, structured, moving frame is alive, so its score is
 * judged on impact like any other, not read as a defect.
 *
 * Deterministic evidence, measured on early + late frames:
 *   - palette: many distinct colours (a near-uniform frame has a handful)
 *   - chroma: real colour, not grey static
 *   - edges: structure at the pixel scale
 *   - coarse/fine edge ratio: the structure survives 4x averaging, which
 *     separates blocky/diagonal glitch from white noise
 *   - motion: the late frame differs from the early frame (not frozen)
 *
 * Calibration (2026-11-18): the two thumbed-up mimo takes pass; the other
 * mimo takes (flat or near-uniform), a black frame and frozen frames fail.
 * Thresholds are deliberately conservative: this only ever lifts a score to
 * the broken-band line, never to a pass.
 */
import type { DecodedImagePixels } from './DecodedImageVisibility.js';

export interface GlitchLivenessMeasure {
  /** Distinct colours (3 bits/channel) on the late frame. */
  palette: number;
  /** Median channel spread (max-min)/255 on the late frame. */
  chroma: number;
  /** Mean luminance gradient on the late frame (0..1). */
  edge: number;
  /** Gradient at 4x coarser scale divided by `edge`; white noise sits near 0.25. */
  coarseRatio: number;
  /** Mean absolute RGB difference between early and late frame (0..1). */
  motion: number;
  /** Saturated, structured and moving: alive glitch, not a broken frame. */
  alive: boolean;
}

export const GLITCH_MIN_PALETTE = 100;
export const GLITCH_MIN_CHROMA = 0.2;
export const GLITCH_MIN_EDGE = 0.03;
export const GLITCH_MIN_COARSE_RATIO = 0.4;
export const GLITCH_MIN_MOTION = 0.05;
/** An alive-glitch frame is never scored inside the judge's "broken" band. */
export const ALIVE_GLITCH_SCORE_FLOOR = 0.4;

const GRID_W = 160;
const GRID_H = 100;
const COARSE = 4;

interface Grid {
  rgb: Float64Array; // GRID_W*GRID_H*3, 0..1
}

function toGrid(img: DecodedImagePixels): Grid | undefined {
  if (img.width <= 0 || img.height <= 0 || img.data.length < img.width * img.height * 4) return undefined;
  const sum = new Float64Array(GRID_W * GRID_H * 3);
  const cnt = new Float64Array(GRID_W * GRID_H);
  const sx = Math.max(1, Math.floor(img.width / (GRID_W * 4)));
  const sy = Math.max(1, Math.floor(img.height / (GRID_H * 4)));
  for (let y = 0; y < img.height; y += sy) {
    const gy = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / img.height));
    for (let x = 0; x < img.width; x += sx) {
      const i = (y * img.width + x) * 4;
      if ((img.data[i + 3] ?? 255) <= 8) continue;
      const g = gy * GRID_W + Math.min(GRID_W - 1, Math.floor((x * GRID_W) / img.width));
      sum[g * 3] += (img.data[i] ?? 0) / 255;
      sum[g * 3 + 1] += (img.data[i + 1] ?? 0) / 255;
      sum[g * 3 + 2] += (img.data[i + 2] ?? 0) / 255;
      cnt[g] += 1;
    }
  }
  for (let g = 0; g < cnt.length; g++) {
    const n = cnt[g] || 1;
    sum[g * 3] /= n; sum[g * 3 + 1] /= n; sum[g * 3 + 2] /= n;
  }
  return { rgb: sum };
}

function luma(grid: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let p = 0; p < w * h; p++) {
    out[p] = 0.2126 * (grid[p * 3] ?? 0) + 0.7152 * (grid[p * 3 + 1] ?? 0) + 0.0722 * (grid[p * 3 + 2] ?? 0);
  }
  return out;
}

function meanGradient(l: Float64Array, w: number, h: number): number {
  let total = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = l[y * w + x] ?? 0;
      if (x + 1 < w) { total += Math.abs((l[y * w + x + 1] ?? 0) - v); n++; }
      if (y + 1 < h) { total += Math.abs((l[(y + 1) * w + x] ?? 0) - v); n++; }
    }
  }
  return n > 0 ? total / n : 0;
}

function coarsen(l: Float64Array, w: number, h: number): { data: Float64Array; w: number; h: number } {
  const cw = Math.floor(w / COARSE);
  const ch = Math.floor(h / COARSE);
  const data = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let s = 0;
      for (let dy = 0; dy < COARSE; dy++) for (let dx = 0; dx < COARSE; dx++) {
        s += l[(y * COARSE + dy) * w + x * COARSE + dx] ?? 0;
      }
      data[y * cw + x] = s / (COARSE * COARSE);
    }
  }
  return { data, w: cw, h: ch };
}

/**
 * Measure whether a frame pair is alive glitch. Returns undefined when either
 * frame cannot be decoded, so a missing frame never rescues anything.
 */
export function measureGlitchLiveness(
  early: DecodedImagePixels,
  late: DecodedImagePixels,
): GlitchLivenessMeasure | undefined {
  const a = toGrid(early);
  const b = toGrid(late);
  if (!a || !b) return undefined;
  const cells = GRID_W * GRID_H;

  const colours = new Set<number>();
  const spreads = new Float64Array(cells);
  let motion = 0;
  for (let p = 0; p < cells; p++) {
    const r = b.rgb[p * 3] ?? 0;
    const g = b.rgb[p * 3 + 1] ?? 0;
    const bl = b.rgb[p * 3 + 2] ?? 0;
    colours.add(((r * 7.999) | 0) * 64 + ((g * 7.999) | 0) * 8 + ((bl * 7.999) | 0));
    spreads[p] = Math.max(r, g, bl) - Math.min(r, g, bl);
    motion += (Math.abs(r - (a.rgb[p * 3] ?? 0)) + Math.abs(g - (a.rgb[p * 3 + 1] ?? 0))
      + Math.abs(bl - (a.rgb[p * 3 + 2] ?? 0))) / 3;
  }
  motion /= cells;
  const sortedSpread = Float64Array.from(spreads).sort();
  const chroma = sortedSpread[Math.floor(cells / 2)] ?? 0;

  const l = luma(b.rgb, GRID_W, GRID_H);
  const edge = meanGradient(l, GRID_W, GRID_H);
  const c = coarsen(l, GRID_W, GRID_H);
  const coarseRatio = edge > 1e-9 ? meanGradient(c.data, c.w, c.h) / edge : 0;

  return {
    palette: colours.size,
    chroma,
    edge,
    coarseRatio,
    motion,
    alive: colours.size >= GLITCH_MIN_PALETTE
      && chroma >= GLITCH_MIN_CHROMA
      && edge >= GLITCH_MIN_EDGE
      && coarseRatio >= GLITCH_MIN_COARSE_RATIO
      && motion >= GLITCH_MIN_MOTION,
  };
}

export function glitchLivenessSummary(m: GlitchLivenessMeasure): string {
  return `palette=${m.palette}, chroma=${m.chroma.toFixed(2)}, edge=${m.edge.toFixed(3)}, coarse=${m.coarseRatio.toFixed(2)}, motion=${m.motion.toFixed(2)}`;
}
