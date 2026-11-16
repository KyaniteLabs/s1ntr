import { execFileSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

// The hydra gate fails a render as "blank output" when no frame shows a lit
// pixel. These tests run the renderer's real in-page probe against a fake
// canvas, so they check what the gate sees, not how it samples.

const W = 16;
const H = 12;
type Frame = Uint8Array; // RGBA, row 0 at the top as the viewer sees it

function blackFrame(): Frame {
  return new Uint8Array(W * H * 4);
}
function light(frame: Frame, x: number, y: number): Frame {
  frame.set([200, 120, 40, 255], (y * W + x) * 4);
  return frame;
}

function fakeCanvas(frame: Frame, kind: 'webgl' | '2d') {
  const gl = {
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    // WebGL rows start at the bottom of the canvas.
    readPixels(x: number, y: number, w: number, h: number, _f: number, _t: number, out: Uint8Array) {
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const src = ((H - 1 - (y + row)) * W + (x + col)) * 4;
          out.set(frame.subarray(src, src + 4), (row * w + col) * 4);
        }
      }
    },
  };
  const ctx2d = {
    getImageData(x: number, y: number, w: number, h: number) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const src = ((y + row) * W + (x + col)) * 4;
          data.set(frame.subarray(src, src + 4), (row * w + col) * 4);
        }
      }
      return { data };
    },
  };
  return {
    width: W,
    height: H,
    getContext: (type: string) =>
      kind === 'webgl' ? (type.startsWith('webgl') ? gl : null) : type === '2d' ? ctx2d : null,
  };
}

function pageShowing(frame: Frame, kind: 'webgl' | '2d' = 'webgl'): Page {
  const canvas = fakeCanvas(frame, kind);
  vi.stubGlobal('document', { querySelector: (sel: string) => (sel === 'canvas' ? canvas : null) });
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  return {
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg)),
    waitForTimeout: vi.fn((ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))),
  } as unknown as Page;
}

const firstFrame = (page: Page, timeout = 200) =>
  (new HeadlessRenderer() as unknown as {
    waitForFirstFrame: (p: Page, t: number) => Promise<boolean>;
  }).waitForFirstFrame(page, timeout);

afterEach(() => vi.unstubAllGlobals());

describe('hydra first-frame gate', () => {
  it('sees a sketch whose center is black (ring, shape scrolled aside)', async () => {
    expect(await firstFrame(pageShowing(light(blackFrame(), 2, 3)))).toBe(true);
  });

  it('sees a one-pixel line on the top row', async () => {
    const frame = blackFrame();
    for (let x = 0; x < W; x++) light(frame, x, 0);
    expect(await firstFrame(pageShowing(frame))).toBe(true);
  });

  it('sees an off-center pixel on a 2d canvas', async () => {
    expect(await firstFrame(pageShowing(light(blackFrame(), W - 1, H - 1), '2d'))).toBe(true);
  });

  it('still reports an all-black canvas as blank', async () => {
    expect(await firstFrame(pageShowing(blackFrame()))).toBe(false);
  });
});

describe('first-frame probe in the page', () => {
  // page.evaluate ships the probe as text. Under tsx (keepNames) a named
  // inner function becomes __name(...), which the page does not have, so
  // every sketch would read as blank. Run the text tsx produces in a bare
  // context that has only what a page would have.
  it('runs from the text tsx serializes, with no helpers from the module', async () => {
    const src = execFileSync(process.execPath, ['--import', 'tsx', '-e',
      "import('./src/render/HeadlessRenderer.ts').then((m) => process.stdout.write(m.probeFrameLit.toString()))"],
    { encoding: 'utf8', timeout: 60_000 });
    const canvas = fakeCanvas(light(blackFrame(), 2, 3), 'webgl');
    const page = createContext({
      document: { querySelector: (sel: string) => (sel === 'canvas' ? canvas : null) },
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      setTimeout, clearTimeout, Promise, Uint8Array,
    });
    expect(await runInContext(`(${src})(500)`, page)).toBe(true);
  }, 70_000);
});
