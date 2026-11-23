/**
 * Value-structure check ("overmixed"): the painter's test on a rendered frame.
 *
 * A painting that was worked until every layer averaged into its neighbours
 * has no real darkest dark, no real lightest light, and no clean colour. Hydra
 * stacks (.blend/.modulate/feedback, sub-1 .color() multipliers over
 * luminance-only generators) average toward the mean of their own palette, so
 * they land here without anyone choosing it.
 *
 * Calibration (2026-11-18, 113 rated hydra pieces, grouped CV by prompt id,
 * 8 folds): held-out precision 0.76, recall 0.83. A deliberately muted piece
 * with a clean colour accent, a real light, or a hue away from the muddy
 * green-teal band passes. Colour stats are a diagnostic: the verdict is only
 * ever advisory feedback plus a score cap, never a hard reject.
 */
import type { DecodedImagePixels } from './DecodedImageVisibility.js';

export interface ValueStructureMeasure {
  /** OKLab lightness of the 98th percentile pixel: is there a real light? */
  lightP98: number;
  /** OKLab lightness of the 2nd percentile pixel. */
  lightP02: number;
  /** OKLab chroma of the 95th percentile pixel: is there any clean colour? */
  chromaP95: number;
  /** Saturation x value weight sitting in the muddy yellow-green..cyan band. */
  muddyHueShare: number;
  /** Share of pixels that are a real light (OKLab L >= 0.8) or a clean colour (chroma >= 0.2): a small bright accent counts. */
  accentShare: number;
  overmixed: boolean;
}

export const OVERMIXED_MAX_LIGHT_P98 = 0.8;
export const OVERMIXED_MAX_CHROMA_P95 = 0.2;
export const OVERMIXED_MIN_MUDDY_HUE_SHARE = 0.3;
/**
 * A dark scene lit by a thin bright line (a lit trace, a cursor, a filament) has a real light even though it covers
 * well under 2% of the frame and so never reaches the 98th percentile. Mud camo has none (0.00% on the thumbed-down
 * frames); the lit-trace circuit board has 0.12%. Anything at or above this share is a deliberate accent.
 */
export const OVERMIXED_MIN_ACCENT_SHARE = 0.0005;
export const OVERMIXED_SCORE_CAP = 0.29;

const MAX_SAMPLES = 20_000;

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? 0;
}

export function measureValueStructure(decoded: DecodedImagePixels): ValueStructureMeasure | undefined {
  const pixelCount = decoded.width * decoded.height;
  if (pixelCount <= 0 || decoded.data.length < pixelCount * 4) return undefined;
  const step = Math.max(1, Math.floor(pixelCount / MAX_SAMPLES));
  const lights: number[] = [];
  const chromas: number[] = [];
  let hueWeight = 0;
  let muddyWeight = 0;
  let accentPixels = 0;
  for (let p = 0; p < pixelCount; p += step) {
    const i = p * 4;
    if ((decoded.data[i + 3] ?? 255) <= 8) continue;
    const r8 = decoded.data[i] ?? 0;
    const g8 = decoded.data[i + 1] ?? 0;
    const b8 = decoded.data[i + 2] ?? 0;
    const r = srgbToLinear(r8);
    const g = srgbToLinear(g8);
    const b = srgbToLinear(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const light = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const chroma = Math.hypot(
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    );
    lights.push(light);
    chromas.push(chroma);
    if (light >= OVERMIXED_MAX_LIGHT_P98 || chroma >= OVERMIXED_MAX_CHROMA_P95) accentPixels++;
    const mx = Math.max(r8, g8, b8) / 255;
    const d = mx - Math.min(r8, g8, b8) / 255;
    if (mx > 0) {
      const w = (d / mx) * mx;
      hueWeight += w;
      if (d > 0) {
        const rr = r8 / 255;
        const gg = g8 / 255;
        const bb = b8 / 255;
        const h = (mx === rr ? (((gg - bb) / d) % 6 + 6) % 6 : mx === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4) / 6;
        if (h >= 0.15 && h <= 0.55) muddyWeight += w;
      }
    }
  }
  if (lights.length === 0) return undefined;
  const sortedL = Float64Array.from(lights).sort();
  const sortedC = Float64Array.from(chromas).sort();
  const lightP98 = percentile(sortedL, 0.98);
  const lightP02 = percentile(sortedL, 0.02);
  const chromaP95 = percentile(sortedC, 0.95);
  const muddyHueShare = hueWeight > 1e-9 ? muddyWeight / hueWeight : 0;
  return {
    lightP98,
    lightP02,
    chromaP95,
    muddyHueShare,
    accentShare: accentPixels / lights.length,
    overmixed: accentPixels / lights.length < OVERMIXED_MIN_ACCENT_SHARE
      && lightP98 < OVERMIXED_MAX_LIGHT_P98
      && chromaP95 < OVERMIXED_MAX_CHROMA_P95
      && muddyHueShare >= OVERMIXED_MIN_MUDDY_HUE_SHARE,
  };
}

export function valueStructureSummary(m: ValueStructureMeasure): string {
  return `lightP98=${m.lightP98.toFixed(2)}, chromaP95=${m.chromaP95.toFixed(2)}, muddyHue=${m.muddyHueShare.toFixed(2)}`;
}

/** Painter-language retry feedback naming the collapse and the mechanism fix. */
export function overmixedRepairAdvice(m: ValueStructureMeasure) {
  return {
    issue: `Overmixed / lost value structure: the frame has no real lightest light and no clean colour (${valueStructureSummary(m)}); every layer averaged into its neighbours.`,
    fix: 'Stop overworking: blend/modulate/feedback average toward grey, and .color() multipliers below 1 darken and desaturate. Fewer layers; one anchor at full strength (a real light, a clean saturated hue with its complement kept apart); separate shapes by value and keep edges crisp instead of re-blending them.',
    constraint: 'Keep the subject and composition; pick 2-3 intentional hues, a real darkest dark and lightest light, and one focal cluster.',
  };
}
