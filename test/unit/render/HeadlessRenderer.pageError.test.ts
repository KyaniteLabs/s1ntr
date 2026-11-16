import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessRenderer, type RenderResult } from '../../../src/render/HeadlessRenderer.js';

const frame = { buffer: Buffer.from([1]), width: 800, height: 600, success: true };

async function evidenceFor(result: RenderResult) {
  const renderer = new HeadlessRenderer();
  vi.spyOn(renderer, 'render').mockResolvedValue(result);
  return renderer.renderWithEvidence('function setup() {}', { domain: 'p5' });
}

// A piece that throws still yields a frame: p5 makes its canvas before setup runs (#1690).
describe('HeadlessRenderer.renderWithEvidence with a piece that threw', () => {
  it('blames the candidate, keeps the frame and names what it threw', async () => {
    const evidence = await evidenceFor({
      success: false, error: 'The page threw: browser is not defined', screenshot: frame,
      logs: [], errors: ['browser is not defined'], pageErrors: ['browser is not defined'],
    });
    expect(evidence).toMatchObject({
      candidateFailure: true, infraUnavailable: false,
      failure: 'The page threw: browser is not defined', errors: ['browser is not defined'],
    });
    expect(evidence.screenshot).toEqual({ mimeType: 'image/png', dataBase64: 'AQ==', width: 800, height: 600 });
  });

  it('blames the candidate when it threw before any frame', async () => {
    const evidence = await evidenceFor({
      success: false, error: 'Canvas not found or timed out for p5 render. The page threw: chromium is not defined',
      logs: [], errors: ['chromium is not defined'], pageErrors: ['chromium is not defined'],
    });
    expect(evidence).toMatchObject({ candidateFailure: true, infraUnavailable: false });
  });

  it('blames the infrastructure when the browser died after the piece threw', async () => {
    const evidence = await evidenceFor({
      success: false,
      error: 'page.waitForTimeout: Target page, context or browser has been closed. The page threw: x is not defined',
      logs: [], errors: ['x is not defined'], pageErrors: ['x is not defined'],
    });
    expect(evidence).toMatchObject({ candidateFailure: false, infraUnavailable: true });
  });

  it('still blames the infrastructure when the browser never ran', async () => {
    const evidence = await evidenceFor({
      success: false, error: 'Failed to initialize headless browser: chromium missing',
      logs: [], errors: [], pageErrors: [],
    });
    expect(evidence).toMatchObject({ candidateFailure: false, infraUnavailable: true });
    expect(evidence.failure).toBeUndefined();
  });

  it('passes a render whose only errors went to the console', async () => {
    const evidence = await evidenceFor({
      success: true, screenshot: frame, logs: [], errors: ['Failed to load resource'], pageErrors: [],
    });
    expect(evidence).toMatchObject({ candidateFailure: false, infraUnavailable: false });
    expect(evidence.failure).toBeUndefined();
  });
});

// render() itself, with a page that captures a frame and fires the events given.
async function renderWith(events: Array<['pageerror', Error] | ['console', { type: () => string; text: () => string }]>) {
  const handlers: Record<string, (value: unknown) => void> = {};
  const page = {
    setViewportSize: vi.fn(), on: vi.fn((event: string, handler: (value: unknown) => void) => { handlers[event] = handler; }),
    setContent: vi.fn(async () => { for (const [event, value] of events) handlers[event]?.(value); }),
    waitForFunction: vi.fn(), waitForTimeout: vi.fn(), close: vi.fn(),
    exposeFunction: vi.fn(), evaluate: vi.fn().mockResolvedValue(true),
  } as unknown as Page;
  const renderer = new HeadlessRenderer() as unknown as HeadlessRenderer & {
    context: { newPage: () => Promise<Page> }; initialize: () => Promise<void>; captureScreenshot: () => Promise<typeof frame> };
  renderer.context = { newPage: vi.fn().mockResolvedValue(page) };
  renderer.initialize = vi.fn().mockResolvedValue(undefined);
  renderer.captureScreenshot = vi.fn().mockResolvedValue(frame);
  return renderer.render('function setup(){createCanvas(100, 100)}', { domain: 'p5' });
}

describe('HeadlessRenderer.render with a captured frame', () => {
  it('fails when the page threw and names the first error', async () => {
    const result = await renderWith([['pageerror', new Error('undefinedHelper is not defined')], ['pageerror', new Error('later')]]);
    expect(result).toMatchObject({
      success: false, error: 'The page threw: undefinedHelper is not defined',
      pageErrors: ['undefinedHelper is not defined', 'later'], screenshot: frame,
    });
  });

  it('succeeds when the only errors went to the console', async () => {
    const result = await renderWith([['console', { type: () => 'error', text: () => 'Failed to load resource' }]]);
    expect(result).toMatchObject({ success: true, pageErrors: [], errors: ['Failed to load resource'] });
    expect(result.error).toBeUndefined();
  });
});

// The sandbox's CSP blocks web fonts; the piece still draws with a fallback face.
describe('HeadlessRenderer.render with a CSP block', () => {
  const csp = (what: string, url: string) => ({ type: () => 'error', text: () =>
    `Loading the ${what} '${url}' violates the following Content Security Policy directive: "default-src 'none'". The action has been blocked.` });

  it('keeps a blocked stylesheet or font as a warning, not a runtime error', async () => {
    const result = await renderWith([
      ['console', csp('stylesheet', 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono')],
      ['console', csp('font', 'https://fonts.gstatic.com/s/plex.woff2')],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.logs.filter((log) => log.startsWith('[warn] blocked by sandbox CSP'))).toHaveLength(2);
  });

  it('still counts a blocked script as a runtime error', async () => {
    const result = await renderWith([['console', csp('script', 'https://cdn.example/lib.js')]]);
    expect(result.errors).toHaveLength(1);
  });
});
