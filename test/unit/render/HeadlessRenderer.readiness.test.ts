import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

type TestRenderer = HeadlessRenderer & {
  context: { newPage: () => Promise<Page> };
  initialize: () => Promise<void>;
  captureScreenshot: () => Promise<{
    buffer: Buffer;
    width: number;
    height: number;
    success: boolean;
  }>;
  captureAudio: (page: Page, options: { stabilizationTime: number }) => Promise<unknown>;
};

function makeRenderer(options: { canvasReady?: boolean; delayed?: boolean } = {}) {
  const events: string[] = [];
  const waitForFunction = vi.fn(async () => {
    if (options.delayed) await Promise.resolve();
    events.push('canvas-ready');
    if (options.canvasReady === false) throw new Error('timed out');
  });
  const page = {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    setContent: vi.fn(async () => events.push('domcontentloaded')),
    waitForFunction,
    waitForTimeout: vi.fn(async (milliseconds: number) => events.push(`stabilized:${milliseconds}`)),
    close: vi.fn().mockResolvedValue(undefined),
    // Mock for waitForFirstFrame: return true to simulate frame detected
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(true),
  } as unknown as Page;
  const renderer = new HeadlessRenderer() as TestRenderer;
  renderer.context = { newPage: vi.fn().mockResolvedValue(page) };
  renderer.initialize = vi.fn().mockResolvedValue(undefined);
  renderer.captureScreenshot = vi.fn(async () => {
    events.push('captured');
    return { buffer: Buffer.from([1]), width: 100, height: 100, success: true };
  });
  return { renderer, page, events, waitForFunction };
}

/**
 * Creates a renderer mock where waitForFirstFrame times out because the canvas
 * stays blank (evaluate returns false past the deadline).
 */
function makeRendererWithBlankCanvas() {
  const events: string[] = [];
  const waitForFunction = vi.fn(async () => {
    events.push('canvas-ready');
  });
  const page = {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    setContent: vi.fn(async () => events.push('domcontentloaded')),
    waitForFunction,
    waitForTimeout: vi.fn(async (ms: number) => events.push(`wait:${ms}`)),
    close: vi.fn().mockResolvedValue(undefined),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    // Simulate blank canvas: evaluate always returns false (no pixels rendered)
    evaluate: vi.fn().mockResolvedValue(false),
  } as unknown as Page;
  const renderer = new HeadlessRenderer() as TestRenderer;
  renderer.context = { newPage: vi.fn().mockResolvedValue(page) };
  renderer.initialize = vi.fn().mockResolvedValue(undefined);
  renderer.captureScreenshot = vi.fn(async () => {
    events.push('captured');
    return { buffer: Buffer.from([1]), width: 100, height: 100, success: true };
  });
  return { renderer, page, events };
}

describe('HeadlessRenderer readiness', () => {
  it('bounds a stalled Hydra animation frame and cancels its pending probe', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', () => 7);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    try {
      const page = { exposeFunction: vi.fn(async () => {}),
        evaluate: async (callback: (timeout: number) => unknown, timeout: number) => callback(timeout),
        waitForTimeout: vi.fn(async () => {}) } as unknown as Page;
      const renderer = new HeadlessRenderer() as unknown as {
        waitForFirstFrame: (page: Page, timeout: number) => Promise<boolean> };
      expect(await renderer.waitForFirstFrame(page, 30)).toBe(false);
      expect(cancel).toHaveBeenCalledWith(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('detects Hydra pixels during the frame when its earlier event was missed', async () => {
    let drawing = false;
    const gl = { RGBA: 1, UNSIGNED_BYTE: 2,
      readPixels: (_x: number, _y: number, _w: number, _h: number,
        _format: number, _type: number, pixels: Uint8Array) => {
        pixels.set(drawing ? [20, 30, 40, 255] : [0, 0, 0, 0]);
      } };
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('document', { querySelector: () => ({
      width: 100, height: 100, getContext: () => gl }) });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      queueMicrotask(() => { drawing = true; callback(); drawing = false; });
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    try {
      const page = { exposeFunction: vi.fn(async () => {}),
        evaluate: async (callback: (timeout: number) => unknown, timeout: number) => callback(timeout),
        waitForTimeout: vi.fn(async () => {}) } as unknown as Page;
      const renderer = new HeadlessRenderer() as unknown as {
        waitForFirstFrame: (page: Page, timeout: number) => Promise<boolean> };
      expect(await renderer.waitForFirstFrame(page, 250)).toBe(true);
      expect(page.waitForTimeout).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('captures an immediately ready canvas after the default short stabilization', async () => {
    const { renderer, page, events } = makeRenderer();

    const result = await renderer.render('function setup(){createCanvas(100, 100)}', { domain: 'p5' });

    expect(result.success).toBe(true);
    expect(page.setContent).toHaveBeenCalledWith(expect.any(String), {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    expect(events.slice(0, 4)).toEqual(['domcontentloaded', 'canvas-ready', 'stabilized:500', 'captured']);
  });

  it('waits for delayed canvas readiness before stabilization and capture', async () => {
    const { renderer, events } = makeRenderer({ delayed: true });

    await renderer.render('const scene = new THREE.Scene()', {
      domain: 'three',
      stabilizationTime: 125,
    });

    expect(events.slice(0, 4)).toEqual(['domcontentloaded', 'canvas-ready', 'stabilized:125', 'captured']);
  });

  it('returns a bounded render failure when a required canvas times out', async () => {
    const { renderer, waitForFunction } = makeRenderer({ canvasReady: false });

    const result = await renderer.render('void main(){gl_FragColor=vec4(1.0);}', {
      domain: 'glsl',
      timeout: 900,
    });

    expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), { timeout: 900 });
    expect(result).toMatchObject({
      success: false,
      error: 'Canvas not found or timed out for glsl render',
    });
    expect(renderer.captureScreenshot).not.toHaveBeenCalled();
  });

  it('does not use network idleness as readiness during continuous activity', async () => {
    const { renderer, page } = makeRenderer();

    const result = await renderer.render('<canvas width="10" height="10"></canvas>', {
      domain: 'hydra',
      waitForStabilization: false,
    });

    expect(result.success).toBe(true);
    expect(page.setContent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      waitUntil: 'domcontentloaded',
    }));
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('honors configured stabilization for visual and audio capture', async () => {
    const { renderer, page } = makeRenderer();

    await renderer.render('function setup(){createCanvas(100, 100)}', {
      domain: 'p5',
      stabilizationTime: 321,
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(321);

    const audioPage = {
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        samples: [0.25],
        sampleRate: 44100,
        duration: 0.321,
        hasAudio: true,
        warnings: [],
      }),
    } as unknown as Page;
    await renderer.captureAudio(audioPage, { stabilizationTime: 321 });
    expect(audioPage.waitForTimeout).toHaveBeenCalledWith(321);
    expect(audioPage.evaluate).toHaveBeenCalledWith(expect.any(Function), 321);
  });

  it('returns failure when hydra canvas stays blank past timeout (waitForFirstFrame timeout path)', async () => {
    const { renderer, page, events } = makeRendererWithBlankCanvas();

    // Use a short timeout so the test runs fast
    const result = await renderer.render('osc().out(o0)', {
      domain: 'hydra',
      timeout: 500,
    });

    // waitForFirstFrame should have polled and found blank canvas
    // Should have waited for the canvas
    expect(events).toContain('canvas-ready');
    // The hydra blank-output error should be returned
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Hydra failed to render within timeout.*blank output/i);
    // Screenshot should NOT be captured when waitForFirstFrame times out
    expect(renderer.captureScreenshot).not.toHaveBeenCalled();
  });
});
