import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

// #1637: a piece that unfolds over a minute must be judged on its arc, not on
// two frames from its first four seconds. The renderer fast-forwards a virtual
// clock to the arc horizon before the late frame, bounded by a wall budget.

type TestRenderer = HeadlessRenderer & {
  context: { newPage: () => Promise<Page> };
  initialize: () => Promise<void>;
  captureScreenshot: () => Promise<{ buffer: Buffer; width: number; height: number; success: boolean }>;
};

function makeRenderer(runForDelayMs = 0) {
  const events: string[] = [];
  const page = {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    addInitScript: vi.fn(async () => { events.push('guards'); }),
    setContent: vi.fn(async () => events.push('loaded')),
    waitForFunction: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async (ms: number) => events.push(`wait:${ms}`)),
    close: vi.fn().mockResolvedValue(undefined),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(true),
    clock: {
      install: vi.fn(async () => { events.push('clock'); }),
      runFor: vi.fn(async (ms: number) => {
        if (runForDelayMs) await new Promise(resolve => setTimeout(resolve, runForDelayMs));
        events.push(`run:${ms}`);
      }),
    },
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

describe('HeadlessRenderer arc capture (#1637)', () => {
  it('installs the clock before the guards and fast-forwards to the horizon before the late frame', async () => {
    const { renderer, events } = makeRenderer();
    const result = await renderer.render('function setup(){} function draw(){}', {
      domain: 'p5', stabilizationTime: 750, lateCaptureDelay: 3000, arcHorizonMs: 60_000 });
    expect(events.indexOf('clock')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('clock')).toBeLessThan(events.indexOf('guards'));
    const firstCapture = events.indexOf('captured');
    const lastCapture = events.lastIndexOf('captured');
    const runs = events.filter(event => event.startsWith('run:'));
    // The first 750 ms ran in real time before the early frame.
    expect(runs.reduce((sum, event) => sum + Number(event.slice(4)), 0)).toBe(60_000 - 750);
    expect(events.findIndex(event => event.startsWith('run:'))).toBeGreaterThan(firstCapture);
    expect(lastCapture).toBeGreaterThan(events.lastIndexOf(runs.at(-1)!));
    expect(events).not.toContain('wait:3000');
    expect(result.arc).toMatchObject({ horizonMs: 60_000, reachedMs: 60_000 });
  });

  it('stops at the wall budget and reports how far the piece got', async () => {
    const { renderer } = makeRenderer(20);
    const result = await renderer.render('function setup(){} function draw(){}', {
      domain: 'p5', arcHorizonMs: 60_000, arcWallBudgetMs: 1 });
    expect(result.arc!.reachedMs).toBeGreaterThan(0);
    expect(result.arc!.reachedMs).toBeLessThan(60_000);
    expect(result.lateScreenshot?.success).toBe(true);
  });

  it('stops inside the render duration cap even when the arc budget is larger', async () => {
    const { renderer } = makeRenderer(20);
    const result = await renderer.render('function setup(){} function draw(){}', {
      domain: 'p5', arcHorizonMs: 60_000, arcWallBudgetMs: 60_000, maximumDurationMs: 10_100 });
    expect(result.arc!.reachedMs).toBeLessThan(60_000);
    expect(result.arc!.wallMs).toBeLessThan(1_000);
  });

  it.each(['tone', 'strudel', 'svg', 'ascii', 'textgen'] as const)(
    'leaves %s on the real clock', async domain => {
      const { renderer, page } = makeRenderer();
      const result = await renderer.render('x', { domain, arcHorizonMs: 60_000 });
      expect(page.clock.install).not.toHaveBeenCalled();
      expect(result.arc).toBeUndefined();
    });

  it('keeps the old real-time late frame when no horizon is set', async () => {
    const { renderer, page, events } = makeRenderer();
    await renderer.render('function setup(){} function draw(){}', { domain: 'p5', lateCaptureDelay: 3000 });
    expect(page.clock.install).not.toHaveBeenCalled();
    expect(events).toContain('wait:3000');
  });
});
