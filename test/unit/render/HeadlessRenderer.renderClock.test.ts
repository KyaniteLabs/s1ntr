import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import sharp from 'sharp';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

const png = (v: number) => sharp({ create: { width: 4, height: 4, channels: 4, background: { r: v, g: v, b: v, alpha: 1 } } }).png().toBuffer();

// crystal-k (2026-11-17): a cold browser launch counted against the piece's
// duration cap. And three/glsl/p5 captured at the first canvas, before async
// setup drew anything. Both are host/timing facts, not the piece's fault.

type TestRenderer = HeadlessRenderer & {
  context: { newPage: () => Promise<Page> };
  initialize: () => Promise<void>;
  waitForCanvas: () => Promise<boolean>;
  captureScreenshot: () => Promise<{ buffer: Buffer; width: number; height: number; success: boolean }>;
};

function makeRenderer(opts: { launchMs?: number; lit?: boolean } = {}) {
  const shot = vi.fn(async () => png(opts.lit === false ? 0 : 200));
  const page = {
    locator: () => ({ first: () => ({ screenshot: shot }) }),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    setContent: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn(async () => {}),
    waitForTimeout: vi.fn(() => new Promise(r => setTimeout(r, 5))),
    close: vi.fn().mockResolvedValue(undefined),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(true),
    context: () => ({}),
  } as unknown as Page;
  const renderer = new HeadlessRenderer() as TestRenderer;
  (renderer as unknown as { hostLoadPerCore: () => number }).hostLoadPerCore = () => 0.1;
  renderer.context = { newPage: vi.fn().mockResolvedValue(page) };
  renderer.initialize = vi.fn(() => new Promise<void>(r => setTimeout(r, opts.launchMs ?? 0)));
  renderer.waitForCanvas = vi.fn().mockResolvedValue(true);
  renderer.captureScreenshot = vi.fn(async () => ({ buffer: Buffer.from([1]), width: 100, height: 100, success: true }));
  return { renderer, page, shot };
}

describe('render clock and first frame', () => {
  it('does not charge browser launch to the duration cap', async () => {
    const { renderer } = makeRenderer({ launchMs: 120 });
    const result = await renderer.render('<svg></svg>', { domain: 'svg', maximumDurationMs: 80 });
    expect(result.error ?? '').not.toMatch(/DURATION|CONTENTION/);
    expect(result.success).toBe(true);
  });

  it('waits for a lit frame before capturing a three scene', async () => {
    const { renderer, shot } = makeRenderer({ lit: true });
    const result = await renderer.render('<canvas></canvas>', { domain: 'three' });
    expect(result.success).toBe(true);
    expect(shot).toHaveBeenCalledTimes(1); // lit on the first look: one screenshot, no polling
    expect(result.logs.some(l => /no lit three frame/.test(l))).toBe(false);
  });

  it('captures a dark scene anyway, with a warning, instead of failing it', async () => {
    const { renderer } = makeRenderer({ lit: false });
    const result = await renderer.render('<canvas></canvas>', { domain: 'glsl', timeout: 300 });
    expect(result.success).toBe(true);
    expect(result.logs.some(l => /no lit glsl frame/.test(l))).toBe(true);
  });
});
