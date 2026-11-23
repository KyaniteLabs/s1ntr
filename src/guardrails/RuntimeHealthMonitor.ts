/**
 * M10: Runtime Health Monitor
 * 
 * Monitors code execution over time to detect:
 * - Memory leaks (growing heap usage)
 * - Frame rate degradation
 * - Uncaught page errors (console errors are counted, not failed: a
 *   blocked font or a 404 does not stop a piece)
 * 
 * Runs p5 sketches only. Requires Puppeteer to run code in headless browser.
 */

import puppeteer from 'puppeteer';
import { getChromeArgs } from '../security/SandboxConfig.js';
import { resolveChromiumExecutablePath } from '../utils/browserAssetFallbacks.js';
import { missingChromiumError } from '../utils/browserPreflight.js';
import { generateHTML } from '../utils/generateHTML.js';
import { formatError } from '../utils/errors.js';
import { pageScript } from '../utils/pageScript.js';
import { inlineVendorAssets } from '../utils/vendorAssets.js';
import { prepareBrowserScratch } from '../utils/scratchSpace.js';

export interface RuntimeHealthResult {
  healthy: boolean;
  duration: number;  // How long it ran (ms)
  checks: {
    memoryLeak: boolean;
    frameRateStable: boolean;
    noPageErrors: boolean;
  };
  metrics: {
    initialMemoryMB: number;
    finalMemoryMB: number;
    memoryGrowthMB: number;
    avgFPS: number;
    minFPS: number;
    pageErrorCount: number;
    consoleErrorCount: number;
  };
  issues: string[];
}

export interface RuntimeHealthOptions {
  durationMs?: number;      // How long to monitor (default: 5000ms)
  sampleIntervalMs?: number; // How often to sample (default: 500ms)
  memoryLeakThresholdMB?: number;  // Memory growth threshold (default: 50MB)
  minAcceptableFPS?: number;  // Minimum acceptable FPS (default: 10)
  disableSandbox?: boolean;
}

const DEFAULT_OPTIONS: Required<RuntimeHealthOptions> = {
  durationMs: 5000,
  sampleIntervalMs: 500,
  memoryLeakThresholdMB: 50,
  minAcceptableFPS: 10,
  disableSandbox: false,
};

/**
 * Runs in the page: records the interval between animation frames and a
 * rough count of underscore globals at start and once a second.
 */
function installHealthTracker(): void {
  if (window.__liminalMetrics) return;
  const metrics = {
    frameCount: 0,
    lastFrameTime: performance.now(),
    fpsSamples: [] as number[],
  };
  window.__liminalMetrics = metrics;
  const trackFrame = () => {
    const now = performance.now();
    metrics.fpsSamples.push(1000 / (now - metrics.lastFrameTime));
    metrics.lastFrameTime = now;
    metrics.frameCount++;
    requestAnimationFrame(trackFrame);
  };
  requestAnimationFrame(trackFrame);
}

export class RuntimeHealthMonitor {
  private options: Required<RuntimeHealthOptions>;

  constructor(options?: RuntimeHealthOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Monitor code health over time
   */
  async monitor(code: string, domain: string): Promise<RuntimeHealthResult> {
    // The page is a p5 page. Other code would run inside it as p5 JavaScript,
    // and the result would describe a different program.
    if (domain !== 'p5') {
      throw new Error(`RuntimeHealthMonitor runs p5 sketches only, not ${domain}`);
    }
    const executablePath = resolveChromiumExecutablePath();
    if (!executablePath) throw missingChromiumError();
    prepareBrowserScratch();   // profile dir off the data volume + free-space check
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: getChromeArgs({ forceDisableSandbox: this.options.disableSandbox }),
    });

    const issues: string[] = [];
    const memorySamples: number[] = [];
    const fpsSamples: number[] = [];
    let pageErrorCount = 0;
    let consoleErrorCount = 0;

    try {
      const page = await browser.newPage();

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrorCount++;
        }
      });

      page.on('pageerror', () => {
        pageErrorCount++;
      });

      // Inline the vendored libraries: a setContent page is about:blank,
      // where /vendor URLs never load.
      const html = await inlineVendorAssets(generateHTML({
        code,
        title: 'Runtime Health Check',
        bodyStyle: 'margin: 0; padding: 0; overflow: hidden;',
        fullscreen: true,
      }));

      // The libraries are inlined, so there is no network to wait for. A
      // networkidle wait never ends while a slow draw loop holds the page.
      await page.setContent(html, { waitUntil: 'load' });

      // Start the tracker after load: a new-document script never runs for a
      // setContent page, so it would leave the metrics undefined.
      await page.evaluate(pageScript(installHealthTracker, null));

      // Get initial metrics
      const initialMetrics = await page.metrics();
      memorySamples.push((initialMetrics.JSHeapUsedSize || 0) / 1024 / 1024);

      // Monitor over time
      const startTime = Date.now();
      const sampleCount = Math.floor(this.options.durationMs / this.options.sampleIntervalMs);
      
      for (let i = 0; i < sampleCount; i++) {
        await new Promise(r => setTimeout(r, this.options.sampleIntervalMs));
        
        const metrics = await page.metrics();
        memorySamples.push((metrics.JSHeapUsedSize || 0) / 1024 / 1024);

        // Get FPS samples from page
        const pageFps = await page.evaluate(() => {
          const metrics = window.__liminalMetrics;
          if (!metrics) return [];
          const samples = metrics.fpsSamples;
          metrics.fpsSamples = []; // Reset for next interval
          return samples;
        });
        fpsSamples.push(...pageFps);
      }

      // Calculate results
      const initialMemory = memorySamples[0];
      const finalMemory = memorySamples[memorySamples.length - 1];
      const memoryGrowth = finalMemory - initialMemory;
      const avgFPS = fpsSamples.length > 0 
        ? fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length 
        : 0;
      const minFPS = fpsSamples.length > 0 
        ? Math.min(...fpsSamples) 
        : 0;

      // Check for issues
      const memoryLeak = memoryGrowth > this.options.memoryLeakThresholdMB;
      const frameRateStable = minFPS >= this.options.minAcceptableFPS;
      const noPageErrors = pageErrorCount === 0;

      if (memoryLeak) {
        issues.push(`Memory leak detected: ${memoryGrowth.toFixed(1)}MB growth over ${this.options.durationMs}ms`);
      }
      if (!frameRateStable) {
        issues.push(`Frame rate unstable: min FPS was ${minFPS.toFixed(1)}`);
      }
      if (!noPageErrors) {
        issues.push(`The page threw ${pageErrorCount} uncaught error(s)`);
      }

      return {
        healthy: !memoryLeak && frameRateStable && noPageErrors,
        duration: Date.now() - startTime,
        checks: {
          memoryLeak: !memoryLeak,
          frameRateStable,
          noPageErrors,
        },
        metrics: {
          initialMemoryMB: initialMemory,
          finalMemoryMB: finalMemory,
          memoryGrowthMB: memoryGrowth,
          avgFPS,
          minFPS,
          pageErrorCount,
          consoleErrorCount,
        },
        issues,
      };

    } catch (error) {
      issues.push(formatError('Runtime monitoring', error));
      
      return {
        healthy: false,
        duration: 0,
        checks: {
          memoryLeak: false,
          frameRateStable: false,
          // Not measured: the run stopped before it could watch the page.
          noPageErrors: false,
        },
        metrics: {
          initialMemoryMB: 0,
          finalMemoryMB: 0,
          memoryGrowthMB: 0,
          avgFPS: 0,
          minFPS: 0,
          pageErrorCount,
          consoleErrorCount,
        },
        issues,
      };
    } finally {
      await browser.close();
    }
  }

  /**
   * Quick health check - runs for shorter duration
   */
  async quickCheck(code: string, domain: string): Promise<RuntimeHealthResult> {
    const originalDuration = this.options.durationMs;
    this.options.durationMs = 2000; // 2 second quick check
    const result = await this.monitor(code, domain);
    this.options.durationMs = originalDuration;
    return result;
  }
}
