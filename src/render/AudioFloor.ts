/**
 * Deterministic audio measurements and a floor that rejects clearly broken
 * sound (#1631). Model judges cannot be trusted here: the LFM3 sound judges
 * scored music, white noise and silence within 0.2 of each other (#1627).
 * The floor is deliberately loose; it only catches what cannot be music.
 */

export interface AudioMeasurements {
  /** Share of analysis frames quieter than -50 dBFS. */
  readonly silentShare: number;
  /** Median frame loudness of the non-silent frames, dBFS (-99 when all silent). */
  readonly loudnessDb: number;
  /** Median spectral flatness of the non-silent frames: 1 = white noise, near 0 = tonal. */
  readonly noisiness: number | null;
}

const WINDOW = 2048;
const HOP = 512;
const SILENT_DB = -50;

/** In-place iterative radix-2 FFT; `re`/`im` length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Measures captured mono samples (normalised -1..1). Null when too short to judge. */
export function measureAudio(samples: Float32Array): AudioMeasurements | null {
  if (samples.length < WINDOW) return null;
  const hann = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  const loudDb: number[] = [];
  const flatness: number[] = [];
  let frames = 0;
  for (let start = 0; start + WINDOW <= samples.length; start += HOP) {
    frames++;
    let sumSquares = 0;
    for (let i = 0; i < WINDOW; i++) {
      const v = samples[start + i] * hann[i];
      re[i] = v; im[i] = 0;
      sumSquares += v * v;
    }
    const db = 20 * Math.log10(Math.sqrt(sumSquares / WINDOW) + 1e-9);
    if (db < SILENT_DB) continue;
    loudDb.push(db);
    fft(re, im);
    let logSum = 0;
    let sum = 0;
    const bins = WINDOW / 2 + 1;
    for (let k = 0; k < bins; k++) {
      const magnitude = Math.hypot(re[k], im[k]) + 1e-9;
      logSum += Math.log(magnitude);
      sum += magnitude;
    }
    flatness.push(Math.exp(logSum / bins) / (sum / bins));
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    silentShare: round(1 - loudDb.length / frames),
    loudnessDb: loudDb.length ? Math.round(median(loudDb) * 10) / 10 : -99,
    noisiness: flatness.length ? round(median(flatness)) : null,
  };
}

/** Why a recording cannot be good music, or null when it clears the floor. */
export function audioFloorFailure(measured: AudioMeasurements | null | undefined): string | null {
  if (!measured) return null;
  if (measured.silentShare > 0.8) return `silent ${Math.round(measured.silentShare * 100)}% of the time`;
  if (measured.noisiness !== null && measured.noisiness > 0.6) return `noise-like (noisiness ${measured.noisiness})`;
  return null;
}
