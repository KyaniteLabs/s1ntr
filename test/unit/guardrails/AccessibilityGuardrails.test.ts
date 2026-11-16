/**
 * Tests for AccessibilityGuardrails with a mocked browser: constructor
 * options, the domain guard, and the page each domain loads.
 */

import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

const { mockLaunch, mockClose, mockNewPage, mockStart, mockCapture, mockSetViewport, mockSetContent, mockWaitForSelector } = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockNewPage: vi.fn(),
  mockStart: vi.fn(),
  mockCapture: vi.fn().mockResolvedValue(null),
  mockSetViewport: vi.fn().mockResolvedValue(undefined),
  mockSetContent: vi.fn().mockResolvedValue(undefined),
  mockWaitForSelector: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('puppeteer', () => ({
  default: {
    launch: (...args: unknown[]) => mockLaunch(...args),
  },
}));

// The screencast needs a real browser (see FlashMeasure.test.ts); the verdict
// on what it captured is real.
vi.mock('../../../src/guardrails/FlashMeasure.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/guardrails/FlashMeasure.js')>()),
  startLuminanceCapture: async (page: unknown) => {
    mockStart(page);
    return { stop: () => mockCapture() };
  },
}));


const { mockResolveChromium } = vi.hoisted(() => ({ mockResolveChromium: vi.fn(() => '/managed/chromium' as string | undefined) }));
vi.mock('../../../src/utils/browserAssetFallbacks.js', () => ({
  resolveChromiumExecutablePath: () => mockResolveChromium(),
}));

vi.mock('../../../src/utils/errors.js', () => ({
  formatError: vi.fn().mockReturnValue('formatted error'),
}));

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { AccessibilityGuardrails } from '../../../src/guardrails/AccessibilityGuardrails.js';
import { WINDOW_COUNT } from '../../../src/guardrails/FlashMeasure.js';

// What the screencast capture returns: 60 Hz frames of per-region luminance
// (25 windows plus the whole viewport).
function captureOf(luminance: (t: number) => number, ms = 100) {
  const frames = [];
  for (let t = 0; t <= ms; t += 1000 / 60) frames.push({ t, regions: new Array(WINDOW_COUNT + 1).fill(luminance(t)) });
  return { frames, error: null };
}
const steadyCapture = () => captureOf(() => 0.2);
const strobeCapture = (hz: number) => captureOf((t) => (Math.floor((t / 1000) * hz * 2) % 2 === 0 ? 0 : 1), 1000);

describe('AccessibilityGuardrails', () => {
  describe('constructor', () => {
    it('uses default options when none provided', () => {
      const guard = new AccessibilityGuardrails();
      // Internal options aren't exposed, but we can verify it constructs
      expect(guard).toBeInstanceOf(AccessibilityGuardrails);
    });

    it('merges custom options with defaults', () => {
      const guard = new AccessibilityGuardrails({ checkDurationMs: 5000, disableSandbox: true });
      expect(guard).toBeInstanceOf(AccessibilityGuardrails);
    });
  });

  describe('check', () => {
    it('refuses a domain it would load as the wrong program', async () => {
      await expect(new AccessibilityGuardrails().check('<p>x</p>', 'tone')).rejects.toThrow('p5 sketches and html pages only');
    });

    it('runs an html page as written, with no p5 wrap, no canvas wait and no network', async () => {
      const handlers: Record<string, (request: { url(): string; continue(): Promise<void>; abort(): Promise<void> }) => void> = {};
      const setRequestInterception = vi.fn().mockResolvedValue(undefined);
      const evaluateOnNewDocument = vi.fn().mockResolvedValue(undefined);
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve({
          setContent: mockSetContent, waitForSelector: mockWaitForSelector, setViewport: mockSetViewport,
          setRequestInterception, evaluateOnNewDocument,
          on: (event: string, handler: never) => { handlers[event] = handler; },
        }),
        close: mockClose,
      });
      mockCapture.mockResolvedValueOnce(steadyCapture());
      mockSetContent.mockClear();
      mockWaitForSelector.mockClear();
      const page = '<!doctype html><title>plain</title><p>still</p>';
      const result = await new AccessibilityGuardrails({ checkDurationMs: 10 }).check(page, 'html');
      expect(mockClose).toHaveBeenCalledTimes(1);
      mockClose.mockClear();

      expect(mockSetContent).toHaveBeenCalledWith(page, { waitUntil: 'load' });
      expect(mockWaitForSelector).not.toHaveBeenCalled();
      expect(setRequestInterception).toHaveBeenCalledWith(true);
      const verdicts = ['data:text/plain,x', 'https://example.com/a.js'].map((url) => {
        const request = { url: () => url, continue: vi.fn().mockRejectedValue(new Error('page closed')),
          abort: vi.fn().mockRejectedValue(new Error('page closed')) };
        handlers.request!(request);
        return [request.continue.mock.calls.length, request.abort.mock.calls.length];
      });
      expect(verdicts).toEqual([[1, 0], [0, 1]]);
      const sandbox = vm.createContext({ navigator: {}, WebSocket: class {}, EventSource: class {} });
      sandbox.window = sandbox;
      sandbox.window.open = () => ({});
      vm.runInContext(String(evaluateOnNewDocument.mock.calls[0][0]), sandbox);
      expect(() => vm.runInContext('new WebSocket("wss://example.com")', sandbox)).toThrow('LIMINAL_NETWORK_DENIED');
      expect(() => vm.runInContext('new EventSource("https://example.com")', sandbox)).toThrow('LIMINAL_NETWORK_DENIED');
      expect(vm.runInContext('window.open("https://example.com")', sandbox)).toBeNull();
      expect(result.photosensitivity.pass).toBe(true);
      expect(result.photosensitivity.measurement?.frames).toBeGreaterThan(0);
    });

    it('launches the Chromium the renderer resolves, not whatever puppeteer caches', async () => {
      mockLaunch.mockRejectedValue(new Error('stop after launch'));
      await expect(new AccessibilityGuardrails().check('code', 'p5')).rejects.toThrow('stop after launch');
      expect(mockLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ executablePath: '/managed/chromium' }));
    });

    it('fails without launching when no Chromium resolves', async () => {
      mockLaunch.mockClear();
      mockResolveChromium.mockReturnValueOnce(undefined);
      await expect(new AccessibilityGuardrails().check('code', 'p5')).rejects.toThrow();
      expect(mockLaunch).not.toHaveBeenCalled();
    });

    it('rejects when browser launch fails', async () => {
      mockLaunch.mockRejectedValue(new Error('no browser'));
      const guard = new AccessibilityGuardrails({ disableSandbox: true });

      await expect(guard.check('code', 'p5')).rejects.toThrow('no browser');
    });

    it('runs full check with passing metrics', async () => {
      const mockPage = {
        setContent: mockSetContent,
        waitForSelector: mockWaitForSelector,
        setViewport: mockSetViewport,
      };
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve(mockPage),
        close: mockClose,
      });
      mockCapture.mockResolvedValue(steadyCapture());

      const guard = new AccessibilityGuardrails({ checkDurationMs: 100, disableSandbox: true });
      const result = await guard.check('function setup() {}', 'p5');

      expect(result.accessible).toBe(true);
      expect(result.checks.photosensitivity).toBe(true);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('flags photosensitivity when flash rate exceeds 3Hz', async () => {
      const mockPage = {
        setContent: mockSetContent,
        waitForSelector: mockWaitForSelector,
        setViewport: mockSetViewport,
      };
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve(mockPage),
        close: mockClose,
      });
      mockCapture.mockResolvedValue(strobeCapture(10));

      const guard = new AccessibilityGuardrails({ checkDurationMs: 100, disableSandbox: true });
      const result = await guard.check('flash code', 'p5');

      expect(result.checks.photosensitivity).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('Photosensitivity')])
      );
    });

    it('loads p5 inline and records from before the page loads, at the renderer size', async () => {
      mockCapture.mockResolvedValueOnce(steadyCapture());
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve({ setContent: mockSetContent, waitForSelector: mockWaitForSelector, setViewport: mockSetViewport }),
        close: mockClose,
      });
      mockSetContent.mockClear();
      mockCapture.mockClear();
      await new AccessibilityGuardrails({ checkDurationMs: 100 }).check('function setup() {}', 'p5');

      // A setContent page is about:blank: a /vendor URL would never load p5.
      const html = String(mockSetContent.mock.calls[0][0]);
      expect(html).not.toMatch(/src="\/vendor\//);
      expect(html).toContain('p5.js v');
      expect(mockSetViewport).toHaveBeenCalledWith({ width: 800, height: 600 });
      // WebGL in software, as the Playwright renderer draws it; --disable-gpu alone leaves WebGL sketches blank.
      expect(mockLaunch.mock.calls.at(-1)![0].args).toContain('--enable-unsafe-swiftshader');
      // Recording starts before the page loads, so the first frames count.
      expect(mockStart.mock.invocationCallOrder.at(-1)).toBeLessThan(mockSetContent.mock.invocationCallOrder.at(-1)!);
      expect(mockCapture).toHaveBeenCalledTimes(1);
    });

    it('fails photosensitivity when no frame was measured', async () => {
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve({ setContent: mockSetContent, waitForSelector: mockWaitForSelector, setViewport: mockSetViewport }),
        close: mockClose,
      });
      mockCapture.mockResolvedValue(null);

      const guard = new AccessibilityGuardrails({ checkDurationMs: 100, disableSandbox: true });
      const result = await guard.check('function setup() {}', 'p5');

      expect(result.checks.photosensitivity).toBe(false);
      expect(result.accessible).toBe(false);
      expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('not measured')]));
    });

    it('warns on code with red/green color blindness issues', async () => {
      const mockPage = {
        setContent: mockSetContent,
        waitForSelector: mockWaitForSelector,
        setViewport: mockSetViewport,
      };
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve(mockPage),
        close: mockClose,
      });
      mockCapture.mockResolvedValue(steadyCapture());

      const guard = new AccessibilityGuardrails({ checkDurationMs: 100, disableSandbox: true });
      // Code using red and green without shapes
      const result = await guard.check('fill("red"); fill("green");', 'p5');

      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('color blindness')])
      );
    });

    it('passes color blindness check with shapes', async () => {
      const mockPage = {
        setContent: mockSetContent,
        waitForSelector: mockWaitForSelector,
        setViewport: mockSetViewport,
      };
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve(mockPage),
        close: mockClose,
      });
      mockCapture.mockResolvedValue(steadyCapture());

      const guard = new AccessibilityGuardrails({ checkDurationMs: 100, disableSandbox: true });
      const result = await guard.check('fill("red"); stroke("green"); line(0,0,100,100);', 'p5');

      expect(result.checks.colorBlindnessSafe).toBe(true);
    });

    it('warns on rapid motion without prefers-reduced-motion', async () => {
      const mockPage = {
        setContent: mockSetContent,
        waitForSelector: mockWaitForSelector,
        setViewport: mockSetViewport,
      };
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve(mockPage),
        close: mockClose,
      });
      mockCapture.mockResolvedValue(steadyCapture());

      const guard = new AccessibilityGuardrails({ checkDurationMs: 100, disableSandbox: true });
      const result = await guard.check('speed = 8; function draw() {}', 'p5');

      expect(result.checks.motionSafe).toBe(false);
    });

    it('warns on audio without volume control', async () => {
      const mockPage = {
        setContent: mockSetContent,
        waitForSelector: mockWaitForSelector,
        setViewport: mockSetViewport,
      };
      mockLaunch.mockResolvedValue({
        newPage: () => Promise.resolve(mockPage),
        close: mockClose,
      });
      mockCapture.mockResolvedValue(steadyCapture());

      const guard = new AccessibilityGuardrails({ checkDurationMs: 100, disableSandbox: true });
      const result = await guard.check('new Tone.Synth().toDestination();', 'p5');

      expect(result.checks.audioSafe).toBe(false);
    });
  });
});
