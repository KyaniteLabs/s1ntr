import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

const RUNTIME_ERROR = 'Cannot connect to node with no inputs';

type TestRenderer = HeadlessRenderer & {
  context: { newPage: () => Promise<Page> };
  initialize: () => Promise<void>;
  captureScreenshot: () => Promise<{ buffer: Buffer; width: number; height: number; success: boolean }>;
};

const g = globalThis as Record<string, unknown>;

/**
 * A tone page that logs one console error and makes no sound: the shape of a
 * piece whose Tone graph failed to connect, so the capture stays empty.
 */
function tonePageThatMakesNoSound(consoleError?: string) {
  g.window = { __audioCaptureData: [], __audioCaptureWarnings: [] };
  const handlers: Record<string, (value: unknown) => void> = {};
  const page = {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (value: unknown) => void) => { handlers[event] = handler; }),
    setContent: vi.fn(async () => {
      if (consoleError) handlers.console?.({ type: () => 'error', text: () => consoleError });
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn(async () => { throw new Error('this page has no play control'); }),
    evaluate: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg)),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
  const renderer = new HeadlessRenderer() as TestRenderer;
  renderer.context = { newPage: vi.fn().mockResolvedValue(page) };
  renderer.initialize = vi.fn().mockResolvedValue(undefined);
  renderer.captureScreenshot = vi.fn().mockResolvedValue({
    buffer: Buffer.from([1]), width: 800, height: 600, success: true,
  });
  return renderer;
}

afterEach(() => { delete g.window; });

describe('a tone page that logged a runtime error and made no sound', () => {
  it('leads with the runtime error and keeps the empty-capture fact after it', async () => {
    const renderer = tonePageThatMakesNoSound(RUNTIME_ERROR);

    const result = await renderer.render('const synth = new Tone.Synth();', {
      domain: 'tone', waitForStabilization: false,
    });

    expect(result.audio?.success).toBe(false);
    expect(result.audio?.error).toMatch(/^Cannot connect to node with no inputs/);
    expect(result.audio?.error).toContain('No audio captured during render window');
    expect(result.audio?.error?.indexOf('Cannot connect')).toBeLessThan(
      result.audio?.error?.indexOf('No audio captured') ?? -1);
  });

  it('still reports the empty capture when the page logged no runtime error', async () => {
    const renderer = tonePageThatMakesNoSound();

    const result = await renderer.render('const synth = new Tone.Synth();', {
      domain: 'tone', waitForStabilization: false,
    });

    expect(result.audio?.success).toBe(false);
    expect(result.audio?.error).toBe('No audio captured during render window');
  });
});
