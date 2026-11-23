/**
 * M11: Accessibility Guardrails
 * 
 * Validates creative output for accessibility:
 * - Photosensitivity: no more than 3 flashes in any second (WCAG 2.3.1)
 * - Color blindness: Avoid problematic color combinations
 * - Contrast: Sufficient for low vision
 * - Motion: Respects prefers-reduced-motion
 * - Audio: No sudden loud noises
 */

import puppeteer from 'puppeteer';
import { getChromeArgs } from '../security/SandboxConfig.js';
import { generateHTML } from '../utils/generateHTML.js';
import { formatError } from '../utils/errors.js';
import { judgePhotosensitivity, startLuminanceCapture, type PhotosensitivityVerdict } from './FlashMeasure.js';
import { inlineVendorAssets } from '../utils/vendorAssets.js';
import { resolveChromiumExecutablePath } from '../utils/browserAssetFallbacks.js';
import { missingChromiumError } from '../utils/browserPreflight.js';
import { prepareBrowserScratch } from '../utils/scratchSpace.js';

export interface AccessibilityResult {
  accessible: boolean;
  checks: {
    photosensitivity: boolean;  // No more than 3 flashes in any second (WCAG 2.3.1)
    colorBlindnessSafe: boolean;  // Not relying solely on red/green
    sufficientContrast: boolean;  // WCAG AA minimum
    motionSafe: boolean;  // Respects reduced motion
    audioSafe: boolean;  // No sudden loud sounds
  };
  /** The flash verdict from the frames the screen showed; `measurement` is null when nothing was measured. */
  photosensitivity: PhotosensitivityVerdict;
  issues: string[];
  warnings: string[];  // Non-blocking suggestions
}

export interface AccessibilityOptions {
  checkDurationMs?: number;  // How long to analyze (default: 2000ms)
  disableSandbox?: boolean;
}

/** The size the flash check renders at, the same as the renderer's default. */
const VIEWPORT = { width: 800, height: 600 };

/** Model-written pages get no realtime network, no popups and no service workers. */
const HTML_PAGE_GUARDS = `(() => {
  const blocked = class { constructor() { throw new Error('LIMINAL_NETWORK_DENIED'); } };
  for (const name of ['WebSocket', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'EventSource', 'WebTransport']) {
    try { Object.defineProperty(globalThis, name, { value: blocked, configurable: false }); } catch {}
  }
  try { Object.defineProperty(window, 'open', { value: () => null, configurable: false }); } catch {}
  try { if (navigator.sendBeacon) Object.defineProperty(navigator, 'sendBeacon', { value: () => false }); } catch {}
  try { if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'register',
    { value: () => Promise.reject(new Error('LIMINAL_NETWORK_DENIED')) }); } catch {}
})();`;

const DEFAULT_OPTIONS: Required<AccessibilityOptions> = {
  checkDurationMs: 2000,
  disableSandbox: false,
};

export class AccessibilityGuardrails {
  private options: Required<AccessibilityOptions>;

  constructor(options?: AccessibilityOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Run full accessibility check. `p5` code is wrapped in a p5 page; `html`
   * is a complete page and runs as written, with no network.
   */
  async check(code: string, domain: string): Promise<AccessibilityResult> {
    if (domain !== 'p5' && domain !== 'html') {
      throw new Error(`AccessibilityGuardrails checks p5 sketches and html pages only, not ${domain}`);
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
    const warnings: string[] = [];

    try {
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);

      // Inline the vendored libraries: a setContent page is about:blank,
      // where /vendor URLs never load.
      const html = await inlineVendorAssets(domain === 'html' ? code : generateHTML({
        code,
        title: 'Accessibility Check',
        bodyStyle: 'margin: 0; padding: 0; overflow: hidden;',
        fullscreen: true,
      }));
      if (domain === 'html') {
        // Model output is untrusted: only in-browser schemes may load.
        // Interception sees HTTP only: realtime transports, popups and
        // service workers are removed before any page script runs.
        await page.evaluateOnNewDocument(HTML_PAGE_GUARDS);
        page.on('popup', (popup) => { void popup?.close().catch(() => undefined); });
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const settle = /^(data|blob|about):/.test(request.url()) ? request.continue() : request.abort();
          void settle.catch(() => undefined);
        });
      }

      // Recording starts before the page loads, so a flash in the first
      // frames counts, and runs for checkDurationMs once the canvas exists.
      const recording = await startLuminanceCapture(page);
      try {
        // The libraries are inlined, so there is no network to wait for. A
        // networkidle wait never ends while a slow draw loop holds the page.
        await page.setContent(html, { waitUntil: 'load' });
        if (domain === 'p5') await page.waitForSelector('canvas', { timeout: 10000 });
        await new Promise(r => setTimeout(r, this.options.checkDurationMs));
      } catch (error) {
        await recording.stop();
        throw error;
      }
      const capture = await recording.stop();

      // Analyze code for static checks
      const codeAnalysis = this.analyzeCode(code);

      // Check photosensitivity (more than 3 flashes in any second is dangerous)
      const photosensitivity = judgePhotosensitivity(capture);
      const photosensitivityPass = photosensitivity.pass;
      if (photosensitivity.issue) {
        issues.push(photosensitivity.issue);
      }

      // Check color blindness safety
      const colorBlindnessPass = codeAnalysis.protanopiaSafe && codeAnalysis.deuteranopiaSafe;
      if (!colorBlindnessPass) {
        warnings.push('Code may have color accessibility issues for red/green color blindness');
      }

      // Check contrast (simplified - look for very low contrast combinations)
      const contrastPass = !codeAnalysis.lowContrastPatterns.some((p: string) => 
        code.toLowerCase().includes(p)
      );
      if (!contrastPass) {
        warnings.push('Potential low contrast detected - consider accessibility');
      }

      // Check motion (look for rapid animations without media query support)
      const hasRapidMotion = /\bspeed\s*[=:]\s*[5-9]|\bfast\b|\brapid\b/.test(code.toLowerCase());
      const hasReducedMotionCheck = code.includes('prefers-reduced-motion') || 
                                     code.includes('matchMedia');
      const motionPass = !hasRapidMotion || hasReducedMotionCheck;

      if (hasRapidMotion && !hasReducedMotionCheck) {
        warnings.push('Rapid motion detected without prefers-reduced-motion support');
      }

      // Check audio safety
      const hasAudio = /\baudio\b|\bsound\b|\bTone\b|\bosc\(/.test(code);
      const hasVolumeControl = code.includes('volume') || code.includes('gain');
      const audioPass = !hasAudio || hasVolumeControl;

      if (hasAudio && !hasVolumeControl) {
        warnings.push('Audio present without explicit volume control');
      }

      return {
        accessible: photosensitivityPass, // Hard fail only on photosensitivity
        checks: {
          photosensitivity: photosensitivityPass,
          colorBlindnessSafe: colorBlindnessPass,
          sufficientContrast: contrastPass,
          motionSafe: motionPass,
          audioSafe: audioPass,
        },
        photosensitivity,
        issues,
        warnings,
      };

    } catch (error) {
      issues.push(formatError('Accessibility check', error));
      
      return {
        accessible: false,
        checks: {
          photosensitivity: false,
          colorBlindnessSafe: false,
          sufficientContrast: false,
          motionSafe: false,
          audioSafe: false,
        },
        photosensitivity: { pass: false, issue: `Photosensitivity not measured: ${issues[0]}`, measurement: null },
        issues,
        warnings,
      };
    } finally {
      await browser.close();
    }
  }

  /**
   * Static code analysis for accessibility patterns
   */
  private analyzeCode(code: string): {
    protanopiaSafe: boolean;
    deuteranopiaSafe: boolean;
    lowContrastPatterns: string[];
  } {
    const codeLower = code.toLowerCase();
    
    // Check for red-green dependent patterns
    const hasRedGreenCombo = 
      (/\bred\b/.test(codeLower) && /\bgreen\b/.test(codeLower)) ||
      (/#ff0000|rgb\(255,\s*0,\s*0\)/.test(code) && /#00ff00|rgb\(0,\s*255,\s*0\)/.test(code));
    
    const usesPatternsOrShapes = 
      /\bshape\b|\bpattern\b|\bstroke\b|\bstrokeweight\b|\bline\b/.test(codeLower);

    return {
      // Safe if not relying solely on red/green distinction
      protanopiaSafe: !hasRedGreenCombo || usesPatternsOrShapes,
      deuteranopiaSafe: !hasRedGreenCombo || usesPatternsOrShapes,
      lowContrastPatterns: [
        'lightgray', 'lightgrey',
        'rgba(255,255,255,0.1)',
        'rgba(0,0,0,0.1)',
      ],
    };
  }
}
