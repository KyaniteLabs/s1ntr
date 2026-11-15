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
import { createHash } from 'node:crypto';
import type { Browser, Page, BrowserContext, ConsoleMessage } from 'playwright';
import { HTMLWrapper } from '../utils/htmlWrapper.js';
import { hasVendorImportMap, inlineVendorAssets, isVendorAssetPath, readVendorAsset } from '../utils/vendorAssets.js';
import { failureLogger } from '../harness/FailureLogger.js';
import { Logger } from '../utils/Logger.js';
import { RenderEvidence } from '../core/types/GenerationEvaluation.js';
import { getPinnedBrowserAssetForUrl,
  resolveChromiumExecutablePath } from '../utils/browserAssetFallbacks.js';
import { missingChromiumError } from '../utils/browserPreflight.js';
import { getChromeArgs, isNetworkIsolatedRenderEnabled } from '../security/SandboxConfig.js';
import { runInSandbox } from '../sandbox/index.js';
import type { DomainString } from '../types/domains.js';
import { summarizeAudioCapture } from './AudioEvidence.js';
import { renderBlender } from './BlenderRenderer.js';

export type RenderDomain = Extract<DomainString, 'p5' | 'three' | 'glsl' | 'hydra' | 'strudel' | 'tone' | 'svg' | 'html' | 'dataviz' | 'meta' | 'ascii' | 'kinetic' | 'textgen' | 'hyperframes' | 'revideo' | 'blender' | 'unknown'>;

export interface RenderOptions {
  /** Canvas width in pixels */
  width?: number;
  /** Canvas height in pixels */
  height?: number;
  /** Timeout for rendering in milliseconds */
  timeout?: number;
  /** Whether to wait for animation/video to stabilize */
  waitForStabilization?: boolean;
  /** Stabilization time in milliseconds */
  stabilizationTime?: number;
  /** Delay after the early frame so slow motion is visible to evaluators. */
  lateCaptureDelay?: number;
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
  /** Error message if rendering failed */
  error?: string;
  /** Console logs from the page */
  logs: string[];
  /** Page errors */
  errors: string[];
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
  waitForStabilization: true,
  stabilizationTime: 500,
  lateCaptureDelay: 3000,
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

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }

  return ALLOWED_RENDER_HOSTS.has(host);
}

/** Private origin for pages that load pinned ES modules (.invalid never resolves). */
const RENDER_ORIGIN = 'http://sinter-render.invalid';

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
  const tempoSetter = (value: unknown): unknown => {
    const cps = (globalThis as Record<string, unknown>).setcps;
    const v = Number(value);
    if (typeof cps === 'function' && Number.isFinite(v) && v > 0) {
      try { return (cps as (x: number) => unknown)(v / 60); } catch { /* best effort */ }
    }
    return undefined;
  };
  const g = globalThis as Record<string, unknown>;
  if (typeof g.bpm !== 'function') g.bpm = tempoSetter;
  if (typeof g.setbpm !== 'function') g.setbpm = tempoSetter;

  const OriginalAudioContext = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!OriginalAudioContext) return;
  const captureSinks = new WeakMap<BaseAudioContext, ScriptProcessorNode>();
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
          let i = 0;
          if (captureData.length === 0) {
            while (i < inputData.length && inputData[i] === 0) i += 1;
          }
          if (captureData.length === 0 && i < inputData.length) {
            (window as unknown as { __audioCaptureRate: number }).__audioCaptureRate = ctxRate;
          }
          for (; i < inputData.length && captureData.length < cap; i += 1) {
            captureData.push(inputData[i]);
          }
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
  // strudel pattern-method shims: corpus pieces chain .bpm(...)/.tempo(...)/
  // .cpm(...) onto patterns (TidalCycles-style teaching drift); strudel has no
  // such methods, so the whole pattern eval crashed (silent). No-op methods
  // keep the piece playing at the scheduler's default tempo.
  let strudelPatternPatched = false;
  const patchStrudelPattern = () => {
    if (strudelPatternPatched) return;
    const P = (window as unknown as { strudel?: { Pattern?: { prototype: Record<string, unknown> } } }).strudel?.Pattern;
    if (!P?.prototype) return;
    const proto = P.prototype as Record<string, unknown> & { __liminalPatternShimmed?: boolean };
    if (proto.__liminalPatternShimmed) { strudelPatternPatched = true; return; }
    for (const m of ['bpm', 'cpm', 'tempo', 'setcpm', 'setbpm']) {
      if (typeof proto[m] !== 'function') {
        proto[m] = function (this: unknown) { return this; };
      }
    }
    proto.__liminalPatternShimmed = true;
    strudelPatternPatched = true;
  };
  patchStrudelPattern();
  setInterval(patchStrudelPattern, 200);
  // strudel short-name sample bank (bd/hh/cp...): the strudel.b-cdn.net
  // banks only carry machine-prefixed names, so corpus pieces using classic
  // Dirt short names triggered "sound bd not found" and stayed silent. Load
  // the Dirt-Samples bank the same way the real REPL does. Renderer-side so
  // STORED playables heal on replay/rescore (wrapper fix covers new pieces).
  let strudelBanked = false;
  const bankStrudel = async () => {
    if (strudelBanked) return;
    const sd = (window as unknown as { strudel?: { initStrudel?: () => Promise<unknown>; samples?: (u: string) => Promise<unknown> } }).strudel;
    if (!sd?.initStrudel || typeof sd.samples !== 'function') return;
    strudelBanked = true;
    try {
      await sd.initStrudel();
      await sd.samples('https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json');
    } catch { /* best effort */ }
  };
  void bankStrudel();
  setInterval(() => { void bankStrudel(); }, 300);
}

/**
 * Headless renderer for creative coding outputs
 */
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
        // Respect SandboxConfig: launch sandboxed by default; only pass
        // --no-sandbox when LIMINAL_DISABLE_SANDBOX=true (containerized/CI).
        const disableSandbox = process.env.LIMINAL_DISABLE_SANDBOX === 'true';
        const { chromium } = await import('playwright');
        this.browser = await chromium.launch({
          headless: true,
          executablePath,
          args: getChromeArgs({ forceDisableSandbox: disableSandbox }),
        });
        const browserVersion = typeof this.browser.version === 'function'
          ? this.browser.version()
          : 'unknown';
        this.rendererEnvironmentDigest = createHash('sha256').update(JSON.stringify({
          engine: 'playwright-chromium', executablePath,
          version: browserVersion })).digest('hex');
      }

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      if (typeof this.context.clearPermissions === 'function') {
        await this.context.clearPermissions();
        this.permissionsCleared = true;
      }

      Logger.info('HeadlessRenderer', 'Browser initialized');
    } catch (error) {
      Logger.error('HeadlessRenderer', 'Failed to initialize browser:', error);
      throw new Error(`Failed to initialize headless browser: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error instanceof Error ? error : undefined });
    }
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

  /** Run a bpy script headless and adapt the PNG to the screenshot shape the judges consume. */
  private static async renderBlenderScript(code: string): Promise<RenderResult> {
    const result = await renderBlender(code);
    if (!result.success || !result.png) {
      const error = result.error ?? 'Blender render failed';
      return { success: false, error, logs: result.logs, errors: [error] };
    }
    const shot: ScreenshotResult = {
      buffer: result.png, width: result.width ?? 0, height: result.height ?? 0, success: true,
    };
    return { rendered: true, success: true, screenshot: shot, lateScreenshot: shot, logs: result.logs, errors: [] };
  }

  /**
   * Render code and capture output
   */
  async render(code: string, options: RenderOptions = {}): Promise<RenderResult> {
    if (options.domain === 'revideo' || /data-revideo-timeline-preview/.test(code)
      || ((!options.domain || options.domain === 'unknown') && HeadlessRenderer.detectDomain(code) === 'revideo')) {
      const error = 'Revideo scene not rendered: wrapper is an approximation';
      return { rendered: false, success: false, error, logs: [], errors: [error] };
    }
    // Detect domain BEFORE applying options so we know whether to use hydra viewport
    const detectedDomain = options.domain === 'unknown' || !options.domain
      ? HeadlessRenderer.detectDomain(code)
      : options.domain;

    // Blender is a Python subprocess, not a browser page: it never touches Playwright.
    // It runs model-written code, so only an explicit domain opts in; code that merely
    // looks like bpy (unknown domain, no domain) is refused, never auto-routed.
    if (detectedDomain === 'blender') {
      if (options.domain === 'blender') return HeadlessRenderer.renderBlenderScript(code);
      const error = 'bpy script detected; Blender renders only run for an explicit blender domain';
      return { rendered: false, success: false, error, logs: [], errors: [error] };
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
    let playback: RenderResult['playback'];
    let interaction: RenderResult['interaction'];
    const startedAt = Date.now();

    try {
      if (Buffer.byteLength(code) > opts.maximumOutputBytes) {
        throw new Error('RENDER_OUTPUT_BYTES_EXCEEDED');
      }
      containment.outputLimitEnforced = true;
      await this.initialize();
      containment.permissionsDenied = this.permissionsCleared;

      if (!this.context) {
        throw new Error('Browser context not initialized');
      }

      pagesBefore = typeof this.context.pages === 'function' ? this.context.pages().length : 0;
      page = await this.context.newPage();
      const guardsInstalled = await this.installContainmentGuards(page, opts);
      containment.routeInstalled = await this.installLocalAssetFallbacks(page, opts.networkPolicy,
        () => { containment.blockedRequests++; }, digest => assetDigests.add(digest));
      containment.networkIsolated = opts.networkPolicy === 'isolated'
        && containment.routeInstalled && guardsInstalled;
      containment.timeoutEnforced = Number.isFinite(opts.timeout) && opts.timeout > 0;

      // Set viewport size
      await page.setViewportSize({ width: opts.width, height: opts.height });

      // Capture console logs
      page.on('console', (msg: ConsoleMessage) => {
        const log = `[${msg.type()}] ${msg.text()}`;
        logs.push(log);
        if (msg.type() === 'error') {
          errors.push(msg.text());
        }
      });

      // Capture page errors
      page.on('pageerror', (error: Error) => {
        errors.push(error.message);
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
            // kinetic, dataviz, and meta all emit complete HTML pages; render
            // them via the html pass-through wrapper (dataviz = D3 HTML, meta =
            // a custom-medium HTML page, same self-contained shape as html).
            : domain === 'kinetic' || domain === 'dataviz' || domain === 'meta'
              ? 'html'
              : domain === 'unknown' ? undefined : domain
      });

      let renderSource = html;
      if (domain === 'tone' || domain === 'strudel') {
        // Instrumentation must exist in the page before Tone/strudel load:
        // prepend it into the head so it runs first.
        renderSource = HeadlessRenderer.audioCaptureScript(opts.stabilizationTime) + renderSource;
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
      await page.setContent(renderHtml, { waitUntil: 'domcontentloaded', timeout: opts.timeout });

      // Canvas-backed domains must be ready before capture.
      if (domainRequiresCanvas(domain)) {
        const canvasReady = await this.waitForCanvas(page, opts.timeout);
        if (!canvasReady) {
          const error = `Canvas not found or timed out for ${domain} render`;
          logs.push(`[warn] ${error}`);
          errors.push(error);
          return {
            success: false,
            error,
            logs,
            errors,
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
              error,
              logs,
              errors,
              containment,
            };
          }
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

      if (opts.observeInteraction) interaction = await this.observeInteraction(page);

      // Preserve the distinct steady-state frame without a separate fixed delay.
      let lateScreenshot: ScreenshotResult | undefined;
      if (screenshot.success && opts.waitForStabilization) {
        await page.waitForTimeout(opts.lateCaptureDelay);
        lateScreenshot = await this.captureScreenshot(page, opts);
        if (!lateScreenshot.success) {
          logs.push(`[warn] late frame capture failed: ${lateScreenshot.error ?? 'unknown error'}`);
          lateScreenshot = undefined;
        }
      }

      // Capture audio if applicable
      const audio = domain === 'tone' || domain === 'strudel'
        ? await this.captureAudio(page, opts)
        : undefined;

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
      const postRunCensus = await this.collectPostRunCensus(page, startedAt, pagesBefore);
      // eslint-disable-next-line require-atomic-updates -- containment is a per-render local; no other task can observe or mutate it
      containment.postRunCensus = postRunCensus;
      if (postRunCensus.usedHeapBytes !== null
        && postRunCensus.usedHeapBytes > opts.maximumHeapBytes) {
        throw new Error('RENDER_HEAP_LIMIT_EXCEEDED');
      }
      if (postRunCensus.durationMs > opts.maximumDurationMs) {
        throw new Error('RENDER_DURATION_LIMIT_EXCEEDED');
      }
      if (postRunCensus.eventsDispatched > opts.maximumEvents) {
        throw new Error('RENDER_EVENT_RATE_EXCEEDED');
      }
      if (postRunCensus.eventListeners > opts.maximumEventListeners) {
        throw new Error('RENDER_EVENT_LISTENER_LIMIT_EXCEEDED');
      }
      if (postRunCensus.timers > opts.maximumTimers) {
        throw new Error('RENDER_TIMER_LIMIT_EXCEEDED');
      }
      if (postRunCensus.audioContexts > opts.maximumAudioContexts) {
        throw new Error('RENDER_AUDIO_CONTEXT_LIMIT_EXCEEDED');
      }

      return {
        page: opts.keepPageOpen ? page : undefined,
        screenshot,
        lateScreenshot,
        audio,
        success: screenshot.success,
        error: screenshot.success ? undefined : screenshot.error || 'Screenshot failed',
        logs,
        errors,
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
        error: message,
        logs,
        errors,
        containment,
        rendererEnvironmentDigest: this.rendererEnvironmentDigest,
      };
    } finally {
      if (page && !opts.keepPageOpen) {
        try {
          await page.close();
          const pagesAfter = this.context && typeof this.context.pages === 'function'
            ? this.context.pages().length : pagesBefore;
          if (containment.postRunCensus) containment.postRunCensus.pagesAfter = pagesAfter;
          // eslint-disable-next-line require-atomic-updates -- containment is a per-render local; no other task can observe or mutate it
          containment.cleanupSucceeded = pagesAfter === pagesBefore;
        } catch (closeError) {
          Logger.debug('HeadlessRenderer', 'Failed to close render page:', closeError);
        }
      } else if (!page) {
        containment.cleanupSucceeded = true;
      }
    }
  }

  private async installLocalAssetFallbacks(page: Page,
    policy: 'assets-only' | 'isolated' = 'assets-only',
    onBlocked: () => void = () => undefined,
    onAsset: (digest: string) => void = () => undefined): Promise<boolean> {
    if (typeof page.route !== 'function') return false;

    await page.route('**/*', async (route) => {
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

  private async installContainmentGuards(page: Page, limits: {
    maximumEventListeners: number; maximumEvents: number; maximumTimers: number;
    maximumAudioContexts: number; maximumHeapBytes: number;
  }): Promise<boolean> {
    if (typeof page.addInitScript !== 'function') return false;
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
    await page.addInitScript({ content });
    if (typeof page.evaluate === 'function') await page.evaluate(content);
    return true;
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
        };
      }
    }

    const result = await this.render(code, options);
    const timingMs = Date.now() - startTime;

    const errorMessage = result.error || '';
    const lowerError = errorMessage.toLowerCase();

    // Infrastructure failures: browser cannot start, missing binary, system-level errors
    const infraUnavailable = !result.success && (
      lowerError.includes('failed to initialize headless browser') ||
      lowerError.includes('browser context not initialized') ||
      lowerError.includes('executable') ||
      lowerError.includes('sandbox unavailable') ||
      lowerError.includes('playwright') ||
      lowerError.includes('chromium') ||
      lowerError.includes('browser') ||
      lowerError.includes('spawn') ||
      lowerError.includes('econnrefused')
    );

    // Candidate failures: JS errors, timeouts, canvas issues caused by bad code
    const candidateFailure = !result.success && !infraUnavailable && result.rendered !== false;

    return {
      rendered: result.rendered,
      timingMs,
      infraUnavailable,
      candidateFailure,
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

  private async observeInteraction(page: Page): Promise<NonNullable<RenderEvidence['interaction']>> {
    return page.evaluate(async () => {
      const target = document.querySelector<HTMLElement>(
        'button:not([disabled]), [role="button"], input[type="range"]');
      if (!target) return { actions: 0, stateChanged: false };
      const snapshot = () => `${document.documentElement.innerHTML}|${Array.from(
        document.querySelectorAll('canvas')).map(canvas => {
          try { return canvas.toDataURL(); } catch { return ''; }
        }).join('|')}`;
      const before = snapshot();
      if (target instanceof HTMLInputElement && target.type === 'range') {
        const maximum = Number(target.max || 100);
        target.value = String(Math.min(maximum, Number(target.value || 0) + 1));
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else target.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      return { actions: 1, stateChanged: snapshot() !== before };
    });
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
  private async waitForFirstFrame(page: Page, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;

    // For hydra: listen for the custom first-frame event first (most efficient).
    // The wrapper dispatches 'hydra:firstFrame' when pixels appear.
    let eventFired = false;
    const eventHandler = () => { eventFired = true; };
    await page.exposeFunction('__onHydraFirstFrame', eventHandler);
    await page.evaluate(() => {
      const handler = (window as unknown as Record<string, () => void>).__onHydraFirstFrame;
      window.addEventListener('hydra:firstFrame', handler);
    });

    while (Date.now() < deadline) {
      // Check if the custom event fired
      if (eventFired) {
        Logger.debug('HeadlessRenderer', 'First frame detected via event');
        return true;
      }

      try {
        // Sample the center pixel of the canvas. Any non-black value indicates
        // the renderer is producing frames.
        const hasContent = await page.evaluate((probeTimeoutMs) => new Promise<boolean>(resolve => {
          const sampleFrame = () => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return false;

            // Try WebGL context first (hydra, three, shader)
            const glCtx = canvas.getContext('webgl') || canvas.getContext('webgl2');
            if (glCtx) {
              // Read a center pixel
              const x = Math.floor(canvas.width / 2);
              const y = Math.floor(canvas.height / 2);
              const pixels = new Uint8Array(4);
              // WebGL renders upside-down; flip Y to match visual top
              glCtx.readPixels(x, canvas.height - 1 - y, 1, 1, glCtx.RGBA, glCtx.UNSIGNED_BYTE, pixels);
              // Any non-zero channel means something was rendered
              return pixels[0] > 0 || pixels[1] > 0 || pixels[2] > 0;
            }

            // Fall back to 2D canvas
            const ctx2d = canvas.getContext('2d');
            if (ctx2d) {
              const x = Math.floor(canvas.width / 2);
              const y = Math.floor(canvas.height / 2);
              const pixel = ctx2d.getImageData(x, y, 1, 1).data;
              return pixel[0] > 0 || pixel[1] > 0 || pixel[2] > 0;
            }

            return false;
          };
          // WebGL may clear its drawing buffer after presentation. Read in the
          // animation frame, when Hydra has drawn, rather than between frames.
          let frame = 0;
          const timer = setTimeout(() => {
            cancelAnimationFrame(frame);
            resolve(false);
          }, probeTimeoutMs);
          frame = requestAnimationFrame(() => {
            clearTimeout(timer);
            try { resolve(sampleFrame()); } catch { resolve(false); }
          });
        }), Math.min(100, Math.max(1, deadline - Date.now())));

        if (hasContent) {
          Logger.debug('HeadlessRenderer', 'First frame detected');
          return true;
        }

        // Give the render loop time to produce a frame
        await page.waitForTimeout(100);
      } catch {
        // Non-fatal: canvas may not be ready yet, keep polling
        await page.waitForTimeout(100);
      }
    }

    Logger.debug('HeadlessRenderer', 'No frame content detected within timeout');
    return false;
  }

  /**
   * Capture screenshot of the rendered output
   */
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
  private static audioCaptureScript(stabilizationTime: number): string {
    // IIFE of the compiled module-level init (types erased by tsc).
    const maxSamples = Math.max(1, Math.floor(44_100 * stabilizationTime / 1_000));
    return '<script>(' + audioCapturePageInit.toString() + `)(${maxSamples});</script>`;
  }
  /**
   * Trigger audio playback for Tone.js or Strudel content.
   * This clicks the play button or calls play functions to ensure audio is actually playing.
   */
  private async triggerAudioPlayback(page: Page, domain: RenderDomain): Promise<{
    controlsAccessible: boolean; started: boolean; warning?: string }> {
    try {
      // Wait a short time for the page to initialize
      await page.waitForTimeout(500);

      const controlsAccessible = await page.evaluate(() => Boolean(
        document.getElementById('playBtn') || document.querySelector('button')))
        .catch(() => false);
      let started = false;
      // Trusted-gesture first: Chromium's autoplay policy only unlocks the
      // AudioContext inside a REAL user activation. Synthetic element.click()
      // from evaluate() is not trusted, so Tone.start()/ctx.resume() inside
      // the shell's handler stayed suspended and capture heard silence.
      // Playwright's click() dispatches a trusted event.
      if (domain === 'tone' || domain === 'strudel') {
        const selector = domain === 'tone' ? '#start' : '#sinter-strudel-play';
        try {
          await page.waitForSelector(selector, { timeout: 4000 });
          await page.click(selector, { delay: 40 });
          started = true;
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
  private async captureAudio(page: Page, opts: Required<RenderOptions>): Promise<AudioCaptureResult> {
    try {
      // Wait for audio to be captured during the stabilization period
      await page.waitForTimeout(opts.stabilizationTime);

      // Retrieve the captured audio data
      const audioData = await page.evaluate((duration: number) => {
        const captureData = (window as unknown as { __audioCaptureData?: number[] }).__audioCaptureData;
        const captureWarnings = (window as unknown as { __audioCaptureWarnings?: string[] }).__audioCaptureWarnings || [];

        if (!captureData || captureData.length === 0) {
          // No audio captured - return empty result
          return {
            samples: [] as number[],
            sampleRate: 44100,
            duration: duration / 1000,
            hasAudio: false,
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
      }, opts.stabilizationTime);

      return {
        samples: new Float32Array(audioData.samples),
        sampleRate: audioData.sampleRate,
        duration: audioData.duration,
        success: audioData.hasAudio,
        error: audioData.hasAudio ? undefined : 'No audio captured during render window',
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
    await context?.close();
    await browser?.close();

    HeadlessRenderer.instance = null;
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
