/**
 * Renderer - Screenshot capture for p5.js sketches
 *
 * Provides functionality to render p5.js sketches using a headless browser
 * and capture screenshots of the canvas output. Uses a shared browser
 * instance (browser pool) to avoid launching a new Chromium process per render.
 */

import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { Logger } from '../utils/Logger.js';
import { HTMLWrapper } from '../utils/htmlWrapper.js';
import { validateString } from '../utils/validation.js';
import { getLocalP5ScriptForUrl, resolveChromiumExecutablePath } from '../utils/browserAssetFallbacks.js';
import { inlineVendorAssets } from '../utils/vendorAssets.js';
import { missingChromiumError } from '../utils/browserPreflight.js';
import { getChromeArgs } from '../security/SandboxConfig.js';
import { isAllowedRenderRequestUrl } from './HeadlessRenderer.js';
import { prepareBrowserScratch } from '../utils/scratchSpace.js';

export class Renderer {
  private readonly RENDER_TIMEOUT = 30000;
  private readonly DEFAULT_WIDTH = 800;
  private readonly DEFAULT_HEIGHT = 600;

  /** Shared browser instance — launched once, reused across render() calls. */
  private static browser: Browser | null = null;
  private static browserLaunching: Promise<Browser> | null = null;

  /**
   * Get or create the shared browser instance.
   */
  private static async getBrowser(): Promise<Browser> {
    if (Renderer.browser) return Renderer.browser;
    if (Renderer.browserLaunching) return Renderer.browserLaunching;
    // Respect SandboxConfig: launch sandboxed by default; only pass
    // --no-sandbox when LIMINAL_DISABLE_SANDBOX=true (containerized/CI).
    const disableSandbox = process.env.LIMINAL_DISABLE_SANDBOX === 'true';
    const executablePath = resolveChromiumExecutablePath();
    if (!executablePath) throw missingChromiumError();
    prepareBrowserScratch();   // profile dir off the data volume + free-space check
    const launching = puppeteer.launch({
      headless: true,
      executablePath,
      args: getChromeArgs({ forceDisableSandbox: disableSandbox }),
    });
    Renderer.browserLaunching = launching;
    let browser: Browser;
    try {
      browser = await launching;
    } catch (err) {
      if (Renderer.browserLaunching === launching) Renderer.browserLaunching = null;
      throw err;
    }
    // closeBrowser() ran while this launch was pending; it owns closing it.
    if (Renderer.browserLaunching !== launching) {
      throw new Error('RENDERER_BROWSER_CLOSED_DURING_LAUNCH');
    }
    Renderer.browser = browser;
    Renderer.browserLaunching = null;
    return browser;
  }

  /**
   * Close the shared browser instance. Call when done rendering.
   * State is detached before awaiting, so a concurrent getBrowser() launches
   * a fresh browser instead of receiving the one being closed.
   */
  static async closeBrowser(): Promise<void> {
    const open = Renderer.browser;
    const launching = Renderer.browserLaunching;
    Renderer.browser = null;
    Renderer.browserLaunching = null;
    const target = open ?? (launching ? await launching.catch(() => null) : null);
    await target?.close().catch((err: unknown) => {
      Logger.warn('Renderer', `Failed to close browser: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Render a p5.js sketch and capture screenshot
   * @param code - p5.js sketch code
   * @param outputPath - Path where screenshot will be saved
   * @throws Error if rendering fails or output path is invalid
   */
  async render(code: string, outputPath: string): Promise<void> {
    validateString(code, 'Sketch code');
    validateString(outputPath, 'Output path');

    const outputDir = path.dirname(outputPath);
    try {
      await fs.access(outputDir);
    } catch {
      throw new Error(`Output directory does not exist: ${outputDir}`);
    }

    const ext = path.extname(outputPath).toLowerCase();
    if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
      throw new Error(`Unsupported file format: ${ext}. Only .png, .jpg, .jpeg are supported.`);
    }

    let page: Page | null = null;
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    try {
      const browser = await Renderer.getBrowser();
      page = await browser.newPage();
      await this.installLocalAssetFallbacks(page);

      page.on('pageerror', (error) => {
        pageErrors.push(error instanceof Error ? error.message : String(error));
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });

      await page.setViewport({
        width: this.DEFAULT_WIDTH,
        height: this.DEFAULT_HEIGHT,
      });

      // setContent runs at about:blank where /vendor/ URLs never resolve —
      // inline the vendored scripts first (issue #924). Missing vendor file
      // throws here: loud failure, no CDN fallback.
      const html = await inlineVendorAssets(this.generateHTML(code));

      await page.setContent(html, {
        waitUntil: 'load',
        timeout: this.RENDER_TIMEOUT,
      });

      await this.waitForP5Initialization(page);
      await this.delay(1000);

      const canvas = await page.$('canvas');
      if (!canvas) {
        throw new Error(`No canvas element found. The sketch may have failed to initialize.${this.formatDiagnostics(pageErrors, consoleErrors)}`);
      }
      const image = await canvas.screenshot({ type: ext === '.png' ? 'png' : 'jpeg' });
      // A sketch that threw up to the capture left a partial or blank canvas;
      // saving it would pass a crash off as artwork.
      if (pageErrors.length > 0) {
        throw new Error(`The sketch threw while rendering.${this.formatDiagnostics(pageErrors, consoleErrors)}`);
      }

      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(outputPath, image);
    } catch (error) {
      if (error instanceof Error) {
        const message = error.message.includes('Diagnostics:')
          ? error.message
          : `${error.message}${this.formatDiagnostics(pageErrors, consoleErrors)}`;
        throw new Error(`Failed to render sketch: ${message}`, { cause: error });
      }
      throw new Error('Failed to render sketch: Unknown error');
    } finally {
      if (page) {
        await page.close().catch((err) => {
          Logger.warn('Renderer', `Failed to close page: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  }

  private generateHTML(code: string): string {
    return HTMLWrapper.wrap(code);
  }

  private async installLocalAssetFallbacks(page: Page): Promise<void> {
    if (typeof page.setRequestInterception !== 'function') return;

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      void (async () => {
        const localScript = await getLocalP5ScriptForUrl(url);
        if (localScript) {
          await request.respond({
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
            body: localScript,
          });
          return;
        }

        // Deny-by-default: generated sketch code must not reach arbitrary
        // hosts. Only the explicit CDN allowlist (and inert/loopback schemes)
        // may continue; everything else is aborted and logged.
        if (!isAllowedRenderRequestUrl(url)) {
          Logger.warn('Renderer', `Blocked off-allowlist request: ${url}`);
          await request.abort('blockedbyclient');
          return;
        }

        await request.continue();
      })().catch((err) => {
        Logger.debug('Renderer', 'Asset fallback request handling failed:', err);
        void request.abort('failed').catch((abortErr) => {
          Logger.debug('Renderer', 'Request abort failed:', abortErr);
        });
      });
    });
  }

  private async waitForP5Initialization(page: Page): Promise<void> {
    try {
      await page.waitForSelector('canvas', { timeout: 10000 });
    } catch {
      await this.delay(500);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatDiagnostics(pageErrors: string[], consoleErrors: string[]): string {
    const parts: string[] = [];
    if (pageErrors.length > 0) {
      parts.push(`page errors: ${pageErrors.join(' | ')}`);
    }
    if (consoleErrors.length > 0) {
      parts.push(`console errors: ${consoleErrors.join(' | ')}`);
    }
    return parts.length > 0 ? ` Diagnostics: ${parts.join(' ; ')}` : '';
  }
}
