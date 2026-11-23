export interface LuminanceMeasure {
  /** Mean perceptual luminance of the frame, 0..1 (0.299R+0.587G+0.114B). */
  meanLuminance: number;
  /** Fraction of pixels with luminance > 0.5 ("bright" content). */
  brightFraction: number;
  /** Fraction of pixels with luminance < 0.12. */
  darkFraction: number;
  /** Fraction of pixels at or above 0.95 luminance. */
  clippedHighlightFraction?: number;
  /** Fill ratio of clipped pixels in their bounding box; ~1 means a solid flat panel. */
  clippedBoundsFill?: number;
  /** Standard deviation of perceptual brightness on the 0..255 luma scale. */
  brightnessStd?: number;
}

export type LuminanceVerdict = 'ok' | 'washout' | 'too-dark' | 'low-contrast' | 'highlight-clipped';

export const WASHOUT_MEAN_LUMINANCE = 0.8;
export const DARK_MEAN_LUMINANCE = 0.1;
export const DARK_MIN_BRIGHT_FRACTION = 0.02;
export const BRIGHT_LUMINANCE_THRESHOLD = 0.5;
export const DARK_LUMINANCE_THRESHOLD = 0.12;
export const CLIPPED_HIGHLIGHT_LUMINANCE_THRESHOLD = 0.95;
// Wave 8 calibration: rejected Abyssal Mineral measured 0.1856 clipped / 0.1472
// dark; its complete identity-preserving baseline measured 0 / 0.5474. Keep
// this deliberately narrow because this verdict fails creative admission.
export const CLIPPED_HIGHLIGHT_MIN_FRACTION = 0.15;
export const CLIPPED_HIGHLIGHT_MIN_DARK_FRACTION = 0.12;
// A clipped region that fills its own bounding box is a designed flat panel
// (a cream card on a dark page), not an additive bloom. Measured on 18 archived
// highlight-clipped late frames: the 3 svg metro cards fill 0.95-0.96; every
// hydra/p5/html blowout fills <= 0.77.
export const CLIPPED_SOLID_PANEL_MIN_FILL = 0.9;
// brightnessStd is measured on the 0..255 luma scale; the F19 labeled set
// separates true washouts (<= 9.5) from good high-key art (>= 18.5).
export const WASHOUT_MAX_STD = 15;
export const DARK_MAX_STD = 5;
// Fog shape (2026-06-11 addendum): a structureless frame where EVERY pixel is
// "bright" evades the mean-luminance bar (live hydra probe: lum 0.731). On the
// 39-measurement set + probe this catches 5 fogs/blanks (all q0.65) with zero
// false positives; nearest good work measures std 11.19.
export const FOG_MIN_BRIGHT_FRACTION = 0.98;
export const FOG_MAX_STD = 10;
// Mud shape (2026-06-12 fog audit): a mid-tone frame with no dark anchors, no
// highlights, and a collapsed spread — grey mush that evades both the washout
// and too-dark bars. Calibrated on the audit set: flat-slate three measured
// std 9.1 / darkF ~0 (mud); good dark abyss work measures std ~13 but darkF
// 0.8+ (safe); the flat-shaded meadow measures std 28 (safe). Opt-in via
// verdictFromMeasure's lowContrast option so existing single-domain callers
// keep their behavior.
export const MUD_MAX_STD = 12;
export const MUD_MIN_MEAN_LUMINANCE = 0.15;
export const MUD_MAX_DARK_FRACTION = 0.05;
export const MUD_MAX_BRIGHT_FRACTION = 0.9;
// Dim-sparse floor (W6c beauty-campaign p5): crushed near-black frames with
// almost no readable highlights. The classic too-dark rule also requires low
// std; sparse dim particle fields inflate std with a few slightly brighter
// points and slip through. Calibrated so campaign run1/run3 fail while
// luminous bokeh (run2) and intentional dark art with structure pass.
export const SPARSE_DIM_MAX_MEAN_LUMINANCE = 0.035;
export const SPARSE_DIM_MIN_DARK_FRACTION = 0.98;
export const SPARSE_DIM_MAX_BRIGHT_FRACTION = 0.005;

export function luminanceFromRgb8(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function verdictFromMeasure(
  measure: LuminanceMeasure,
  options: { lowContrast?: boolean } = {},
): LuminanceVerdict {
  const std = validStd(measure.brightnessStd);
  if (
    measure.meanLuminance >= WASHOUT_MEAN_LUMINANCE
    && (std === undefined || std < WASHOUT_MAX_STD)
  ) return 'washout';
  // Fog needs a measured std: with no structure signal we stay conservative.
  if (
    std !== undefined
    && measure.brightFraction >= FOG_MIN_BRIGHT_FRACTION
    && std < FOG_MAX_STD
  ) return 'washout';
  // A dark, structured scene can retain high global contrast while a large
  // focal region is still clipped flat. Requiring dark anchors distinguishes
  // that failure from intentional high-key artwork.
  if (
    (measure.clippedHighlightFraction ?? 0) >= CLIPPED_HIGHLIGHT_MIN_FRACTION
    && measure.darkFraction >= CLIPPED_HIGHLIGHT_MIN_DARK_FRACTION
    && (measure.clippedBoundsFill ?? 0) < CLIPPED_SOLID_PANEL_MIN_FILL
  ) return 'highlight-clipped';
  // Dim-sparse: nearly empty crushed canvas — independent of std (W6c).
  if (
    measure.meanLuminance < SPARSE_DIM_MAX_MEAN_LUMINANCE
    && measure.darkFraction > SPARSE_DIM_MIN_DARK_FRACTION
    && measure.brightFraction < SPARSE_DIM_MAX_BRIGHT_FRACTION
  ) {
    return 'too-dark';
  }
  if (
    measure.meanLuminance <= DARK_MEAN_LUMINANCE
    && measure.brightFraction < DARK_MIN_BRIGHT_FRACTION
    && (std === undefined || std < DARK_MAX_STD)
  ) {
    return 'too-dark';
  }
  // Mud needs a measured std for the same conservatism reason as fog.
  if (
    options.lowContrast
    && std !== undefined
    && std < MUD_MAX_STD
    && measure.meanLuminance > MUD_MIN_MEAN_LUMINANCE
    && measure.meanLuminance < WASHOUT_MEAN_LUMINANCE
    && measure.darkFraction < MUD_MAX_DARK_FRACTION
    && measure.brightFraction < MUD_MAX_BRIGHT_FRACTION
  ) {
    return 'low-contrast';
  }
  return 'ok';
}

function validStd(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value;
}
