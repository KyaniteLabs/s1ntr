import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { formatError } from '../utils/errors.js';
import { VideoExporter } from '../export/VideoExporter.js';
import { HTMLWrapper } from '../utils/htmlWrapper.js';
import { Domain } from '../types/domains.js';
import { Logger } from '../utils/Logger.js';
import { ExportError } from '../errors/ExportError.js';
import { ValidationError } from '../errors/ValidationError.js';
import { getChromeArgs } from '../security/SandboxConfig.js';
import { resolveChromiumExecutablePath } from '../utils/browserAssetFallbacks.js';
import { missingChromiumError } from '../utils/browserPreflight.js';
import { isAllowedRenderRequestUrl, RENDER_ORIGIN } from './HeadlessRenderer.js';
import { hasVendorImportMap, inlineVendorAssets, isVendorAssetPath, readVendorAsset } from '../utils/vendorAssets.js';
import { prepareBrowserScratch } from '../utils/scratchSpace.js';

export interface RecordingOptions {
  fps: number;
  duration: number;  // seconds
  width: number;
  height: number;
  /** One budget for browser capture, encode, and verification. */
  timeoutMs?: number;
}

export interface RecordingConfig extends RecordingOptions {
  totalFrames: number;
}

export class CanvasRecorder {
  private readonly config: RecordingConfig;
  private readonly exporter: VideoExporter;

  constructor(options: RecordingOptions) {
    if (options.fps <= 0) throw new ValidationError('fps must be a positive number');
    if (options.duration <= 0) throw new ValidationError('duration must be a positive number');
    if (options.width <= 0) throw new ValidationError('width must be a positive number');
    if (options.height <= 0) throw new ValidationError('height must be a positive number');

    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)) {
      throw new ValidationError('timeoutMs must be a positive timer duration in milliseconds');
    }

    this.config = {
      fps: options.fps,
      duration: options.duration,
      width: options.width,
      height: options.height,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      totalFrames: Math.floor(options.fps * options.duration),
    };
    this.exporter = new VideoExporter();
  }

  getConfig(): RecordingConfig {
    return { ...this.config };
  }

  /**
   * Record a creative code sketch as video.
   * Uses Puppeteer to load the code in a headless browser, step through frames,
   * capture canvas screenshots, then stitch into MP4 via FFmpeg.
   */
  async record(code: string, domain: Domain, outputPath: string): Promise<string> {
    const deadlineAt = this.config.timeoutMs ? Date.now() + this.config.timeoutMs : undefined;
    const expired = () => new ExportError('Canvas recording exceeded the export deadline', { format: 'video' });
    const remaining = (): number => {
      if (deadlineAt === undefined) return Infinity;
      const left = deadlineAt - Date.now();
      if (left <= 0) throw expired();
      return left;
    };
    // Dynamic import to avoid loading Puppeteer at module level
    const puppeteer = await import('puppeteer');

    const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-frames-'));
    let stagingDir: string | undefined;

    try {
      // Respect SandboxConfig: launch sandboxed by default; only pass
      // --no-sandbox when LIMINAL_DISABLE_SANDBOX=true (containerized/CI).
      const disableSandbox = process.env.LIMINAL_DISABLE_SANDBOX === 'true';
      const executablePath = resolveChromiumExecutablePath();
      if (!executablePath) throw missingChromiumError();
      prepareBrowserScratch();   // profile dir off the data volume + free-space check
      const browser = await puppeteer.default.launch({
        headless: true,
        executablePath,
        args: getChromeArgs({ forceDisableSandbox: disableSandbox }),
        ...(deadlineAt === undefined ? {} : { timeout: remaining() }),
      });
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const drive = async (): Promise<void> => {
        const page = await browser.newPage();
        await page.setViewport({ width: this.config.width, height: this.config.height });

        // Deny-by-default network egress: generated code may only fetch from
        // the CDN allowlist; arbitrary callouts are aborted and logged.
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const url = request.url();
          if (url.startsWith(`${RENDER_ORIGIN}/`)) {
            // The private origin serves a blank page and pinned /vendor/
            // files only, as the renderer's does.
            void CanvasRecorder.servePrivateOrigin(request).catch((err) => {
              Logger.warn('CanvasRecorder', `Private origin request failed: ${url}`, err);
              void request.abort('failed').catch(() => undefined);
            });
            return;
          }
          if (isAllowedRenderRequestUrl(url)) {
            void request.continue().catch((err) => {
              Logger.debug('CanvasRecorder', 'Request continue failed:', err);
            });
            return;
          }
          Logger.warn('CanvasRecorder', `Blocked off-allowlist request: ${url}`);
          void request.abort('blockedbyclient').catch((err) => {
            Logger.debug('CanvasRecorder', 'Request abort failed:', err);
          });
        });

        const thrown: string[] = [];
        page.on('pageerror', (error) => {
          thrown.push(error instanceof Error ? error.message : String(error));
        });

        // A sketch that threw is broken, so its frames are not the artwork.
        // Any page error fails the export, as it fails the a11y check.
        const crashed = () => (thrown.length > 0
          ? new Error(`The sketch threw while recording: ${thrown[0]}`)
          : null);

        // setContent runs at about:blank, where /vendor/ URLs never resolve,
        // so vendored scripts go inline (#924). ES modules (Three) cannot be
        // inlined under the wrapper CSP, so those pages get the private
        // origin first, where 'self' covers the served /vendor/ modules.
        const wrapped = this.wrapForDomain(code, domain);
        const servedOrigin = hasVendorImportMap(wrapped);
        if (servedOrigin) {
          await page.goto(`${RENDER_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
        }
        const html = await inlineVendorAssets(wrapped, undefined, { keepImportMaps: servedOrigin });
        await page.setContent(html, { waitUntil: 'networkidle0' });

        try {
          await page.waitForSelector('canvas', { timeout: 10000 });
        } catch (error) {
          throw crashed() ?? error;
        }

        // Capture frames
        for (let frame = 0; frame < this.config.totalFrames; frame++) {
          const failure = crashed();
          if (failure) throw failure;
          // Advance animation by one frame
          const frameDelay = 1000 / this.config.fps;
          await page.evaluate((delay) => {
            return new Promise(resolve => setTimeout(resolve, delay));
          }, frameDelay);

          // Screenshot the canvas
          const canvas = await page.$('canvas');
          if (canvas) {
            const framePath = path.join(framesDir, `frame_${String(frame).padStart(5, '0')}.png`);
            await canvas.screenshot({ path: framePath, type: 'png' });
          }
        }

        const failure = crashed();
        if (failure) throw failure;
      };
      const captureAndClose = async (): Promise<void> => {
        try { await drive(); } finally { await browser.close(); }
      };
      if (deadlineAt === undefined) await captureAndClose();
      else {
        try {
          const pending = new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => {
              browser.process()?.kill('SIGKILL');
              reject(expired());
            }, remaining());
          });
          await Promise.race([captureAndClose(), pending]);
          remaining();
        } finally {
          clearTimeout(deadlineTimer);
          // If time ran out immediately after launch, no timer was installed.
          if (deadlineTimer === undefined) browser.process()?.kill('SIGKILL');
        }
      }

      const exporter = deadlineAt === undefined ? this.exporter : new VideoExporter({ deadlineAt });
      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });
      stagingDir = await fs.mkdtemp(path.join(outputDir, '.sinter-video-'));
      const stagedPath = path.join(stagingDir, path.basename(outputPath));
      await exporter.framesToVideo(framesDir, stagedPath, this.config.fps);
      await exporter.probe(stagedPath);
      remaining();
      await fs.rename(stagedPath, outputPath);
      return outputPath;
    } finally {
      for (const directory of [framesDir, stagingDir]) {
        if (!directory) continue;
        try {
          await fs.rm(directory, { recursive: true, force: true });
        } catch (error) {
          Logger.error('CanvasRecorder', 'Cleanup failed:', this.formatErrorMessage(error));
        }
      }
    }
  }

  private static async servePrivateOrigin(request: {
    url(): string;
    respond(response: { status: number; contentType: string; body: string }): Promise<void>;
    abort(reason: 'blockedbyclient'): Promise<void>;
  }): Promise<void> {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/') {
      await request.respond({ status: 200, contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head></head><body></body></html>' });
    } else if (isVendorAssetPath(pathname)) {
      await request.respond({ status: 200, contentType: 'application/javascript; charset=utf-8',
        body: await readVendorAsset(pathname) });
    } else {
      Logger.warn('CanvasRecorder', `Blocked private-origin request: ${request.url()}`);
      await request.abort('blockedbyclient');
    }
  }

  /**
   * Build the JavaScript to execute in the browser for capturing a single frame.
   */
  buildFrameCaptureScript(_domain: string): string {
    // All domains use the same canvas capture mechanism
    return `
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      return canvas.toDataURL('image/png');
    `;
  }

  private formatErrorMessage(error: unknown): string {
    return formatError('CanvasRecorder', error);
  }

  private wrapForDomain(code: string, domain: Domain): string {
    if (domain === Domain.P5) {
      return HTMLWrapper.wrap(code);
    }
    // Accept 'shader' domain; also handle any non-Domain string that looks like GLSL
    if (domain === Domain.SHADER) {
      return HTMLWrapper.wrap(code, { domain: Domain.SHADER });
    }
    if (domain === Domain.THREE) {
      // Three.js code may already be complete HTML
      if (code.trim().startsWith('<!DOCTYPE') || code.trim().startsWith('<html')) {
        return code;
      }
      return HTMLWrapper.wrap(code, { domain: Domain.THREE });
    }
    // Default: wrap as p5
    return HTMLWrapper.wrap(code);
  }
}
