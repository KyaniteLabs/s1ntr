import { renderHtmlScreenshot } from '../../src/tui-bridge/PreviewService.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PageHandler = (error: Error) => void;

const pageErrorHandlers: PageHandler[] = [];
const closePage = vi.fn(async () => undefined);
const closeBrowser = vi.fn(async () => undefined);
const screenshotPage = vi.fn(async () => undefined);
const launchChromium = vi.fn();

// When true, the mocked page fires a `pageerror` during goto, simulating a
// broken sketch (e.g. a p5 runtime failure).
let emitPageErrorOnGoto = true;

const newPage = vi.fn(async () => ({
  on: vi.fn((event: string, handler: PageHandler) => {
    if (event === 'pageerror') pageErrorHandlers.push(handler);
  }),
  route: vi.fn(async () => undefined),
  setViewportSize: vi.fn(async () => undefined),
  goto: vi.fn(async () => {
    if (emitPageErrorOnGoto) {
      pageErrorHandlers.forEach((handler) => handler(new Error('p5 runtime failed')));
    }
  }),
  waitForSelector: vi.fn(async () => ({})),
  screenshot: screenshotPage,
  close: closePage,
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => launchChromium(...args),
  },
}));

describe('PreviewService preview runtime verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageErrorHandlers.length = 0;
    emitPageErrorOnGoto = true;
    launchChromium.mockImplementation(async () => ({
      newPage,
      close: closeBrowser,
    }));
  });

  it('rejects preview screenshots when the generated page throws a runtime error', async () => {
    await expect(renderHtmlScreenshot('/tmp/bad-p5.html', '/tmp/bad-p5.png', 'p5'))
      .rejects.toThrow('p5 runtime failed');
    expect(closePage).toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
  });

  it('renders and closes page and browser on the success path', async () => {
    emitPageErrorOnGoto = false;

    await renderHtmlScreenshot('/tmp/good-p5.html', '/tmp/good-p5.png', 'p5');

    expect(screenshotPage).toHaveBeenCalledWith({ path: '/tmp/good-p5.png', type: 'png' });
    expect(closePage).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('fails with an actionable install message when the browser binary is unavailable', async () => {
    launchChromium.mockRejectedValueOnce(
      new Error("browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome"),
    );

    await expect(renderHtmlScreenshot('/tmp/no-browser.html', '/tmp/no-browser.png', 'p5'))
      .rejects.toThrow('pnpm exec playwright install chromium');
    // Browser was never created, so there is nothing to clean up.
    expect(closePage).not.toHaveBeenCalled();
    expect(closeBrowser).not.toHaveBeenCalled();
  });
});
