import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockLaunch } = vi.hoisted(() => ({ mockLaunch: vi.fn() }));
vi.mock('puppeteer', () => ({ default: { launch: (...args: unknown[]) => mockLaunch(...args) } }));
vi.mock('../../../src/security/SandboxConfig.js', () => ({ getChromeArgs: () => [] }));
const mockResolve = vi.hoisted(() => vi.fn(() => '/opt/chromium' as string | null));
vi.mock('../../../src/utils/browserAssetFallbacks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/browserAssetFallbacks.js')>()),
  resolveChromiumExecutablePath: mockResolve,
}));

import { RuntimeHealthMonitor } from '../../../src/guardrails/RuntimeHealthMonitor.js';

// A page loaded with setContent: scripts given to evaluateOnNewDocument never
// run in it, as in Chrome. Script text runs in the page's own context and
// function evaluates see the same window, so the monitor reads what the page
// actually recorded.
const timers: Array<ReturnType<typeof setTimeout>> = [];
let running = true;
type PageEvent = ['pageerror', Error] | ['console', { type: () => string }];

function setContentPage(globals: Record<string, unknown> = {}, events: PageEvent[] = []) {
  const win = createContext({
    ...globals,
    performance,
    Object,
    requestAnimationFrame: (cb: (t: number) => void) => {
      if (running) timers.push(setTimeout(() => cb(performance.now()), 16));
    },
    setInterval: (cb: () => void, ms: number) => {
      const id = setInterval(cb, ms);
      timers.push(id);
      return id;
    },
  });
  runInContext('globalThis.window = globalThis', win);
  vi.stubGlobal('window', win);
  const handlers: Record<string, (value: unknown) => void> = {};
  return {
    on: vi.fn((event: string, handler: (value: unknown) => void) => { handlers[event] = handler; }),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    setContent: vi.fn(async () => { for (const [event, value] of events) handlers[event]?.(value); }),
    // No <canvas>: a sketch that throws before createCanvas never makes one.
    waitForSelector: vi.fn().mockRejectedValue(new Error('Waiting for selector `canvas` failed')),
    metrics: vi.fn().mockResolvedValue({ JSHeapUsedSize: 8 * 1024 * 1024 }),
    evaluate: vi.fn(async (script: string | (() => unknown)) =>
      typeof script === 'string' ? runInContext(script, win) : script()),
  };
}

afterEach(() => {
  mockResolve.mockReturnValue('/opt/chromium');
  running = false;
  for (const id of timers.splice(0)) clearTimeout(id);
  vi.unstubAllGlobals();
  running = true;
});

describe('RuntimeHealthMonitor', () => {
  it('launches the Chromium the renderer resolves', async () => {
    mockLaunch.mockResolvedValue({ newPage: async () => setContentPage(), close: vi.fn() });
    await new RuntimeHealthMonitor({ durationMs: 100, sampleIntervalMs: 100 }).monitor('function draw() {}', 'p5');
    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/opt/chromium' }));
  });

  it('throws the missing-browser error and never launches when nothing resolves', async () => {
    mockResolve.mockReturnValue(null);
    mockLaunch.mockClear();
    await expect(new RuntimeHealthMonitor().monitor('function draw() {}', 'p5')).rejects.toThrow(/Chromium executable not found/);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('measures the frame rate of a page loaded with setContent', async () => {
    mockLaunch.mockResolvedValue({ newPage: async () => setContentPage(), close: vi.fn() });

    const monitor = new RuntimeHealthMonitor({ durationMs: 300, sampleIntervalMs: 100 });
    const result = await monitor.monitor('function draw() {}', 'p5');

    expect(result.issues).toEqual([]);
    expect(result.healthy).toBe(true);
    expect(result.metrics.avgFPS).toBeGreaterThan(10);
  });

  it('loads p5 inline', async () => {
    let page: ReturnType<typeof setContentPage> | undefined;
    mockLaunch.mockResolvedValue({ newPage: async () => (page = setContentPage()), close: vi.fn() });
    await new RuntimeHealthMonitor({ durationMs: 300, sampleIntervalMs: 100 }).monitor('function draw() {}', 'p5');

    // A setContent page is about:blank: a /vendor URL would never load p5.
    expect(String(page!.setContent.mock.calls[0][0])).not.toMatch(/src="\/vendor\//);
  });

  it('counts console errors without failing the piece', async () => {
    mockLaunch.mockResolvedValue({
      newPage: async () => setContentPage({}, [['console', { type: () => 'error' }], ['console', { type: () => 'log' }]]),
      close: vi.fn(),
    });
    const result = await new RuntimeHealthMonitor({ durationMs: 300, sampleIntervalMs: 100 })
      .monitor('function draw() {}', 'p5');

    expect(result).toMatchObject({ healthy: true, issues: [], checks: { noPageErrors: true } });
    expect(result.metrics).toMatchObject({ consoleErrorCount: 1, pageErrorCount: 0 });
  });

  it('fails a piece that threw', async () => {
    mockLaunch.mockResolvedValue({
      newPage: async () => setContentPage({}, [['pageerror', new Error('x is not defined')]]),
      close: vi.fn(),
    });
    const result = await new RuntimeHealthMonitor({ durationMs: 300, sampleIntervalMs: 100 })
      .monitor('function draw() { x() }', 'p5');

    expect(result).toMatchObject({
      healthy: false,
      checks: { noPageErrors: false, frameRateStable: true, memoryLeak: true },
      metrics: { pageErrorCount: 1, consoleErrorCount: 0 },
      issues: ['The page threw 1 uncaught error(s)'],
    });
  });

  it('starts measuring at load without waiting for a canvas', async () => {
    let page: ReturnType<typeof setContentPage> | undefined;
    mockLaunch.mockResolvedValue({ newPage: async () => (page = setContentPage()), close: vi.fn() });
    await new RuntimeHealthMonitor({ durationMs: 300, sampleIntervalMs: 100 }).monitor('function draw() {}', 'p5');

    // The libraries are inlined: a network-idle wait stalls behind a slow
    // draw loop, and a canvas wait hides a throw before createCanvas.
    expect(page!.setContent).toHaveBeenCalledWith(expect.any(String), { waitUntil: 'load' });
    expect(page!.waitForSelector).not.toHaveBeenCalled();
  });

  it('marks page errors unmeasured when the browser fails', async () => {
    mockLaunch.mockResolvedValue({
      newPage: async () => ({ ...setContentPage(), setContent: vi.fn().mockRejectedValue(new Error('Target closed')) }),
      close: vi.fn(),
    });
    const result = await new RuntimeHealthMonitor({ durationMs: 300, sampleIntervalMs: 100 })
      .monitor('function draw() {}', 'p5');

    expect(result.healthy).toBe(false);
    expect(result.checks).toEqual({ memoryLeak: false, frameRateStable: false, noPageErrors: false });
  });

  it('refuses code that is not a p5 sketch', async () => {
    mockLaunch.mockClear();
    await expect(new RuntimeHealthMonitor().monitor('<svg viewBox="0 0 10 10"></svg>', 'svg'))
      .rejects.toThrow('RuntimeHealthMonitor runs p5 sketches only, not svg');
    expect(mockLaunch).not.toHaveBeenCalled();
  });
});
