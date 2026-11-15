/**
 * Deterministic audio feature extraction for reverse mode. No model calls.
 * Input is mono float samples; output is a small card of numbers.
 */
import { detectKey } from '../audio/BPMKeyDetector.js';
import { curveToSections, round, type ArcSection } from './Arc.js';

export interface DecodedAudio {
  readonly samples: Float32Array; // mono, -1..1
  readonly sampleRate: number;
}

export interface AudioFeatures {
  durationSec: number;
  sampleRate: number;
  bpm: number;
  key: string;
  mode: 'major' | 'minor';
  barSeconds: number;
  /** RMS per bar, scaled so the loudest bar is 1. */
  barEnergy: number[];
  /** Detected onsets per second. */
  onsetDensity: number;
  spectralCentroidHz: number;
  sections: ArcSection[];
}

/** Decode a RIFF/WAVE buffer (PCM 8/16/24/32 or float32/64) to mono. Throws on anything else. */
export function decodeWav(buf: Buffer): DecodedAudio {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  let dataStart = -1;
  let dataLen = 0;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      if (p + 8 + 16 > buf.length) throw new Error('truncated fmt chunk');
      let tag = buf.readUInt16LE(p + 8);
      const bits = buf.readUInt16LE(p + 22);
      if (tag === 0xfffe && size >= 26) tag = buf.readUInt16LE(p + 8 + 24);
      fmt = { tag, channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits };
    } else if (id === 'data') {
      dataStart = p + 8;
      dataLen = Math.min(size, buf.length - dataStart);
      break;
    }
    p += 8 + size + (size % 2);
  }
  if (!fmt) throw new Error('missing fmt chunk');
  if (dataStart < 0) throw new Error('missing data chunk');
  const { tag, channels, rate, bits } = fmt;
  if (channels < 1 || rate < 1000) throw new Error('invalid channel count or sample rate');
  const bytes = bits / 8;
  const supported = (tag === 1 && [8, 16, 24, 32].includes(bits)) || (tag === 3 && [32, 64].includes(bits));
  if (!supported) throw new Error(`unsupported wav encoding (format ${tag}, ${bits}-bit)`);
  const frames = Math.floor(dataLen / (bytes * channels));
  if (frames < 1) throw new Error('wav has no audio frames');
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataStart + (i * channels + c) * bytes;
      let v: number;
      if (tag === 3) v = bits === 32 ? buf.readFloatLE(o) : buf.readDoubleLE(o);
      else if (bits === 8) v = (buf[o] - 128) / 128;
      else if (bits === 16) v = buf.readInt16LE(o) / 32768;
      else if (bits === 24) v = buf.readIntLE(o, 3) / 8388608;
      else v = buf.readInt32LE(o) / 2147483648;
      sum += v;
    }
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate: rate };
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
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
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function pickBpm(onset: Float64Array, hopSec: number): number {
  const minLag = Math.max(2, Math.ceil(60 / 180 / hopSec));
  const maxLag = Math.min(Math.floor(60 / 70 / hopSec), Math.floor(onset.length / 2));
  if (maxLag <= minLag) return 120;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < onset.length; i++) s += onset[i] * onset[i + lag];
    ac[lag] = s / (onset.length - lag);
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > ac[best]) best = lag;
  // Prefer the faster pulse when it is nearly as strong (half-tempo ambiguity).
  const half = Math.round(best / 2);
  if (half >= minLag && ac[half] >= 0.8 * ac[best]) best = half;
  // Parabolic interpolation around the peak for sub-frame lag.
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return 60 / ((best + shift) * hopSec);
}

export function analyzeAudio(audio: DecodedAudio): AudioFeatures {
  const { samples, sampleRate } = audio;
  const durationSec = samples.length / sampleRate;
  if (durationSec < 1) throw new Error(`audio is ${round(durationSec)}s long; need at least 1 s`);

  // Short-time RMS (20 ms window, 5 ms hop) -> onset novelty.
  const hop = Math.max(1, Math.round(sampleRate * 0.005));
  const win = hop * 4;
  const frames = Math.max(1, Math.floor((samples.length - win) / hop));
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < f * hop + win; i++) s += samples[i] * samples[i];
    rms[f] = Math.sqrt(s / win);
  }
  const hopSec = hop / sampleRate;
  const onset = new Float64Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, rms[f] - rms[f - 1]);

  const bpm = round(pickBpm(onset, hopSec), 1);

  // Onset density: peaks above 15% of the strongest, at least 150 ms apart.
  const maxOnset = onset.reduce((m, v) => Math.max(m, v), 0);
  const minGap = Math.round(0.15 / hopSec);
  let peaks = 0;
  let last = -minGap;
  for (let f = 1; f < frames - 1; f++) {
    if (onset[f] > 0.15 * maxOnset && onset[f] >= onset[f - 1] && onset[f] > onset[f + 1] && f - last >= minGap) {
      peaks++;
      last = f;
    }
  }
  const onsetDensity = round(peaks / durationSec, 2);

  // Spectrum: chroma for the key, centroid for brightness.
  const nfft = sampleRate > 24000 ? 16384 : 8192;
  const chroma = new Array<number>(12).fill(0);
  let centroidSum = 0;
  let centroidCount = 0;
  const fftFrames = Math.max(1, Math.floor((samples.length - nfft) / (nfft / 2)) + 1);
  const step = Math.max(1, Math.floor(fftFrames / 60));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let f = 0; f < fftFrames; f += step) {
    const start = Math.min(f * (nfft / 2), Math.max(0, samples.length - nfft));
    for (let i = 0; i < nfft; i++) {
      const v = start + i < samples.length ? samples[start + i] : 0;
      re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1)));
      im[i] = 0;
    }
    fft(re, im);
    let num = 0;
    let den = 0;
    for (let k = 1; k < nfft / 2; k++) {
      const freq = (k * sampleRate) / nfft;
      const mag = Math.hypot(re[k], im[k]);
      num += freq * mag;
      den += mag;
      if (freq >= 100 && freq <= 2000) {
        const pc = (((Math.round(12 * Math.log2(freq / 440) + 69)) % 12) + 12) % 12;
        chroma[pc] += mag * mag;
      }
    }
    if (den > 1e-9) { centroidSum += num / den; centroidCount++; }
  }
  const key = detectKey(chroma);

  // Per-bar energy (4/4) and sections.
  const barSeconds = (4 * 60) / bpm;
  const nBars = Math.max(1, Math.floor(durationSec / barSeconds + 0.25));
  const barRms: number[] = [];
  for (let b = 0; b < nBars; b++) {
    const from = Math.floor(b * barSeconds * sampleRate);
    const to = Math.min(samples.length, Math.floor((b + 1) * barSeconds * sampleRate));
    let s = 0;
    for (let i = from; i < to; i++) s += samples[i] * samples[i];
    barRms.push(to > from ? Math.sqrt(s / (to - from)) : 0);
  }
  const maxBar = Math.max(...barRms, 1e-12);
  return {
    durationSec: round(durationSec, 2),
    sampleRate,
    bpm,
    key: key.key,
    mode: key.mode,
    barSeconds: round(barSeconds),
    barEnergy: barRms.map((v) => round(v / maxBar)),
    onsetDensity,
    spectralCentroidHz: round(centroidCount ? centroidSum / centroidCount : 0, 1),
    sections: curveToSections(barRms, barSeconds),
  };
}
