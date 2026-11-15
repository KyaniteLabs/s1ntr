/**
 * Reverse mode, exact-duration fit (#711). Measures a rendered buffer against the brief:
 * length (+/-50 ms), a final transient in the last 250 ms, envelope-vs-arc correlation
 * (r >= 0.6), and ending quality (decay and spectral richness of the last hit against the
 * body, or a real fade for a "phrase out" ending). On failure the caller revises exactly once
 * with a critique that quotes the measured numbers.
 */
import { arcEnergyAt, round, type Arc, type ArcEnding } from './Arc.js';
import { fft } from './AudioFeatures.js';

export type EndingKind = ArcEnding;

export const FIT_LENGTH_TOLERANCE_SEC = 0.05;
export const FIT_END_WINDOW_SEC = 0.25;
export const FIT_MIN_CORRELATION = 0.6;
const MIN_DECAY_DB = 12;
const MIN_FADE_DB = 6;
const MIN_ENDING_BANDS = 3;
const TRANSIENT_RISE = 2.5;
const FRAME_SEC = 0.005;
const FFT_SIZE = 4096;

export interface RenderedAudio { readonly samples: Float32Array; readonly sampleRate: number }

const peakOf = (s: Float32Array, from = 0, to = s.length) => {
  let p = 0;
  for (let i = Math.max(0, from); i < Math.min(s.length, to); i++) { const a = Math.abs(s[i]); if (a > p) p = a; }
  return p;
};
const toDb = (ratio: number) => 20 * Math.log10(Math.max(ratio, 1e-9));

/** Pearson correlation, or null when either series has no variance. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  if (saa < 1e-12 || sbb < 1e-12) return null;
  return sab / Math.sqrt(saa * sbb);
}

/** End of the last audible sound: the last sample above `thresholdDb` relative to the peak. */
export function measureLength(samples: Float32Array, sampleRate: number, thresholdDb = -40): number {
  const peak = peakOf(samples);
  if (peak === 0) return 0;
  const thr = peak * 10 ** (thresholdDb / 20);
  for (let i = samples.length - 1; i >= 0; i--) if (Math.abs(samples[i]) > thr) return (i + 1) / sampleRate;
  return 0;
}

/** Per-frame peak levels of [fromSec, toSec). */
function framePeaks(samples: Float32Array, sr: number, fromSec: number, toSec: number): number[] {
  const step = Math.max(1, Math.round(FRAME_SEC * sr));
  const out: number[] = [];
  for (let i = Math.max(0, Math.round(fromSec * sr)); i < Math.min(samples.length, Math.round(toSec * sr)); i += step) {
    out.push(peakOf(samples, i, i + step));
  }
  return out;
}

export function finalTransient(samples: Float32Array, sr: number, durationSec: number)
  : { present: boolean; riseRatio: number } {
  const global = peakOf(samples);
  if (global === 0) return { present: false, riseRatio: 0 };
  const frames = framePeaks(samples, sr, durationSec - FIT_END_WINDOW_SEC - FRAME_SEC, durationSec);
  const floor = 0.01 * global;
  let best = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i] < 0.1 * global) continue;
    best = Math.max(best, frames[i] / Math.max(frames[i - 1], floor));
  }
  return { present: best >= TRANSIENT_RISE, riseRatio: round(best, 2) };
}

/** RMS per 0.5 s bin against the arc energy at the bin centre. Null when either is flat. */
export function correlateWithArc(samples: Float32Array, sr: number, arc: Arc, durationSec: number): number | null {
  const bin = 0.5;
  const env: number[] = [];
  const target: number[] = [];
  for (let t = 0; t + bin <= durationSec + 1e-9; t += bin) {
    const from = Math.round(t * sr);
    const to = Math.min(samples.length, Math.round((t + bin) * sr));
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    env.push(to > from ? Math.sqrt(sum / (to - from)) : 0);
    target.push(arcEnergyAt(arc, t + bin / 2));
  }
  return pearson(env, target);
}

/** Count of octave bands (from 62.5 Hz) holding energy within 40 dB of the strongest band. */
function activeBands(samples: Float32Array, sr: number, start: number, end: number): number {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const len = Math.min(FFT_SIZE, Math.max(0, Math.min(samples.length, end) - start));
  for (let i = 0; i < len; i++) re[i] = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, len - 1)));
  fft(re, im);
  const bands: number[] = [];
  for (let lo = 62.5; lo < sr / 2; lo *= 2) {
    let e = 0;
    const k0 = Math.ceil((lo * FFT_SIZE) / sr);
    const k1 = Math.min(FFT_SIZE / 2, Math.floor((lo * 2 * FFT_SIZE) / sr));
    for (let k = k0; k < k1; k++) e += re[k] * re[k] + im[k] * im[k];
    bands.push(e);
  }
  const max = Math.max(...bands, 0);
  return max === 0 ? 0 : bands.filter((e) => e >= max * 1e-4).length;
}

export interface EndingReport {
  readonly kind: EndingKind;
  readonly ok: boolean;
  /** Hit: peak to end of the last 250 ms. Phrase-out: previous second to the last 40 ms. */
  readonly decayDb: number;
  readonly bands: number;
  readonly bodyBands: number;
  readonly problems: readonly string[];
}

export function endingQuality(samples: Float32Array, sr: number, durationSec: number, kind: EndingKind): EndingReport {
  const problems: string[] = [];
  if (kind === 'phrase-out') {
    const before = peakOf(samples, Math.round((durationSec - 1.25) * sr), Math.round((durationSec - FIT_END_WINDOW_SEC) * sr));
    const last = peakOf(samples, Math.round((durationSec - 0.04) * sr), Math.round(durationSec * sr));
    const fadeDb = round(Math.min(80, toDb(before / Math.max(last, 1e-6))), 1);
    if (fadeDb < MIN_FADE_DB) problems.push(`the phrase does not fade: only ${fadeDb} dB quieter at the end, need ${MIN_FADE_DB} dB`);
    return { kind, ok: problems.length === 0, decayDb: fadeDb, bands: 0, bodyBands: 0, problems };
  }
  const frames = framePeaks(samples, sr, durationSec - FIT_END_WINDOW_SEC, durationSec);
  const peak = Math.max(...frames, 0);
  const pk = frames.indexOf(peak);
  const tail = Math.max(...frames.slice(-2), 0);
  const decayDb = round(Math.min(80, toDb(peak / Math.max(tail, 1e-6))), 1);
  let abrupt = false;
  for (let i = Math.max(1, pk + 1); i < frames.length; i++) {
    if (frames[i - 1] >= 0.25 * peak && frames[i] <= frames[i - 1] * 0.03) abrupt = true;
  }
  const hitStart = Math.round((durationSec - FIT_END_WINDOW_SEC + (pk * FRAME_SEC)) * sr);
  const bands = peak === 0 ? 0 : activeBands(samples, sr, hitStart, Math.round(durationSec * sr));
  let bodyBands = 0;
  const bodySpan = Math.max(0, durationSec - 0.5 - FFT_SIZE / sr);
  for (let k = 0; k < 8; k++) {
    const at = Math.round((bodySpan * k / 7) * sr);
    bodyBands = Math.max(bodyBands, activeBands(samples, sr, at, at + FFT_SIZE));
  }
  if (decayDb < MIN_DECAY_DB) problems.push(`the last hit does not decay: only ${decayDb} dB down by the end, need ${MIN_DECAY_DB} dB`);
  if (abrupt) problems.push('the last hit is cut off abruptly instead of ringing out');
  const need = Math.max(MIN_ENDING_BANDS, Math.ceil(0.6 * bodyBands));
  if (bands < need) problems.push(`the last hit is spectrally thin: ${bands} octave bands active, the body has ${bodyBands}, need ${need}`);
  return { kind, ok: problems.length === 0, decayDb, bands, bodyBands, problems };
}

export interface FitOptions {
  readonly arc: Arc | null;
  readonly durationSec: number;
  readonly ending: EndingKind;
}

export interface FitMeasure {
  readonly lengthSec: number;
  readonly lengthErrorSec: number;
  readonly lengthOk: boolean;
  readonly finalTransient: { readonly present: boolean; readonly riseRatio: number } | null;
  readonly correlation: number | null;
  readonly ending: EndingReport;
  readonly pass: boolean;
  readonly failures: readonly string[];
}

export function assessFit(samples: Float32Array, sampleRate: number, opts: FitOptions): FitMeasure {
  const { durationSec, ending: kind, arc } = opts;
  const lengthSec = round(measureLength(samples, sampleRate, kind === 'hit' ? -40 : -30), 3);
  const lengthErrorSec = round(lengthSec - durationSec, 3);
  const lengthOk = Math.abs(lengthErrorSec) <= FIT_LENGTH_TOLERANCE_SEC + 1e-9;
  const transient = kind === 'hit' ? finalTransient(samples, sampleRate, durationSec) : null;
  const rawCorr = arc ? correlateWithArc(samples, sampleRate, arc, durationSec) : null;
  const correlation = rawCorr === null ? null : round(rawCorr, 3);
  const ending = endingQuality(samples, sampleRate, durationSec, kind);
  const failures: string[] = [];
  if (!lengthOk) {
    failures.push(`length ${lengthSec} s misses target ${durationSec} s by ${lengthErrorSec} s (tolerance ${FIT_LENGTH_TOLERANCE_SEC} s)`);
  }
  if (transient && !transient.present) {
    failures.push(`no final hit in the last ${FIT_END_WINDOW_SEC * 1000} ms (strongest rise ${transient.riseRatio}x, need ${TRANSIENT_RISE}x)`);
  }
  if (correlation !== null && correlation < FIT_MIN_CORRELATION) {
    failures.push(`envelope correlation r = ${correlation} is below ${FIT_MIN_CORRELATION}`);
  }
  failures.push(...ending.problems);
  return { lengthSec, lengthErrorSec, lengthOk, finalTransient: transient, correlation, ending,
    pass: failures.length === 0, failures };
}

/** The revision brief: every failure, with the numbers that were measured. */
export function buildFitCritique(m: FitMeasure, durationSec: number): string {
  const lines = [
    'Your previous attempt was rendered and measured. It missed the brief:',
    `- measured length ${m.lengthSec} s, target ${durationSec} s (error ${m.lengthErrorSec} s, tolerance ${FIT_LENGTH_TOLERANCE_SEC} s)`,
    `- envelope correlation r = ${m.correlation === null ? 'n/a (flat arc)' : m.correlation} (need >= ${FIT_MIN_CORRELATION})`,
  ];
  if (m.finalTransient) lines.push(`- final hit rise ${m.finalTransient.riseRatio}x in the last ${FIT_END_WINDOW_SEC * 1000} ms (need >= ${TRANSIENT_RISE}x)`);
  lines.push(`- ending: ${m.ending.decayDb} dB decay, ${m.ending.bands} octave bands in the ending vs ${m.ending.bodyBands} in the body`);
  lines.push('Problems to fix:', ...m.failures.map((f) => `- ${f}`));
  lines.push(`Rewrite it so the audible sound ends at ${durationSec} s, follows the arc, and ends with a full, naturally decaying`
    + ' ending (several octave bands, not a single bleep).');
  return lines.join('\n');
}

export interface FitRecord {
  readonly schema: 'sinter-reverse-fit-v1';
  readonly targetSec: number;
  readonly ending: EndingKind;
  readonly attempts: readonly FitMeasure[];
  readonly revised: boolean;
  readonly critique?: string;
  readonly passed: boolean;
}

/**
 * Render, measure, and if it misses, ask for exactly one revision (never more) and measure again.
 * `revise` receives the critique and must make `render` return the revised piece.
 */
export async function fitWithOneRevision(input: FitOptions & {
  render: () => Promise<RenderedAudio>;
  revise: (critique: string) => Promise<void>;
}): Promise<FitRecord> {
  const { render, revise, ...opts } = input;
  const measure = async () => { const r = await render(); return assessFit(r.samples, r.sampleRate, opts); };
  const first = await measure();
  const base = { schema: 'sinter-reverse-fit-v1' as const, targetSec: opts.durationSec, ending: opts.ending };
  if (first.pass) return { ...base, attempts: [first], revised: false, passed: true };
  const critique = buildFitCritique(first, opts.durationSec);
  await revise(critique);
  const second = await measure();
  return { ...base, attempts: [first, second], revised: true, critique, passed: second.pass };
}
