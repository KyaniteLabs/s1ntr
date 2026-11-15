import { describe, expect, it } from 'vitest';
import {
  DARK_LUMINANCE_THRESHOLD,
  WASHOUT_MEAN_LUMINANCE,
  SPARSE_DIM_MAX_MEAN_LUMINANCE,
  SPARSE_DIM_MIN_DARK_FRACTION,
  SPARSE_DIM_MAX_BRIGHT_FRACTION,
  luminanceFromRgb8,
  verdictFromMeasure,
} from '../../../src/render/LuminanceVerdict.js';

const measure = (
  meanLuminance: number,
  brightnessStd: number,
  brightFraction = 0.3,
  darkFraction = 0.1,
) => ({
  meanLuminance,
  brightFraction,
  darkFraction,
  brightnessStd,
});

describe('LuminanceVerdict', () => {
  it('uses the F19 labeled fixtures for structure-aware washout and darkness', () => {
    expect(verdictFromMeasure(measure(0.8296, 8.7951))).toBe('washout'); // hydra fog
    expect(verdictFromMeasure(measure(0.9386, 9.4877))).toBe('washout'); // three blank-pink
    expect(verdictFromMeasure(measure(0.831, 20.4243))).toBe('ok'); // pastel flower field A
    expect(verdictFromMeasure(measure(0.8173, 18.4812))).toBe('ok'); // pastel flower field B
    expect(verdictFromMeasure(measure(0.0654, 11.3449, 0.0))).toBe('ok'); // glowing-pond nocturne
    expect(verdictFromMeasure(measure(0.03, 0.5, 0.0))).toBe('too-dark'); // dead black render
  });

  it('flags structureless full-bright fog even below the washout luminance bar (2026-06-11 addendum, n=39+probe)', () => {
    expect(verdictFromMeasure(measure(0.5132, 7.363, 1.0))).toBe('washout'); // hydra fog, q0.65
    expect(verdictFromMeasure(measure(0.7, 7.9085, 1.0))).toBe('washout'); // hydra fog, q0.65
    expect(verdictFromMeasure(measure(0.731, 4.76, 1.0))).toBe('washout'); // live hydra probe (ferrofluid chapel)
    expect(verdictFromMeasure(measure(0.7472, 12.422, 1.0))).toBe('ok'); // vivid hydra marble, q0.85
    expect(verdictFromMeasure(measure(0.7415, 11.1868, 0.9988))).toBe('ok'); // three lanterns, q0.95 — nearest good work
    expect(verdictFromMeasure({ meanLuminance: 0.7, brightFraction: 1.0, darkFraction: 0 })).toBe('ok'); // no std measured → conservative
  });

  it('flags concentrated clipped highlights in an otherwise dark structured frame', () => {
    expect(verdictFromMeasure({
      meanLuminance: 0.47,
      brightFraction: 0.39,
      darkFraction: 0.14,
      brightnessStd: 86,
      clippedHighlightFraction: 0.18,
    })).toBe('highlight-clipped');

    expect(verdictFromMeasure({
      meanLuminance: 0.83,
      brightFraction: 0.92,
      darkFraction: 0,
      brightnessStd: 20,
      clippedHighlightFraction: 0.18,
    })).toBe('ok');
  });

  it('keeps threshold names and the luminance formula stable for callers', () => {
    expect(WASHOUT_MEAN_LUMINANCE).toBe(0.8);
    expect(DARK_LUMINANCE_THRESHOLD).toBe(0.12);
    expect(luminanceFromRgb8(255, 255, 255)).toBe(1);
    expect(luminanceFromRgb8(0, 0, 0)).toBe(0);
  });

  it('flags mid-grey mud only when opted in (2026-06-12 fog-audit calibration)', () => {
    // Flat-slate three (thr_d6022aa7): lum 0.483, std 9.1, brightF 0.006, darkF ~0.
    expect(verdictFromMeasure(measure(0.483, 9.1, 0.006, 0.0), { lowContrast: true })).toBe('low-contrast');
    // Same frame without the option: existing callers keep their behavior.
    expect(verdictFromMeasure(measure(0.483, 9.1, 0.006, 0.0))).toBe('ok');
    // Kinetic borderline (kin_c00f7cca, std 14.8): above MUD_MAX_STD, stays ok.
    expect(verdictFromMeasure(measure(0.424, 14.8, 0.022, 0.0), { lowContrast: true })).toBe('ok');
    // Good dark abyss (p5_62dfe69d): low std but real dark anchors — never mud.
    expect(verdictFromMeasure(measure(0.06, 13.4, 0.001, 0.85), { lowContrast: true })).toBe('ok');
    // Hydra fog keeps its washout verdict — fog precedence over mud.
    expect(verdictFromMeasure(measure(0.7, 7.9, 1.0, 0.0), { lowContrast: true })).toBe('washout');
    // Known blind band stays blind: full-bright with std between FOG_MAX_STD
    // and MUD_MAX_STD (hyd_70f3789c measured 10.9) — the nearest GOOD work
    // (three lanterns) measures std 11.19, so neither rule may claim it.
    expect(verdictFromMeasure(measure(0.717, 10.9, 1.0, 0.0), { lowContrast: true })).toBe('ok');
    // Flat-shaded meadow (thr_61079820, std 28.1): healthy spread, stays ok.
    expect(verdictFromMeasure(measure(0.63, 28.1, 0.905, 0.0), { lowContrast: true })).toBe('ok');
    // No measured std: conservative, stays ok even when opted in.
    expect(verdictFromMeasure({ meanLuminance: 0.48, brightFraction: 0.01, darkFraction: 0 }, { lowContrast: true })).toBe('ok');
  });

  it('flags dim-sparse frames even when std is inflated by a few dim points (W6c)', () => {
    // Beauty-campaign run1: mean ~0.022, std ~7.4 (escapes classic too-dark), darkF ~0.997, brightF ~0.0005
    expect(verdictFromMeasure({
      meanLuminance: 0.0219,
      brightFraction: 0.0005,
      darkFraction: 0.9975,
      brightnessStd: 7.37,
    })).toBe('too-dark');
    // Campaign run3: mean ~0.021, std ~5.45, darkF ~0.992, brightF 0
    expect(verdictFromMeasure({
      meanLuminance: 0.0209,
      brightFraction: 0,
      darkFraction: 0.9919,
      brightnessStd: 5.45,
    })).toBe('too-dark');
    // Campaign run2 luminous bokeh: higher mean, lower darkF — must still pass
    expect(verdictFromMeasure({
      meanLuminance: 0.0444,
      brightFraction: 0.0035,
      darkFraction: 0.9753,
      brightnessStd: 13.56,
    })).toBe('ok');
    // Intentional dark art with structure (dark anchors but not near-empty)
    expect(verdictFromMeasure({
      meanLuminance: 0.06,
      brightFraction: 0.001,
      darkFraction: 0.85,
      brightnessStd: 13.4,
    })).toBe('ok');
  });

  it('keeps sparse-dim thresholds stable for callers', () => {
    expect(SPARSE_DIM_MAX_MEAN_LUMINANCE).toBe(0.035);
    expect(SPARSE_DIM_MIN_DARK_FRACTION).toBe(0.98);
    expect(SPARSE_DIM_MAX_BRIGHT_FRACTION).toBe(0.005);
  });
});
