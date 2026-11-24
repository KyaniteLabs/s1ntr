/**
 * VisualDiversity — perceptual fingerprinting, visual similarity, MMR-style diverse
 * take selection, and distinct take seed directives (#1855).
 *
 * Solves take convergence where N takes for one prompt produce near-identical looks
 * (e.g. 3 nearly cloned firefly renders crowding out a genuinely distinct interpretation).
 *
 * @module evaluation/VisualDiversity
 */

import type { DecodedImagePixels } from '../render/DecodedImageVisibility.js';
import { luminanceFromRgb8 } from '../render/LuminanceVerdict.js';

/**
 * Marker that starts the per-take flavoring best-of appends to the user's prompt.
 * Everything from this marker on is pipeline text, not the user's brief, so brief
 * coverage (#1853) cuts it off before extracting named elements.
 */
export const TAKE_VARIANT_MARKER = ' — tournament variant ';

export interface VisualFingerprint {
  lumaGrid: number[];
  dHashHex: string;
  dHashHigh: number;
  dHashLow: number;
  dHashTransitions: number;
  colorHistogram: number[];
  width: number;
  height: number;
}

export interface DiverseTakeCandidate {
  id?: string;
  score: number;
  fingerprint: VisualFingerprint;
}

export interface DiversityOptions {
  penaltyWeight?: number;
  similarityThreshold?: number;
}

export type SelectedDiverseTake<T extends DiverseTakeCandidate> = T & {
  effectiveScore: number;
  maxSimilarityToSelected: number;
  diversityPenalty: number;
};

const LUMA_GRID_SIZE = 8;
const DHASH_COLS = 9;
const DHASH_ROWS = 8;
const HIST_BINS_PER_CHANNEL = 4;
const HIST_TOTAL_BINS = HIST_BINS_PER_CHANNEL ** 3;
const DHASH_EPSILON = 1e-4;
const MAX_CELL_AXIS_SAMPLES = 16;
const MAX_HIST_SAMPLES = 16_384;
const DEFAULT_PENALTY_WEIGHT = 0.35;
const DEFAULT_SIMILARITY_THRESHOLD = 0.45;

function sampleLumaGrid(decoded: DecodedImagePixels, cols: number, rows: number): number[] {
  const { width, height, data } = decoded;
  const grid = new Array<number>(cols * rows).fill(0);

  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / rows));
    const yStep = Math.max(1, Math.floor((y1 - y0) / MAX_CELL_AXIS_SAMPLES));

    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / cols));
      const xStep = Math.max(1, Math.floor((x1 - x0) / MAX_CELL_AXIS_SAMPLES));

      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += yStep) {
        const clampedY = Math.min(height - 1, y);
        const rowOffset = clampedY * width;
        for (let x = x0; x < x1; x += xStep) {
          const clampedX = Math.min(width - 1, x);
          const idx = (rowOffset + clampedX) * 4;
          const alpha = (data[idx + 3] ?? 255) / 255;
          sum += luminanceFromRgb8(data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0) * alpha;
          count++;
        }
      }
      grid[gy * cols + gx] = count > 0 ? sum / count : 0;
    }
  }
  return grid;
}

function computeDHash(grid9x8: readonly number[]) {
  let high = 0;
  let low = 0;
  let transitions = 0;
  for (let y = 0; y < DHASH_ROWS; y++) {
    const rowOffset = y * DHASH_COLS;
    for (let x = 0; x < DHASH_COLS - 1; x++) {
      const diff = (grid9x8[rowOffset + x] ?? 0) - (grid9x8[rowOffset + x + 1] ?? 0);
      if (Math.abs(diff) > DHASH_EPSILON) transitions++;
      if (diff > DHASH_EPSILON) {
        const bitIndex = y * 8 + x;
        if (bitIndex < 32) high = (high | (1 << (31 - bitIndex))) >>> 0;
        else low = (low | (1 << (63 - bitIndex))) >>> 0;
      }
    }
  }
  const dHashHex = high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
  return { dHashHex, dHashHigh: high, dHashLow: low, dHashTransitions: transitions };
}

function computeColorHistogram(decoded: DecodedImagePixels): number[] {
  const { width, height, data } = decoded;
  const pixelCount = width * height;
  const bins = new Array<number>(HIST_TOTAL_BINS).fill(0);
  const step = Math.max(1, Math.floor(pixelCount / MAX_HIST_SAMPLES));
  let opaqueCount = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const idx = pixel * 4;
    if ((data[idx + 3] ?? 255) <= 8) continue;
    const rb = Math.min(3, (data[idx] ?? 0) >> 6);
    const gb = Math.min(3, (data[idx + 1] ?? 0) >> 6);
    const bb = Math.min(3, (data[idx + 2] ?? 0) >> 6);
    bins[(rb << 4) | (gb << 2) | bb]++;
    opaqueCount++;
  }
  if (opaqueCount > 0) for (let i = 0; i < HIST_TOTAL_BINS; i++) bins[i] /= opaqueCount;
  return bins;
}

function popcount32(value: number): number {
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function lumaGridSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sumSq += diff * diff;
  }
  return Math.max(0, Math.min(1, 1 - Math.sqrt(sumSq / len) * 2));
}

function histogramIntersection(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  let overlap = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    sumA += va;
    sumB += vb;
    overlap += Math.min(va, vb);
  }
  if (sumA === 0 && sumB === 0) return 1;
  if (sumA === 0 || sumB === 0) return 0;
  return Math.max(0, Math.min(1, overlap));
}

export function computeVisualFingerprint(decoded: DecodedImagePixels): VisualFingerprint {
  const pixelCount = decoded.width * decoded.height;
  if (decoded.width <= 0 || decoded.height <= 0 || decoded.data.length < pixelCount * 4) {
    return {
      lumaGrid: new Array<number>(LUMA_GRID_SIZE * LUMA_GRID_SIZE).fill(0),
      dHashHex: '0000000000000000',
      dHashHigh: 0,
      dHashLow: 0,
      dHashTransitions: 0,
      colorHistogram: new Array<number>(HIST_TOTAL_BINS).fill(0),
      width: decoded.width,
      height: decoded.height,
    };
  }
  const lumaGrid = sampleLumaGrid(decoded, LUMA_GRID_SIZE, LUMA_GRID_SIZE);
  const grid9x8 = sampleLumaGrid(decoded, DHASH_COLS, DHASH_ROWS);
  return {
    lumaGrid,
    ...computeDHash(grid9x8),
    colorHistogram: computeColorHistogram(decoded),
    width: decoded.width,
    height: decoded.height,
  };
}

export function visualSimilarity(a: VisualFingerprint, b: VisualFingerprint): number {
  const lumaSim = lumaGridSimilarity(a.lumaGrid, b.lumaGrid);
  const histSim = histogramIntersection(a.colorHistogram, b.colorHistogram);
  const aFlat = a.dHashTransitions === 0;
  const bFlat = b.dHashTransitions === 0;
  let combined: number;
  if (aFlat && bFlat) {
    combined = 0.45 * lumaSim + 0.55 * histSim;
  } else if (aFlat !== bFlat) {
    combined = 0.35 * lumaSim + 0.30 * histSim;
  } else {
    const hamming = popcount32((a.dHashHigh ^ b.dHashHigh) >>> 0) + popcount32((a.dHashLow ^ b.dHashLow) >>> 0);
    const dHashSim = Math.max(0, 1 - hamming / 32);
    combined = 0.35 * lumaSim + 0.35 * dHashSim + 0.30 * histSim;
  }
  return Math.round(Math.max(0, Math.min(1, combined)) * 10000) / 10000;
}

export function selectDiverseTakes<T extends DiverseTakeCandidate>(
  takes: readonly T[],
  count: number,
  options: DiversityOptions = {},
): Array<SelectedDiverseTake<T>> {
  const targetCount = Math.min(takes.length, Math.max(0, Math.floor(count)));
  if (targetCount === 0) return [];
  const penaltyWeight = Math.max(0, options.penaltyWeight ?? DEFAULT_PENALTY_WEIGHT);
  const similarityThreshold = Math.max(0, Math.min(0.999, options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD));

  const remaining = takes.map((take, index) => ({ take, index }));
  const selected: Array<SelectedDiverseTake<T>> = [];

  while (selected.length < targetCount && remaining.length > 0) {
    let bestPos = 0;
    let bestEffective = -Infinity;
    let bestMaxSim = 0;
    let bestPenalty = 0;
    let bestRawScore = -Infinity;
    let bestOriginalIndex = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const { take, index } = remaining[i];
      const rawScore = Number.isFinite(take.score) ? take.score : 0;
      let maxSim = 0;
      for (const chosen of selected) {
        const sim = visualSimilarity(take.fingerprint, chosen.fingerprint);
        if (sim > maxSim) maxSim = sim;
      }
      const excess = maxSim > similarityThreshold ? (maxSim - similarityThreshold) / (1 - similarityThreshold) : 0;
      const penalty = penaltyWeight * excess;
      const effective = rawScore - penalty;

      const isBetter =
        effective > bestEffective + 1e-12 ||
        (Math.abs(effective - bestEffective) <= 1e-12 &&
          (rawScore > bestRawScore + 1e-12 ||
            (Math.abs(rawScore - bestRawScore) <= 1e-12 && index < bestOriginalIndex)));

      if (isBetter) {
        bestPos = i;
        bestEffective = effective;
        bestMaxSim = maxSim;
        bestPenalty = penalty;
        bestRawScore = rawScore;
        bestOriginalIndex = index;
      }
    }

    const [winner] = remaining.splice(bestPos, 1);
    selected.push({
      ...winner.take,
      effectiveScore: Math.round(bestEffective * 10000) / 10000,
      maxSimilarityToSelected: Math.round(bestMaxSim * 10000) / 10000,
      diversityPenalty: Math.round(bestPenalty * 10000) / 10000,
    });
  }
  return selected;
}

const TAKE_SEED_ANGLES = [
  { name: 'Wide Establishing Depth', framing: 'Wide establishing view with explicit foreground, midground, and deep background planes.', structure: 'Anchor one dominant focal centerpiece framed by environmental depth cues and perspective lines.', paletteTreatment: 'Balanced atmospheric depth with clear value separation between near darks and distant highlights.' },
  { name: 'Intimate Macro Detail', framing: 'Tight close-up / macro crop pushing the primary subject right into the lens with off-center asymmetry.', structure: 'Emphasize tactile surface microstructure, layered close-range geometry, and cropped monumental forms.', paletteTreatment: 'High local contrast, crisp specular accents, and rich material texture instead of soft ambient glow.' },
  { name: 'Graphic Silhouette & Negative Space', framing: 'Bold poster-like graphic composition built around strong silhouettes and generous negative space.', structure: 'Use crisp geometric contours, stark figure-ground separation, and hard-edged tonal planes.', paletteTreatment: 'Restrained 2-3 flat or posterized color bands with one sharp chromatic accent instead of smooth gradients.' },
  { name: 'Overhead / Axonometric Rhythmic Field', framing: 'High-angle top-down or isometric/axonometric projection surveying an organized field.', structure: 'Distribute repeating rhythmic motifs and architectural order across the entire canvas rather than a single centered hero.', paletteTreatment: 'Cohesive surface rhythm with deliberate alternating light/dark cadence across the grid.' },
  { name: 'Nocturnal Chiaroscuro & Rim Light', framing: 'Low-angle dramatic perspective slicing diagonally across the canvas.', structure: 'Carve forms out of deep shadow anchors using narrow rim-lit edges and directional light shafts.', paletteTreatment: 'High-drama shadow dominance (~70% dark negative mass) punctuated by razor-sharp luminous highlights.' },
  { name: 'Kinetic Swept Trajectory', framing: 'Dynamic oblique camera tilted into motion along a sweeping diagonal or spiral axis.', structure: 'Drive the eye along directional trails, clustered velocity ribbons, and asymmetric massing.', paletteTreatment: 'Temperature-split palette (cool structural ground against hot kinetic streaks) to amplify motion.' },
  { name: 'Modular Triptych / Layered Framing', framing: 'Structured multi-zone or split-panel architectural framing contrasting macro and wide scale together.', structure: 'Organize the subject into distinct rhythmic compartments or nested frames with clear visual borders.', paletteTreatment: 'Alternating tonal keys between compartments while unifying them through one recurring motif color.' },
  { name: 'Minimalist Sculptural Restraint', framing: 'Expansive quiet field isolating a single sculptural form off the rule-of-thirds intersection.', structure: 'Strip away particle clutter and filler; let one refined silhouette and subtle structural echo carry the piece.', paletteTreatment: 'Near-monochrome tonal subtlety with surgical micro-contrast around the focal edge.' },
] as const;

export function buildTakeSeedDirective(
  brief: string,
  takeIndex: number,
  priorHints?: readonly string[],
): string {
  const normalizedIndex = Math.max(0, Math.floor(Number.isFinite(takeIndex) ? takeIndex : 0));
  const angle = TAKE_SEED_ANGLES[normalizedIndex % TAKE_SEED_ANGLES.length];
  const cycle = Math.floor(normalizedIndex / TAKE_SEED_ANGLES.length);
  const briefSnippet = brief.trim().replace(/\s+/g, ' ').slice(0, 180);
  const cleanPriorHints = (priorHints ?? []).map(h => h.trim()).filter(h => h.length > 0);
  const lines: string[] = [
    `Take ${normalizedIndex + 1} visual direction — ${angle.name}${cycle > 0 ? ` (variation cycle ${cycle + 1}, invert primary orientation and temperature)` : ''}:`,
    `- Framing: ${angle.framing}`,
    `- Structure: ${angle.structure}`,
    `- Palette & tonal treatment: ${angle.paletteTreatment}`,
  ];
  if (briefSnippet) {
    lines.push(`- Brief fidelity: Keep every named subject in "${briefSnippet}" unmistakably recognizable under this fresh angle.`);
  }
  if (cleanPriorHints.length > 0) {
    lines.push(`- Mandatory divergence from prior takes: Do NOT repeat the framing, palette distribution, or silhouette of earlier takes (${cleanPriorHints.join('; ')}).`);
  } else if (normalizedIndex > 0) {
    lines.push('- Mandatory divergence: Choose a visibly different camera angle, figure-ground value ratio, and structural grammar than earlier takes for this brief.');
  }
  return lines.join('\n');
}
