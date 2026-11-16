import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

// #1752: the duration cap compared wall time only, so on a loaded host a
// healthy piece failed as RENDER_DURATION_LIMIT_EXCEEDED and was scored as a
// broken render (37 runs on 11-16, every seat alike). The page's own
// main-thread busy time tells a slow piece from a busy machine.

type TestRenderer = HeadlessRenderer & {
  context: { newPage: () => Promise<Page> };
  initialize: () => Promise<void>;
  captureScreenshot: () => Promise<{ buffer: Buffer; width: number; height: number; success: boolean }>;
};

/** taskSeconds: the page's main-thread busy time; null = no CDP available. */
function makeRenderer(taskSeconds: number | null, loadPerCore = 0.2) {
  const cdp = {
    send: vi.fn(async (method: string) => method === 'Performance.getMetrics'
      ? { metrics: [{ name: 'TaskDuration', value: taskSeconds }] } : {}),
  };
  const page = {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    // The wall clock runs past the 10 ms cap while the page itself idles.
    setContent: vi.fn(() => new Promise(resolve => setTimeout(resolve, 40))),
    waitForFunction: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    close: vi.fn().mockResolvedValue(undefined),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(true),
    context: () => (taskSeconds === null ? {} : { newCDPSession: vi.fn().mockResolvedValue(cdp) }),
  } as unknown as Page;
  const renderer = new HeadlessRenderer() as TestRenderer;
  (renderer as unknown as { hostLoadPerCore: () => number }).hostLoadPerCore = () => loadPerCore;
  renderer.context = { newPage: vi.fn().mockResolvedValue(page) };
  renderer.initialize = vi.fn().mockResolvedValue(undefined);
  renderer.captureScreenshot = vi.fn(async () => ({ buffer: Buffer.from([1]), width: 100, height: 100, success: true }));
  return renderer;
}

const OPTS = { domain: 'svg' as const, maximumDurationMs: 10 };

describe('render duration cap vs host load (#1752)', () => {
  it('reports host contention, not a broken piece, when the page was mostly idle', async () => {
    const renderer = makeRenderer(0.001);
    const result = await renderer.render('<svg></svg>', OPTS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/RENDER_HOST_CONTENTION/);
    const evidence = await makeRenderer(0.001).renderWithEvidence('<svg></svg>', OPTS);
    expect(evidence.infraUnavailable).toBe(true);
    expect(evidence.candidateFailure).toBe(false);
  });

  it('still fails the piece when the page itself was busy past the cap', async () => {
    const evidence = await makeRenderer(5).renderWithEvidence('<svg></svg>', OPTS);
    expect(evidence.failure).toMatch(/RENDER_DURATION_LIMIT_EXCEEDED/);
    expect(evidence.candidateFailure).toBe(true);
  });

  // Measured on Chromium 1255: a starved host stretches an animating page's
  // TaskDuration from 35% to 60% of wall time, so busy time alone cannot
  // clear a busy piece. Host load is the direct signal.
  it('reports host contention for a busy piece when the host was overloaded', async () => {
    const evidence = await makeRenderer(5, 4).renderWithEvidence('<svg></svg>', OPTS);
    expect(evidence.failure ?? '').not.toMatch(/RENDER_DURATION_LIMIT_EXCEEDED/);
    expect(evidence.infraUnavailable).toBe(true);
  });

  it('keeps the wall-clock rule when busy time cannot be measured', async () => {
    const result = await makeRenderer(null).render('<svg></svg>', OPTS);
    expect(result.error).toMatch(/RENDER_DURATION_LIMIT_EXCEEDED/);
  });
});
