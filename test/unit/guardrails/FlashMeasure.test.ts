import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Page } from 'puppeteer';
import {
  judgePhotosensitivity,
  measureFlashes,
  regionLuminance,
  startLuminanceCapture,
  WINDOW_COUNT,
  type LuminanceCapture,
  type LuminanceFrame,
} from '../../../src/guardrails/FlashMeasure.js';

// Frames at 60 Hz. `whole(t)` gives the whole-frame luminance at t ms; every
// grid cell shows the same value unless `cell0` overrides the first cell.
function frames(ms: number, whole: (t: number) => number, cell0?: (t: number) => number): LuminanceFrame[] {
  const out: LuminanceFrame[] = [];
  for (let t = 0; t <= ms; t += 1000 / 60) {
    const v = whole(t);
    const regions = new Array(WINDOW_COUNT + 1).fill(v);
    if (cell0) regions[0] = cell0(t);
    out.push({ t, regions });
  }
  return out;
}
const strobe = (hz: number, low = 0, high = 1) => (t: number) =>
  Math.floor((t / 1000) * hz * 2) % 2 === 0 ? low : high;
const capture = (f: LuminanceFrame[]): LuminanceCapture => ({ frames: f, error: null });

describe('measureFlashes (WCAG 2.3.1 general flash)', () => {
  it('fails a 10 Hz black/white strobe', () => {
    const verdict = judgePhotosensitivity(capture(frames(2000, strobe(10))));
    expect(verdict.pass).toBe(false);
    expect(verdict.measurement?.maxFlashesPerSecond).toBeGreaterThanOrEqual(9);
  });

  it('fails 4 flashes a second and passes 2', () => {
    expect(judgePhotosensitivity(capture(frames(3000, strobe(4)))).pass).toBe(false);
    expect(judgePhotosensitivity(capture(frames(3000, strobe(2)))).pass).toBe(true);
  });

  it('passes a slow fade from black to white', () => {
    // One change is half a flash.
    expect(measureFlashes(frames(2000, (t) => t / 2000)).maxFlashesPerSecond).toBe(0.5);
  });

  it('ignores swings smaller than 0.1 and swings that stay above 0.8', () => {
    expect(measureFlashes(frames(2000, strobe(10, 0.3, 0.38))).maxFlashesPerSecond).toBe(0);
    expect(measureFlashes(frames(2000, strobe(10, 0.82, 1))).maxFlashesPerSecond).toBe(0);
  });

  it('counts a strobe through frame-to-frame noise', () => {
    const noisy = (t: number) => strobe(8, 0.1, 0.6)(t) + ((Math.round(t) % 3) - 1) * 0.04;
    expect(measureFlashes(frames(2000, noisy)).maxFlashesPerSecond).toBeGreaterThan(3);
  });

  it('fails a strobe confined to one region of a steady frame', () => {
    const verdict = judgePhotosensitivity(capture(frames(2000, () => 0.2, strobe(10))));
    expect(verdict.pass).toBe(false);
  });

  // A 60 Hz screen shows at most 30 flashes a second: one frame light, one dark.
  it('fails 20 and 30 flashes a second', () => {
    expect(judgePhotosensitivity(capture(frames(2000, strobe(20)))).pass).toBe(false);
    const everyOtherFrame = Array.from({ length: 121 }, (_, i) => ({ t: (i * 1000) / 60, regions: new Array(WINDOW_COUNT + 1).fill(i % 2) }));
    expect(measureFlashes(everyOtherFrame).maxFlashesPerSecond).toBe(30);
  });

  it('passes 6 transitions in a second and fails 7', () => {
    // Opposing changes at 125 ms steps, the first at 125 ms: n of them land inside one second.
    const steps = (n: number) => frames(1100, (t) => (Math.min(Math.floor(t / 125), n) % 2 === 0 ? 0 : 1));
    expect(judgePhotosensitivity(capture(steps(6))).pass).toBe(true);
    expect(judgePhotosensitivity(capture(steps(7))).pass).toBe(false);
    expect(measureFlashes(steps(7)).maxFlashesPerSecond).toBe(3.5);
  });

  it('passes exactly 3 Hz when the clock reads changes a second apart as a hair under', () => {
    // A change every 1000/6 ms at epoch-scale compositor times, as CDP sends them.
    const at = (start: number) => Array.from({ length: 13 }, (_, i) => ({
      t: start + (i * 1000) / 6,
      regions: new Array(WINDOW_COUNT + 1).fill(i % 2),
    }));
    for (const start of [0, 1.7e12, 1.7e12 + 0.3]) {
      expect(measureFlashes(at(start)).maxFlashesPerSecond).toBe(3);
    }
  });

  it('fails a 3.2 Hz strobe and passes 2.8 Hz', () => {
    expect(judgePhotosensitivity(capture(frames(3000, strobe(3.2)))).pass).toBe(false);
    expect(judgePhotosensitivity(capture(frames(3000, strobe(2.8)))).pass).toBe(true);
  });

  it('counts the last swing even when the capture ends on it', () => {
    const endsHigh = frames(500, (t) => (t < 100 ? 0 : t < 200 ? 1 : t < 300 ? 0 : 1));
    expect(measureFlashes(endsHigh).maxFlashesPerSecond).toBe(1.5);
  });

  it('counts a swing of exactly 0.1', () => {
    expect(measureFlashes(frames(2000, strobe(10, 0.5, 0.6))).maxFlashesPerSecond).toBeGreaterThan(3);
  });

  it('does not pass a capture that saw nothing', () => {
    for (const seen of [null, undefined, capture([])]) {
      const verdict = judgePhotosensitivity(seen);
      expect(verdict.pass).toBe(false);
      expect(verdict.issue).toMatch(/not measured/);
    }
    const failed = { frames: [], error: 'screencast failed: Target closed' };
    expect(judgePhotosensitivity(failed).issue).toMatch(/Target closed/);
  });

  // The screencast sends a frame only when the screen changes.
  it('passes a still page that sent one frame', () => {
    expect(judgePhotosensitivity(capture([{ t: 0, regions: new Array(WINDOW_COUNT + 1).fill(0.5) }])).pass).toBe(true);
  });

  // A WebGL sketch with no context throws and draws nothing: calm frames of a crash.
  it('does not pass calm frames of a page that threw', () => {
    const still = { ...capture([{ t: 0, regions: new Array(WINDOW_COUNT + 1).fill(0) }]), pageErrors: ['Error creating webgl context'] };
    const verdict = judgePhotosensitivity(still);
    expect(verdict.pass).toBe(false);
    expect(verdict.issue).toBe('Photosensitivity not measured: the artwork threw: Error creating webgl context');
  });
});

// An RGBA frame, black except a rectangle of one gray level.
function frame(width: number, height: number, box: { x: number; y: number; w: number; h: number; gray: number } | null) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      data.set([inside ? box.gray : 0, inside ? box.gray : 0, inside ? box.gray : 0, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

describe('regionLuminance', () => {
  it('gives every window and then the whole frame', () => {
    const regions = regionLuminance(frame(120, 90, { x: 0, y: 0, w: 120, h: 90, gray: 255 }));
    expect(regions).toHaveLength(WINDOW_COUNT + 1);
    for (const value of regions) expect(value).toBeCloseTo(1, 6);
    expect(regionLuminance(frame(120, 90, null)).every((value) => value === 0)).toBe(true);
  });

  it('refuses a frame smaller than the grid instead of averaging empty cells', () => {
    expect(() => regionLuminance(frame(8, 6, null))).toThrow(/smaller than the 12x12 grid/);
  });

  it('averages linear light, not sRGB values', () => {
    // sRGB 128 is about 0.216 relative luminance, not 0.5.
    expect(regionLuminance(frame(36, 36, { x: 0, y: 0, w: 36, h: 36, gray: 128 })).at(-1)).toBeCloseTo(0.2158, 3);
  });

  it('puts a flash in the top-left ninth fully in the first window, partly in the next', () => {
    const regions = regionLuminance(frame(120, 90, { x: 0, y: 0, w: 40, h: 30, gray: 255 }));
    expect(regions[0]).toBeCloseTo(1, 6);
    expect(regions[1]).toBeCloseTo(0.75, 6);
    expect(regions[WINDOW_COUNT - 1]).toBe(0);
    expect(regions.at(-1)).toBeCloseTo(1 / 9, 6);
  });

  // Two halves that swap light and dark keep the whole frame at one level.
  it('fails a counter-phase flash the whole-frame average hides', () => {
    const left = frame(120, 90, { x: 0, y: 0, w: 60, h: 90, gray: 255 });
    const right = frame(120, 90, { x: 60, y: 0, w: 60, h: 90, gray: 255 });
    const seen: LuminanceFrame[] = [];
    for (let i = 0; i < 120; i++) seen.push({ t: (i * 1000) / 60, regions: regionLuminance(Math.floor(i / 3) % 2 ? left : right) });
    expect(seen.every((f) => Math.abs(f.regions.at(-1)! - 0.5) < 1e-9)).toBe(true);
    expect(judgePhotosensitivity(capture(seen)).pass).toBe(false);
  });
});

// A fake CDP session: replays PNG frames when the screencast starts and
// records the acknowledgements a real compositor waits for.
function screencastPage(pngs: Buffer[], opts: { start?: () => Promise<void>; timestamps?: Array<number | undefined> } = {}) {
  const session = new EventEmitter() as EventEmitter & { send: (method: string, params?: unknown) => Promise<unknown>; detach: () => Promise<void> };
  const acked: number[] = [];
  session.send = async (method, params) => {
    if (method === 'Page.startScreencast') {
      await opts.start?.();
      pngs.forEach((png, i) => session.emit('Page.screencastFrame', {
        data: png.toString('base64'), sessionId: i,
        metadata: { timestamp: opts.timestamps ? opts.timestamps[i] : 100 + i / 60 },
      }));
    }
    if (method === 'Page.screencastFrameAck') acked.push((params as { sessionId: number }).sessionId);
    return {};
  };
  session.detach = async () => undefined;
  const page = Object.assign(new EventEmitter(), { createCDPSession: async () => session });
  return { page: page as unknown as Page, emit: page.emit.bind(page), acked };
}

const png = (gray: number) => sharp({ create: { width: 16, height: 12, channels: 3, background: { r: gray, g: gray, b: gray } } }).png().toBuffer();
const record = async (page: Page) => (await startLuminanceCapture(page)).stop();

describe('startLuminanceCapture', () => {
  it('measures each screencast frame at its compositor time', async () => {
    const { page, acked } = screencastPage([await png(0), await png(255)]);
    const result = await record(page);
    expect(result.error).toBeNull();
    expect(result.frames.map((f) => f.regions.at(-1))).toEqual([0, 1]);
    expect(result.frames[1].t - result.frames[0].t).toBeCloseTo(1000 / 60, 6);
    expect(acked).toEqual([0, 1]);
  });

  it('keeps one clock when a frame has no compositor time', async () => {
    const { page } = screencastPage([await png(0), await png(255), await png(0)], { timestamps: [100, undefined, 100.05] });
    const times = (await record(page)).frames.map((f) => f.t);
    // Arrival times, all of them: a mix would put frame 2 near zero.
    expect(times.every((t) => t < 100_000 * 1000)).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[2] - times[0]).toBeLessThan(1000);
  });

  it('keeps the errors the page throws while recording, and only those', async () => {
    const { page, emit } = screencastPage([await png(0)]);
    const recording = await startLuminanceCapture(page);
    emit('pageerror', new Error('Error creating webgl context'));
    const result = await recording.stop();
    emit('pageerror', new Error('after the check'));
    expect(result.pageErrors).toEqual(['Error creating webgl context']);
  });

  it('reports a screencast that could not start', async () => {
    const { page } = screencastPage([], { start: () => Promise.reject(new Error('Target closed')) });
    const result = await record(page);
    expect(result.frames).toEqual([]);
    expect(result.error).toMatch(/screencast failed: Target closed/);
  });

  it('names the frame it cannot decode', async () => {
    const { page } = screencastPage([await png(0), Buffer.from('not a png')]);
    const result = await record(page);
    expect(result.frames).toEqual([]);
    expect(result.error).toMatch(/^screencast frame 2 of 2 could not be measured: /);
  });
});
