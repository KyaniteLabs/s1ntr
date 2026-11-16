import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveChromiumExecutablePath } from '../utils/browserAssetFallbacks.js';
import { launchPlaywrightChromium, sandboxOptOutArgs } from '../security/SandboxConfig.js';
import { isVendorAssetPath, readVendorAsset } from '../utils/vendorAssets.js';

/** Capture an existing artifact with an owned browser and bounded render stages. */
export async function capturePlayableScreenshot(playable: string, screenshot: string): Promise<void> {
  const { chromium } = await import('playwright');
  const executablePath = resolveChromiumExecutablePath();
  if (!executablePath) throw new Error('SCORE_CAPTURE_FAILED: browser unavailable');
  let stage = 'launch';
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await launchPlaywrightChromium(chromium, {
      executablePath, headless: true, timeout: 20_000,
      args: [...sandboxOptOutArgs(), '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    stage = 'navigation';
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    let pageErrors = 0;
    page.on('pageerror', () => { pageErrors++; });
    // file:// artifacts resolve root-absolute /vendor/ scripts at file:///vendor/.
    // Serve only pinned library paths from this checkout, as the HTTP preview does.
    await page.route('file:///vendor/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (!isVendorAssetPath(pathname)) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8',
        body: await readVendorAsset(pathname) });
    });
    await page.goto(pathToFileURL(path.resolve(playable)).href, { waitUntil: 'load', timeout: 15_000 });
    await page.waitForTimeout(3_000);
    stage = 'screenshot';
    // Animation-heavy pages can need ~50s under the Air's bounded 50% CPU share.
    await page.screenshot({ path: screenshot, timeout: 60_000 });
    // eslint-disable-next-line no-console -- stderr is the capture subprocess error channel
    if (pageErrors) console.error(`SCORE_CAPTURE_PAGE_ERRORS: ${pageErrors}`);
  } catch {
    // Browser errors can contain artifact URLs, paths, or page-provided text.
    throw new Error(`SCORE_CAPTURE_FAILED: ${stage}`);
  } finally {
    await browser?.close();
  }
}
