/**
 * Deterministic feature cards for images and video frames. No model calls.
 * Pixel data stays in this process; only the derived numbers leave.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** The slice of sharp this module uses. sharp is an optional dependency, so it loads on demand. */
export interface SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number }>;
  rotate(): SharpPipeline;
  resize(w: number, h: number, o: { fit: string; withoutEnlargement?: boolean }): SharpPipeline;
  removeAlpha(): SharpPipeline;
  flatten(o: { background: string }): SharpPipeline;
  toColourspace(c: string): SharpPipeline;
  raw(): SharpPipeline;
  jpeg(o: { quality: number }): SharpPipeline;
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
}
export type SharpFactory = (input: Buffer) => SharpPipeline;

export async function loadSharp(): Promise<SharpFactory> {
  try {
    const mod = await import('sharp') as unknown as { default?: SharpFactory };
    return (mod.default ?? (mod as unknown as SharpFactory));
  } catch {
    throw new Error('the sharp image decoder is not installed (pnpm add sharp)');
  }
}
import { round } from './Arc.js';
import type { AudioFeatures } from './AudioFeatures.js';

const execFileAsync = promisify(execFile);

export interface ImageFeatures {
  width: number;
  height: number;
  palette: string[]; // dominant colors, most common first
  brightness: number; // mean luma 0..1
  contrast: number; // luma standard deviation 0..~0.5
  edgeDensity: number; // fraction of pixels on a strong edge
  balance: { x: number; y: number }; // luma centre of mass, -1 (left/top) .. 1 (right/bottom)
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Top-N colors from packed RGB triples, quantised to 4 bits per channel. */
export function dominantPalette(rgb: Uint8Array, count = 5): string[] {
  const buckets = new Map<number, number>();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const key = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, count)
    .map(([key]) => `#${hex2(((key >> 8) << 4) | 8)}${hex2((((key >> 4) & 15) << 4) | 8)}${hex2(((key & 15) << 4) | 8)}`);
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export async function analyzeImage(buf: Buffer): Promise<ImageFeatures> {
  const sharp = await loadSharp();
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error('image has no dimensions');
  const { data, info } = await sharp(buf).rotate().resize(128, 128, { fit: 'inside' })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const grey = new Float64Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    grey[i] = luma(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    sum += grey[i];
  }
  const mean = sum / (w * h);
  let varSum = 0;
  let mx = 0;
  let my = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = grey[y * w + x];
    varSum += (v - mean) ** 2;
    mx += v * x;
    my += v * y;
  }
  let edges = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const g = (dx: number, dy: number) => grey[(y + dy) * w + x + dx];
    const gx = -g(-1, -1) - 2 * g(-1, 0) - g(-1, 1) + g(1, -1) + 2 * g(1, 0) + g(1, 1);
    const gy = -g(-1, -1) - 2 * g(0, -1) - g(1, -1) + g(-1, 1) + 2 * g(0, 1) + g(1, 1);
    if (Math.hypot(gx, gy) > 80) edges++;
  }
  const total = sum || 1;
  return {
    width: meta.width,
    height: meta.height,
    palette: dominantPalette(data),
    brightness: round(mean / 255),
    contrast: round(Math.sqrt(varSum / (w * h)) / 255),
    edgeDensity: round(edges / Math.max(1, (w - 2) * (h - 2))),
    balance: {
      x: round(w > 1 ? (2 * (mx / total)) / (w - 1) - 1 : 0),
      y: round(h > 1 ? (2 * (my / total)) / (h - 1) - 1 : 0),
    },
  };
}

export interface VideoFeatures {
  /** Full length from the container; the picture is analysed up to `analyzedSec`. */
  durationSec: number;
  analyzedSec: number;
  /** Frames per second sampled from the picture (25 for clips up to 2 minutes, fewer for longer ones). */
  sampleFps: number;
  palette: string[];
  /** Mean frame-to-frame change 0..1, max-pooled to at most 60 buckets. */
  motionEnergy: number[];
  motionBucketSec: number;
  /** Scene-change times in seconds. */
  cuts: number[];
  cutRhythm: { cutsPerMinute: number; meanShotSec: number };
  /** The soundtrack's audio card, or null when the file has no audio track. */
  audio: AudioFeatures | null;
}

const VIDEO_MAX_FPS = 25;
const VIDEO_MAX_FRAMES = 3000;
const VIDEO_W = 48;
const VIDEO_H = 27;
export const VIDEO_MAX_SECONDS = 600;
export const FFMPEG_TIMEOUT_MS = 120_000;

/** Run ffmpeg with a hard time limit; failures carry ffmpeg's own last error line. */
export async function runFfmpeg(ffmpeg: string, args: string[], timeoutMs: number, maxBuffer: number): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', ...args],
      { encoding: 'buffer', maxBuffer, timeout: timeoutMs, killSignal: 'SIGKILL' });
    return stdout;
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; stderr?: Buffer; message: string };
    if (err.killed || err.signal === 'SIGKILL') throw new Error(`ffmpeg took longer than ${timeoutMs / 1000} s and was stopped`);
    const reason = err.stderr?.toString('utf8').trim().split('\n').filter(Boolean).at(-1);
    throw new Error(reason ? `ffmpeg: ${reason}` : err.message.split('\n')[0]);
  }
}

interface MediaProbe { durationSec: number | null; hasVideo: boolean; hasAudio: boolean }

/** `ffmpeg -i` with no output prints the container header; read length and stream kinds from it. */
async function probeMedia(ffmpeg: string, input: string, timeoutMs: number): Promise<MediaProbe> {
  let text: string;
  try {
    await execFileAsync(ffmpeg, ['-nostdin', '-hide_banner', '-i', input], { timeout: timeoutMs, killSignal: 'SIGKILL' });
    text = '';
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; stderr?: string };
    if (err.killed || err.signal === 'SIGKILL') throw new Error(`ffmpeg took longer than ${timeoutMs / 1000} s and was stopped`);
    text = String(err.stderr ?? '');
  }
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const hasVideo = /Stream #\S+.*: Video:/.test(text);
  if (!hasVideo) {
    const reason = text.trim().split('\n').filter(Boolean).at(-1);
    throw new Error(reason ? `ffmpeg: ${reason}` : 'no video stream found');
  }
  return {
    durationSec: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null,
    hasVideo,
    hasAudio: /Stream #\S+.*: Audio:/.test(text),
  };
}

export interface VideoAnalysisOptions {
  timeoutMs?: number;
  /** Decode the first `seconds` of the soundtrack and build its audio card. */
  analyzeSoundtrack?: (input: string, seconds: number) => Promise<AudioFeatures>;
}

/**
 * Sample frames with ffmpeg, then compute palette, motion and cuts; hand the soundtrack to the audio card.
 * `input` must be a path ffmpeg reads as a plain file (the caller passes a private copy).
 * At most VIDEO_MAX_FRAMES frames from the first VIDEO_MAX_SECONDS are decoded.
 */
export async function analyzeVideo(input: string, ffmpeg: string, options: VideoAnalysisOptions = {}): Promise<VideoFeatures> {
  const timeoutMs = options.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  const probe = await probeMedia(ffmpeg, input, timeoutMs);
  const window = Math.min(probe.durationSec ?? VIDEO_MAX_SECONDS, VIDEO_MAX_SECONDS);
  const fps = Math.max(1, Math.min(VIDEO_MAX_FPS, Math.floor(VIDEO_MAX_FRAMES / Math.max(window, 1))));
  const frameBytes = VIDEO_W * VIDEO_H * 3;
  const stdout = await runFfmpeg(ffmpeg, ['-t', String(window), '-i', input,
    '-vf', `fps=${fps},scale=${VIDEO_W}:${VIDEO_H}`, '-frames:v', String(VIDEO_MAX_FRAMES),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], timeoutMs, (VIDEO_MAX_FRAMES + 1) * frameBytes);
  const frames = Math.floor(stdout.length / frameBytes);
  if (frames < 2) throw new Error('video yielded fewer than 2 frames');
  const diffs: number[] = [];
  for (let f = 1; f < frames; f++) {
    let s = 0;
    for (let i = 0; i < frameBytes; i++) s += Math.abs(stdout[f * frameBytes + i] - stdout[(f - 1) * frameBytes + i]);
    diffs.push(s / frameBytes / 255);
  }
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length);
  const threshold = Math.max(0.2, mean + 4 * sd);
  const cuts = diffs.flatMap((d, i) => (d > threshold ? [round((i + 1) / fps, 2)] : []));
  const analyzedSec = frames / fps;
  const pool = Math.max(1, Math.ceil(diffs.length / 60));
  const motionEnergy: number[] = [];
  for (let i = 0; i < diffs.length; i += pool) motionEnergy.push(round(Math.max(...diffs.slice(i, i + pool))));
  const boundaries = [0, ...cuts, analyzedSec];
  const shots = boundaries.slice(1).map((t, i) => t - boundaries[i]);
  const audio = probe.hasAudio && options.analyzeSoundtrack ? await options.analyzeSoundtrack(input, analyzedSec) : null;
  return {
    durationSec: round(probe.durationSec ?? analyzedSec, 2),
    analyzedSec: round(analyzedSec, 2),
    sampleFps: fps,
    palette: dominantPalette(stdout.subarray(0, frames * frameBytes)),
    motionEnergy,
    motionBucketSec: round(pool / fps),
    cuts,
    cutRhythm: {
      cutsPerMinute: round((cuts.length / analyzedSec) * 60, 1),
      meanShotSec: round(shots.reduce((a, b) => a + b, 0) / shots.length, 2),
    },
    audio,
  };
}
