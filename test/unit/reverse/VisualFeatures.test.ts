import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

type Cb = (err: unknown, res?: { stdout: unknown; stderr: unknown }) => void;

const cp = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  handler: undefined as undefined | ((args: string[]) => { error?: unknown; stdout?: unknown }),
}));

vi.mock('node:child_process', () => {
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: Cb) => {
    cp.calls.push({ cmd, args });
    const out = cp.handler!(args);
    if (out.error) cb(out.error);
    else cb(null, { stdout: out.stdout ?? '', stderr: '' });
  };
  return { execFile, default: { execFile } };
});

import {
  analyzeImage,
  analyzeVideo,
  dominantPalette,
  runFfmpeg,
} from '../../../src/reverse/VisualFeatures.js';

async function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    raw.set(pixel(x, y), (y * width + x) * 3);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('dominantPalette', () => {
  it('orders colours by frequency and quantises to 4 bits per channel', () => {
    const rgb = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 255]);
    expect(dominantPalette(rgb)).toEqual(['#f80808', '#0808f8']);
  });

  it('breaks ties by bucket key and honours the count limit', () => {
    const rgb = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 0, 0]);
    expect(dominantPalette(rgb, 2)).toEqual(['#080808', '#f80808']);
  });

  it('ignores a trailing partial pixel and returns [] for empty input', () => {
    expect(dominantPalette(new Uint8Array([10, 20]))).toEqual([]);
    expect(dominantPalette(new Uint8Array([]))).toEqual([]);
  });
});

describe('analyzeImage', () => {
  it('describes a flat red image: no contrast, no edges, centred balance', async () => {
    const out = await analyzeImage(await png(32, 32, () => [255, 0, 0]));
    expect(out).toMatchObject({
      width: 32, height: 32, palette: ['#f80808'], brightness: 0.299, contrast: 0, edgeDensity: 0,
    });
    expect(out.balance.x).toBeCloseTo(0, 5);
    expect(out.balance.y).toBeCloseTo(0, 5);
  });

  it('sees edges, contrast and a right-heavy balance in a black/white split', async () => {
    const out = await analyzeImage(await png(64, 64, x => (x < 32 ? [0, 0, 0] : [255, 255, 255])));
    expect(out.brightness).toBeCloseTo(0.5, 1);
    expect(out.contrast).toBeGreaterThan(0.45);
    expect(out.edgeDensity).toBeGreaterThan(0);
    expect(out.edgeDensity).toBeLessThan(0.1);
    expect(out.balance.x).toBeGreaterThan(0.4);
    expect(out.balance.y).toBeCloseTo(0, 5);
    expect(out.palette.slice(0, 2).sort()).toEqual(['#080808', '#f8f8f8']);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(analyzeImage(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('runFfmpeg', () => {
  beforeEach(() => { cp.calls.length = 0; });

  it('prefixes quiet flags and returns stdout', async () => {
    cp.handler = () => ({ stdout: Buffer.from('frames') });
    expect((await runFfmpeg('ffmpeg', ['-i', 'a.mp4'], 1000, 10)).toString()).toBe('frames');
    expect(cp.calls[0]).toEqual({ cmd: 'ffmpeg', args: ['-nostdin', '-v', 'error', '-i', 'a.mp4'] });
  });

  it('reports a timeout kill as a time limit message', async () => {
    cp.handler = () => ({ error: Object.assign(new Error('x'), { killed: true }) });
    await expect(runFfmpeg('ffmpeg', [], 5000, 10)).rejects.toThrow('ffmpeg took longer than 5 s and was stopped');
  });

  it('surfaces the last stderr line of a failure, else the first message line', async () => {
    cp.handler = () => ({ error: Object.assign(new Error('boom'), { stderr: Buffer.from('warn\nInvalid data found\n') }) });
    await expect(runFfmpeg('ffmpeg', [], 1, 1)).rejects.toThrow('ffmpeg: Invalid data found');
    cp.handler = () => ({ error: new Error('spawn ffmpeg ENOENT\nmore') });
    await expect(runFfmpeg('ffmpeg', [], 1, 1)).rejects.toThrow('spawn ffmpeg ENOENT');
  });
});

describe('analyzeVideo', () => {
  const FRAME = 48 * 27 * 3;
  const banner = (extra = '') => `Input #0\n  Duration: 00:00:04.00, start: 0\n  Stream #0:0: Video: h264\n${extra}`;

  /** probe call carries -hide_banner and "fails" with the header on stderr, like real ffmpeg. */
  function ffmpeg(header: string, frames: Buffer) {
    cp.handler = args => (args.includes('-hide_banner')
      ? { error: Object.assign(new Error('no output'), { stderr: header }) }
      : { stdout: frames });
  }
  const frames = (count: number, value: (i: number) => number) =>
    Buffer.concat(Array.from({ length: count }, (_, i) => Buffer.alloc(FRAME, value(i))));

  beforeEach(() => { cp.calls.length = 0; });

  it('finds the cut, rhythm, palette and motion in a black-to-white clip', async () => {
    ffmpeg(banner(), frames(50, i => (i < 25 ? 0 : 255)));
    const out = await analyzeVideo('clip.mp4', 'ffmpeg');
    expect(out.durationSec).toBe(4);
    expect(out.analyzedSec).toBe(2);
    expect(out.sampleFps).toBe(25);
    expect(out.cuts).toEqual([1]);
    expect(out.cutRhythm).toEqual({ cutsPerMinute: 30, meanShotSec: 1 });
    expect(out.palette.slice(0, 2).sort()).toEqual(['#080808', '#f8f8f8']);
    expect(out.motionBucketSec).toBe(0.04);
    expect(out.motionEnergy).toHaveLength(49);
    expect(out.motionEnergy[24]).toBe(1);
    expect(out.motionEnergy[0]).toBe(0);
    expect(out.audio).toBeNull();
    const decode = cp.calls[1].args;
    expect(decode).toContain('fps=25,scale=48:27');
    expect(decode[decode.indexOf('-t') + 1]).toBe('4');
  });

  it('hands the soundtrack to the supplied audio analyser when the file has audio', async () => {
    ffmpeg(banner('  Stream #0:1: Audio: aac\n'), frames(10, () => 7));
    const analyzeSoundtrack = vi.fn().mockResolvedValue({ marker: 'audio-card' });
    const out = await analyzeVideo('clip.mp4', 'ffmpeg', { analyzeSoundtrack });
    expect(analyzeSoundtrack).toHaveBeenCalledWith('clip.mp4', 0.4);
    expect(out.audio).toEqual({ marker: 'audio-card' });
    expect(out.cuts).toEqual([]);
  });

  it('rejects a file with no video stream using the last header line', async () => {
    ffmpeg('clip.mp3: Invalid data found when processing input', Buffer.alloc(0));
    await expect(analyzeVideo('clip.mp3', 'ffmpeg')).rejects.toThrow('ffmpeg: clip.mp3: Invalid data found when processing input');
  });

  it('rejects a clip that decodes to fewer than two frames', async () => {
    ffmpeg(banner(), frames(1, () => 0));
    await expect(analyzeVideo('clip.mp4', 'ffmpeg')).rejects.toThrow('video yielded fewer than 2 frames');
  });

  it('reports a probe timeout', async () => {
    cp.handler = () => ({ error: Object.assign(new Error('x'), { killed: true }) });
    await expect(analyzeVideo('clip.mp4', 'ffmpeg', { timeoutMs: 2000 })).rejects.toThrow('ffmpeg took longer than 2 s and was stopped');
  });
});
