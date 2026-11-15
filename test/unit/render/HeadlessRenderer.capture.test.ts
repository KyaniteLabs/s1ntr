import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

type Box = { x: number; y: number; width: number; height: number } | null;
type Capture = (page: Page, opts: { width: number; height: number; omitBackground: boolean }) => Promise<{
  buffer: Buffer; width: number; height: number; success: boolean; error?: string;
}>;

const OPTS = { width: 800, height: 600, omitBackground: false };

function fakePage(box: Box | 'no-canvas', screenshot = vi.fn(async () => Buffer.from([7]))) {
  const elementScreenshot = vi.fn(async () => { throw new Error('element screenshots wait for a still element'); });
  const canvas = box === 'no-canvas' ? null : { boundingBox: async () => box, screenshot: elementScreenshot };
  const page = {
    $: async () => canvas,
    viewportSize: () => ({ width: 825, height: 620 }),
    screenshot,
  } as unknown as Page;
  return { page, screenshot, elementScreenshot };
}

const capture = (page: Page) =>
  ((new HeadlessRenderer() as unknown as { captureScreenshot: Capture }).captureScreenshot)(page, OPTS);

describe('HeadlessRenderer.captureScreenshot', () => {
  it('clips a page screenshot to the canvas instead of waiting for an animated canvas to hold still', async () => {
    const { page, screenshot, elementScreenshot } = fakePage({ x: 10, y: 20, width: 300, height: 200 });
    const shot = await capture(page);
    expect(shot).toEqual({ buffer: Buffer.from([7]), width: 300, height: 200, success: true });
    expect(screenshot.mock.calls[0]).toEqual([{ type: 'png', omitBackground: false, clip: { x: 10, y: 20, width: 300, height: 200 } }]);
    expect(elementScreenshot).not.toHaveBeenCalled();
  });

  it('trims a scaled canvas that spills past the viewport to the visible area', async () => {
    // A CSS scale(1.022) grows the box beyond an 825x620 viewport on every side.
    const { page, screenshot } = fakePage({ x: -9, y: -7, width: 843, height: 634 });
    const shot = await capture(page);
    expect(shot.width).toBe(825);
    expect(shot.height).toBe(620);
    expect(screenshot.mock.calls[0]).toEqual([{ type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: 825, height: 620 } }]);
  });

  it.each([
    ['there is no canvas', 'no-canvas' as const],
    ['the canvas has no layout box', null],
    ['the canvas is zero-sized', { x: 0, y: 0, width: 0, height: 0 }],
  ])('falls back to the whole viewport when %s', async (_label, box) => {
    const { page, screenshot } = fakePage(box);
    const shot = await capture(page);
    expect(shot).toEqual({ buffer: Buffer.from([7]), width: 800, height: 600, success: true });
    expect(screenshot.mock.calls[0]).toEqual([{ type: 'png', fullPage: false, omitBackground: false }]);
  });

  it('reports a failed capture with its reason instead of throwing', async () => {
    const { page } = fakePage({ x: 0, y: 0, width: 100, height: 100 },
      vi.fn(async () => { throw new Error('Timeout 30000ms exceeded'); }));
    const shot = await capture(page);
    expect(shot).toEqual({ buffer: Buffer.alloc(0), width: 0, height: 0, success: false, error: 'Timeout 30000ms exceeded' });
  });
});
