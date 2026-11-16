/**
 * GUI backend: Express app that serves config API and (later) run() from dist/index.js.
 * Export createApp(configPath) for testing; start.js calls createApp() and listen().
 */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { loadConfig, loadProjectConfig, getEffectiveConfig, updateConfig } from '../dist/config/ConfigLoader.js';
import { Gallery } from '../dist/gallery/Gallery.js';
import { eventBus } from '../dist/core/EventBus.js';
import { TuiBridgeService } from '../dist/tui-bridge/TuiBridgeService.js';
import { VENDOR_ASSETS, isVendorAssetPath, readVendorAsset } from '../dist/utils/vendorAssets.js';
import { applyBridgeProviderEnv, resolveBridgeProviderConfig, summarizeBridgeRuntime } from '../dist/tui-bridge/BridgeLauncherConfig.js';
import { LLMClient } from '../dist/llm/LLMClient.js';
import { logSecurityEvent } from '../dist/security/SecurityLogger.js';
import { collectRepositoryOpportunityEvidence, scanGreenSystemOpportunities } from '../dist/improvement/OpportunityScanner.js';
import { buildGuiBridgeInput } from './bridgeInput.js';
import { prepareComposition } from '../dist/composition/CompositionGraph.js';
import { bootstrapProductionDreamRuntime, bootstrapProductionLiminalRuntime }
  from '../dist/runtime-core/ProductionLiminalRuntime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const homeDir = process.env.HOME || '';
const tempDir = os.tmpdir();

const DEFAULTS = {
  loop: { maxIterations: 20, timeoutMinutes: 30 },
  creative: { minQualityScore: 0.7 },
  galleryPath: 'gallery',
};
const STORED_SECRET_SENTINEL = '(stored)';

/**
 * Validate a gallery path to prevent path traversal attacks.
 * Rejects paths containing '..', rejects absolute paths outside cwd/HOME,
 * and resolves relative paths against cwd.
 * @param {string} galleryPath
 * @returns {string} resolved absolute path
 * @throws {Error} on invalid path
 */
function validateGalleryPath(galleryPath) {
  if (!galleryPath || typeof galleryPath !== 'string') {
    throw new Error('Invalid gallery path');
  }
  if (galleryPath.includes('..')) {
    throw new Error('Invalid gallery path');
  }
  const resolved = path.resolve(cwd, galleryPath);
  let canonical;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  const allowedRoots = [cwd, homeDir, tempDir]
    .filter(Boolean)
    .map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    });
  const insideAllowedRoot = allowedRoots.some((root) => {
    const relative = path.relative(root, canonical);
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (path.isAbsolute(galleryPath)) {
    if (!insideAllowedRoot) {
      throw new Error('Invalid gallery path');
    }
  } else {
    const relative = path.relative(cwd, canonical);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid gallery path');
    }
  }
  return canonical;
}

function normalizedBpm(value, fallback = 120) {
  const bpm = Number(value);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : fallback;
}

function safeTraitLabel(value, fallback) {
  const label = typeof value === 'string' ? value.trim() : '';
  return (label || fallback).replace(/[^\w -]/g, '').slice(0, 60) || fallback;
}

function withBpmLine(musicCode, bpm) {
  const cps = bpm / 60;
  const line = `setcps(${cps})`;
  const code = typeof musicCode === 'string' && musicCode.trim()
    ? musicCode.trim()
    : 'n("c4").sound("sine")';
  return /\bsetcps\s*\([^)]*\)/.test(code)
    ? code.replace(/\bsetcps\s*\([^)]*\)/, line)
    : `${line}\n${code}`;
}

function withPaletteComment(visualCode, palette) {
  const code = typeof visualCode === 'string' && visualCode.trim()
    ? visualCode.trim()
    : 'osc(0.2).out();';
  const comment = `// palette: ${palette}`;
  return /^\/\/ palette: .*$/m.test(code)
    ? code.replace(/^\/\/ palette: .*$/m, comment)
    : `${comment}\n${code}`;
}

function deterministicMusicCode(promptLabel) {
  return [
    `// deterministic organism: ${promptLabel}`,
    'stack(',
    '  s("bd ~ hh ~").gain(0.75),',
    '  note("c4 e4 g4 b4").sound("sine").slow(2).gain(0.45)',
    ').room(0.25)',
  ].join('\n');
}

function deterministicVisualCode(bpm) {
  const rate = Math.max(0.05, bpm / 600);
  return [
    `osc(${rate}, 0.08, 0.8)`,
    '  .kaleid(4)',
    '  .color(0.9, 0.45, 0.2)',
    '  .rotate(0.1)',
    '  .modulate(noise(2.5), 0.08)',
    '  .blend(shape(4, 0.35).luma(0.2), 0.25)',
    '  .out(o0);',
  ].join('\n');
}

function buildDeterministicOrganism(prompt, traits = {}, seed = {}) {
  const bpm = normalizedBpm(traits.bpm);
  const palette = safeTraitLabel(traits.palette, 'default');
  const seedMusic = seed.musicCode || '';
  const seedVisual = seed.visualCode || '';
  const promptLabel = safeTraitLabel(prompt, 'ambient');
  const baseMusic = seedMusic || deterministicMusicCode(promptLabel);
  const baseVisual = seedVisual || deterministicVisualCode(bpm);
  return {
    type: 'organism',
    musicCode: withBpmLine(baseMusic, bpm),
    visualCode: withPaletteComment(baseVisual, palette),
  };
}

// In-memory store for "Run in preview" so GET /preview can serve the code
const previewStore = new Map();
let productionRuntimePromise;
let productionDreamRuntimePromise;
function productionRuntime() {
  productionRuntimePromise ??= bootstrapProductionLiminalRuntime();
  return productionRuntimePromise;
}
function productionDreamRuntime() {
  productionDreamRuntimePromise ??= bootstrapProductionDreamRuntime();
  return productionDreamRuntimePromise;
}
const productionCommands = {
  submitCreate: (...args) => productionRuntime().then(runtime => runtime.port.submitCreate(...args)),
  propose: (...args) => productionRuntime().then(runtime => runtime.port.propose(...args)),
  projection: (...args) => productionRuntime().then(runtime => runtime.port.projection(...args)),
  verifiedCreate: (...args) => productionRuntime().then(runtime => runtime.port.verifiedCreate(...args)),
  verifiedArtifact: (...args) => productionRuntime().then(runtime => runtime.port.verifiedArtifact(...args)),
};
const productionDreamCommands = {
  run: (...args) => productionDreamRuntime().then(runtime => {
    if (!runtime.dream) throw new Error('DREAM_PRODUCT_RUNTIME_NOT_CONFIGURED');
    return runtime.dream.run(...args);
  }),
};
const productionDreamTransferCommands = {
  run: (...args) => productionDreamRuntime().then(runtime => {
    if (!runtime.dreamTransfer) throw new Error('DREAM_TRANSFER_RUNTIME_NOT_CONFIGURED');
    return runtime.dreamTransfer.run(...args);
  }),
};
const productionDreamActivationCommands = {
  run: (...args) => productionDreamRuntime().then(runtime => {
    if (!runtime.dreamActivation) throw new Error('DREAM_ACTIVATION_RUNTIME_NOT_CONFIGURED');
    return runtime.dreamActivation.run(...args);
  }),
};
const productionCompoundCreateCommands = {
  run: (...args) => productionDreamRuntime().then(runtime => {
    if (!runtime.compoundCreate) throw new Error('COMPOUND_CREATE_RUNTIME_NOT_CONFIGURED');
    return runtime.compoundCreate.run(...args);
  }),
};
const tuiBridge = new TuiBridgeService({
  ownerReactionPath: process.env.SINTER_ORGANISM_STATE_PATH
    || path.join(homeDir || '.', '.sinter', 'organism', 'owner-reactions.json'),
  productCommands: productionCommands,
  productCreateCommand: (...args) => productionRuntime().then(runtime =>
    runtime.createCommand(...args)),
  dreamCommands: productionDreamCommands,
  dreamTransferCommands: productionDreamTransferCommands,
  dreamActivationCommands: productionDreamActivationCommands,
  compoundCreateCommands: productionCompoundCreateCommands,
});

const P5_SENSOR_POLICY_SCRIPT = `
  <script>
    (function liminalSensorPolicy() {
      const nativeAddEventListener = window.addEventListener.bind(window);
      window.addEventListener = function(type, listener, options) {
        const eventName = String(type).toLowerCase();
        if (eventName === 'devicemotion' || eventName === 'deviceorientation' || eventName === 'deviceorientationabsolute') return;
        return nativeAddEventListener(type, listener, options);
      };
      try { Object.defineProperty(window, 'DeviceMotionEvent', { value: undefined, configurable: true }); } catch {}
      try { Object.defineProperty(window, 'DeviceOrientationEvent', { value: undefined, configurable: true }); } catch {}
    })();
  </script>`;
const STUDIO_HSTS_HEADER = 'max-age=31536000; includeSubDomains';

function setStudioCommonSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', STUDIO_HSTS_HEADER);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function setPreviewSecurityHeaders(res, options = {}) {
  const organism = options.profile === 'organism';
  setStudioCommonSecurityHeaders(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "upgrade-insecure-requests",
    organism
      ? "script-src 'unsafe-inline' 'unsafe-eval' 'self'"
      : "script-src 'unsafe-inline' 'self'",
    "style-src 'unsafe-inline'",
    "img-src * data: blob:",
    "media-src * data: blob:",
    "connect-src 'none'",
    "font-src 'none'",
    "frame-src 'none'",
    "sandbox allow-scripts",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape every `</script` (any case, any trailing whitespace or `/`) — the
// HTML parser ends a script element there, not only at a literal `</script>`.
// Same rule as escapeScriptClose in src/utils/vendorAssets.ts.
function escapeScript(value) {
  return String(value).replace(/<\/script/gi, '<\\/script');
}

function parseOrganismPreview(code) {
  try {
    const parsed = JSON.parse(code);
    if (parsed?.type !== 'organism') return null;
    return {
      musicCode: typeof parsed.musicCode === 'string' ? parsed.musicCode : '',
      visualCode: typeof parsed.visualCode === 'string' ? parsed.visualCode : '',
    };
  } catch {
    return null;
  }
}

function renderOrganismPreview({ musicCode, visualCode }, version) {
  const safeMusic = escapeHtml(musicCode || 'No Strudel layer was saved.');
  const safeVisual = escapeHtml(visualCode || 'No Hydra visual layer was saved.');
  const runnableVisual = visualCode ? escapeScript(visualCode) : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Permissions-Policy" content="accelerometer=(), gyroscope=(), magnetometer=(), deviceorientation=(), devicemotion=()">
  <title>Organism Preview v${version}</title>
  <script src="${VENDOR_ASSETS.hydra}"></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #05070d; color: #eaf2ff; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .organism { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 420px); }
    .visual { position: relative; min-height: 100vh; background: #000; overflow: hidden; }
    #hydra-canvas { width: 100%; height: 100%; display: block; }
    .panel { border-left: 1px solid rgba(143, 166, 210, 0.26); background: rgba(10, 14, 24, 0.92); padding: 22px; display: flex; flex-direction: column; gap: 16px; }
    h1, h2 { margin: 0; }
    h1 { font-size: 20px; }
    h2 { color: #66e7ff; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 14px; border: 1px solid rgba(143, 166, 210, 0.24); border-radius: 12px; background: rgba(3, 6, 13, 0.84); color: #d8f6ff; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .error { position: absolute; left: 24px; bottom: 24px; max-width: min(640px, calc(100% - 48px)); color: #ff8585; background: rgba(0, 0, 0, 0.82); border: 1px solid rgba(255, 120, 120, 0.42); border-radius: 12px; padding: 12px; font: 12px/1.4 ui-monospace, monospace; display: none; }
  </style>
</head>
<body>
  <main class="organism">
    <section class="visual" aria-label="Hydra visual layer">
      <canvas id="hydra-canvas"></canvas>
      <pre id="hydra-error" class="error"></pre>
    </section>
    <aside class="panel" aria-label="Organism source layers">
      <div>
        <h2>Organism Preview</h2>
        <h1>Strudel + Hydra organism</h1>
      </div>
      <section>
        <h2>Strudel layer</h2>
        <pre>${safeMusic}</pre>
      </section>
      <section>
        <h2>Hydra visual layer</h2>
        <pre>${safeVisual}</pre>
      </section>
    </aside>
  </main>
  <script>
    window.fetch = undefined;
    window.XMLHttpRequest = undefined;
    window.WebSocket = undefined;
    window.EventSource = undefined;
    window.open = undefined;
    const errorEl = document.getElementById('hydra-error');
    try {
      const canvas = document.getElementById('hydra-canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const hydra = new Hydra({ canvas, detectAudio: false, enableStreamCapture: false });
      const go = () => {};
      const o = typeof o0 !== 'undefined' ? o0 : undefined;
      ${runnableVisual}
    } catch (e) {
      errorEl.style.display = 'block';
      errorEl.textContent = 'Hydra preview error: ' + e.message;
    }
  </script>
</body>
</html>`;
}

function resolveGuiBridgeProvider() {
  const providerConfig = resolveBridgeProviderConfig();
  applyBridgeProviderEnv(process.env, providerConfig);
  return providerConfig;
}

function createGuiBridgeLLM() {
  resolveGuiBridgeProvider();
  // Studio artifact generation must run on the GENERATOR role (the configured
  // generator model), not the harness. Routing it through 'harness' sent every
  // generation to the harness model (e.g. MiniMax-M3) — slower for full
  // artifacts and semantically wrong (harness is for meta-reasoning). Generator
  // temperature (0.7) suits creative codegen.
  return new LLMClient({
    role: 'generator',
    temperature: 0.7,
    maxTokens: 4096,
  });
}

function unwrapConfigResult(result) {
  return result && typeof result.match === 'function'
    ? result.match((config) => config, () => null)
    : result;
}

function sanitizeRoles(roles = {}) {
  return Object.fromEntries(Object.entries(roles).map(([role, cfg]) => [role, {
    provider: cfg?.provider,
    baseUrl: cfg?.baseUrl,
    model: cfg?.model,
    apiKeyStored: Boolean(cfg?.apiKey),
  }]));
}

function sanitizeProviders(providers = {}) {
  return Object.fromEntries(Object.entries(providers).map(([provider, cfg]) => [provider, {
    baseUrl: cfg?.baseUrl,
    model: cfg?.model,
    apiKeyStored: Boolean(cfg?.apiKey),
  }]));
}

function sanitizeConfigForClient(config) {
  if (!config) return null;
  return {
    defaultProvider: config.defaultProvider,
    providers: sanitizeProviders(config.providers || {}),
    roles: sanitizeRoles(config.roles || {}),
    loop: config.loop,
    creative: config.creative,
    galleryPath: config.galleryPath,
  };
}

function mergeProviderConfigs(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [name, cfg] of Object.entries(incoming)) {
    const previous = existing[name] || {};
    merged[name] = {
      ...previous,
      ...cfg,
      apiKey: resolveSecretValue(cfg?.apiKey, previous.apiKey, cfg, previous),
    };
  }
  return merged;
}

function mergeRoleConfigs(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [role, cfg] of Object.entries(incoming)) {
    const previous = existing[role] || {};
    merged[role] = {
      ...previous,
      ...cfg,
      apiKey: resolveSecretValue(cfg?.apiKey, previous.apiKey, cfg, previous),
    };
  }
  return merged;
}

function resolveSecretValue(incoming, existing, incomingConfig = {}, existingConfig = {}) {
  if (incoming === STORED_SECRET_SENTINEL || incoming === undefined) {
    return isSameSecretTarget(incomingConfig, existingConfig) ? existing : undefined;
  }
  if (typeof incoming === 'string' && incoming.trim() === '') return undefined;
  return incoming;
}

// A stored key may only follow a save that keeps the same provider and the
// same endpoint origin. Compare the effective values after the merge (an absent
// field keeps the old value); unset vs set counts as a change, so a client
// cannot point a stored key at a new host by adding a baseUrl.
function isSameSecretTarget(incoming = {}, existing = {}) {
  const provider = (cfg) => cfg.provider || undefined;
  const effectiveProvider = incoming.provider !== undefined ? provider(incoming) : provider(existing);
  if (effectiveProvider !== provider(existing)) return false;
  const effectiveBaseUrl = incoming.baseUrl !== undefined ? incoming.baseUrl : existing.baseUrl;
  return endpointOrigin(effectiveBaseUrl) === endpointOrigin(existing.baseUrl);
}

function endpointOrigin(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return undefined;
  try {
    return new URL(baseUrl.trim()).origin;
  } catch {
    return `invalid:${baseUrl.trim()}`;
  }
}

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];
const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::']);

/** Host names Studio answers to, or null when bound to every interface (token-gated by start.js). */
function studioAllowedHosts(extra = []) {
  const bindHost = (process.env.SINTER_GUI_HOST ?? process.env.LIMINAL_GUI_HOST ?? '').trim().toLowerCase();
  if (WILDCARD_HOSTNAMES.has(bindHost)) return null;
  const names = [...LOOPBACK_HOSTNAMES, ...extra];
  if (bindHost) names.push(bindHost);
  return new Set(names.map((name) => name.toLowerCase().replace(/^\[|\]$/g, '')));
}

/** Hostname from a Host header without port or IPv6 brackets; null when absent. */
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * True when a browser sent this write from another site. allowedHosts null
 * (bound to every interface, token-gated) skips the Origin host match only.
 */
function isCrossSiteWrite(headers, allowedHosts) {
  if (headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = headers.origin;
  if (origin === undefined) return false;
  if (origin === 'null') return true;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  return allowedHosts !== null && !allowedHosts.has(hostname);
}

const STUDIO_SESSION_COOKIE = 'sinter_studio_session';

/** Routes that show or change private Studio data. The app shell stays public. */
function isPrivateStudioPath(pathname) {
  return pathname.startsWith('/api/') || pathname === '/progress' || pathname === '/preview';
}

/** One cookie's value from a Cookie header, or null. */
function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Constant-time token comparison (hashing first hides the length). */
function tokensMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// F5: CSRF protection on SSE endpoints
function validateSSEOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next(); // no origin = non-browser client, allow
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return next();
    }
  } catch { /* invalid URL, deny */ }
  res.status(403).json({ error: 'Forbidden origin' });
}

/**
 * @param {string} [configPath] - Override path to ~/.sinter/config.json (e.g. for tests)
 * @param {number} [port] - Backend port (for preview URL in response)
 * @param {{commandBridge?: Pick<TuiBridgeService, 'submitStudioCreate' | 'submitDreamResearch' |
 *     'submitDreamTransfer' | 'submitDreamActivation' | 'submitCompoundCreate' |
 *     'composeStudioLayersGoverned'>}} [options]
 * @returns {import('express').Express}
 */
export function createApp(configPath, port = 5174, options = {}) {
  const app = express();
  const commandBridge = options.commandBridge ?? tuiBridge;
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    setStudioCommonSecurityHeaders(res);
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // --- Host check: block DNS rebinding. A page on another site can resolve its
  // own name to 127.0.0.1 and call Studio; the browser then sends that foreign
  // name in Host. Only loopback names (and SINTER_GUI_HOST) may reach the API.
  const allowedHosts = studioAllowedHosts(options.allowedHosts);
  if (allowedHosts) {
    app.use((req, res, next) => {
      const hostname = hostnameOf(req.headers.host);
      if (hostname === null || allowedHosts.has(hostname)) return next();
      res.status(403).json({ error: 'Forbidden host' });
    });
  }

  // --- Cross-site write check. With no token, a page on another site can still
  // send a simple POST (no body, so no CORS preflight) to 127.0.0.1 and start a
  // job. Browsers label such requests: Sec-Fetch-Site: cross-site, and an
  // Origin that is foreign or "null" (sandboxed frames). Refuse those writes.
  // Non-browser clients send neither header and pass.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (isCrossSiteWrite(req.headers, allowedHosts)) {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }
    next();
  });

  // --- Vendored libraries. Every playable loads p5/Strudel/Hydra from a
  // root-absolute /vendor/... URL; without this route the stage stays blank.
  // Only registered files are served, so no other path on disk is reachable.
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.path.startsWith('/vendor/')) return next();
    if (!isVendorAssetPath(req.path)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    readVendorAsset(req.path).then(
      (body) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('text/javascript').send(body);
      },
      () => res.status(404).type('text/plain').send('Not found'),
    );
  });

  // --- B2: Rate limiter for POST routes (30 req/min per IP) ---
  const rateLimitMap = new Map();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX = 30;

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now >= entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 60_000).unref();

  app.use((req, _res, next) => {
    if (req.method !== 'POST') return next();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateLimitMap.set(ip, entry);
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
      _res.status(429).json({ error: 'Rate limited' });
      return;
    }
    next();
  });

  // --- B1: Auth for everything private when a Studio token is set ---
  // Writes need the bearer header. Reads, live streams and render iframes also
  // accept a session cookie, because a browser cannot add a header to an
  // EventSource or an iframe. The cookie holds an HMAC of the token, never the
  // token, and is only issued to a request that already proved the token.
  const guiToken = process.env.SINTER_GUI_TOKEN ?? process.env.LIMINAL_GUI_TOKEN;
  if (guiToken) {
    const sessionValue = crypto.createHmac('sha256', guiToken).update('sinter-studio-session-v1').digest('hex');
    app.use((req, res, next) => {
      const readOnly = req.method === 'GET' || req.method === 'HEAD';
      // Every write needs the token; reads only on private paths.
      if (readOnly && !isPrivateStudioPath(req.path)) return next();
      const authHeader = req.headers['authorization'];
      const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const bearerOk = bearerToken !== null && tokensMatch(bearerToken, guiToken);
      const cookie = readCookie(req.headers.cookie, STUDIO_SESSION_COOKIE);
      const cookieOk = readOnly && cookie !== null && tokensMatch(cookie, sessionValue);
      if (!bearerOk && !cookieOk) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
    app.post('/api/auth/session', (req, res) => {
      const secure = req.secure ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `${STUDIO_SESSION_COOKIE}=${sessionValue}; HttpOnly; SameSite=Strict; Path=/${secure}`,
      );
      res.json({ ok: true });
    });
  }

  const getConfigPath = () =>
    // Canonical runtime path is ~/.sinter/config.json (ConfigLoader.DEFAULT_CONFIG_PATH).
    // The runtime migrates ~/.liminal → ~/.sinter only once, when ~/.sinter is absent —
    // so the GUI MUST write the canonical path or saved keys are silently ignored.
    // SINTER_CONFIG_PATH is the supported override; LIMINAL_/ATELIER_ remain for back-compat.
    configPath
      || process.env.SINTER_CONFIG_PATH
      || process.env.LIMINAL_CONFIG_PATH
      || process.env.ATELIER_CONFIG_PATH
      || path.join(os.homedir(), '.sinter', 'config.json');

  const backendOrigin = `http://localhost:${port}`;

  app.post('/api/tui/session', (_req, res) => {
    try {
      const providerConfig = resolveGuiBridgeProvider();
      const status = tuiBridge.createSession({
        provider: providerConfig.provider,
        model: providerConfig.model,
        ...summarizeBridgeRuntime(process.env),
      });
      res.status(200).json(status);
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get('/api/tui/session/:id/status', (req, res) => {
    try {
      res.status(200).json(tuiBridge.getStatus(req.params.id));
    } catch (err) {
      res.status(404).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/tui/session/:id/input', async (req, res) => {
    try {
      const result = await tuiBridge.submitInput(req.params.id, buildGuiBridgeInput(req.body), createGuiBridgeLLM());
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/tui/session/:id/actions/:actionId/confirm', async (req, res) => {
    try {
      await tuiBridge.confirmAction(req.params.id, req.params.actionId, createGuiBridgeLLM());
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/tui/session/:id/actions/:actionId/cancel', (req, res) => {
    try {
      tuiBridge.cancelAction(req.params.id, req.params.actionId);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/tui/session/:id/cancel', (req, res) => {
    try {
      tuiBridge.cancelRun(req.params.id);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get('/api/tui/session/:id/events', validateSSEOrigin, (req, res) => {
    try {
      const sessionId = req.params.id;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      setStudioCommonSecurityHeaders(res);
      res.flushHeaders();
      res.write(': connected\n\n');

      const lastEventId = Number(req.headers['last-event-id'] || 0) || 0;

      const replay = tuiBridge.getEventReplay();
      for (const stored of replay.replayAfter(sessionId, lastEventId)) {
        res.write(`id: ${stored.id}\n`);
        res.write(`data: ${JSON.stringify(stored.event)}\n\n`);
      }

      const unsubscribe = replay.subscribeStored(sessionId, (stored) => {
        res.write(`id: ${stored.id}\n`);
        res.write(`data: ${JSON.stringify(stored.event)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
      }, 15000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      res.on('error', cleanup);
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get('/api/config', async (_req, res) => {
    try {
      const cfgPath = getConfigPath();
      const userConfig = unwrapConfigResult(await loadConfig(cfgPath));
      const projectConfig = unwrapConfigResult(await loadProjectConfig(process.cwd()));
      const effective = await getEffectiveConfig(cfgPath, process.cwd());

      const loop = {
        maxIterations: userConfig?.loop?.maxIterations ?? projectConfig?.loop?.maxIterations ?? DEFAULTS.loop.maxIterations,
        timeoutMinutes: userConfig?.loop?.timeoutMinutes ?? projectConfig?.loop?.timeoutMinutes ?? DEFAULTS.loop.timeoutMinutes,
      };
      const creative = {
        minQualityScore: userConfig?.creative?.minQualityScore ?? projectConfig?.creative?.minQualityScore ?? DEFAULTS.creative.minQualityScore,
      };
      const galleryPath = userConfig?.galleryPath ?? DEFAULTS.galleryPath;

      res.json({
        effective: {
          provider: effective.provider,
          baseUrl: effective.baseUrl ?? '',
          model: effective.model,
          apiKeyStored: Boolean(effective.apiKey),
        },
        loop,
        creative,
        galleryPath,
        roles: sanitizeRoles(userConfig?.roles || {}),
        userConfig: sanitizeConfigForClient(userConfig),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/improve/scan', (_req, res) => {
    try {
      const evidence = collectRepositoryOpportunityEvidence(process.cwd());
      res.status(200).json(scanGreenSystemOpportunities(evidence));
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get('/api/gallery', async (_req, res) => {
    try {
      const cfgPath = getConfigPath();
      const userConfigResult = await loadConfig(cfgPath);
      const userConfig = userConfigResult.match(c => c, () => null);
      const galleryPath = userConfig?.galleryPath ?? DEFAULTS.galleryPath;
      let resolvedPath;
      try { resolvedPath = validateGalleryPath(galleryPath); } catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
      const gallery = new Gallery(resolvedPath);
      const projects = await gallery.listProjectDirs();
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/gallery/:project', async (req, res) => {
    try {
      const cfgPath = getConfigPath();
      const userConfigResult = await loadConfig(cfgPath);
      const userConfig = userConfigResult.match(c => c, () => null);
      const galleryPath = userConfig?.galleryPath ?? DEFAULTS.galleryPath;
      let resolvedPath;
      try { resolvedPath = validateGalleryPath(galleryPath); } catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
      const gallery = new Gallery(resolvedPath);
      const projectDirName = decodeURIComponent(req.params.project || '');
      const iterations = await gallery.loadHistoryFromDir(projectDirName);
      res.json({ iterations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/gallery/:project/render', async (req, res) => {
    try {
      const cfgPath = getConfigPath();
      const userConfigResult = await loadConfig(cfgPath);
      const userConfig = userConfigResult.match(c => c, () => null);
      const galleryPath = userConfig?.galleryPath ?? DEFAULTS.galleryPath;
      let resolvedPath;
      try { resolvedPath = validateGalleryPath(galleryPath); } catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
      const gallery = new Gallery(resolvedPath);
      const projectDirName = decodeURIComponent(req.params.project || '');
      const iterations = await gallery.loadHistoryFromDir(projectDirName);
      const last = iterations[iterations.length - 1];
      if (!last?.code) return res.status(404).json({ error: 'No renderable iteration' });
      const { HTMLWrapper } = await import('../dist/utils/htmlWrapper.js');
      const html = HTMLWrapper.wrap(last.code, { domain: undefined });
      setStageRenderHeaders(res);
      res.send(stageWrap(html));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const ARCHIVE_PATH = path.join(os.homedir(), '.sinter', 'archive', 'quality_archive.json');

  // The stage hangs works in a near-black room; the wrapper's default white
  // page would flood the frame when a piece draws smaller than the window.
  // Endpoint-level only — the vision-audit wrapper output must stay untouched.
  const STAGE_STYLE = '<style>html,body{background:#05070b !important;margin:0;min-height:100vh;display:grid;place-items:center;}</style>';
  function stageWrap(html) {
    return html.includes('</head>') ? html.replace('</head>', `${STAGE_STYLE}</head>`) : STAGE_STYLE + html;
  }

  // Stage renders ship the wrapper's own per-domain meta CSP (three/hydra need
  // jsdelivr/unpkg/eval, which the preview header CSP forbids). The header pins
  // framing and sandboxes the document — meta CSP can set neither. Without the
  // sandbox, opening a render URL directly runs generated code on the Studio
  // origin, where it can read the session token and call private APIs.
  function setStageRenderHeaders(res) {
    setStudioCommonSecurityHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; sandbox allow-scripts");
  }

  function readArchiveEntries() {
    const raw = fs.readFileSync(ARCHIVE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const archives = data?.archives && typeof data.archives === 'object' ? data.archives : {};
    return Object.values(archives).flat().filter(
      (e) => e && typeof e.id === 'string' && typeof e.output === 'string' && typeof e.qualityScore === 'number',
    );
  }

  const PROGRESS_DOMAINS = ['p5', 'glsl', 'three', 'hydra', 'svg', 'ascii', 'textgen', 'kinetic'];
  const RENORMALIZATION_AT = Date.parse('2026-06-12T00:00:00Z');
  const CONTACT_SHEET_LIMIT = 3;

  function score(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function readProgressLedgerEntries() {
    const ledgerPath = process.env.SINTER_PROGRESS_LEDGER_PATH || path.join(cwd, 'docs', 'validation', 'self-improve-ledger.jsonl');
    try {
      return fs.readFileSync(ledgerPath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  function modelEraForEntry(entry) {
    const recorded = entry?.metadata?.generatorModel;
    if (typeof recorded === 'string' && recorded.trim()) return { label: recorded.trim(), source: 'recorded' };
    const created = Date.parse(entry.createdAt || '');
    if (entry.domain === 'three' && Number.isFinite(created) && created >= Date.parse('2026-06-12T16:00:00Z')) {
      return { label: 'MiniMax-M3', source: 'era-derived' };
    }
    return { label: 'glm-5v-turbo', source: 'era-derived' };
  }

  function progressEntry(entry) {
    const model = modelEraForEntry(entry);
    const prior = score(entry?.metadata?.rescore?.priorScore);
    const current = score(entry.qualityScore) ?? 0;
    return {
      id: entry.id,
      domain: entry.domain,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      qualityScore: current,
      createdAt: entry.createdAt || '',
      modelLabel: model.label,
      modelSource: model.source,
      rescore: prior == null ? null : {
        priorScore: prior,
        currentScore: current,
        rescoredAt: entry.metadata?.rescore?.rescoredAt || null,
        provenance: entry.metadata?.rescore?.provenance || null,
      },
      renderMeasure: entry.metadata?.renderMeasure || null,
    };
  }

  function collectProgressData() {
    const archiveEntries = readArchiveEntries()
      .filter((entry) => PROGRESS_DOMAINS.includes(entry.domain))
      .filter((entry) => !entry.metadata?.quarantinedAt)
      .map(progressEntry);
    const entriesByDomain = {};
    const domains = PROGRESS_DOMAINS.map((domain) => {
      const entries = archiveEntries
        .filter((entry) => entry.domain === domain)
        .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
      entriesByDomain[domain] = entries;
      const ordered = [...entries].sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
      const values = entries.map((entry) => entry.qualityScore).filter((n) => Number.isFinite(n));
      return {
        domain,
        count: entries.length,
        top: values.length ? Math.max(...values) : null,
        floor: values.length ? Math.min(...values) : null,
        sparkline: ordered.map((entry) => ({ ts: entry.createdAt, score: entry.qualityScore })),
      };
    });
    const ledger = readProgressLedgerEntries();
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const admittedLast24h = ledger.reduce((sum, line) => {
      const ts = Date.parse(line.ts || '');
      const admitted = typeof line.admitted === 'number' ? line.admitted : null;
      return admitted != null && Number.isFinite(ts) && ts >= dayAgo ? sum + admitted : sum;
    }, 0);
    const timeline = ledger.slice(-40).map((line) => ({
      ts: line.ts || '',
      targetedDomains: Array.isArray(line.targetedDomains) ? line.targetedDomains : [],
      scores: Array.isArray(line.scores) ? line.scores.filter((n) => Number.isFinite(Number(n))).map(Number) : [],
      admitted: typeof line.admitted === 'number' ? line.admitted : null,
      archive: line.after?.archive ?? null,
      honestScoresDivider: Number.isFinite(Date.parse(line.ts || '')) && Date.parse(line.ts) >= RENORMALIZATION_AT,
    }));
    return { generatedAt: new Date().toISOString(), admittedLast24h, domains, timeline, entriesByDomain };
  }

  function fmtScore(value) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
  }

  function sparklineSvg(points) {
    const values = points.map((p) => Number(p.score)).filter(Number.isFinite);
    if (values.length < 2) return '<span class="progress-empty">not enough data</span>';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const coords = points.map((p, i) => {
      const x = values.length === 1 ? 40 : (i / (points.length - 1)) * 120;
      const y = 34 - ((Number(p.score) - min) / range) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="spark" viewBox="0 0 120 40" role="img" aria-label="score trend"><polyline points="${coords}" /></svg>`;
  }

  function progressHeaderHtml(data) {
    return `<section class="progress-header" aria-label="Domain improvement summary">
      ${data.domains.map((domain) => `<article class="domain-strip">
        <div class="domain-strip__top"><strong>${escapeHtml(domain.domain)}</strong><span>${domain.count} pieces</span></div>
        ${sparklineSvg(domain.sparkline)}
        <div class="domain-strip__stats"><span>top ${fmtScore(domain.top)}</span><span>floor ${fmtScore(domain.floor)}</span></div>
      </article>`).join('')}
      <article class="domain-strip admitted-total"><div>admitted / 24h</div><strong>${data.admittedLast24h}</strong></article>
    </section>`;
  }

  function progressTimelineHtml(data) {
    let dividerShown = false;
    return `<section class="progress-panel" aria-label="Self-improvement cycle timeline">
      <div class="section-heading"><h2>Cycle timeline</h2><span>last ${data.timeline.length} daemon cycles</span></div>
      <div class="timeline">
        ${data.timeline.map((line) => {
          const showDivider = line.honestScoresDivider && !dividerShown;
          if (showDivider) dividerShown = true;
          return `${showDivider ? '<div class="renorm-divider">scores became honest here</div>' : ''}
            <article class="cycle ${line.admitted > 0 ? 'cycle--win' : ''}">
              <time>${escapeHtml(line.ts || 'unknown time')}</time>
              <span>${escapeHtml(line.targetedDomains.join(', ') || 'untargeted')}</span>
              <span>scores ${escapeHtml(line.scores.map(fmtScore).join(' / ') || '—')}</span>
              <strong>admitted ${line.admitted == null ? '—' : line.admitted}</strong>
            </article>`;
        }).join('')}
      </div>
    </section>`;
  }

  function contactSheetHtml(data) {
    return `<section class="progress-panel" aria-label="Archive contact sheet">
      <div class="section-heading"><h2>Contact sheet</h2><span>open a domain to load its top ${CONTACT_SHEET_LIMIT}</span></div>
      ${PROGRESS_DOMAINS.map((domain) => {
        const entries = data.entriesByDomain[domain] || [];
        const shownEntries = entries.slice(0, CONTACT_SHEET_LIMIT);
        return `<details class="domain-section" data-domain="${escapeHtml(domain)}">
          <summary class="domain-section__heading"><h3>${escapeHtml(domain)}</h3><span>open to load ${shownEntries.length} of ${entries.length} visible archive entries</span></summary>
          <div class="cards">
            ${shownEntries.map((entry) => {
              const prompt = entry.prompt.length > 140 ? `${entry.prompt.slice(0, 140)}…` : entry.prompt;
              return `<article class="piece-card">
                <iframe loading="lazy" sandbox="allow-scripts" title="${escapeHtml(`${entry.domain} ${entry.id}`)}" data-src="/api/archive/${encodeURIComponent(entry.id)}/render"></iframe>
                <div class="piece-card__meta">
                  <span class="score">score ${fmtScore(entry.qualityScore)}</span>
                  ${entry.rescore ? `<span class="rescore">${fmtScore(entry.rescore.priorScore)} → ${fmtScore(entry.rescore.currentScore)}</span>` : ''}
                  <span>model (era-derived): ${escapeHtml(entry.modelSource === 'recorded' ? `${entry.modelLabel} recorded` : entry.modelLabel)}</span>
                  <time>${escapeHtml(entry.createdAt || 'unknown date')}</time>
                  <p title="${escapeHtml(entry.prompt)}">${escapeHtml(prompt || 'untitled generation')}</p>
                  <code>${escapeHtml(entry.id)}</code>
                </div>
              </article>`;
            }).join('')}
          </div>
        </details>`;
      }).join('')}
    </section>`;
  }

  function progressDashboardHtml(data) {
    const initialJson = escapeScript(JSON.stringify(data));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Sinter Progress</title>
      <style>
        :root{color-scheme:dark;--sinter-bg-void:#07090d;--sinter-surface-1:#121720;--sinter-surface-2:#191f2b;--sinter-text:#eef3ff;--sinter-muted:#9aa7bd;--sinter-cyan:#59e1ff;--font-display:'JetBrains Mono',ui-monospace,Menlo,monospace;--font-mono:'JetBrains Mono',ui-monospace,monospace}
        *{box-sizing:border-box} body{margin:0;background:var(--sinter-bg-void);color:var(--sinter-text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif} .progress-page{max-width:1480px;margin:0 auto;padding:24px}
        .hero{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:22px}.hero h1{margin:0;font:700 clamp(2rem,5vw,4.5rem)/.9 var(--font-display);letter-spacing:-.06em}.hero p{max-width:760px;color:var(--sinter-muted)}.hero a{color:var(--sinter-cyan)}#last-updated{font-family:var(--font-mono);color:var(--sinter-muted)}
        .progress-header{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}.domain-strip,.progress-panel{background:var(--sinter-surface-1);border:1px solid rgba(145,161,190,.18);border-radius:14px}.domain-strip{min-height:124px;padding:12px}.domain-strip__top,.domain-strip__stats,.section-heading,.domain-section__heading,.piece-card__meta{display:flex;justify-content:space-between;gap:10px}.domain-strip strong,.section-heading h2,.domain-section h3{font-family:var(--font-display)}.domain-strip span,.section-heading span,.domain-section span{color:var(--sinter-muted);font-size:.82rem}.admitted-total{display:grid;place-content:center;text-align:center}.admitted-total strong{font-size:3rem;color:var(--sinter-cyan)}
        .spark{width:100%;height:42px}.spark polyline{fill:none;stroke:var(--sinter-cyan);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.progress-empty{display:grid;place-items:center;height:42px;color:var(--sinter-muted);font:12px var(--font-mono)}
        .progress-panel{padding:16px;margin:18px 0}.section-heading{align-items:baseline;margin-bottom:14px}.section-heading h2,.domain-section h3{margin:0}.timeline{display:grid;gap:8px}.cycle{display:grid;grid-template-columns:minmax(210px,.9fr) minmax(160px,1fr) minmax(160px,1fr) 110px;gap:10px;align-items:center;padding:10px 12px;background:var(--sinter-surface-2);border-radius:10px;color:var(--sinter-muted);font-family:var(--font-mono);font-size:.82rem}.cycle--win{border:1px solid var(--sinter-cyan);box-shadow:0 0 0 1px rgba(89,225,255,.18)}.cycle--win strong{color:var(--sinter-cyan)}.renorm-divider{margin:10px 0;padding:8px 12px;border-left:3px solid var(--sinter-cyan);color:var(--sinter-cyan);font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.12em;font-size:.72rem}
        .domain-section{margin:22px 0}.domain-section__heading{display:grid;grid-template-columns:auto 1fr auto;cursor:pointer;align-items:center;list-style:none}.domain-section__heading::-webkit-details-marker{display:none}.domain-section__heading::before{content:'▸';color:var(--sinter-cyan);font-family:var(--font-mono)}.domain-section[open]>.domain-section__heading::before{content:'▾'}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:12px}.piece-card{background:var(--sinter-surface-2);border:1px solid rgba(145,161,190,.18);border-radius:12px;overflow:hidden}.piece-card iframe{width:100%;height:180px;border:0;background:#05070b}.piece-card__meta{flex-direction:column;padding:12px;font-size:.82rem;color:var(--sinter-muted)}.score{color:var(--sinter-text);font-weight:700}.rescore{color:var(--sinter-cyan);font-family:var(--font-mono)}.piece-card p{margin:0;color:var(--sinter-text)}code{font-family:var(--font-mono);color:var(--sinter-muted);word-break:break-all}
        @media (max-width:760px){.hero,.cycle{display:block}.cycle>*{display:block;margin:3px 0}}
      </style></head><body><main class="progress-page">
        <header class="hero"><div><h1>Progress</h1><p>Visual proof of Sinter's self-improvement loop: score trend, daemon admissions, rescored honesty deltas, and archive provenance.</p></div><div id="last-updated">last updated ${escapeHtml(data.generatedAt)}</div></header>
        <div id="progress-header">${progressHeaderHtml(data)}</div>
        <div id="progress-timeline">${progressTimelineHtml(data)}</div>
        ${contactSheetHtml(data)}
      </main><script>
        window.__PROGRESS_DATA__=${initialJson};
        const fmt=n=>Number.isFinite(Number(n))?Number(n).toFixed(2):'—';
        function loadDomain(section){section.querySelectorAll('iframe[data-src]').forEach(frame=>{if(!frame.src){frame.src=frame.dataset.src;frame.removeAttribute('data-src');}});}
        function attachDomainPanels(){document.querySelectorAll('details.domain-section').forEach(section=>section.addEventListener('toggle',()=>{if(section.open)loadDomain(section);}));}
        async function refreshProgress(){try{const res=await fetch('/api/progress/data',{cache:'no-store'});if(!res.ok)return;const data=await res.json();document.getElementById('last-updated').textContent='last updated '+data.generatedAt;}catch{}}
        attachDomainPanels(); setInterval(refreshProgress,60000);
      </script></body></html>`;
  }

  app.get('/api/progress/data', (_req, res) => {
    try {
      res.json(collectProgressData());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/progress', (_req, res) => {
    try {
      setStudioCommonSecurityHeaders(res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(progressDashboardHtml(collectProgressData()));
    } catch (err) {
      res.status(500).send(`Progress dashboard failed: ${escapeHtml(err.message)}`);
    }
  });

  app.get('/api/archive/tops', (req, res) => {
    try {
      const entries = readArchiveEntries();
      const limit = Math.min(Number(req.query.limit) || 12, 50);
      // Curate for diversity: each domain's best first, then fill by score.
      const byScore = [...entries].sort((a, b) => b.qualityScore - a.qualityScore);
      const seen = new Set();
      const domainBests = byScore.filter((e) => !seen.has(e.domain) && seen.add(e.domain));
      const rest = byScore.filter((e) => !domainBests.includes(e));
      const tops = [...domainBests, ...rest].slice(0, limit).map((e) => ({
        id: e.id,
        domain: e.domain,
        prompt: e.prompt,
        qualityScore: e.qualityScore,
        createdAt: e.createdAt,
      }));
      res.json({ tops });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ tops: [] });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/archive/:id/render', async (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id || '');
      const entry = readArchiveEntries().find((e) => e.id === id);
      if (!entry) return res.status(404).json({ error: 'Archive entry not found' });
      // Same domain mapping as scripts/quality/archive-measure.mjs: ascii and
      // textgen are plain text (pre), kinetic entries are already full HTML,
      // and the wrapper's name for glsl is 'shader'.
      let html;
      if (entry.domain === 'ascii' || entry.domain === 'textgen') {
        const text = entry.output;
        const lines = text.split('\n');
        const longest = Math.max(1, ...lines.map((line) => line.length));
        const fontPx = Math.max(14, Math.min(34, Math.floor(Math.min((900 * 0.9) / (longest * 0.6), (600 * 0.9) / (lines.length * 1.25)))));
        html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#06080f;color:#cfe;font:${fontPx}px ui-monospace,Menlo,monospace;display:flex;align-items:center;justify-content:center}pre{padding:18px;white-space:pre;line-height:1.25}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
      } else if (entry.domain === 'kinetic') {
        // Kinetic entries are complete HTML pages with their own layout —
        // injecting the stage's grid/centering body style collapses them to
        // black. Keep the layout; add only the kinetic network policy, which a
        // full page written by the model does not carry.
        const { KineticWrapper } = await import('../dist/generators/kinetic/KineticWrapper.js');
        setStageRenderHeaders(res);
        return res.send(KineticWrapper.wrap(entry.output));
      } else {
        const { HTMLWrapper } = await import('../dist/utils/htmlWrapper.js');
        const wrapperDomain = entry.domain === 'glsl' ? 'shader' : entry.domain;
        html = HTMLWrapper.wrap(entry.output, { domain: wrapperDomain });
      }
      setStageRenderHeaders(res);
      res.send(stageWrap(html));
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'Archive not found' });
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/config', async (req, res) => {
    try {
      const cfgPath = getConfigPath();
      const body = req.body || {};
      const existing = unwrapConfigResult(await loadConfig(cfgPath));

      // Resolve secret sentinels against the existing file first so a "stored"
      // marker never lands in the config literally.
      const providers = mergeProviderConfigs(existing?.providers || {}, body.providers || {});
      const roles = mergeRoleConfigs(existing?.roles || {}, body.roles || {});

      // Deep-merge the update through the shared atomic write contract instead
      // of rebuilding the file from these keys — unrelated sections (fallbacks,
      // capability settings, unknown forward-compatible keys) are preserved.
      const update = {
        ...(body.defaultProvider !== undefined ? { defaultProvider: body.defaultProvider } : {}),
        providers,
        roles,
        ...(body.loop !== undefined ? { loop: body.loop } : {}),
        ...(body.creative !== undefined ? { creative: body.creative } : {}),
        ...(body.galleryPath !== undefined ? { galleryPath: body.galleryPath } : {}),
      };
      const result = await updateConfig(update, cfgPath);
      if (result.isErr()) return res.status(400).json({ error: result.error.message });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run in preview: store code and return URL to preview it
  app.post('/api/preview/run', (req, res) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const version = Number.isInteger(req.body?.version) && req.body.version > 0 ? req.body.version : 1;
      previewStore.set(version, code);
      const url = `${backendOrigin}/preview?version=${version}`;
      res.status(200).json({ url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve preview page (p5 + stored code) so iframe can show the sketch
  app.get('/preview', (req, res) => {
    const version = Math.max(1, parseInt(String(req.query.version), 10) || 1);
    const code = previewStore.get(version);
    if (typeof code !== 'string') {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Permissions-Policy" content="accelerometer=(), gyroscope=(), magnetometer=(), deviceorientation=(), devicemotion=()">
  <title>Preview unavailable</title>
  <style>body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07090d; color: #eef3ff; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; } main { max-width: 560px; padding: 24px; border: 1px solid rgba(145, 161, 190, 0.34); border-radius: 16px; background: rgba(18, 23, 32, 0.92); } h1 { margin: 0 0 8px; font-size: 20px; } p { margin: 0; color: #9aa7bd; line-height: 1.5; }</style>
</head>
<body>
  <main>
    <h1>Preview expired or missing</h1>
    <p>This preview no longer has stored code. Run the artifact again from Sinter Studio to create a fresh sandboxed preview.</p>
  </main>
</body>
</html>`;
      setPreviewSecurityHeaders(res);
      res.status(404).send(html);
      return;
    }
    const organismPreview = parseOrganismPreview(code);
    if (organismPreview) {
      setPreviewSecurityHeaders(res, { profile: 'organism' });
      res.send(renderOrganismPreview(organismPreview, version));
      return;
    }
    const escaped = escapeScript(code);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Permissions-Policy" content="accelerometer=(), gyroscope=(), magnetometer=(), deviceorientation=(), devicemotion=()">
  <title>Preview v${version}</title>
  <style>
    :root { color-scheme: dark; }
    html, body {
      margin: 0;
      min-height: 100vh;
      background: #05070d;
      overflow: hidden;
    }
    body {
      display: grid;
      place-items: center;
    }
    canvas {
      display: block;
      max-width: 100vw;
      max-height: 100vh;
      width: min(100vw, 960px) !important;
      height: auto !important;
      background: #05070d;
      box-shadow: 0 22px 80px rgba(0, 0, 0, 0.34);
    }
  </style>
  ${P5_SENSOR_POLICY_SCRIPT}
  <script src="${VENDOR_ASSETS.p5}"></script>
</head>
<body data-sinter-p5-preview-shell>
  <script>
    // Wave 3 isolation: strip network access before running generated code
    window.fetch = undefined;
    window.XMLHttpRequest = undefined;
    window.WebSocket = undefined;
    window.EventSource = undefined;
    window.open = undefined;
    try {
      ${escaped}
    } catch(e) {
      document.body.innerHTML = '<pre style="color:#f66;padding:12px;font-family:monospace">Preview error: ' + e.message + '</pre>';
    }
  </script>
</body>
</html>`;
    setPreviewSecurityHeaders(res);
    res.send(html);
  });

  // Compose a layered work: generate each layer and assemble a single stacked
  // HTML artifact. This is the Studio's "add layers on top" surface — it drives
  // the same CompositionOrchestrator the `sinter compose` CLI uses.
  const COMPOSE_DOMAINS = new Set(['p5', 'three', 'shader', 'tone', 'music', 'strudel', 'hydra', 'ascii', 'html']);
  const COMPOSE_BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);
  // Studio callers supply creative intent only; the host mints all command authority.
  app.post('/api/liminal/create', async (req, res) => {
    const input = req.body?.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'input is required' });
    }
    try {
      return res.status(200).json(await commandBridge.submitStudioCreate(input));
    } catch (error) {
      return res.status(409).json({ error: error?.message || String(error) });
    }
  });

  app.post('/api/liminal/dream', async (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return res.status(400).json({ error: 'command is required' });
    }
    try {
      return res.status(200).json(await commandBridge.submitDreamResearch(command));
    } catch (error) {
      return res.status(409).json({ error: error?.message || String(error) });
    }
  });

  app.post('/api/liminal/dream/transfer', async (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return res.status(400).json({ error: 'command is required' });
    }
    try {
      return res.status(200).json(await commandBridge.submitDreamTransfer(command));
    } catch (error) {
      return res.status(409).json({ error: error?.message || String(error) });
    }
  });

  app.post('/api/liminal/dream/activate', async (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return res.status(400).json({ error: 'command is required' });
    }
    try {
      return res.status(200).json(await commandBridge.submitDreamActivation(command));
    } catch (error) {
      return res.status(409).json({ error: error?.message || String(error) });
    }
  });

  app.post('/api/liminal/compound-create', async (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return res.status(400).json({ error: 'command is required' });
    }
    try {
      return res.status(200).json(await commandBridge.submitCompoundCreate(command));
    } catch (error) {
      return res.status(409).json({ error: error?.message || String(error) });
    }
  });

  app.post('/api/compose', async (req, res) => {
    try {
      let graphSpec;
      if (req.body?.schema === 'sinter.composition-graph') {
        try {
          graphSpec = prepareComposition(req.body);
        } catch (error) {
          return res.status(400).json({ error: error?.message || String(error) });
        }
      }
      const rawLayers = graphSpec?.layers ?? (Array.isArray(req.body?.layers) ? req.body.layers : null);
      if (!rawLayers || rawLayers.length < 1) {
        return res.status(400).json({ error: 'at least one layer is required' });
      }
      const layers = [];
      for (let i = 0; i < rawLayers.length; i++) {
        const layer = rawLayers[i] || {};
        const domain = String(layer.domain || '').toLowerCase();
        const prompt = typeof layer.prompt === 'string' ? layer.prompt.trim() : '';
        // A layer may carry pre-existing code (kept as-is — e.g. the current work
        // preserved as the base) instead of a prompt to generate from.
        const code = typeof layer.code === 'string' ? layer.code.trim() : '';
        if (!COMPOSE_DOMAINS.has(domain)) {
          return res.status(400).json({ error: `layer ${i + 1}: unsupported medium "${layer.domain}"` });
        }
        if (!prompt && !code) {
          return res.status(400).json({ error: `layer ${i + 1}: a description is required` });
        }
        const spec = code ? { domain, prompt: prompt || 'existing layer', code } : { domain, prompt };
        if (layer.blendMode !== undefined) {
          const blendMode = String(layer.blendMode).toLowerCase();
          if (!COMPOSE_BLEND_MODES.has(blendMode)) {
            return res.status(400).json({ error: `layer ${i + 1}: unsupported blend mode "${layer.blendMode}"` });
          }
          spec.blendMode = blendMode;
        }
        if (layer.opacity !== undefined) {
          const opacity = Number(layer.opacity);
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            return res.status(400).json({ error: `layer ${i + 1}: opacity must be between 0 and 1` });
          }
          spec.opacity = opacity;
        }
        layers.push(spec);
      }
      const spec = { layers };
      const source = graphSpec ?? req.body;
      if (typeof source?.title === 'string' && source.title.trim()) spec.title = source.title.trim();
      if (typeof source?.background === 'string' && source.background.trim()) spec.background = source.background.trim();
      if (Number.isSafeInteger(graphSpec?.maxProviderCalls)) {
        spec.maxProviderCalls = graphSpec.maxProviderCalls;
      }
      if (graphSpec?.creativeThesis) spec.creativeThesis = graphSpec.creativeThesis;

      const result = await commandBridge.composeStudioLayersGoverned(spec);
      // The full layer HTML can be large; return it plus a compact per-layer
      // summary the Studio uses to show which layers generated / were guarded.
      return res.status(200).json({
        html: result.html,
        title: result.title,
        successCount: result.successCount,
        coupled: result.coupled,
        lane: result.lane,
        lineageId: result.lineageId,
        recipeDigest: result.recipeDigest,
        creativeRun: result.creativeRun,
        readiness: result.creativeRun?.readiness,
        layers: result.layers.map((l) => ({
          domain: l.domain,
          blendMode: l.blendMode,
          opacity: l.opacity,
          generated: l.generated,
          error: l.error,
          seamGuarded: l.seamGuarded,
        })),
        renderGate: result.renderGate ? { verdict: result.renderGate.verdict } : undefined,
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });
  // ─── Campaign lifecycle (W9C-01) ──────────────────────────────────────────
  let campaignState = null;

  /**
   * Build the governed studio campaign context from the frozen Wave 8 campaign
   * artifacts. The manifest/plan/routeFreeze already bind the exact funded
   * capacity seats, so the studio EXECUTE path binds executor request/route/
   * response identity exactly like the compose CLI (runCampaignCliJourney).
   * Replicates bin/sinter:2373-2416 (the proven funded CLI path).
   */
  async function buildStudioCampaignContext() {
    const liveDir = process.env.SINTER_WAVE8_LIVE_DIR
      || path.join(cwd, '.quality', 'wave-8', 'live', 'w8-kimi-product-b1a610ca');
    const artifactsDir = path.join(liveDir, 'artifacts');
    const { loadProductionOwnerReviewPackage } = await import('../dist/cli/ProductionOwnerReview.js');
    const { CampaignService } = await import('../dist/creative-run/CampaignService.js');
    const { CreativeRunCoordinator } = await import('../dist/creative-run/CreativeRunCoordinator.js');
    const { createCampaignAuthority, FileCampaignAdmissionStore } = await import('../dist/runtime-core/CampaignOrigin.js');
    const { installCampaignLiveAuthority } = await import('../dist/cli/CampaignCli.js');
    const { assertWave8GovernedCampaignPreflight } = await import('../dist/llm/PreSpendInterlock.js');
    const signingKeyPath = process.env.SINTER_CAMPAIGN_SIGNING_KEY;
    const keyId = process.env.SINTER_CAMPAIGN_KEY_ID;
    const ledgerPath = process.env.SINTER_CAMPAIGN_ADMISSION_LEDGER;
    if (!signingKeyPath || !keyId || !ledgerPath) {
      throw new Error('Studio governed campaign requires SINTER_CAMPAIGN_SIGNING_KEY, SINTER_CAMPAIGN_KEY_ID, and SINTER_CAMPAIGN_ADMISSION_LEDGER');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'manifest.json'), 'utf8'));
    const input = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'execution.json'), 'utf8'));
    const ownerReviewPackage = loadProductionOwnerReviewPackage(path.join(artifactsDir, 'owner-review.json'));
    ownerReviewPackage.assertManifestCoverage(manifest);
    installCampaignLiveAuthority();
    const coordinator = new CreativeRunCoordinator({
      campaignAuthority: createCampaignAuthority({
        keyId,
        privateKeyPem: fs.readFileSync(signingKeyPath, 'utf8'),
        admissionStore: new FileCampaignAdmissionStore(ledgerPath),
      }),
      campaignPreflight: async () => assertWave8GovernedCampaignPreflight(),
    });
    const campaignService = CampaignService.shared(coordinator);
    return { manifest, input, ownerReviewPackage, campaignService };
  }

  app.post('/api/campaign/start', async (req, res) => {
    try {
      const ctx = await buildStudioCampaignContext();
      const briefs = ctx.manifest.briefs.map((brief) => ({
        id: brief.id,
        title: brief.id,
        description: '',
        medium: 'visual',
      }));
      campaignState = {
        id: ctx.manifest.campaignRunId,
        manifest: ctx.manifest,
        input: ctx.input,
        ownerReviewPackage: ctx.ownerReviewPackage,
        campaignService: ctx.campaignService,
        briefs,
        candidates: [],
        reviews: [],
        decisions: {},
        status: 'frozen',
        frozenAt: new Date().toISOString(),
      };
      return res.status(200).json({ campaignId: campaignState.id, status: 'frozen', briefs });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/campaign/execute', async (req, res) => {
    try {
      if (!campaignState) return res.status(400).json({ error: 'No frozen campaign. Call /api/campaign/start first.' });
      campaignState.status = 'executing';
      // Route through the REAL governed campaign journey — same path as the
      // compose CLI — so executor request/route/response identity binds via
      // the CampaignFundingReservationAuthority + routeFreeze. This replaces
      // the product-command port (composeStudioLayersGoverned/submitCreate)
      // which never bound campaign identity (G005 root cause).
      const { runGovernedCampaignStudioJourney } = await import('../dist/tui-bridge/CampaignStudio.js');
      const journey = await runGovernedCampaignStudioJourney(
        campaignState.campaignService,
        { entryPoint: 'studio-layers', requestKey: campaignState.manifest.campaignRunId },
        campaignState.manifest,
        campaignState.ownerReviewPackage.plan,
        {
          input: campaignState.input,
          ownerReviewBriefIds: campaignState.ownerReviewPackage.briefIds,
          ownerReviews: async (admission, candidateManifests) => campaignState.ownerReviewPackage.buildInputs(
            campaignState.campaignService, admission, campaignState.manifest, candidateManifests,
            await campaignState.ownerReviewPackage.captureEvidence(candidateManifests)),
        },
      );
      const executions = journey.result?.executions ?? [];
      const reservationDigest = journey.projection?.campaignFundingReservationDigest;
      for (const execution of executions) {
        const composition = execution?.composition;
        if (!composition) continue;
        campaignState.candidates.push({
          id: `${campaignState.id}-candidate-${campaignState.candidates.length + 1}`,
          html: composition.playable ?? composition.html ?? '',
          successCount: composition.layers?.length ?? 1,
          creativeRun: { readiness: { state: 'campaign-governed', campaignFundingReservationDigest: reservationDigest } },
          generatedAt: new Date().toISOString(),
        });
      }
      campaignState.reviews = journey.ownerReviews ?? [];
      if (journey.closure) campaignState.decisions.closed = { value: true, recordedAt: new Date().toISOString() };
      campaignState.status = 'frozen';
      const candidate = campaignState.candidates[campaignState.candidates.length - 1] ?? null;
      return res.status(200).json({ candidate, totalCandidates: campaignState.candidates.length });
    } catch (err) {
      campaignState.status = 'frozen';
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/campaign/status', (_req, res) => {
    if (!campaignState) return res.status(200).json({ status: 'idle' });
    return res.status(200).json({
      campaignId: campaignState.id, status: campaignState.status,
      briefs: campaignState.briefs, candidateCount: campaignState.candidates.length,
      reviewCount: campaignState.reviews.length, decisions: campaignState.decisions,
      budget: campaignState.budget, frozenAt: campaignState.frozenAt,
    });
  });

  app.get('/api/campaign/candidates', (_req, res) => {
    if (!campaignState) return res.status(200).json({ candidates: [] });
    return res.status(200).json({ candidates: campaignState.candidates.map(c => ({
      id: c.id, briefId: c.briefId, successCount: c.successCount,
      generatedAt: c.generatedAt, layerCount: c.layers?.length || 0,
    })) });
  });

  app.get('/api/campaign/candidate/:id', (req, res) => {
    if (!campaignState) return res.status(404).json({ error: 'No campaign' });
    const candidate = campaignState.candidates.find(c => c.id === req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    return res.status(200).json(candidate);
  });

  app.post('/api/campaign/decision', (req, res) => {
    if (!campaignState) return res.status(400).json({ error: 'No campaign' });
    const kind = String(req.body?.kind || '');
    if (!kind) return res.status(400).json({ error: 'Decision kind required' });
    campaignState.decisions[kind] = { value: req.body?.value, recordedAt: new Date().toISOString() };
    return res.status(200).json({ kind, ...campaignState.decisions[kind] });
  });

  app.get('/api/campaign/packets', (_req, res) => {
    if (!campaignState) return res.status(200).json({ packets: [] });
    return res.status(200).json({ packets: campaignState.briefs.map(brief => ({
      briefId: brief.id, title: brief.title,
      candidates: campaignState.candidates.filter(c => c.briefId === brief.id).map(c => ({
        id: c.id, successCount: c.successCount, generatedAt: c.generatedAt,
      })),
    })) });
  });

  // Historical gallery remix bypassed accepted evidence and rendered evaluation.
  // It remains named only to give old clients an explicit migration response.
  app.post('/api/dream', (_req, res) => res.status(410).json({
    error: 'legacy dream remix retired', governedEndpoint: '/api/liminal/dream',
  }));

  // Train the taste model from this project's preferences + archive. Closes the
  // taste loop in the Studio: pins/rejects build the model that generation reads.
  app.post('/api/taste/train', async (_req, res) => {
    try {
      const { TasteLearningService } = await import('../dist/learning/index.js');
      const { SinterFS } = await import('../dist/fs/index.js');
      const { resolveSinterProjectRoot } = await import('../dist/fs/projectRoot.js');
      const sinterFs = SinterFS.open(resolveSinterProjectRoot());
      try {
        const summary = await new TasteLearningService(sinterFs).trainFromProject();
        return res.status(200).json({
          trained: Boolean(summary.persisted && summary.weights),
          archiveEntryCount: summary.archiveEntryCount ?? 0,
          preferenceEventCount: summary.preferenceEventCount ?? 0,
          pairCount: summary.pairCount ?? 0,
          reason: summary.reason ?? null,
        });
      } finally {
        sinterFs.close();
      }
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Garden health — read-only. The always-on gardener runs as the documented
  // self-improve daemon; starting a long-running loop inside the Studio web
  // process from a button is intentionally NOT exposed here.
  app.get('/api/garden', async (_req, res) => {
    try {
      const { GardenPolicy } = await import('../dist/autonomy/GardenPolicy.js');
      const { StagnationDetector } = await import('../dist/autonomy/StagnationDetector.js');
      const { SinterFS } = await import('../dist/fs/index.js');
      const { EmergenceHooks } = await import('../dist/emergence/index.js');
      const sinterFs = SinterFS.open(process.cwd());
      try {
        const cells = new EmergenceHooks(sinterFs).getArchive().getAllCells();
        const policy = new GardenPolicy();
        const health = policy.getHealthMonitor().measure(cells);
        const stag = new StagnationDetector().detect(policy.getHealthMonitor().getHistory());
        return res.status(200).json({
          health: {
            score: health.healthScore,
            level: health.healthLevel,
            archiveSize: health.archiveSize,
            occupancy: health.nicheOccupancy,
          },
          stagnation: { isStagnant: stag.isStagnant, severity: stag.severity },
        });
      } finally {
        sinterFs.close();
      }
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Wave 7/8 release truth from the repository's release evidence.
  app.get('/api/market', async (_req, res) => {
    try {
      const { collectWave7RepositoryReleaseTruth } = await import('../dist/runtime-core/Wave7RepositoryReleaseTruth.js');
      const status = collectWave7RepositoryReleaseTruth(process.cwd());
      return res.status(200).json({ status });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Run a governed Product Create (or the explicit organism archive workflow).
  app.post('/api/run', async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }
      const mode = req.body?.mode === 'organism' ? 'organism' : 'p5';
      const traits = req.body?.traits && typeof req.body.traits === 'object' ? req.body.traits : {};
      const projectName = req.body?.project || `gui-${Date.now()}`;
      const maxIterations = Math.min(20, Math.max(1, parseInt(req.body?.maxIterations, 10) || 3));

      if (mode === 'organism') {
        const cfgPath = getConfigPath();
        const userConfig = unwrapConfigResult(await loadConfig(cfgPath));
        const projectConfig = await loadProjectConfig(cwd);
        const galleryPath = userConfig?.galleryPath
          ?? projectConfig?.galleryPath ?? DEFAULTS.galleryPath;
        let resolvedGallery;
        try { resolvedGallery = validateGalleryPath(galleryPath); }
        catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
        const gallery = new Gallery(resolvedGallery);
        const useLLM = req.body?.useLLM !== false;
        if (useLLM) {
          const { generateMusicToVisual } = await import('../dist/index.js');
          for (let i = 1; i <= maxIterations; i++) {
            const result = await generateMusicToVisual(prompt, {
              traits: { bpm: traits.bpm, palette: traits.palette },
            });
            await gallery.saveOrganism(projectName, i, result.musicCode, result.visualCode);
          }
        } else {
          for (let i = 1; i <= maxIterations; i++) {
            const result = buildDeterministicOrganism(`${prompt} iteration ${i}`, traits);
            await gallery.saveOrganism(projectName, i, result.musicCode, result.visualCode);
          }
        }
        const dateStr = new Date().toISOString().split('T')[0];
        const projectDirName = `${dateStr}--${projectName}`;
        // Organism runs assemble music+visual layers but do NOT score the
        // output, so we must not fabricate a numeric fitness. Emit a null
        // score with an explicit `unscored` marker instead of a hardcoded 1.0.
        return res.status(200).json({
          ok: true,
          result: { code: '', iterations: maxIterations, completed: true, reason: 'organism run', finalScore: null, unscored: true, project: projectName },
          projectDirName,
        });
      }

      const runtime = await productionRuntime();
      const command = runtime.createCommand({ prompt, domain: 'p5',
        layers: ['p5-composition'], maxTransportAttempts: 2 });
      const projection = await runtime.port.submitCreate('studio', command);
      const artifact = await runtime.port.verifiedArtifact(command.idempotencyKey);
      res.status(200).json({
        ok: true,
        result: {
          code: artifact.source,
          iterations: 1,
          completed: true,
          reason: 'governed-product-create',
          finalScore: projection.result.evaluation.score,
          project: projectName,
        },
        projectDirName: null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Live Music: generate Strudel / Hydra code from prompt
  app.post('/api/live-music/music', async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : 'ambient';
      const { generateMusic } = await import('../dist/index.js');
      const out = await generateMusic({ prompt, platform: 'strudel' });
      res.status(200).json({ code: out.code, source: out.source });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/live-music/visuals', async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : 'reactive';
      const { generateVisuals } = await import('../dist/index.js');
      const out = await generateVisuals({ prompt, platform: 'hydra' });
      res.status(200).json({ code: out.code });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Merge two iterations into a proposed organism/p5 (no save)
  app.post('/api/merge', async (req, res) => {
    try {
      const dirName = req.body?.dirName;
      const versionA = parseInt(req.body?.versionA, 10);
      const versionB = parseInt(req.body?.versionB, 10);
      if (!dirName || !Number.isInteger(versionA) || !Number.isInteger(versionB) || versionA < 1 || versionB < 1) {
        return res.status(400).json({ error: 'dirName, versionA, versionB (positive integers) are required' });
      }
      const cfgPath = getConfigPath();
      const userConfig = unwrapConfigResult(await loadConfig(cfgPath));
      const projectConfig = await loadProjectConfig(cwd);
      const galleryPath = userConfig?.galleryPath ?? projectConfig?.galleryPath ?? DEFAULTS.galleryPath;
      let resolvedGallery;
      try { resolvedGallery = validateGalleryPath(galleryPath); } catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
      const gallery = new Gallery(resolvedGallery);
      const history = await gallery.loadHistoryFromDir(dirName);
      const iterA = history.find((i) => i.version === versionA);
      const iterB = history.find((i) => i.version === versionB);
      if (!iterA || !iterB) {
        return res.status(400).json({ error: 'One or both versions not found', code: 'VERSIONS_NOT_FOUND' });
      }
      const codeA = 'code' in iterA ? iterA.code : null;
      const codeB = 'code' in iterB ? iterB.code : null;
      if (codeA != null && codeB != null) {
        const { mergeSketchCode } = await import('../dist/utils/mergeSketchCode.js');
        const merged = mergeSketchCode(codeA, codeB);
        return res.status(200).json({ proposed: { type: 'p5', code: merged } });
      }
      const musicA = iterA.type === 'organism' ? iterA.musicCode : '';
      const visualA = iterA.type === 'organism' ? iterA.visualCode : '';
      const musicB = iterB.type === 'organism' ? iterB.musicCode : '';
      const visualB = iterB.type === 'organism' ? iterB.visualCode : '';
      const proposed = { type: 'organism', musicCode: musicA || musicB, visualCode: visualB || visualA };
      res.status(200).json({ proposed });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Approve proposed iteration and save as next version
  app.post('/api/approve', async (req, res) => {
    try {
      const dirName = req.body?.dirName;
      const proposed = req.body?.proposed;
      if (!dirName || !proposed) {
        return res.status(400).json({ error: 'dirName and proposed are required' });
      }
      if (proposed.type && !['p5', 'organism'].includes(proposed.type)) {
        return res.status(400).json({ error: 'Invalid proposed type' });
      }
      const cfgPath = getConfigPath();
      const userConfig = unwrapConfigResult(await loadConfig(cfgPath));
      const projectConfig = await loadProjectConfig(cwd);
      const galleryPath = userConfig?.galleryPath ?? projectConfig?.galleryPath ?? DEFAULTS.galleryPath;
      let resolvedGallery;
      try { resolvedGallery = validateGalleryPath(galleryPath); } catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
      const gallery = new Gallery(resolvedGallery);
      const history = await gallery.loadHistoryFromDir(dirName);
      const nextVersion = history.length === 0 ? 1 : Math.max(...history.map((i) => i.version)) + 1;
      const projectName = dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '');
      if (proposed.type === 'organism' && proposed.musicCode != null && proposed.visualCode != null) {
        await gallery.saveOrganism(projectName, nextVersion, proposed.musicCode, proposed.visualCode);
        logSecurityEvent({ type: 'gallery_write', severity: 'low', message: `Saved organism ${projectName} v${nextVersion}`, context: { endpoint: '/api/approve' } });
      } else {
        const code = proposed.code != null ? proposed.code : (proposed.musicCode || '') + '\n' + (proposed.visualCode || '');
        await gallery.saveIteration(projectName, nextVersion, code);
        logSecurityEvent({ type: 'gallery_write', severity: 'low', message: `Saved iteration ${projectName} v${nextVersion}`, context: { endpoint: '/api/approve' } });
      }
      res.status(200).json({ ok: true, version: nextVersion });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Propose-mutate: traits-only (deterministic) or creative (LLM)
  app.post('/api/propose-mutate', async (req, res) => {
    try {
      const dirName = req.body?.dirName;
      const version = parseInt(req.body?.version, 10);
      const traits = req.body?.traits && typeof req.body.traits === 'object' ? req.body.traits : {};
      const creative = req.body?.creative === true;
      if (!dirName || !Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: 'dirName and version (positive integer) are required' });
      }
      const cfgPath = getConfigPath();
      const userConfig = unwrapConfigResult(await loadConfig(cfgPath));
      const projectConfig = await loadProjectConfig(cwd);
      const galleryPath = userConfig?.galleryPath ?? projectConfig?.galleryPath ?? DEFAULTS.galleryPath;
      let resolvedGallery;
      try { resolvedGallery = validateGalleryPath(galleryPath); } catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
      const gallery = new Gallery(resolvedGallery);
      const history = await gallery.loadHistoryFromDir(dirName);
      const iter = history.find((i) => i.version === version);
      if (!iter) return res.status(400).json({ error: 'Version not found', code: 'VERSION_NOT_FOUND' });
      const prompt = req.body?.prompt || 'ambient';
      if (creative) {
        const { LLMClient } = await import('../dist/llm/LLMClient.js');
        const client = new LLMClient();
        const musicCode = iter.type === 'organism' ? iter.musicCode : iter.code;
        const visualCode = iter.type === 'organism' ? iter.visualCode : iter.code;
        const resp = await client.improveP5Sketch(musicCode + '\n\n' + visualCode);
        return res.status(200).json({ proposed: { type: 'p5', code: resp.code } });
      }
      const seed = iter.type === 'organism'
        ? { musicCode: iter.musicCode, visualCode: iter.visualCode }
        : { musicCode: '', visualCode: iter.code || '' };
      const proposed = buildDeterministicOrganism(prompt, traits, seed);
      res.status(200).json({ proposed });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Compost seeds: serve seeds.json for the GUI browser
  app.get('/api/seeds', (_req, res) => {
    try {
      const seedsPath = path.join(cwd, 'compost', 'seeds', 'seeds.json');
      if (!fs.existsSync(seedsPath)) {
        return res.json({ seeds: [], total: 0 });
      }
      const raw = fs.readFileSync(seedsPath, 'utf-8');
      const seeds = JSON.parse(raw);
      const total = Array.isArray(seeds) ? seeds.length : 0;
      res.json({ seeds: Array.isArray(seeds) ? seeds : [], total });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Compost status: heap/seed/soup overview
  app.get('/api/compost/status', async (_req, res) => {
    try {
      const { CompostMill } = await import('../dist/compost/CompostMill.js');
      const { LLMClient } = await import('../dist/llm/LLMClient.js');
      const llm = new LLMClient({ role: 'generator' });
      const mill = new CompostMill(llm);
      const status = await mill.statusAsync();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // SSE event stream — mirrors PreviewServer for GUI frontend
  const sseClients = new Set();

  // Forward events from the singleton eventBus to SSE clients
  eventBus.onEvent((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
  });

  app.get('/api/events', validateSSEOrigin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    setStudioCommonSecurityHeaders(res);
    res.flushHeaders();
    res.write(': connected\n\n');

    const recent = eventBus.getRecentEvents();
    for (const event of recent) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    req.on('error', () => sseClients.delete(res));
    res.on('error', () => sseClients.delete(res));
  });

  // System status — heap/seed/soup counts + recent events
  app.get('/api/status', async (_req, res) => {
    try {
      const { CompostMill } = await import('../dist/compost/CompostMill.js');
      const { mergeConfig } = await import('../dist/compost/defaults.js');
      const { LLMClient } = await import('../dist/llm/LLMClient.js');
      const llm = new LLMClient({ role: 'generator' });
      const mill = new CompostMill(llm, mergeConfig());
      const millStatus = await mill.statusAsync();
      res.json({
        heapSize: millStatus.heapSize,
        heapFileCount: millStatus.heapFileCount,
        seedCount: millStatus.seedCount,
        soupRunning: millStatus.soupRunning,
        loopProgress: null,
        recentEvents: eventBus.getRecentEvents().slice(-20),
      });
    } catch (err) {
      res.json({ error: err instanceof Error ? err.message : 'Status unavailable' });
    }
  });

  // Compost dashboard — full heap/seed/soup stats with top seeds
  app.get('/api/compost/dashboard', async (_req, res) => {
    try {
      const { CompostMill } = await import('../dist/compost/CompostMill.js');
      const { mergeConfig } = await import('../dist/compost/defaults.js');
      const { LLMClient } = await import('../dist/llm/LLMClient.js');
      const llm = new LLMClient({ role: 'generator' });
      const mill = new CompostMill(llm, mergeConfig());
      const [millStatus, topSeeds, seedCount] = await Promise.all([
        mill.statusAsync(),
        mill.getTopSeeds(10),
        mill.getSeedCount(),
      ]);
      res.json({
        heap: { size: millStatus.heapSize, fileCount: millStatus.heapFileCount },
        seeds: { count: seedCount, top: topSeeds.map(s => ({ id: s.id, score: s.score, domain: s.source?.domains?.[0] ?? 'unknown', preview: s.content.slice(0, 100) })) },
        soup: { running: millStatus.soupRunning },
        shouldAutoDigest: await mill.shouldAutoDigest(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Feed gallery output to compost heap
  app.post('/api/compost/add', async (req, res) => {
    try {
      const dirName = req.body?.dirName;
      const version = parseInt(req.body?.version, 10);
      if (!dirName || !Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: 'dirName and version (positive integer) are required' });
      }
      const cfgPath = getConfigPath();
      const userConfig = unwrapConfigResult(await loadConfig(cfgPath));
      const projectConfig = await loadProjectConfig(cwd);
      const galleryPath = userConfig?.galleryPath ?? projectConfig?.galleryPath ?? DEFAULTS.galleryPath;
      let resolvedGallery;
      try { resolvedGallery = validateGalleryPath(galleryPath); } catch { return res.status(400).json({ error: 'Invalid gallery path' }); }
      const gallery = new Gallery(resolvedGallery);
      const history = await gallery.loadHistoryFromDir(dirName);
      const iter = history.find((i) => i.version === version);
      if (!iter) return res.status(400).json({ error: 'Version not found' });

      const { CompostMill } = await import('../dist/compost/CompostMill.js');
      const { mergeConfig } = await import('../dist/compost/defaults.js');
      const { LLMClient } = await import('../dist/llm/LLMClient.js');
      const llm = new LLMClient({ role: 'generator' });
      const mill = new CompostMill(llm, mergeConfig());
      const code = 'code' in iter ? iter.code : (iter.musicCode + '\n' + iter.visualCode);
      // Write to temp file and add to heap
      const fs = await import('fs/promises');
      const tmpDir = path.join(cwd, 'compost', 'heap', '_gui');
      await fs.mkdir(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `gui-${dirName}-v${version}.js`);
      await fs.writeFile(tmpFile, code, 'utf-8');
      await mill.add([tmpFile]);
      res.json({ ok: true, message: 'Added to compost heap' });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return app;
}

export default createApp;
