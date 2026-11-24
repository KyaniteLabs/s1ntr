/**
 * HeadlessRenderer - Render code in a headless browser using Playwright
 *
 * Provides sandboxed rendering for p5.js, Three.js, Hydra, Strudel, and Tone.js code.
 * Captures screenshots and audio output for quality analysis.
 */

// playwright is a heavy, optional rendering dependency. Import its TYPES only
// (erased at compile time) so importing this module — and therefore the whole
// `sinter` package — never eagerly loads playwright. The `chromium` runtime
// value is loaded lazily, on the render path, via `await import('playwright')`.
import { classifyRenderFailure } from './RenderFailureCause.js';
import { createHash } from 'node:crypto';
import os from 'node:os';
import type { Browser, Page, BrowserContext, ConsoleMessage } from 'playwright';
import { HTMLWrapper } from '../utils/htmlWrapper.js';
import { hasVendorImportMap, inlineVendorAssets, isVendorAssetPath, readVendorAsset } from '../utils/vendorAssets.js';
import { failureLogger } from '../harness/FailureLogger.js';
import { Logger } from '../utils/Logger.js';
import { RenderEvidence } from '../core/types/GenerationEvaluation.js';
import { getPinnedBrowserAssetForUrl,
  resolveChromiumExecutablePath } from '../utils/browserAssetFallbacks.js';
import { missingChromiumError } from '../utils/browserPreflight.js';
import { getChromeArgs, isNetworkIsolatedRenderEnabled, launchPlaywrightChromium } from '../security/SandboxConfig.js';
import { runInSandbox } from '../sandbox/index.js';
import type { EngineDomainString } from '../types/domains.js';
import { summarizeAudioCapture } from './AudioEvidence.js';
import { decodeImagePixels } from './DecodedImageVisibility.js';
import { musicRuntimeScript } from '../core/wrappers/musicRuntime.js';
import { BLENDER_DEFAULT_TIMEOUT_MS, renderBlender } from './BlenderRenderer.js';
import { renderNextDomain } from './NextDomainRenderer.js';
import { nextDomainActive } from '../config/nextDomains.js';
import { RevideoRenderer } from './RevideoRenderer.js';

export type RenderDomain = Extract<EngineDomainString, 'p5' | 'three' | 'glsl' | 'hydra' | 'strudel' | 'tone' | 'svg' | 'html' | 'dataviz' | 'custom' | 'ascii' | 'kinetic' | 'textgen' | 'hyperframes' | 'revideo' | 'blender' | 'nbe' | 'unknown'>;

export interface RenderOptions {
  /** Canvas width in pixels */
  width?: number;
  /** Canvas height in pixels */
  height?: number;
  /** Timeout for rendering in milliseconds */
  timeout?: number;
  /** Caller deadline for capture. Browser setup is cancellable before loading code. Native backends retain their own budgets. */
  hardDeadlineMs?: number;
  /** Revideo only: wall-clock budget for the whole scene render (default 60 s); on expiry the render fails with RENDER_TIMEOUT. */
  renderTimeoutMs?: number;
  /** Whether to wait for animation/video to stabilize */
  waitForStabilization?: boolean;
  /** Stabilization time in milliseconds */
  stabilizationTime?: number;
  /** Delay after the early frame so slow motion is visible to evaluators. */
  lateCaptureDelay?: number;
  /**
   * Milliseconds of sound (tone/strudel) the judge hears, counted from the
   * first non-silent sample. 0 keeps the old behaviour: the window equals
   * stabilizationTime, which is only half a second by default (#1641).
   */
  audioCaptureMs?: number;
  /**
   * #1637: piece time (ms) at which the late frame is taken. When set, the page
   * runs on Playwright's virtual clock and is fast-forwarded to this horizon
   * after the early frame, so work that unfolds over a minute is judged on its
   * arc instead of its first seconds. 0 keeps the real-time late frame.
   */
  arcHorizonMs?: number;
  /** Wall-clock ceiling for the fast-forward; the late frame is taken wherever it stops. */
  arcWallBudgetMs?: number;
  /** NBE only: how long to wait for the page's nbe:converged message before failing the render (default 8 s, capped by timeout). */
  nbeConvergenceTimeoutMs?: number;
  /** Domain hint for specialized rendering */
  domain?: RenderDomain;
  /** Keep the Playwright page open for advanced callers */
  keepPageOpen?: boolean;
  /** Preserve transparent pixels in PNG screenshots. */
  omitBackground?: boolean;
  /** Dream experiments use `isolated`; ordinary renders retain asset allowlists. */
  networkPolicy?: 'assets-only' | 'isolated';
  /** Exact source byte ceiling enforced before browser execution. */
  maximumOutputBytes?: number;
  /** Browser-side resource ceilings for generated workloads. */
  maximumEventListeners?: number;
  maximumEvents?: number;
  maximumTimers?: number;
  maximumAudioContexts?: number;
  maximumHeapBytes?: number;
  maximumDurationMs?: number;
  /** Act on one visible control and receipt-observe whether state changed. */
  observeInteraction?: boolean;
}

export interface RenderSandboxPreflight {
  readonly sourceDigest: string;
  readonly networkPolicy: 'isolated';
  readonly realtimeTransportsDenied: true;
  readonly outputLimitEnforced: true;
}

export interface ScreenshotResult {
  /** Screenshot as PNG buffer */
  buffer: Buffer;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Whether the screenshot was captured successfully */
  success: boolean;
  /** Error message if capture failed */
  error?: string;
}

export interface AudioCaptureResult {
  /** Audio data as Float32Array (normalized -1 to 1) */
  samples: Float32Array;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Duration in seconds */
  duration: number;
  /** Whether audio was captured successfully */
  success: boolean;
  /** Error message if capture failed */
  error?: string;
  /** Non-fatal capture warnings surfaced from browser instrumentation */
  warnings?: string[];
}

export interface RenderResult {
  /** False when the scene itself was not rendered. */
  rendered?: boolean;
  /** Deadline before any candidate code started. */
  setupDeadline?: boolean;
  /** #1637: virtual-clock arc capture; the late frame shows the piece at `reachedMs`. */
  arc?: { horizonMs: number; reachedMs: number; wallMs: number };
  /** The Playwright page instance (for advanced use) */
  page?: Page;
  /** Screenshot result */
  screenshot?: ScreenshotResult;
  /** Second capture late in the render window (H13 steady-state frame) */
  lateScreenshot?: ScreenshotResult;
  /** Audio capture result */
  audio?: AudioCaptureResult;
  /** Whether rendering succeeded */
  success: boolean;
  /** Blender only: why the render failed, so a missing binary is not read as a bad script. */
  failureKind?: string;
  /** Error message if rendering failed */
  error?: string;
  /** Console logs from the page */
  logs: string[];
  /** Console errors and uncaught page errors, in arrival order */
  errors: string[];
  /** Uncaught page errors only. Any one of them fails the render (#1690). */
  pageErrors: string[];
  containment?: NonNullable<RenderEvidence['containment']>;
  rendererEnvironmentDigest?: string;
  playback?: NonNullable<RenderEvidence['playback']>;
  interaction?: NonNullable<RenderEvidence['interaction']>;
}

type RenderPostRunCensus = NonNullable<
NonNullable<RenderEvidence['containment']>['postRunCensus']>;

const DEFAULT_OPTIONS: Required<RenderOptions> = {
  width: 800,
  height: 600,
  timeout: 30000,
  hardDeadlineMs: 0,
  renderTimeoutMs: 60_000,
  waitForStabilization: true,
  stabilizationTime: 500,
  lateCaptureDelay: 3000,
  audioCaptureMs: 0,
  arcHorizonMs: 0,
  arcWallBudgetMs: 12_000,
  nbeConvergenceTimeoutMs: 8_000,
  domain: 'unknown',
  keepPageOpen: false,
  omitBackground: false,
  networkPolicy: 'assets-only',
  maximumOutputBytes: 2 * 1024 * 1024,
  maximumEventListeners: 4096,
  maximumEvents: 100_000,
  maximumTimers: 2048,
  maximumAudioContexts: 8,
  maximumHeapBytes: 256 * 1024 * 1024,
  maximumDurationMs: 60_000,
  observeInteraction: false,
};

/** Hydra uses a higher resolution for better visual fidelity */
const HYDRA_OPTIONS = { width: 1280, height: 800 };


function domainRequiresCanvas(domain: RenderDomain): boolean {
  return domain === 'p5' || domain === 'three' || domain === 'glsl' || domain === 'hydra';
}

/**
 * Hosts the generated artifacts legitimately fetch from. Mirrors the hosts
 * declared in HTMLWrapper's CSP: libraries are vendored locally (#924) so no
 * CDN hosts remain — only the strudel sample-bank hosts (still remote until
 * the samples are vendored; see #924 follow-up) and PostHog. Everything else
 * is denied by default so artifact code can't call out to arbitrary network
 * destinations.
 */
const ALLOWED_RENDER_HOSTS: ReadonlySet<string> = new Set([
  // Legacy CDN hosts: every artifact wrapped before #924 references these;
  // the renderer must keep re-rendering the existing store, not just new
  // vendored artifacts. New artifacts load from same-origin /vendor/ paths.
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'd3js.org',
  // Strudel sample banks (still remote until the samples are vendored;
  // see #924 follow-up). Analytics is not allowed: renders never phone home.
  'strudel.b-cdn.net',
  'raw.githubusercontent.com',
]);

/**
 * Decide whether a request URL may proceed. Allows the CDN allowlist plus
 * non-network schemes (data:/blob:/about:/file:) and localhost loopback. Any
 * other host is blocked. Unparseable URLs are blocked.
 */
export function isAllowedRenderRequestUrl(rawUrl: string,
  policy: 'assets-only' | 'isolated' = 'assets-only'): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // file: can expose host bytes and is never permitted in isolated renders.
  if (url.protocol === 'file:') return policy !== 'isolated';
  // Remaining non-network schemes are contained within the browser context.
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') {
    return true;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  if (policy === 'isolated') {
    // Strudel sample banks stay remote until they are vendored (#924
    // follow-up; the wrapper CSP declares both hosts). Vendored library
    // requests are fulfilled from the pinned store before this check, so
    // isolation permits exactly the two trusted sample-bank hosts (the
    // b-cdn banks carry machine-prefixed names; Dirt-Samples strudel.json
    // on raw.githubusercontent.com carries the classic bd/hh short names)
    // and denies everything else.
    const host = url.hostname.toLowerCase();
    return host === 'strudel.b-cdn.net' || host === 'raw.githubusercontent.com';
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }

  return ALLOWED_RENDER_HOSTS.has(host);
}

/** Private origin for pages that load pinned ES modules (.invalid never resolves). */
export const RENDER_ORIGIN = 'http://sinter-render.invalid';

/**
 * An engine page (`<html data-sinter-engine="...">`) does its warm-up steps while it loads, so an engine that never
 * gets ready can hold back DOMContentLoaded past the load timeout. Without this, that surfaced as a raw
 * "page.setContent: Timeout" instead of ENGINE_NOT_READY:<engine> (engine-render.test.ts, red on main 2026-11-23).
 * Returns the mapped error for a load timeout on an engine page; otherwise undefined (rethrow the original).
 */
export function engineLoadTimeoutError(html: string, err: unknown, timeoutMs: number): Error | undefined {
  const engine = html.match(/<html\b[^>]*\bdata-sinter-engine="([A-Za-z0-9_-]+)"/)?.[1];
  if (!engine) return undefined;
  const e = err as { name?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const timedOut = e?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(message);
  if (!timedOut) return undefined;
  return new Error(`ENGINE_NOT_READY:${engine}: page did not finish loading within ${timeoutMs} ms (${message.split('\n')[0]})`);
}

/**
 * Browser-side audio-domain page init (tone/strudel). Executed by PREPENDING
 * the compiled function (types erased by tsc) to the wrapped HTML — Playwright
 * addInitScript does not run for setContent pages, which silently disabled
 * audio capture on every embedded render. Body stays valid plain JS after
 * type-erasure.
 */
function audioCapturePageInit(maxSamples: number): void {
  const audioCaptureData: number[] = [];
  (window as unknown as { __audioCaptureData: number[] }).__audioCaptureData = audioCaptureData;
  const audioCaptureWarnings: string[] = [];
  (window as unknown as { __audioCaptureWarnings: string[] }).__audioCaptureWarnings = audioCaptureWarnings;
  const audioCaptureCounters = { ctor: 0, setup: 0, taps: 0, proc: 0, connects: 0, factories: 0 };
  (window as unknown as { __audioCaptureCounters: typeof audioCaptureCounters }).__audioCaptureCounters = audioCaptureCounters;

  const OriginalAudioContext = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!OriginalAudioContext) return;
  const captureSinks = new WeakMap<BaseAudioContext, ScriptProcessorNode>();
  // A single startup impulse may precede the engine that plays the piece.
  // Once two contexts carry sustained audio, a single-track capture remains incomplete.
  let owner: ScriptProcessorNode | null = null;
  let ownerSoundSamples = 0;
  let handedOff = false;
  const drains = new WeakSet<AudioNode>();
  // A destination may be fed by any node (Strudel ends at a compressor), not
  // just gains and oscillators. Tap only connections that actually reach it.
  const nodeProto = window.AudioNode?.prototype;
  if (nodeProto) {
    const connect = nodeProto.connect;
    const disconnect = nodeProto.disconnect;
    nodeProto.connect = function (target: AudioNode | AudioParam, ...ports: number[]) {
      const result = Reflect.apply(connect, this, [target, ...ports]);
      audioCaptureCounters.connects += 1;
      const sink = captureSinks.get(this.context);
      if (sink && target === this.context.destination && !drains.has(this)) {
        // Tap the same output that feeds the speakers (multi-output nodes).
        Reflect.apply(connect, this, [sink, ports[0] ?? 0]);
        audioCaptureCounters.taps += 1;
      }
      return result;
    };
    nodeProto.disconnect = function (...args: unknown[]) {
      const result = Reflect.apply(disconnect, this, args);
      const sink = captureSinks.get(this.context);
      if (sink && (args.length === 0 || args[0] === this.context.destination)) {
        try { Reflect.apply(disconnect, this, [sink]); } catch { /* already detached */ }
      }
      return result;
    };
  }
  const captureDestinations: MediaStreamAudioDestinationNode[] = [];
  (window as unknown as { __audioCaptureDestinations: MediaStreamAudioDestinationNode[] }).__audioCaptureDestinations = captureDestinations;
  (window as unknown as { AudioContext: typeof AudioContext }).AudioContext = class extends OriginalAudioContext {
    private _captureDestination: MediaStreamAudioDestinationNode | null = null;
    private _scriptProcessor: ScriptProcessorNode | null = null;
    constructor(contextOptions?: AudioContextOptions) {
      super(contextOptions);
      audioCaptureCounters.ctor += 1;
      this._setupCapture();
    }
    private _setupCapture(): void {
      try {
        this._captureDestination = this.createMediaStreamDestination();
        captureDestinations.push(this._captureDestination);
        audioCaptureCounters.setup += 1;
        this._scriptProcessor = this.createScriptProcessor(4096, 1, 1);
        captureSinks.set(this, this._scriptProcessor);
        audioCaptureCounters.proc += 1;
        const captureData = audioCaptureData;
        // The capture budget is sized at 44.1 kHz; the context may run faster
        // (48 kHz on CoreAudio), and the samples are in ITS rate.
        const ctxRate = this.sampleRate > 0 ? this.sampleRate : 44100;
        const cap = Math.ceil(maxSamples * ctxRate / 44100);
        this._scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
          const inputData = event.inputBuffer.getChannelData(0);
          // The window opens at the first sound, not at context creation: the
          // processor runs from the start, so a piece whose first note lands
          // after the window (sample load, scheduler start, slow cpm) filled it
          // with leading zeros and was judged silent at random (same playable:
          // peak 0 on one render, 4.9 on the next).
          //
          const self = this._scriptProcessor;
          if (self !== owner || ownerSoundSamples < 2) {
            let audible = 0;
            for (const sample of inputData) {
              if (sample !== 0 && ++audible === 2) break;
            }
            if (!owner && audible > 0) owner = self;
            if (owner !== self) {
              if (audible === 0) return;
              if (!handedOff && ownerSoundSamples === 1 && audible >= 2) {
                owner = self;
                ownerSoundSamples = 0;
                handedOff = true;
                captureData.length = 0;
              } else {
                (window as unknown as { __audioCaptureIncomplete?: boolean }).__audioCaptureIncomplete = true;
                return;
              }
            }
            ownerSoundSamples += audible;
          }
          let i = 0;
          if (captureData.length === 0) {
            while (i < inputData.length && inputData[i] === 0) i += 1;
            if (i < inputData.length) {
              (window as unknown as { __audioCaptureRate: number }).__audioCaptureRate = ctxRate;
            }
          }
          for (; i < inputData.length && captureData.length < cap; i += 1) captureData.push(inputData[i]);
        };
        // Processor output drains through a zero-gain node: onaudioprocess
        // fires on input connections alone, and this keeps the tap from
        // doubling the audible signal in the render.
        const tapOut = super.createGain();
        drains.add(tapOut);
        tapOut.gain.value = 0;
        this._scriptProcessor.connect(tapOut);
        tapOut.connect(this.destination);
      } catch (e) {
        audioCaptureWarnings.push(`Audio capture setup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  if ((window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) {
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      = (window as unknown as { AudioContext: typeof AudioContext }).AudioContext;
  }
  // Tone.js may hold a context created before this script ran. Steering it
  // is attempted at most ONCE per raw-context instance: an unconditional
  // per-tick swap hammered the allocator (10 contexts/sec -> census + heap
  // limit failures) when the rawContext setter silently refused assignment.
  let lastRawToneContext: AudioContext | null = null;
  const hookTone = () => {
    const Tone = (window as unknown as { Tone?: { context: { rawContext: AudioContext } } }).Tone;
    if (!Tone?.context) return;
    const raw = Tone.context.rawContext as (AudioContext & { __liminalCapture?: boolean }) | undefined;
    if (!raw || raw.__liminalCapture || raw === lastRawToneContext) return;
    lastRawToneContext = raw;
    try {
      const NewContext = (window as unknown as { AudioContext: typeof AudioContext }).AudioContext;
      const newCtx = new NewContext();
      (newCtx as unknown as { __liminalCapture: boolean }).__liminalCapture = true;
      Tone.context.rawContext = newCtx;
    } catch { /* read-only setter — nothing to steer */ }
  };
  hookTone();
  setInterval(hookTone, 100);
  // Strudel/Tone compatibility (tempo globals, Pattern no-ops, sample
  // banks) lives in the shared music runtime, injected beside this script
  // (#1732). This init only taps audio.
}

/**
 * In-page probe: true when any pixel of the page's canvas is not black.
 *
 * It reads the whole frame. A sketch can be black at the center (a ring, a
 * shape scrolled aside, thin lines) and still be drawing.
 *
 * page.evaluate serializes this function, so it must not reference anything
 * outside its own body. WebGL may clear its drawing buffer after
 * presentation, so the read happens inside an animation frame.
 */
export function probeFrameLit(timeoutMs: number): Promise<boolean> {
  // No named inner functions: tsx/esbuild keepNames would wrap them in a
  // __name() helper that does not exist in the page.
  return new Promise<boolean>((resolve) => {
    let frame = 0;
    const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, timeoutMs);
    frame = requestAnimationFrame(() => {
      clearTimeout(timer);
      try {
        const canvas = document.querySelector('canvas');
        if (!canvas || canvas.width === 0 || canvas.height === 0) { resolve(false); return; }
        let px: ArrayLike<number> | null = null;
        // Hydra creates its WebGL context before this runs. Asking for webgl
        // first never turns a hydra canvas into a 2D one.
        const gl = (canvas.getContext('webgl') || canvas.getContext('webgl2')) as WebGLRenderingContext | null;
        if (gl) {
          const buf = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          px = buf;
        } else {
          const ctx = canvas.getContext('2d');
          if (ctx) px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        let lit = false;
        if (px) {
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > 0 || px[i + 1] > 0 || px[i + 2] > 0) { lit = true; break; }
          }
        }
        resolve(lit);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * The Start button of each audio preview shell (GenericWrapper). Tone has two
 * shells: plain JS draws #start, full HTML draws #sinter-tone-start, which in
 * turn presses the artwork's own button or calls its play().
 */
/** A CSP block of a stylesheet or font: cosmetic, unlike a blocked script or image. */
const CSP_COSMETIC_BLOCK = /^(?:Loading|Refused to load) the (?:stylesheet|font) '[^']*' (?:because it )?violates the following Content Security Policy directive/;

const PLAY_BUTTON: Partial<Record<RenderDomain, string>> = {
  tone: '#start, #sinter-tone-start',
  strudel: '#sinter-strudel-play',
};

/** Where a press left an audio shell. */
type PlaybackState = 'playing' | 'booting' | 'idle' | 'failed' | 'waiting';

/**
 * Reads what the page is doing, not what was pressed. Runs in the page. A Tone
 * page plays once an AudioContext runs; Chrome resumes one only inside a
 * trusted gesture. The capture hook sees every context the page makes, so a
 * page that imports Tone as a module, off window, still counts. The Strudel shell says "Playing." once the pattern
 * evaluates, and "Still booting" for a press it ignored. If boot ends after
 * that, the status returns to "Ready.": idle, the press never took.
 */
function readPlaybackState(domain: string): PlaybackState {
  if (domain === 'strudel') {
    const status = document.getElementById('sinter-strudel-status')?.textContent ?? '';
    if (/^Playing/.test(status)) return 'playing';
    if (/error/i.test(status)) return 'failed';
    if (/booting/i.test(status)) return 'booting';
    if (/^Ready/.test(status)) return 'idle';
    return 'waiting';
  }
  const page = window as unknown as {
    Tone?: { context?: { state?: string } };
    __audioCaptureDestinations?: Array<{ context: { state: string } }>;
  };
  const running = page.Tone?.context?.state === 'running'
    || (page.__audioCaptureDestinations ?? []).some((node) => node.context.state === 'running');
  return running ? 'playing' : 'waiting';
}

/**
 * Headless renderer for creative coding outputs
 */
export function computeRendererEnvironmentDigest(executablePath: string, version: string): string {
  return createHash('sha256').update(JSON.stringify({
    engine: 'playwright-chromium', executablePath, version })).digest('hex');
}

export class HeadlessRenderer {
  private browser: Browser | null = null;
  private initializing: Promise<void> | null = null;
  private context: BrowserContext | null = null;
  private permissionsCleared = false;
  private rendererEnvironmentDigest?: string;
  private static instance: HeadlessRenderer | null = null;

  /**
   * Get singleton instance
   */
  static getInstance(): HeadlessRenderer {
    if (!HeadlessRenderer.instance) {
      HeadlessRenderer.instance = new HeadlessRenderer();
    }
    return HeadlessRenderer.instance;
  }

  preflightSandbox(code: string, options: RenderOptions): RenderSandboxPreflight {
    if (options.networkPolicy !== 'isolated') {
      throw new Error('RENDER_SANDBOX_NETWORK_ISOLATION_REQUIRED');
    }
    const bytes = Buffer.byteLength(code, 'utf8');
    if (!options.maximumOutputBytes || bytes > options.maximumOutputBytes) {
      throw new Error('RENDER_OUTPUT_BYTES_EXCEEDED');
    }
    return Object.freeze({
      sourceDigest: createHash('sha256').update(code).digest('hex'),
      networkPolicy: 'isolated' as const, realtimeTransportsDenied: true as const,
      outputLimitEnforced: true as const,
    });
  }

  /**
   * Delegates to the shared browser-asset resolver. This keeps the fallback
   * chain (override → Playwright → compatible Puppeteer → runner scan) in one
   * place so callers like rescore-tops.mjs get the same logic (#339).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  /** Launch the real browser and return the digest every observation will carry (F07). Throws when no browser can launch. */
  static async probeRendererEnvironmentDigest(): Promise<string> {
    const executablePath = await HeadlessRenderer.resolveChromiumExecutable();
    if (!executablePath) throw missingChromiumError();
    const { chromium } = await import('playwright');
    const browser = await launchPlaywrightChromium(chromium, {
      headless: true, executablePath,
      args: getChromeArgs({ forceDisableSandbox: process.env.LIMINAL_DISABLE_SANDBOX === 'true' }) });
    try {
      return computeRendererEnvironmentDigest(executablePath,
        typeof browser.version === 'function' ? browser.version() : 'unknown');
    } finally { await browser.close(); }
  }

  private static async resolveChromiumExecutable(): Promise<string | undefined> {
    return resolveChromiumExecutablePath();
  }

  /**
   * Initialize the browser (lazy initialization)
   */
  async initialize(): Promise<void> {
    if (this.browser && this.context) return;
    // Concurrent callers share one launch; without this each launched its own
    // Chromium and all but the last leaked.
    this.initializing ??= this.launchBrowserAndContext().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  private async launchBrowserAndContext(): Promise<void> {
    try {
      if (!this.browser) {
        const executablePath = await HeadlessRenderer.resolveChromiumExecutable();
        if (!executablePath) {
          // resolveChromiumExecutablePath already attempted one-shot install.
          throw missingChromiumError();
        }
        // Launch sandboxed unless LIMINAL_DISABLE_SANDBOX=true (containerized/CI).
        const disableSandbox = process.env.LIMINAL_DISABLE_SANDBOX === 'true';
        const { chromium } = await import('playwright');
        this.browser = await launchPlaywrightChromium(chromium, {
          headless: true,
          executablePath,
          args: getChromeArgs({ forceDisableSandbox: disableSandbox }),
        });
        const launched = this.browser;
        if (typeof launched.on === 'function') {
          launched.on('disconnected', () => {
            if (this.browser === launched) {
              this.browser = null;
              this.context = null;
            }
          });
        }
        const browserVersion = typeof this.browser.version === 'function'
          ? this.browser.version()
          : 'unknown';
        this.rendererEnvironmentDigest = computeRendererEnvironmentDigest(executablePath, browserVersion);
      }

      this.context = await HeadlessRenderer.newRenderContext(this.browser);
      if (typeof this.context.clearPermissions === 'function') {
        await this.context.clearPermissions();
        this.permissionsCleared = true;
      }

      Logger.info('HeadlessRenderer', 'Browser initialized');
    } catch (error) {
      if (this.browser && !this.context) {
        const orphan = this.browser;
        this.browser = null;
        await orphan.close().catch(() => undefined);
      }
      Logger.error('HeadlessRenderer', 'Failed to initialize browser:', error);
      throw new Error(`Failed to initialize headless browser: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error instanceof Error ? error : undefined });
    }
  }

  private static newRenderContext(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
  }

  /**
   * Detect domain from code content
   */
  static detectDomain(code: string): RenderDomain {
    const trimmed = code.trim();

    if (/data-revideo-timeline-preview|@revideo\/(?:core|2d)/.test(code)) return 'revideo';

    // Python bpy scripts, checked before the p5 test (a bpy script may define draw()).
    if (/^\s*(?:import\s+bpy\b|from\s+bpy\b)/m.test(code)) return 'blender';

    if (code.includes('function setup()') || code.includes('createCanvas') || code.includes('draw()')) {
      return 'p5';
    }
    if (code.includes('THREE.') || code.includes('WebGLRenderer') || code.includes('Scene()')) {
      return 'three';
    }
    if (code.includes('void main') && code.includes('gl_FragColor')) {
      return 'glsl';
    }
    if (code.includes('.out(o0)') || code.includes('src(o0)') || code.includes('osc(')) {
      return 'hydra';
    }
    if (code.includes('.s(') && (code.includes('stack') || code.includes('$:') || code.includes('note('))) {
      return 'strudel';
    }
    if (code.includes('Tone.') || code.includes('Synth') || code.includes('synth')) {
      return 'tone';
    }
    if (/^<svg\b/i.test(trimmed)) {
      return 'svg';
    }
    const isHtmlDocument = /^<!DOCTYPE\s+html/i.test(trimmed) || /<html\b/i.test(code);
    const isHtmlFragment = /^<[a-z][\w:-]*(?:\s|>|\/>)/i.test(trimmed) && /<\/[a-z][\w:-]*>/i.test(code);
    if (isHtmlDocument || isHtmlFragment) {
      return /@keyframes\b|\banimation\s*:/i.test(code) ? 'kinetic' : 'html';
    }
    if (/^[\s\S]*[/\\|_~^*#%+=.-][\s\S]*\n[\s\S]*[/\\|_~^*#%+=.-]/.test(code) && !/[{};=]/.test(code)) {
      return 'ascii';
    }
    return 'unknown';
  }

  /**
   * Render a Revideo scene in its contained harness and hand the judges two
   * real stills (early + 80 %). Containment comes from the harness page:
   * request interception admits only its own file:// URLs, and realtime
   * transports, storage and device permissions are removed (#1628).
   */
  private static async renderRevideoScene(code: string, maximumOutputBytes: number, timeoutMs: number, signal: AbortSignal): Promise<RenderResult> {
    if (Buffer.byteLength(code) > maximumOutputBytes) {
      const error = 'RENDER_OUTPUT_BYTES_EXCEEDED';
      return { rendered: false, success: false, error, logs: [], errors: [error], pageErrors: [] };
    }
    try {
      const stills = await new RevideoRenderer().renderStills(code, { fps: 30, width: 960, height: 540, timeoutMs, signal });
      const shot = (buffer: Buffer): ScreenshotResult => ({ buffer, width: stills.width, height: stills.height, success: true });
      const c = stills.containment;
      const containment: NonNullable<RenderEvidence['containment']> = {
        networkIsolated: c.networkIsolated, permissionsDenied: c.permissionsDenied,
        cleanupSucceeded: c.cleanupSucceeded, blockedRequests: c.blockedRequests,
        routeInstalled: c.networkIsolated, timeoutEnforced: true,
        outputLimitEnforced: true, outputBytes: Buffer.byteLength(code), assetDigests: [],
      };
      return { rendered: true, success: true, screenshot: shot(stills.early), lateScreenshot: shot(stills.late),
        logs: [`revideo scene: ${stills.durationSeconds.toFixed(2)} s`], errors: [], pageErrors: [], containment };
    } catch (err) {
      // `rendered` stays unset: a scene that fails to bundle, initialise or
      // seek is a candidate failure (repairable), not a refused wrapper.
      // Browser launch failures still classify as infra by their message.
      const error = `Revideo render failed: ${err instanceof Error ? err.message : String(err)}`;
      return { success: false, error, logs: [], errors: [error], pageErrors: [] };
    }
  }

  /** Run a bpy script headless and adapt the PNG to the screenshot shape the judges consume. */
  private static async renderBlenderScript(code: string, timeoutMs: number): Promise<RenderResult> {
    const result = await renderBlender(code, { timeoutMs });
    if (!result.success || !result.png) {
      const error = result.error ?? 'Blender render failed';
      return { success: false, error, failureKind: result.failureKind, logs: result.logs, errors: [error], pageErrors: [] };
    }
    const shot: ScreenshotResult = {
      buffer: result.png, width: result.width ?? 0, height: result.height ?? 0, success: true,
    };
    // Only bwrap (--unshare-all, fresh net namespace, read-only system binds, a
    // throwaway out dir and a hard timeout) counts as contained. The unsandboxed
    // escape hatch reports itself as not isolated, so admission rejects it (#1628).
    const isolated = result.sandbox === 'bwrap';
    const containment: NonNullable<RenderEvidence['containment']> = {
      networkIsolated: isolated, permissionsDenied: isolated, cleanupSucceeded: true,
      blockedRequests: 0, routeInstalled: false, timeoutEnforced: true,
      outputLimitEnforced: true, outputBytes: Buffer.byteLength(code), assetDigests: [],
    };
    return { rendered: true, success: true, screenshot: shot, lateScreenshot: shot, logs: result.logs, errors: [], pageErrors: [], containment };
  }

  /** Bounds the caller's wait and starts cleanup for this render's own page. */
  async render(code: string, options: RenderOptions = {}): Promise<RenderResult> {
    const nextDomain = typeof options.domain === 'string' && nextDomainActive(options.domain);
    const nativeBudget = options.domain === 'blender'
      ? options.renderTimeoutMs ?? BLENDER_DEFAULT_TIMEOUT_MS
      : options.domain === 'revideo' || nextDomain
        ? options.renderTimeoutMs ?? (nextDomain ? options.timeout : undefined) ?? DEFAULT_OPTIONS.renderTimeoutMs
        : undefined;
    const hardMs = options.hardDeadlineMs || nativeBudget || ((options.timeout ?? DEFAULT_OPTIONS.timeout)
      + (options.arcWallBudgetMs ?? 0) + (options.lateCaptureDelay ?? DEFAULT_OPTIONS.lateCaptureDelay ?? 0)
      + (options.audioCaptureMs ?? 0) + 30_000);
    const controller = new AbortController();
    const hold: { page?: Page; context?: BrowserContext; candidateStarted?: boolean } = {};
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('expired');
      }, hardMs);
    });
    const work = this.renderGuarded(code, options, hold, controller.signal, Math.min(hardMs, nativeBudget ?? hardMs));
    try {
      const winner = await Promise.race([work, expired]);
      if (winner !== 'expired') return winner;
    } finally {
      clearTimeout(timer);
    }
    const codePrefix = nativeBudget === undefined ? 'RENDER_HARD_DEADLINE' : 'RENDER_TIMEOUT';
    const error = `${codePrefix}: render exceeded ${hardMs} ms`;
    void (hold.context ?? hold.page)?.close().catch(() => undefined);
    return { success: false, error, setupDeadline: nativeBudget === undefined && !hold.candidateStarted,
      logs: [], errors: [error], pageErrors: [] };
  }

  private async renderGuarded(code: string, options: RenderOptions, hold: { page?: Page; context?: BrowserContext; candidateStarted?: boolean },
    signal: AbortSignal, nativeTimeoutMs: number): Promise<RenderResult> {
    // Deprecated alias: `meta` was renamed `custom` (see canonicalDomainId).
    if ((options.domain as string | undefined) === 'meta') options = { ...options, domain: 'custom' };
    // A real Revideo scene renders through its own Player + Stage harness (#1628).
    // The HTML timeline-preview wrapper is an approximation and never counts, and
    // code that only looks like Revideo is not auto-routed into the bundler.
    if (options.domain === 'revideo' && !/data-revideo-timeline-preview/.test(code)) {
      return HeadlessRenderer.renderRevideoScene(code, options.maximumOutputBytes ?? DEFAULT_OPTIONS.maximumOutputBytes,
        nativeTimeoutMs, signal);
    }
    if (options.domain === 'revideo' || /data-revideo-timeline-preview/.test(code)
      || ((!options.domain || options.domain === 'unknown') && HeadlessRenderer.detectDomain(code) === 'revideo')) {
      const error = 'Revideo scene not rendered: wrapper is an approximation';
      return { rendered: false, success: false, error, logs: [], errors: [error], pageErrors: [] };
    }
    // Next-release domains (flag-gated, off by default) render through their own pipeline, never a browser page.
    if (typeof options.domain === 'string' && nextDomainActive(options.domain)) {
      return renderNextDomain(options.domain, code, process.env, {
        timeoutMs: nativeTimeoutMs,
        maximumOutputBytes: options.maximumOutputBytes ?? DEFAULT_OPTIONS.maximumOutputBytes,
      });
    }
    // Detect domain BEFORE applying options so we know whether to use hydra viewport
    const detectedDomain = options.domain === 'unknown' || !options.domain
      ? HeadlessRenderer.detectDomain(code)
      : options.domain;

    // Blender is a Python subprocess, not a browser page: it never touches Playwright.
    // It runs model-written code, so only an explicit domain opts in; code that merely
    // looks like bpy (unknown domain, no domain) is refused, never auto-routed.
    if (detectedDomain === 'blender') {
      if (options.domain === 'blender') return HeadlessRenderer.renderBlenderScript(code, nativeTimeoutMs);
      const error = 'bpy script detected; Blender renders only run for an explicit blender domain';
      return { rendered: false, success: false, error, logs: [], errors: [error], pageErrors: [] };
    }

    const isHydra = detectedDomain === 'hydra';
    const opts = {
      ...DEFAULT_OPTIONS,
      ...(isHydra ? HYDRA_OPTIONS : {}),
      ...options,
      domain: detectedDomain,
    };

    const logs: string[] = [];
    const errors: string[] = [];
    const pageErrors: string[] = [];
    const threw = () => (pageErrors.length > 0 ? `The page threw: ${pageErrors[0]}` : undefined);
    const naming = (message: string) => (pageErrors.length > 0 ? `${message}. ${threw()}` : message);
    const assetDigests = new Set<string>();
    let pagesBefore = 0;
    const containment: NonNullable<RenderEvidence['containment']> = {
      networkIsolated: false,
      permissionsDenied: this.permissionsCleared,
      cleanupSucceeded: false, blockedRequests: 0,
      routeInstalled: false, timeoutEnforced: false, outputLimitEnforced: false,
      outputBytes: Buffer.byteLength(code),
      assetDigests: [],
    };
    let page: Page | undefined;
    let ownedContext: BrowserContext | undefined;
    let busyMeter: { read: () => Promise<number | null>; detach: () => Promise<void> } | undefined;
    let keepPage = false;
    let playback: RenderResult['playback'];
    let interaction: RenderResult['interaction'];
    const startedAt = Date.now();
    let renderClockAt = startedAt;

    try {
      if (Buffer.byteLength(code) > opts.maximumOutputBytes) {
        throw new Error('RENDER_OUTPUT_BYTES_EXCEEDED');
      }
      containment.outputLimitEnforced = true;
      await this.initialize();
      signal.throwIfAborted();
      // The duration cap budgets the piece, not the host: a cold browser launch
      // ate the crystal-k margin (2026-11-17), so the render clock starts here.
      renderClockAt = Date.now();
      containment.permissionsDenied = this.permissionsCleared;

      const sharedContext = this.context;
      if (!sharedContext) {
        throw new Error('Browser context not initialized');
      }

      if (opts.networkPolicy === 'isolated') {
        if (!this.browser) throw new Error('Browser not initialized');
        ownedContext = await HeadlessRenderer.newRenderContext(this.browser);
        hold.context = ownedContext;
        signal.throwIfAborted();
        containment.permissionsDenied = false;
        await ownedContext.clearPermissions();
        containment.permissionsDenied = true;
      }
      signal.throwIfAborted();
      const renderContext = ownedContext ?? sharedContext;
      pagesBefore = typeof renderContext.pages === 'function' ? renderContext.pages().length : 0;
      page = await renderContext.newPage();
      hold.page = page;
      signal.throwIfAborted();
      busyMeter = await HeadlessRenderer.startBusyMeter(page);
      const readBusyMs = busyMeter.read;
      // The clock goes in before the guards so the timer census wraps the fake
      // timers; the guards seal setTimeout, which would block a later install.
      const arcClock = await this.installArcClock(page, opts);
      const timerLimit = arcClock
        ? opts.maximumTimers * Math.max(1, Math.ceil(opts.arcHorizonMs
          / Math.max(1, opts.stabilizationTime + opts.lateCaptureDelay)))
        : opts.maximumTimers;
      const guardsInstalled = await this.installContainmentGuards(page,
        { ...opts, maximumTimers: timerLimit }, ownedContext);
      containment.routeInstalled = await this.installLocalAssetFallbacks(ownedContext ?? page, opts.networkPolicy,
        () => { containment.blockedRequests++; }, digest => assetDigests.add(digest));
      containment.networkIsolated = opts.networkPolicy === 'isolated'
        && containment.routeInstalled && guardsInstalled;
      containment.timeoutEnforced = Number.isFinite(opts.timeout) && opts.timeout > 0;

      // Set viewport size
      await page.setViewportSize({ width: opts.width, height: opts.height });

      // Capture console logs
      page.on('console', (msg: ConsoleMessage) => {
        // Our sandbox CSP blocks web fonts; the piece still draws with a
        // fallback face, so that block is a warning, not the piece failing.
        if (msg.type() === 'error' && CSP_COSMETIC_BLOCK.test(msg.text())) {
          logs.push(`[warn] blocked by sandbox CSP: ${msg.text()}`);
          return;
        }
        const log = `[${msg.type()}] ${msg.text()}`;
        logs.push(log);
        if (msg.type() === 'error') {
          errors.push(msg.text());
        }
      });

      // Capture page errors
      page.on('pageerror', (error: Error) => {
        errors.push(error.message);
        pageErrors.push(error.message);
      });

      const domain = opts.domain;



      // Wrap code in HTML
      const html = HTMLWrapper.wrap(code, {
        domain: domain === 'glsl'
          ? 'shader'
          // textgen is plain text art: the ascii pre-wrap renders it faithfully.
          // Unmapped it fell through HTMLWrapper's default (wrapped AS CODE),
          // rendered blank, and every daemon-path textgen gen scored 0.06
          // (floor 0.1 x cap 0.6) — starving the archive's best domain.
          : domain === 'textgen'
            ? 'ascii'
            // kinetic, dataviz, meta, and nbe all emit complete HTML pages;
            // render them via the html pass-through wrapper (dataviz = D3 HTML,
            // meta = a custom-medium HTML page, nbe = the Neural Bloom Engine
            // cascade-field page, same self-contained shape as html).
            : domain === 'kinetic' || domain === 'dataviz' || domain === 'custom' || domain === 'nbe'
              ? 'html'
              : domain === 'unknown' ? undefined : domain
      });

      let renderSource = html;
      if (domain === 'tone' || domain === 'strudel') {
        // Instrumentation must exist in the page before Tone/strudel load:
        // prepend it into the head so it runs first.
        renderSource = HeadlessRenderer.audioCaptureScript(HeadlessRenderer.audioWindowMs(opts)) + renderSource;
      }

      if (domain === 'nbe') {
        // Count the convergence signal the page must post (Sol L3-09). Prepended like the audio hook: init scripts do not run for setContent.
        renderSource = HeadlessRenderer.NBE_CONVERGENCE_HOOK + renderSource;
      }

      // setContent runs at about:blank where /vendor/ URLs never resolve —
      // inline the vendored scripts first (#924). Missing vendor file throws
      // here: loud failure, no CDN fallback.
      // ES modules (Three) can't be inlined, and the wrapper CSP blocks data:
      // modules. Give those pages a private origin first, so 'self' covers
      // the routed /vendor/ module URLs and the CSP stays as written.
      const servedOrigin = containment.routeInstalled && typeof page.goto === 'function'
        && hasVendorImportMap(renderSource);
      if (servedOrigin) {
        await page.goto(`${RENDER_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
      }
      const renderHtml = await inlineVendorAssets(renderSource,
        (digest) => { assetDigests.add(digest); }, { keepImportMaps: servedOrigin });

      // Load the HTML
      signal.throwIfAborted();
      hold.candidateStarted = true;
      try {
        await page.setContent(renderHtml, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
      } catch (err) {
        throw engineLoadTimeoutError(renderHtml, err, opts.timeout) ?? err;
      }

      // Canvas-backed domains must be ready before capture.
      if (domainRequiresCanvas(domain)) {
        const canvasReady = await this.waitForCanvas(page, opts.timeout);
        if (!canvasReady) {
          const error = `Canvas not found or timed out for ${domain} render`;
          logs.push(`[warn] ${error}`);
          errors.push(error);
          return {
            success: false,
            error: naming(error),
            logs,
            errors,
            pageErrors,
            containment,
          };
        }

        // For hydra: wait for the first actual rendered frame, not just canvas
        // dimensions. This guards against headless WebGL failing silently (blank
        // output) due to rAF stalls or context initialization timing.
        if (domain === 'hydra') {
          const frameReady = await this.waitForFirstFrame(page, opts.timeout);
          if (!frameReady) {
            const error = `Hydra failed to render within timeout (blank output)`;
            logs.push(`[warn] ${error}`);
            errors.push(error);
            return {
              success: false,
              error: naming(error),
              logs,
              errors,
              pageErrors,
              containment,
            };
          }
        } else if (domain === 'three' || domain === 'glsl' || domain === 'p5') {
          // Capture after the first drawn frame, not the first canvas: async
          // setup (holo.ready, loaders) left early captures black. Soft: a
          // genuinely dark scene must not fail here. Probed from the
          // compositor, never getContext: claiming the canvas first broke
          // three's WebGL2 context (CI, 2026-11-17).
          const frameLit = await this.waitForLitCanvasScreenshot(page, Math.min(opts.timeout, HeadlessRenderer.SOFT_FIRST_FRAME_MS));
          if (!frameLit) logs.push(`[warn] no lit ${domain} frame within ${HeadlessRenderer.SOFT_FIRST_FRAME_MS} ms; capturing anyway`);
        }
      }
      // Trigger audio playback for audio domains so we capture actual sound
      if (domain === 'tone' || domain === 'strudel') {
        const playbackReceipt = await this.triggerAudioPlayback(page, domain);
        playback = { controlsAccessible: playbackReceipt.controlsAccessible,
          started: playbackReceipt.started };
        if (playbackReceipt.warning) {
          logs.push(`[warn] ${playbackReceipt.warning}`);
          errors.push(playbackReceipt.warning);
        }
      }

      // Both captured frames must show the evolved field. Wait for its first signal before capturing either.
      const readNbeSignals = (page: Page) => page.evaluate(() => (window as unknown as { __nbeConverged?: number }).__nbeConverged ?? 0).catch(() => 0);
      if (domain === 'nbe') {
        const limit = Number.isFinite(opts.nbeConvergenceTimeoutMs) ? opts.nbeConvergenceTimeoutMs : DEFAULT_OPTIONS.nbeConvergenceTimeoutMs;
        const waitMs = Math.min(opts.timeout, limit);
        let message: string | undefined;
        const deadline = Date.now() + waitMs;
        for (;;) {
          const status = await page.evaluate(() => {
            const engine = (window as unknown as { sinterEngine?: { state: string; error?: string } }).sinterEngine;
            return {
              id: document.documentElement.getAttribute('data-sinter-engine'),
              state: engine?.state, error: engine?.error,
              signals: (window as unknown as { __nbeConverged?: number }).__nbeConverged ?? 0,
            };
          });
          if (status.id && status.state === 'failed') {
            message = `ENGINE_FAILED:${status.id}: ${status.error ?? 'unknown failure'}`;
            break;
          }
          if (status.signals > 0 && (!status.id || status.state === 'ready')) break;
          if (Date.now() >= deadline) {
            message = status.id && status.state !== 'ready'
              ? `ENGINE_NOT_READY:${status.id}: not ready within ${waitMs} ms`
              : `NBE_NOT_CONVERGED: no "nbe:converged" message within ${waitMs} ms`;
            break;
          }
          await page.waitForTimeout(250);
        }
        if (message) {
          errors.push(message); pageErrors.push(message);
        }
      }

      // Wait for stabilization if requested
      if (opts.waitForStabilization) {
        await page.waitForTimeout(opts.stabilizationTime);
      }

      // Capture screenshot
      const screenshot = await this.captureScreenshot(page, opts);
      if (!screenshot.success && screenshot.error) {
        logs.push(`[warn] ${screenshot.error}`);
        errors.push(screenshot.error);
      }

      const stageTimeout = Math.min(opts.timeout, 2_000);
      let stagePaint = domain === 'hyperframes' && screenshot.success
        ? await this.hyperFramesStagePaints(page, stageTimeout) : undefined;

      // Preserve the distinct steady-state frame without a separate fixed delay.
      let lateScreenshot: ScreenshotResult | undefined;
      let arc: RenderResult['arc'];
      if (screenshot.success && opts.waitForStabilization) {
        if (arcClock) arc = await this.fastForwardArc(page, opts, renderClockAt);
        else await page.waitForTimeout(opts.lateCaptureDelay);
        lateScreenshot = await this.captureScreenshot(page, opts);
        if (!lateScreenshot.success) {
          logs.push(`[warn] late frame capture failed: ${lateScreenshot.error ?? 'unknown error'}`);
          lateScreenshot = undefined;
        }
      }

      if (domain === 'hyperframes' && stagePaint !== true && lateScreenshot?.success) {
        const latePaint = await this.hyperFramesStagePaints(page, stageTimeout);
        stagePaint = latePaint ?? stagePaint;
      }

      if (domain === 'nbe') {
        const signals = await readNbeSignals(page);
        logs.push(`[nbe] convergence signals observed: ${signals}`);
        if (signals > 1) logs.push(`[warn] nbe:converged posted ${signals} times; the contract says exactly once`);
      }

      // The surrounding preview shell does not attest a painted composition.
      if (domain === 'hyperframes') {
        logs.push(`[hyperframes] stage paint: ${stagePaint === true ? 'visible' : stagePaint === false ? 'empty' : 'unverified'}`);
        if (stagePaint !== true) {
          const message = stagePaint === false
            ? 'HYPERFRAMES_STAGE_EMPTY: the composition produced no visible pixels'
            : 'HYPERFRAMES_STAGE_UNVERIFIED: unable to inspect the composition pixels';
          errors.push(message); pageErrors.push(message);
        }
      }

      // After the late frame, so pointer events cannot change it.
      if (opts.observeInteraction) interaction = await this.observeInteraction(page);

      // Capture audio if applicable
      const audio = domain === 'tone' || domain === 'strudel'
        ? await this.captureAudio(page, opts, domain)
        : undefined;

      // A silent render caused by the piece's own runtime error (#1760): lead
      // with that error, the cause, and keep the empty-capture fact after it.
      if (audio && !audio.success && audio.error === HeadlessRenderer.EMPTY_AUDIO_ERROR) {
        const runtimeError = errors.find(message => message.trim().length > 0);
        if (runtimeError) audio.error = `${runtimeError.trim()} (${HeadlessRenderer.EMPTY_AUDIO_ERROR})`;
      }

      if (audio && !audio.success && audio.error) {
        logs.push(`[warn] ${audio.error}`);
        errors.push(audio.error);
      }
      if (audio?.warnings?.length) {
        for (const warning of audio.warnings) {
          logs.push(`[warn] ${warning}`);
          errors.push(warning);
        }
      }

      const pinnedAssetRequired = ['p5', 'three', 'hydra', 'tone', 'strudel'].includes(domain);
      if (opts.networkPolicy === 'isolated' && pinnedAssetRequired && assetDigests.size === 0) {
        throw new Error('RENDER_PINNED_RUNTIME_ASSET_REQUIRED');
      }
      const sortedAssetDigests = [...assetDigests].sort();
      // Invocation-local evidence object; no other task can observe or mutate it.
      // eslint-disable-next-line require-atomic-updates -- containment is a per-render local; no other task can observe or mutate it
      containment.assetDigests = sortedAssetDigests;
      // eslint-disable-next-line require-atomic-updates -- containment is a per-render local; no other task can observe or mutate it
      containment.runtimeDigest = createHash('sha256').update(JSON.stringify({
        rendererEnvironmentDigest: this.rendererEnvironmentDigest,
        assetDigests: sortedAssetDigests, domain, networkPolicy: opts.networkPolicy,
        limits: { maximumOutputBytes: opts.maximumOutputBytes,
          maximumEventListeners: opts.maximumEventListeners,
          maximumEvents: opts.maximumEvents, maximumTimers: opts.maximumTimers,
          maximumAudioContexts: opts.maximumAudioContexts,
          maximumHeapBytes: opts.maximumHeapBytes, maximumDurationMs: opts.maximumDurationMs },
      })).digest('hex');
      const postRunCensus = await this.collectPostRunCensus(page, renderClockAt, pagesBefore);
      // eslint-disable-next-line require-atomic-updates -- containment is a per-render local; no other task can observe or mutate it
      containment.postRunCensus = postRunCensus;
      if (postRunCensus.usedHeapBytes !== null
        && postRunCensus.usedHeapBytes > opts.maximumHeapBytes) {
        throw new Error('RENDER_HEAP_LIMIT_EXCEEDED');
      }
      if (postRunCensus.durationMs > opts.maximumDurationMs) {
        // Wall time counts host load too (#1752). An overloaded host, or a
        // page whose own main-thread work stayed under half the cap, means the
        // machine was slow, not the piece: report it as infrastructure so it is
        // rerun, not scored. Busy time alone cannot clear an animating piece,
        // because starvation stretches its tasks too.
        const busyMs = await readBusyMs();
        const loadPerCore = this.hostLoadPerCore();
        if (loadPerCore > 1 || (busyMs !== null && busyMs < opts.maximumDurationMs / 2)) {
          throw new Error(`RENDER_HOST_CONTENTION: wall ${postRunCensus.durationMs} ms, page busy ${busyMs ?? 'unknown'} ms, load/core ${loadPerCore.toFixed(2)}`);
        }
        throw new Error('RENDER_DURATION_LIMIT_EXCEEDED');
      }
      if (postRunCensus.eventsDispatched > opts.maximumEvents) {
        throw new Error('RENDER_EVENT_RATE_EXCEEDED');
      }
      if (postRunCensus.eventListeners > opts.maximumEventListeners) {
        throw new Error('RENDER_EVENT_LISTENER_LIMIT_EXCEEDED');
      }
      if (postRunCensus.timers > timerLimit) {
        throw new Error('RENDER_TIMER_LIMIT_EXCEEDED');
      }
      if (postRunCensus.audioContexts > opts.maximumAudioContexts) {
        throw new Error('RENDER_AUDIO_CONTEXT_LIMIT_EXCEEDED');
      }

      keepPage = opts.keepPageOpen;
      if (keepPage && ownedContext) {
        const context = ownedContext;
        page.once('close', () => { void context.close().catch(() => undefined); });
      }
      return {
        page: opts.keepPageOpen ? page : undefined,
        screenshot,
        lateScreenshot,
        ...(arc ? { arc } : {}),
        audio,
        // p5 makes its canvas before setup runs, so a sketch that throws still
        // yields a screenshot. A frame of a crashed piece is not a render.
        success: screenshot.success && pageErrors.length === 0,
        error: screenshot.success ? threw() : naming(screenshot.error || 'Screenshot failed'),
        logs,
        errors,
        pageErrors,
        containment,
        rendererEnvironmentDigest: this.rendererEnvironmentDigest,
        playback,
        interaction,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Render failed';
      Logger.error('HeadlessRenderer', 'Render failed:', error);
      const domain = opts.domain === 'unknown' ? HeadlessRenderer.detectDomain(code) : opts.domain;
      failureLogger.log({
        model: 'headless-renderer',
        provider: 'playwright',
        domain,
        prompt: 'Render generated artifact',
        code,
        error: `[render-degraded] ${message}`,
        errorType: 'degraded',
        duration: Date.now() - startedAt,
        codeLength: code.length,
      });
      return {
        success: false,
        error: naming(message),
        logs,
        errors,
        pageErrors,
        containment,
        rendererEnvironmentDigest: this.rendererEnvironmentDigest,
      };
    } finally {
      if (busyMeter) {
        await busyMeter.detach();
      }
      if ((ownedContext || page) && (!keepPage || signal.aborted)) {
        try {
          if (ownedContext) await ownedContext.close();
          else await page?.close();
          const context = ownedContext ?? this.context;
          const open = typeof context?.pages === 'function' ? context.pages() : undefined;
          const pagesAfter = open?.length ?? pagesBefore;
          if (containment.postRunCensus) containment.postRunCensus.pagesAfter = pagesAfter;
          // eslint-disable-next-line require-atomic-updates -- containment is a per-render local; no other task can observe or mutate it
          // Judge this request's page. Other reads on the shared context can change the census.
          containment.cleanupSucceeded = ownedContext
            ? open?.length === 0
            : Boolean(page?.isClosed() && !open?.includes(page));
        } catch (closeError) {
          Logger.debug('HeadlessRenderer', 'Failed to close render page:', closeError);
        }
      } else if (!page) {
        // eslint-disable-next-line require-atomic-updates -- containment is a per-render local; no other task can observe or mutate it
        containment.cleanupSucceeded = true;
      }
    }
  }

  private async installLocalAssetFallbacks(target: Page | BrowserContext,
    policy: 'assets-only' | 'isolated' = 'assets-only',
    onBlocked: () => void = () => undefined,
    onAsset: (digest: string) => void = () => undefined): Promise<boolean> {
    if (typeof target.route !== 'function') return false;

    await target.route('**/*', async (route) => {
      const url = route.request().url();
      try {
        if (url.startsWith(`${RENDER_ORIGIN}/`)) {
          // The renderer's private origin serves a blank page and pinned
          // /vendor/ files only; anything else is blocked.
          const pathname = new URL(url).pathname;
          if (pathname === '/') {
            await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
              body: '<!doctype html><html><head></head><body></body></html>' });
          } else if (isVendorAssetPath(pathname)) {
            const body = await readVendorAsset(pathname);
            onAsset(createHash('sha256').update(body).digest('hex'));
            await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body });
          } else {
            onBlocked();
            await route.abort('blockedbyclient');
          }
          return;
        }
        const asset = await getPinnedBrowserAssetForUrl(url);
        if (asset) {
          onAsset(asset.digest);
          await route.fulfill({
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
            body: asset.body,
          });
          return;
        }

        // Deny-by-default: generated artifact code must not reach arbitrary
        // hosts. Only the explicit CDN allowlist (and inert/loopback schemes)
        // may continue; everything else is aborted and logged.
        if (!isAllowedRenderRequestUrl(url, policy)) {
          onBlocked();
          Logger.warn('HeadlessRenderer', `Blocked off-allowlist request: ${url}`);
          await route.abort('blockedbyclient').catch((abortErr) => {
            Logger.debug('HeadlessRenderer', 'Route abort failed:', abortErr);
          });
          return;
        }

        await route.continue();
      } catch (err) {
        Logger.debug('HeadlessRenderer', 'Asset fallback route handling failed:', err);
        await route.abort('failed').catch((abortErr) => {
          Logger.debug('HeadlessRenderer', 'Route abort failed:', abortErr);
        });
      }
    });
    return true;
  }

  /** How long three/glsl/p5 renders wait for a lit frame before capturing anyway. */
  static readonly SOFT_FIRST_FRAME_MS = 5_000;

  /** Wall time kept back from maximumDurationMs for the late capture and census. */
  private static readonly ARC_DURATION_RESERVE_MS = 10_000;
  /** The probe needs about a second at full speed; throttled timers can stretch it, so allow ten. */
  private static readonly PROBE_DEADLINE_MS = 10_000;

  /** Domains whose late frame comes from piece time, not wall time (#1637). */
  private static readonly ARC_EXEMPT = new Set<string>(
    ['tone', 'strudel', 'svg', 'ascii', 'textgen', 'blender', 'revideo', 'unknown']);

  /** Put the page on Playwright's virtual clock when an arc horizon is asked for.
   * Time still flows in real time until the fast-forward. */
  private async installArcClock(page: Page, opts: Required<RenderOptions>): Promise<boolean> {
    if (!(opts.arcHorizonMs > 0) || HeadlessRenderer.ARC_EXEMPT.has(opts.domain)) return false;
    const clock = (page as Partial<Page>).clock;
    if (!clock || typeof clock.install !== 'function') return false;
    await clock.install();
    return true;
  }

  /** Advance piece time to the horizon in one-second steps, stopping at the
   * wall budget so a heavy scene can't hold the render past its limits. */
  private async fastForwardArc(page: Page, opts: Required<RenderOptions>, renderStartedAt: number)
    : Promise<NonNullable<RenderResult['arc']>> {
    const started = Date.now();
    // Frame-driven pieces must render every frame, so piece time only runs
    // ~1.5-2x wall time under swiftshader. Stop well inside the duration cap.
    const budgetMs = Math.min(opts.arcWallBudgetMs,
      opts.maximumDurationMs - (started - renderStartedAt) - HeadlessRenderer.ARC_DURATION_RESERVE_MS);
    const elapsedBeforeArc = opts.stabilizationTime;
    let reachedMs = elapsedBeforeArc;
    // runFor cannot be interrupted: a fixed one-second step on a piece whose
    // frames take ~0.5 s each (holospot foils on swiftshader) ran 30 s past the
    // budget and tripped RENDER_DURATION_LIMIT_EXCEEDED. Probe with a short
    // step, then size each step to the wall left at the measured cost.
    let wallPerPieceMs = 0;
    let step = Math.min(250, opts.arcHorizonMs - reachedMs);
    while (reachedMs < opts.arcHorizonMs && step > 0) {
      let left = budgetMs - (Date.now() - started);
      // A horizon more than 10x beyond the wall left is out of reach (foil
      // frames run ~17 ms of wall per ms of piece): the late frame lands
      // near the start either way, so spend half the budget, not all of it.
      if (wallPerPieceMs * (opts.arcHorizonMs - reachedMs) > 10 * left) {
        left = Math.min(left, budgetMs / 2 - (Date.now() - started));
      }
      if (left <= 0) break;
      if (wallPerPieceMs > 0) {
        const fits = Math.floor(left / wallPerPieceMs);
        if (fits < 100) break;
        step = Math.min(1_000, opts.arcHorizonMs - reachedMs, fits);
      }
      const t = Date.now();
      await page.clock.runFor(step);
      reachedMs += step;
      wallPerPieceMs = Math.max(wallPerPieceMs, (Date.now() - t) / step);
      if (wallPerPieceMs === 0) step = Math.min(1_000, opts.arcHorizonMs - reachedMs);
    }
    return { horizonMs: opts.arcHorizonMs, reachedMs, wallMs: Date.now() - started };
  }

  private async installContainmentGuards(page: Page, limits: {
    maximumEventListeners: number; maximumEvents: number; maximumTimers: number;
    maximumAudioContexts: number; maximumHeapBytes: number;
  }, context?: BrowserContext): Promise<boolean> {
    const target = context ?? page;
    if (typeof target.addInitScript !== 'function') return false;
    const install = (policy: typeof limits) => {
      const root = globalThis as unknown as Record<string, unknown>;
      if (root.__liminalContainmentInstalled) return;
      root.__liminalContainmentInstalled = true;
      const census = { eventListeners: 0, eventsDispatched: 0, timers: 0, audioContexts: 0,
        maximumHeapBytes: policy.maximumHeapBytes };
      root.__liminalContainmentCensus = census;
      const deny = () => Promise.reject(new Error('LIMINAL_PERMISSION_DENIED'));
      for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
        try { Object.defineProperty(globalThis, name, { get() {
          throw new Error('LIMINAL_STORAGE_DENIED'); }, configurable: false }); } catch { /* sealed */ }
      }
      const navigatorRecord = navigator as unknown as Record<string, unknown>;
      if (navigator.mediaDevices) {
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: deny });
      }
      if (navigator.clipboard) Object.defineProperties(navigator.clipboard,
        { read: { value: deny }, readText: { value: deny }, write: { value: deny },
          writeText: { value: deny } });
      if (navigator.credentials) Object.defineProperties(navigator.credentials,
        { get: { value: deny }, create: { value: deny }, store: { value: deny },
          preventSilentAccess: { value: deny } });
      navigatorRecord.webdriver = true;
      root.RTCPeerConnection = class { constructor() {
        throw new Error('LIMINAL_NETWORK_DENIED'); } };
      root.WebSocket = class { constructor() {
        throw new Error('LIMINAL_NETWORK_DENIED'); } };
      root.EventSource = class { constructor() {
        throw new Error('LIMINAL_NETWORK_DENIED'); } };
      const add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (...args) {
        if (++census.eventListeners > policy.maximumEventListeners) {
          return;
        }
        return add.apply(this, args as Parameters<typeof add>);
      };
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (...args) {
        if (++census.eventsDispatched > policy.maximumEvents) {
          return false;
        }
        return dispatch.apply(this, args as Parameters<typeof dispatch>);
      };
      for (const timerName of ['setTimeout', 'setInterval'] as const) {
        const original = globalThis[timerName];
        Object.defineProperty(globalThis, timerName, { value: (...args: unknown[]) => {
          if (++census.timers > policy.maximumTimers) {
            return 0;
          }
          return (original as (...values: unknown[]) => unknown)(...args);
        } });
      }
      for (const audioName of ['AudioContext', 'webkitAudioContext']) {
        const Original = root[audioName];
        if (typeof Original !== 'function') continue;
        root[audioName] = new Proxy(Original, { construct(target, args, newTarget) {
          if (++census.audioContexts > policy.maximumAudioContexts) {
            throw new Error('LIMINAL_AUDIO_CONTEXT_LIMIT_EXCEEDED');
          }
          return Reflect.construct(target, args, newTarget);
        } });
      }
    };
    const content = `const __name=(value)=>value;(${install.toString()})(${JSON.stringify(limits)});`;
    // No generated code runs before this context-wide policy is installed.
    await target.addInitScript({ content });
    if (typeof page.evaluate === 'function') await page.evaluate(content);
    return true;
  }

  /** One-minute load average per core; 0 where the OS does not report it. */
  private hostLoadPerCore(): number {
    const cores = os.cpus().length;
    return cores > 0 ? os.loadavg()[0] / cores : 0;
  }

  /**
   * Starts Chromium's per-page performance counters and returns a reader for
   * the page's main-thread busy time in ms plus an idempotent CDP session
   * detacher so render runs never leak CDP sessions.
   */
  private static async startBusyMeter(
    page: Page,
  ): Promise<{ read: () => Promise<number | null>; detach: () => Promise<void> }> {
    try {
      const session = await page.context().newCDPSession(page);
      await session.send('Performance.enable');
      let detached = false;
      return {
        read: async () => {
          if (detached) return null;
          try {
            const { metrics } = await session.send('Performance.getMetrics');
            const task = metrics.find((metric) => metric.name === 'TaskDuration');
            return typeof task?.value === 'number' ? Math.round(task.value * 1000) : null;
          } catch {
            return null;
          }
        },
        detach: async () => {
          if (detached) return;
          detached = true;
          try {
            await session.detach();
          } catch {
            // Page/context may already be closed.
          }
        },
      };
    } catch {
      return { read: () => Promise.resolve(null), detach: () => Promise.resolve() };
    }
  }

  private async collectPostRunCensus(page: Page, startedAt: number,
    pagesBefore: number): Promise<RenderPostRunCensus> {
    const observed = typeof page.evaluate === 'function' ? await page.evaluate(() => {
      const root = globalThis as unknown as { __liminalContainmentCensus?: {
        eventListeners?: number; eventsDispatched?: number;
        timers?: number; audioContexts?: number } };
      const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } };
      return { eventListeners: root.__liminalContainmentCensus?.eventListeners ?? 0,
        eventsDispatched: root.__liminalContainmentCensus?.eventsDispatched ?? 0,
        timers: root.__liminalContainmentCensus?.timers ?? 0,
        audioContexts: root.__liminalContainmentCensus?.audioContexts ?? 0,
        usedHeapBytes: memory.memory?.usedJSHeapSize ?? null };
    }) : { eventListeners: 0, eventsDispatched: 0,
      timers: 0, audioContexts: 0, usedHeapBytes: null };
    return { durationMs: Date.now() - startedAt, usedHeapBytes: observed.usedHeapBytes,
      eventListeners: observed.eventListeners, timers: observed.timers,
      eventsDispatched: observed.eventsDispatched,
      audioContexts: observed.audioContexts, pagesBefore, pagesAfter: pagesBefore + 1 };
  }

  /**
   * Render code and capture normalized RenderEvidence.
   *
   * Backward-compatible wrapper around `render()` that classifies failures
   * as infrastructure (browser unavailable) or candidate (code/JS error).
   */
  async renderWithEvidence(code: string, options: RenderOptions = {}): Promise<RenderEvidence> {
    const startTime = Date.now();

    // Hardened deployments (LIMINAL_NETWORK_ISOLATED_RENDER=true) vet candidate
    // code in the fully network-isolated Puppeteer sandbox FIRST. runInSandbox
    // denies all network requests except locally-fulfilled library scripts —
    // stronger than this renderer's CDN allowlist. It is purpose-built for p5
    // sketches (injects p5, waits for <canvas>), so the gate only applies to
    // the p5 domain; every other domain keeps the normal path. Default OFF, so
    // the standard render path is byte-for-byte unchanged.
    const domainHint = options.domain ?? HeadlessRenderer.detectDomain(code);
    if (isNetworkIsolatedRenderEnabled() && domainHint === 'p5') {
      const sandboxResult = await runInSandbox(code, { timeoutMs: options.timeout });
      if (!sandboxResult.completed) {
        return {
          timingMs: Date.now() - startTime,
          infraUnavailable: false,
          candidateFailure: true,
          ...(sandboxResult.error ? { failure: sandboxResult.error } : {}),
        };
      }
    }

    const result = await this.render(code, options);
    const timingMs = Date.now() - startTime;

    // Infrastructure failures: browser cannot start, missing binary, system-level errors.
    // Only the renderer's own reason counts: text the piece threw is removed, so
    // a sketch's "browser is not defined" is not read as a missing browser. A
    // captured frame proves the browser ran.
    const failureCause = classifyRenderFailure(result);
    const infraUnavailable = failureCause === 'host-contention' || failureCause === 'infra';

    // Candidate failures: JS errors, timeouts, canvas issues caused by bad code
    const candidateFailure = !result.success && !infraUnavailable && result.rendered !== false;

    return {
      rendered: result.rendered,
      timingMs,
      infraUnavailable,
      candidateFailure,
      ...(candidateFailure && result.error ? { failure: result.error } : {}),
      screenshotRef: result.screenshot?.success ? 'screenshot' : undefined,
      screenshot: result.screenshot?.success
        ? {
            mimeType: 'image/png',
            dataBase64: result.screenshot.buffer.toString('base64'),
            width: result.screenshot.width,
            height: result.screenshot.height,
          }
        : undefined,
      lateScreenshot: result.lateScreenshot?.success
        ? {
            mimeType: 'image/png',
            dataBase64: result.lateScreenshot.buffer.toString('base64'),
            width: result.lateScreenshot.width,
            height: result.lateScreenshot.height,
          }
        : undefined,
      logRef: result.logs.length > 0 ? 'logs' : undefined,
      logs: result.logs,
      errors: result.errors,
      audio: summarizeAudioCapture(result.audio),
      containment: result.containment,
      rendererEnvironmentDigest: result.rendererEnvironmentDigest,
      playback: result.playback,
      interaction: result.interaction,
    };
  }

  /** Runs the probe with a deadline: a page that swallows the probe's timers reports 'error', never hangs the render. */
  private async observeInteraction(page: Pick<Page, 'evaluate'>, deadlineMs = HeadlessRenderer.PROBE_DEADLINE_MS)
    : Promise<NonNullable<RenderEvidence['interaction']>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); });
    const probe = page.evaluate(
      `(() => { const __name = (value) => value; return (${probeInteraction.toString()})(); })()`) as Promise<
        NonNullable<RenderEvidence['interaction']>>;
    try {
      const seen = await Promise.race([probe.then(value => ({ value })), expired.then(() => undefined)]);
      if (seen) return seen.value;
      // A page too busy to answer the probe may not answer this either; give it one more second at most.
      const settled = page.evaluate(
        `(() => { const __name = (value) => value; (${settleInteractionProbe.toString()})(); })()`)
        .catch(() => undefined);
      await Promise.race([settled, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
      return { actions: 0, stateChanged: null, target: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wait for canvas element to be ready
   */
  private async waitForCanvas(page: Page, timeout: number): Promise<boolean> {
    try {
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector('canvas');
          return canvas && canvas.width > 0 && canvas.height > 0;
        },
        { timeout: Math.min(timeout, 5000) }
      );
      return true;
    } catch {
      // Canvas might not be required for all domains (e.g., audio-only)
      Logger.debug('HeadlessRenderer', 'No canvas found or timeout waiting for canvas');
      return false;
    }
  }

  /**
   * Wait for the first rendered frame on a canvas-backed page.
   *
   * Unlike waitForCanvas (which only checks dimensions), this polls pixel
   * data to confirm the renderer has actually drawn something. This guards
   * against headless WebGL failing silently (blank output) due to rAF stalls
   * or context initialization timing.
   *
   * Returns true if non-black pixels are detected within the timeout.
   * Returns false if the canvas stays blank (render-failed state).
   */
  /**
   * Poll the composited canvas until any pixel is non-black. Reads the
   * screenshot, not a context, so it cannot claim a canvas before the piece.
   */
  private async waitForLitCanvasScreenshot(page: Page, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const png = await page.locator('canvas').first().screenshot({ timeout: Math.max(1, deadline - Date.now()) });
        const { data } = await decodeImagePixels(png);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) return true;
        }
      } catch {
        // screenshot() already waited for a canvas until the deadline.
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  private async waitForFirstFrame(page: Page, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    let probeErrorLogged = false;
    while (Date.now() < deadline) {
      try {
        const probeMs = Math.min(100, Math.max(1, deadline - Date.now()));
        if (await page.evaluate(probeFrameLit, probeMs)) {
          Logger.debug('HeadlessRenderer', 'First frame detected');
          return true;
        }
      } catch (error) {
        // The canvas or its context may not exist yet; keep polling.
        if (!probeErrorLogged) {
          probeErrorLogged = true;
          Logger.debug('HeadlessRenderer', 'First-frame probe failed, still polling:', error);
        }
      }
      await page.waitForTimeout(100);
    }
    Logger.debug('HeadlessRenderer', 'No frame content detected within timeout');
    return false;
  }

  /**
   * Capture screenshot of the rendered output
   */
  private async hyperFramesStagePaints(page: Page, timeout: number): Promise<boolean | undefined> {
    const frame = page.locator('iframe.hyperframes-stage');
    const root = frame.contentFrame().locator('[data-composition-id]').first();
    try {
      const box = await frame.boundingBox({ timeout });
      const viewport = page.viewportSize();
      if (!box || !viewport) return undefined;
      const x = Math.ceil(Math.max(0, box.x));
      const y = Math.ceil(Math.max(0, box.y));
      const width = Math.floor(Math.min(viewport.width, box.x + box.width)) - x;
      const height = Math.floor(Math.min(viewport.height, box.y + box.height)) - y;
      // Only attest pixels visible in the preview. CSS scale bounds the decode on high-DPI browsers.
      if (width < 1 || height < 1 || width * height > 4_194_304) return undefined;
      const capture = () => page.screenshot({ clip: { x, y, width, height }, scale: 'css', timeout });
      const painted = await capture();
      const opacity = await root.evaluate(element => {
        const { style } = element as HTMLElement;
        const prior = { value: style.getPropertyValue('opacity'), priority: style.getPropertyPriority('opacity') };
        style.setProperty('opacity', '0', 'important');
        return prior;
      }, undefined, { timeout });
      let blank: Buffer;
      try {
        blank = await capture();
      } finally {
        await root.evaluate((element, prior) => {
          (element as HTMLElement).style.setProperty('opacity', prior.value, prior.priority);
        }, opacity, { timeout });
      }
      const [paintedImage, blankImage] = await Promise.all([decodeImagePixels(painted), decodeImagePixels(blank)]);
      if (paintedImage.width !== blankImage.width || paintedImage.height !== blankImage.height) return undefined;
      const { data } = paintedImage;
      return !Buffer.from(data.buffer, data.byteOffset, data.byteLength).equals(blankImage.data);
    } catch {
      return undefined;
    }
  }

  private async captureScreenshot(page: Page, opts: Required<RenderOptions>): Promise<ScreenshotResult> {
    try {
      // Capture just the canvas area. Clip a page screenshot rather than calling
      // canvas.screenshot(): an element screenshot waits for the element to stop
      // moving, so a canvas with an animated CSS transform took ~23s per capture
      // and the late frame hit the 30s timeout (live matrix 2026-11-10).
      const canvas = await page.$('canvas');
      const box = canvas ? await canvas.boundingBox() : null;
      const viewport = page.viewportSize() ?? { width: opts.width, height: opts.height };
      const x = Math.max(0, box?.x ?? 0);
      const y = Math.max(0, box?.y ?? 0);
      const width = Math.min(viewport.width, (box?.x ?? 0) + (box?.width ?? 0)) - x;
      const height = Math.min(viewport.height, (box?.y ?? 0) + (box?.height ?? 0)) - y;

      if (box && width >= 1 && height >= 1) {
        const buffer = await page.screenshot({
          type: 'png',
          omitBackground: opts.omitBackground,
          clip: { x, y, width, height },
        });

        return {
          buffer,
          width: Math.round(width),
          height: Math.round(height),
          success: true,
        };
      }

      // Fallback to full page screenshot
      const buffer = await page.screenshot({
        type: 'png',
        fullPage: false,
        omitBackground: opts.omitBackground,
      });

      return {
        buffer,
        width: opts.width,
        height: opts.height,
        success: true,
      };
    } catch (error) {
      return {
        buffer: Buffer.alloc(0),
        width: 0,
        height: 0,
        success: false,
        error: error instanceof Error ? error.message : 'Screenshot failed',
      };
    }
  }

  /**
   * Injects audio capture instrumentation into the page.
   * This must be called BEFORE setContent to intercept AudioContext creation.
   */
  /**
   * Audio-domain page instrumentation as an HTML <script> (tone/strudel).
   *
   * PREPENDED to the wrapped HTML: Playwright's addInitScript does not run for
   * setContent documents, so the old injection never existed inside embedded
   * renders — capture arrays stayed undefined and every tone/strudel render
   * heard silence regardless of the piece.
   */
  private static readonly NBE_CONVERGENCE_HOOK =
    '<script>window.__nbeConverged=0;window.addEventListener("message",function(e){if(e.data==="nbe:converged")window.__nbeConverged++;});</script>';

  private static audioCaptureScript(windowMs: number): string {
    // IIFE of the compiled module-level init (types erased by tsc).
    const maxSamples = Math.max(1, Math.floor(44_100 * windowMs / 1_000));
    // The shared music runtime first, so a stored playable that predates it
    // plays exactly as a fresh one does (idempotent on fresh pages).
    return musicRuntimeScript() + '<script>(' + audioCapturePageInit.toString() + `)(${maxSamples});</script>`;
  }
  /**
   * Polls the page for up to 3 s until it plays, fails, or says it is still
   * booting. "Ready." can last while a pattern evaluates, so idle is only
   * final at the end.
   */
  private async awaitPlayback(page: Page, domain: RenderDomain): Promise<PlaybackState> {
    let state: PlaybackState = 'waiting';
    for (let poll = 0; poll < 12; poll += 1) {
      state = await page.evaluate(readPlaybackState, domain).catch((): PlaybackState => 'waiting');
      if (state !== 'waiting' && state !== 'idle') return state;
      await page.waitForTimeout(250);
    }
    return state;
  }

  /**
   * A trusted press of a shell control. An artwork layer over the button
   * (a full-page canvas, a fixed panel) makes the mouse click wait out its
   * timeout (#1757); a focused button activated by Enter is still a trusted
   * gesture, whatever lies on top of it.
   */
  private static async pressControl(page: Page, selector: string): Promise<void> {
    try {
      await page.click(selector, { delay: 40, timeout: 2_000 });
    } catch {
      await page.focus(selector);
      await page.keyboard.press('Enter');
    }
  }

  /**
   * Presses the audio shell's Start button and reports whether the page then
   * plays; falls back to calling play() when there is no button.
   */
  private async triggerAudioPlayback(page: Page, domain: RenderDomain): Promise<{
    controlsAccessible: boolean; started: boolean; warning?: string }> {
    try {
      // Wait a short time for the page to initialize
      await page.waitForTimeout(500);

      // Any button on the page used to count, so every page passed. Only the
      // shell's own play button, visible, is a control a listener can use.
      let controlsAccessible = false;
      let started = false;
      // Trusted-gesture first: Chromium's autoplay policy only unlocks the
      // AudioContext inside a REAL user activation. Synthetic element.click()
      // from evaluate() is not trusted, so Tone.start()/ctx.resume() inside
      // the shell's handler stayed suspended and capture heard silence.
      // Playwright's click() dispatches a trusted event.
      const selector = PLAY_BUTTON[domain];
      if (selector) {
        try {
          await page.waitForSelector(selector, { state: 'visible', timeout: 4000 });
          controlsAccessible = true;
          // A press counts once the page plays. The Strudel shell ignores a
          // press until its sample banks load; press again while it boots.
          for (let press = 0; press < 4; press += 1) {
            if (press > 0) await page.waitForTimeout(1200);
            await HeadlessRenderer.pressControl(page, selector);
            const state = await this.awaitPlayback(page, domain);
            started = state === 'playing';
            if (state !== 'booting' && state !== 'idle') break;
          }
        } catch {
          started = false;
        }
      }
      if (!started) {
        // Fallback for shells without the canonical play button: invoke the
        // page's own play()/controls.start() entry points.
        started = await page.evaluate(async () => {
          const w = window as unknown as {
            play?: () => void | Promise<void>;
            controls?: { start: () => Promise<void> | void };
          };
          try {
            if (typeof w.play === 'function') { await w.play(); return true; }
            if (typeof w.controls?.start === 'function') { await w.controls.start(); return true; }
          } catch { /* fall through */ }
          return false;
        }).catch(() => false);
        // Calling play() is not playing: an untrusted call leaves audio suspended.
        if (started) started = await this.awaitPlayback(page, domain) === 'playing';
      }

      // Wait for audio to actually start
      await page.waitForTimeout(500);
      return { controlsAccessible, started };
    } catch (error) {
      Logger.debug('HeadlessRenderer', 'Failed to trigger audio playback:', error);
      // Non-fatal - audio might auto-play or not be needed
      return { controlsAccessible: false, started: false,
        warning: `Audio playback trigger failed for ${domain}: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  }

  /**
   * Capture audio output from the page
   * Uses Web Audio API to capture real audio data
   */
  /** How much sound the judge hears: audioCaptureMs, else the settle time. */
  private static audioWindowMs(opts: Pick<RenderOptions, 'audioCaptureMs' | 'stabilizationTime'>): number {
    const settle = opts.stabilizationTime ?? DEFAULT_OPTIONS.stabilizationTime;
    return opts.audioCaptureMs && opts.audioCaptureMs > 0 ? opts.audioCaptureMs : settle;
  }

  /**
   * Wait until the page has captured `windowMs` of sound, or `windowMs` has
   * passed. The capture opens at the first sound, so a piece that is still
   * arriving gets its full window and a silent one costs at most windowMs.
   */
  private async waitForAudioWindow(page: Page, windowMs: number): Promise<void> {
    const deadline = Date.now() + windowMs;
    for (;;) {
      const capturedMs = await page.evaluate(() => {
        const w = window as unknown as { __audioCaptureData?: number[]; __audioCaptureRate?: number };
        const rate = w.__audioCaptureRate && w.__audioCaptureRate > 0 ? w.__audioCaptureRate : 44100;
        return w.__audioCaptureData ? (w.__audioCaptureData.length / rate) * 1000 : 0;
      });
      const left = deadline - Date.now();
      if (capturedMs >= windowMs || left <= 0) return;
      await page.waitForTimeout(Math.min(250, left));
    }
  }

  private static readonly EMPTY_AUDIO_ERROR = 'No audio captured during render window';

  private async waitForFirstSound(page: Page, domain: RenderDomain): Promise<boolean> {
    const hasSound = () => page.evaluate(() =>
      Boolean((window as unknown as { __audioCaptureData?: number[] }).__audioCaptureData?.length));
    if (await hasSound()) return false;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const starting = domain === 'strudel'
        ? ['waiting', 'booting', 'idle'].includes(await page.evaluate(readPlaybackState, domain))
        : await page.evaluate(() => {
          const pageState = window as unknown as { __audioCaptureDestinations?: Array<{ context: { state: string } }> };
          const contexts = pageState.__audioCaptureDestinations ?? [];
          return contexts.some(node => node.context.state === 'suspended') && !contexts.some(node => node.context.state === 'running');
        });
      if (!starting) return false;
      await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
      if (await hasSound()) return true;
    }
    return false;
  }

  private async captureAudio(page: Page, opts: Required<RenderOptions>, domain: RenderDomain = 'tone'): Promise<AudioCaptureResult> {
    try {
      // Wait for audio to be captured during the stabilization period
      await page.waitForTimeout(opts.stabilizationTime);
      const windowMs = HeadlessRenderer.audioWindowMs(opts);
      const late = await this.waitForFirstSound(page, domain);
      if (late || windowMs > opts.stabilizationTime) await this.waitForAudioWindow(page, windowMs);

      // Retrieve the captured audio data
      const audioData = await page.evaluate((duration: number) => {
        const captureData = (window as unknown as { __audioCaptureData?: number[] }).__audioCaptureData;
        const captureWarnings = (window as unknown as { __audioCaptureWarnings?: string[] }).__audioCaptureWarnings || [];
        const incomplete = (window as unknown as { __audioCaptureIncomplete?: boolean }).__audioCaptureIncomplete === true;

        if (incomplete || !captureData || captureData.length === 0) {
          // No audio captured - return empty result
          return {
            samples: [] as number[],
            sampleRate: 44100,
            duration: duration / 1000,
            hasAudio: false,
            incomplete,
            warnings: captureWarnings,
          };
        }

        // Calculate actual duration based on sample rate
        // The rate of the context that produced the samples, not an assumed 44.1 kHz.
        const recordedRate = (window as unknown as { __audioCaptureRate?: number }).__audioCaptureRate;
        const sampleRate = recordedRate && recordedRate > 0 ? recordedRate : 44100;
        const durationSec = duration / 1000;
        const expectedSamples = Math.floor(sampleRate * durationSec);

        // Trim or pad to expected length
        let samples: number[];
        if (captureData.length >= expectedSamples) {
          samples = captureData.slice(0, expectedSamples);
        } else {
          // Pad with zeros if we didn't get enough samples
          samples = [...captureData, ...new Array(expectedSamples - captureData.length).fill(0)];
        }

        return {
          samples,
          sampleRate,
          duration: durationSec,
          hasAudio: true,
          warnings: captureWarnings,
        };
      }, windowMs);

      return {
        samples: new Float32Array(audioData.samples),
        sampleRate: audioData.sampleRate,
        duration: audioData.duration,
        success: audioData.hasAudio,
        error: audioData.incomplete ? 'AUDIO_CAPTURE_INCOMPLETE: multiple AudioContexts produced sound'
          : audioData.hasAudio ? undefined : HeadlessRenderer.EMPTY_AUDIO_ERROR,
        warnings: audioData.warnings,
      };
    } catch (error) {
      return {
        samples: new Float32Array(0),
        sampleRate: 44100,
        duration: 0,
        success: false,
        error: error instanceof Error ? error.message : 'Audio capture failed',
        warnings: [],
      };
    }
  }

  /**
   * Close the browser and clean up resources
   */
  async close(): Promise<void> {
    await this.initializing?.catch(() => undefined);
    // Detach before awaiting so a concurrent initialize() starts fresh
    // instead of reusing a browser that is being closed.
    const { context, browser } = this;
    this.context = null;
    this.browser = null;
    try {
      await context?.close();
    } catch (err) {
      Logger.debug('HeadlessRenderer', 'Context close error during shutdown:', err);
    } finally {
      await browser?.close().catch((err) => {
        Logger.debug('HeadlessRenderer', 'Browser close error during shutdown:', err);
      });
      if (HeadlessRenderer.instance === this) {
        HeadlessRenderer.instance = null;
      }
    }
    Logger.info('HeadlessRenderer', 'Browser closed');
  }

  /**
   * Check if renderer is initialized
   */
  isInitialized(): boolean {
    return this.browser !== null && this.context !== null;
  }
}

export { audioCapturePageInit };

export default HeadlessRenderer;

/**
 * Runs inside the page (Playwright serialises it, so it is self-contained): acts like a user and reports whether
 * the document or any canvas changed. Attempts run in order: the first interactive control, then, unless an
 * earlier attempt was credited, a pointer sequence at the centre of the largest visible canvas. Each attempt has its
 * own idle window, so a change the page makes on its own is never credited to the action.
 *
 * Controls get a dispatched click (SVG elements have no `.click()`). The canvas sequence goes to whatever element
 * is at the canvas centre, as a real pointer would, so overlays receive it. Snapshots are read inside an animation
 * frame because a WebGL canvas can read blank outside one. A crash reports target 'error', never 'none' (#1629, #1702).
 */
export type InteractionTarget = 'control' | 'canvas-pointer' | 'none' | 'error';
/**
 * What the probe did. `stateChanged` is true when any attempt was credited, null when an attempt could not be
 * attributed because the page also changed over an equal window with no action, false otherwise.
 */
export interface InteractionObservation { actions: number; stateChanged: boolean | null; target: InteractionTarget }

type ProbeLedger = { timers: number; settled: boolean };

/** Runs in the page when the probe misses its deadline: stops it scheduling more timers and takes the
 * ones it already counted back out of the census, so the post-run census sees only the piece's. */
export function settleInteractionProbe(): void {
  const root = globalThis as { __liminalContainmentCensus?: { timers: number }; __liminalProbe?: ProbeLedger };
  const ledger = root.__liminalProbe;
  if (!ledger || ledger.settled) return;
  ledger.settled = true;
  if (root.__liminalContainmentCensus) root.__liminalContainmentCensus.timers -= ledger.timers;
}

export async function probeInteraction(): Promise<InteractionObservation> {
  const settleMs = 100;
  // The containment census counts timers against the piece. The probe's own go in a ledger and are taken
  // back out once, by `finally` or by the renderer's deadline (settleInteractionProbe), whichever is first.
  const root = globalThis as { __liminalContainmentCensus?: { timers: number }; __liminalProbe?: ProbeLedger };
  const census = root.__liminalContainmentCensus;
  const ledger: ProbeLedger = { timers: 0, settled: false };
  root.__liminalProbe = ledger;
  try {
    const read = () => `${document.documentElement.innerHTML}|${Array.from(
      document.querySelectorAll('canvas')).map(canvas => {
        try { return canvas.toDataURL(); } catch { return ''; }
      }).join('|')}`;
    const wait = (callback: () => void) => {
      if (ledger.settled) throw new Error('PROBE_DEADLINE_PASSED');
      const counted = census?.timers ?? 0;
      const scheduled: unknown = setTimeout(callback, settleMs);
      ledger.timers += (census?.timers ?? 0) - counted;
      // The census returns 0 instead of scheduling once the piece is over its timer limit.
      if (scheduled === 0) throw new Error('PROBE_TIMER_REFUSED');
    };
    const snapshot = () => new Promise<string>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { resolve(read()); } catch { resolve(''); }
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
      wait(finish);
    });
    const settle = () => new Promise<void>(resolve => wait(resolve));
    const control = document.querySelector<Element>(
      'button:not([disabled]), [role="button"], input[type="range"]');
    let canvas: HTMLCanvasElement | undefined;
    let canvasArea = 0;
    for (const candidate of Array.from(document.querySelectorAll('canvas'))) {
      const box = candidate.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && box.width * box.height > canvasArea) {
        canvas = candidate;
        canvasArea = box.width * box.height;
      }
    }
    if (!control && !canvas) return { actions: 0, stateChanged: false, target: 'none' };
    const attempt = async (act: () => void): Promise<boolean | null> => {
      const idle = await snapshot();
      await settle();
      const before = await snapshot();
      act();
      await settle();
      const after = await snapshot();
      return idle !== before ? null : after !== before;
    };
    const attempts: Array<{ target: InteractionTarget; result: boolean | null }> = [];
    if (control) {
      const result = await attempt(() => {
        if (control instanceof HTMLInputElement && control.type === 'range') {
          const maximum = Number(control.max || 100);
          control.value = String(Math.min(maximum, Number(control.value || 0) + 1));
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      });
      attempts.push({ target: 'control', result });
    }
    if (canvas && !attempts.some(made => made.result === true)) {
      const box = canvas.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const result = await attempt(() => {
        const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
        const receiver: Element = hit ?? canvas;
        const at = { clientX: x, clientY: y, bubbles: true, cancelable: true };
        const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        for (const [Kind, type] of [[Pointer, 'pointermove'], [MouseEvent, 'mousemove'], [Pointer, 'pointerdown'],
          [MouseEvent, 'mousedown'], [Pointer, 'pointerup'], [MouseEvent, 'mouseup'], [MouseEvent, 'click']] as const) {
          receiver.dispatchEvent(new Kind(type, { ...at, pointerId: 1, isPrimary: true } as PointerEventInit));
        }
      });
      attempts.push({ target: 'canvas-pointer', result });
    }
    const credited = attempts.find(made => made.result === true);
    const stateChanged = credited ? true : attempts.some(made => made.result === null) ? null : false;
    return { actions: attempts.length, stateChanged, target: (credited ?? attempts[attempts.length - 1]).target };
  } catch {
    return { actions: 0, stateChanged: null, target: 'error' };
  } finally {
    if (!ledger.settled) {
      ledger.settled = true;
      if (census) census.timers -= ledger.timers;
    }
  }
}
