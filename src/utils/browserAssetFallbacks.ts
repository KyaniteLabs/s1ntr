import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { readVendorAsset } from './vendorAssets.js';
import { VENDORED_LIBRARIES } from '../core/wrappers/VendoredLibraries.js';
import {
  ensurePurgeResistantBrowserEnv,
  checkDiskPressureOnce,
  attemptBrowserInstallOnce,
  scanLegacyBrowserCaches,
  defaultPlaywrightBrowsersPath,
  type BrowserPreflightOptions,
} from './browserPreflight.js';

const require = createRequire(import.meta.url);

/**
 * Legacy CDN URL → vendored asset path (#924). New artifacts reference
 * /vendor/... directly; this map lets the QA renderers keep fulfilling
 * references found in ALREADY-GENERATED artifacts from the exact vendored
 * bytes instead of the network. Keep in sync with vendor/manifest.json.
 */
const LEGACY_CDN_URLS: Readonly<Record<string, string>> = {
  'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js': '/vendor/p5/1.9.0/p5.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/addons/p5.sound.min.js': '/vendor/p5/1.9.0/p5.sound.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js': '/vendor/three/r128/three.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js': '/vendor/tone/14.8.49/Tone.js',
  'https://unpkg.com/three@0.160.0/build/three.module.js': '/vendor/three/0.160.0/three.module.js',
  'https://unpkg.com/tone@14.8.49/build/Tone.js': '/vendor/tone/14.8.49/Tone.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js': '/vendor/three/0.160.0/three.module.js',
  'https://unpkg.com/hydra-synth': '/vendor/hydra-synth/1.3.10/hydra-synth.js',
  'https://cdn.jsdelivr.net/npm/hydra-synth@1.3.10/dist/hydra-synth.js': '/vendor/hydra-synth/1.3.10/hydra-synth.js',
  'https://cdn.jsdelivr.net/npm/@strudel/web@1.3.0/dist/index.js': '/vendor/strudel-web/1.3.0/strudel-web.js',
  'https://cdn.jsdelivr.net/npm/d3@7': '/vendor/d3/7.9.0/d3.min.js',
  'https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js': '/vendor/gsap/3.15.0/gsap.min.js',
};

function isP5CdnUrl(rawUrl: string): 'p5' | 'p5Sound' | null {
  try {
    const url = new URL(rawUrl);
    // Resolve p5.js from both cdnjs and jsdelivr CDNs to the local install.
    if (url.hostname !== 'cdnjs.cloudflare.com' && url.hostname !== 'cdn.jsdelivr.net') return null;

    const pathname = url.pathname.toLowerCase();
    // cdnjs: /ajax/libs/p5.js/X.Y.Z/p5.min.js
    // jsdelivr: /npm/p5@X.Y.Z/lib/p5.min.js
    const isP5 = pathname.includes('/p5.js/') || pathname.includes('/p5@') || pathname.endsWith('/p5.min.js') || pathname.endsWith('/p5.js');
    if (!isP5) return null;

    if (
      pathname.endsWith('/p5.sound.min.js')
      || pathname.endsWith('/p5.sound.js')
      || pathname.endsWith('/addons/p5.sound.min.js')
      || pathname.endsWith('/addons/p5.sound.js')
      || pathname.includes('/p5.sound')
    ) {
      return 'p5Sound';
    }
    if (pathname.endsWith('/p5.min.js') || pathname.endsWith('/p5.js')
      || pathname.includes('/lib/p5.min.js') || pathname.includes('/lib/p5.js')) {
      return 'p5';
    }
  } catch {
    return null;
  }

  return null;
}

export function isPuppeteerChromeCompatible(
  executablePath: string,
  platform = process.platform,
  arch = process.arch,
): boolean {
  // Chrome for Testing does not publish Linux arm64 builds. Puppeteer can
  // still install its x64 binary into an arm64-named cache directory, where
  // it fails at launch under QEMU. Prefer the CI-provided native Chromium.
  return !(platform === 'linux' && arch === 'arm64' && executablePath.includes('/chrome-linux64/'));
}

/**
 * Map a rendered page's script URL to the vendored asset path that should be
 * served for it. Handles (in order): direct /vendor/ references (new
 * artifacts), exact legacy CDN URLs (already-generated artifacts), and any
 * cdnjs/jsdelivr p5 URL (older p5 version pins). Returns null when the URL is
 * not a vendored library reference.
 */
/**
 * Any D3 v7 bundle URL on a known CDN (jsdelivr/unpkg/cdnjs/d3js.org). Models
 * write many spellings (d3@7, d3@7.8.5/dist/d3.min.js, d3.v7.min.js); all are
 * API-compatible with the vendored 7.9.0, so a CDN slip still renders offline.
 */
function isD3V7CdnUrl(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const p = url.pathname.toLowerCase();
  // d3js.org/d3.min.js is the latest build, which is v7.
  if (host === 'd3js.org') return p === '/d3.v7.min.js' || p === '/d3.v7.js' || p === '/d3.min.js' || p === '/d3.js';
  if (host === 'cdn.jsdelivr.net' || host === 'unpkg.com') {
    return /^\/(npm\/)?d3@7(\.\d+){0,2}(\/(dist\/d3(\.min)?\.js)?)?$/.test(p);
  }
  if (host === 'cdnjs.cloudflare.com') return /^\/ajax\/libs\/d3\/7\.\d+\.\d+\/d3(\.min)?\.js$/.test(p);
  return false;
}

/**
 * Script-loaded libraries from the vendored index (culori, the d3 add-ons,
 * roughjs, matter-js, ...), keyed by npm name. Without this a model that
 * writes <script src=".../culori@4/..."> keeps the CDN URL, the page CSP
 * (script-src 'self') blocks it, and the piece dies on "culori is not
 * defined" even though the same library ships in /vendor.
 */
const SCRIPT_LIBRARIES = Object.entries(VENDORED_LIBRARIES)
  .filter(([, e]) => e.load === 'script')
  .map(([id, e]) => ({ npm: (e.npm ?? id).toLowerCase(), version: e.file.split('/')[3], file: e.file }));

/** Same API line as the vendored build: same major, or same 0.minor below 1.0. */
function sameApiLine(requested: string, vendored: string): boolean {
  const [rMaj, rMin] = requested.split('.');
  const [vMaj, vMin] = vendored.split('.');
  if (rMaj !== vMaj) return false;
  return vMaj !== '0' || rMin === vMin;
}

/** A jsdelivr/unpkg/cdnjs URL for a script library Sinter vendors, mapped to its /vendor file. */
function vendoredLibraryForCdnUrl(rawUrl: string): string | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const p = url.pathname.toLowerCase();
  // ESM builds are imports, not classic scripts; the UMD file would not stand in for them.
  if (p.includes('+esm') || p.endsWith('.mjs') || /\/(esm|es)\//.test(p)) return null;
  let pkg: string | undefined;
  let version: string | undefined;
  if (host === 'cdn.jsdelivr.net' || host === 'unpkg.com') {
    const m = /^\/(?:npm\/)?((?:@[^/]+\/)?[^/@]+)@(\d+(?:\.\d+){0,2})(?:\/|$)/.exec(p);
    [pkg, version] = m ? [m[1], m[2]] : [];
  } else if (host === 'cdnjs.cloudflare.com') {
    const m = /^\/ajax\/libs\/([^/]+)\/(\d+(?:\.\d+){0,2})\//.exec(p);
    [pkg, version] = m ? [m[1], m[2]] : [];
  }
  if (!pkg || !version) return null;
  const lib = SCRIPT_LIBRARIES.find((l) => l.npm === pkg || `${l.npm}.js` === pkg || l.npm === `${pkg}.js`);
  return lib && sameApiLine(version, lib.version) ? lib.file : null;
}

/**
 * three on jsdelivr/unpkg: the 0.160 module build (any 0.160.x spelling) and the
 * classic build, which the vendored r128 global stands in for. Other majors of
 * the module build would not match the vendored API, so they stay unmapped.
 */
function vendoredThreeForCdnUrl(rawUrl: string): string | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (host !== 'cdn.jsdelivr.net' && host !== 'unpkg.com') return null;
  const m = /^\/(?:npm\/)?three@(\d+(?:\.\d+){0,2})\/build\/(three\.module\.js|three\.min\.js)$/i.exec(url.pathname);
  if (!m) return null;
  if (m[2].toLowerCase() === 'three.min.js') return '/vendor/three/r128/three.min.js';
  return /^0\.160(\.\d+)?$/.test(m[1]) ? '/vendor/three/0.160.0/three.module.js' : null;
}

/** Only the classic GSAP 3 core bundle can use the vendored script. */
function isGsapV3CdnUrl(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.hostname === 'cdnjs.cloudflare.com') {
    return /^\/ajax\/libs\/gsap\/3\.\d+\.\d+\/gsap(?:\.min)?\.js$/.test(url.pathname);
  }
  const prefix = url.hostname === 'cdn.jsdelivr.net' ? '/npm/' : '/';
  return (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com')
    && url.pathname.startsWith(prefix)
    && /^gsap@3(?:\.\d+){0,2}(?:\/dist\/gsap(?:\.min)?\.js|\/?)$/.test(url.pathname.slice(prefix.length));
}

/** The served /vendor path for a known CDN library URL, or null (#924, FABLE-R3.7). */
export function vendorPathForUrl(rawUrl: string): string | null {
  if (rawUrl.startsWith('/vendor/')) return rawUrl;
  const legacy = LEGACY_CDN_URLS[rawUrl];
  if (legacy) return legacy;
  if (isD3V7CdnUrl(rawUrl)) return '/vendor/d3/7.9.0/d3.min.js';
  if (isGsapV3CdnUrl(rawUrl)) return '/vendor/gsap/3.15.0/gsap.min.js';
  const library = vendoredLibraryForCdnUrl(rawUrl);
  if (library) return library;
  const three = vendoredThreeForCdnUrl(rawUrl);
  if (three) return three;
  const p5Key = isP5CdnUrl(rawUrl);
  if (p5Key) {
    return p5Key === 'p5' ? '/vendor/p5/1.9.0/p5.min.js' : '/vendor/p5/1.9.0/p5.sound.min.js';
  }
  return null;
}

/**
 * External <script src> URLs in a page that no vendored copy can stand in for.
 * The page CSP is script-src 'self', so each of these is blocked at render and
 * the piece dies on a missing global (v2r1: 12 runs, one on an invented host).
 */
export function unservedScriptUrls(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    const src = m[2].trim();
    if (/^(?:https?:)?\/\//i.test(src) && !vendorPathForUrl(src.startsWith('//') ? `https:${src}` : src)) urls.push(src);
  }
  return urls;
}

/**
 * Fulfill a rendered page's library reference from the vendored bytes (#924).
 * Returns null when the URL is not a vendored library reference.
 */
export async function getVendoredScriptForUrl(rawUrl: string): Promise<string | null> {
  const vendorPath = vendorPathForUrl(rawUrl);
  if (!vendorPath) return null;
  return readVendorAsset(vendorPath);
}

/**
 * Back-compat alias for getVendoredScriptForUrl (historically p5-only).
 * Kept because existing callers and tests assert p5 fulfillment behavior.
 */
export async function getLocalP5ScriptForUrl(rawUrl: string): Promise<string | null> {
  return getVendoredScriptForUrl(rawUrl);
}

export interface PinnedBrowserAsset {
  readonly id: string;
  readonly body: string;
  readonly digest: string;
}

/** Resolve a rendered page's library reference to exact vendored bytes. */
export async function getPinnedBrowserAssetForUrl(
  rawUrl: string,
): Promise<PinnedBrowserAsset | null> {
  const vendorPath = vendorPathForUrl(rawUrl);
  if (!vendorPath) return null;
  const body = await readVendorAsset(vendorPath);
  return Object.freeze({ id: vendorPath, body,
    digest: createHash('sha256').update(body).digest('hex') });
}

/**
 * Resolve chromium without install side-effects (pure lookup chain).
 *
 * Tier order:
 *  1. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH override
 *  2. playwright's default chromium executablePath() (respects PLAYWRIGHT_BROWSERS_PATH)
 *  3. puppeteer's installed Chrome executablePath(), when architecture-safe
 *     (skipped when PLAYWRIGHT_BROWSERS_PATH is explicitly set — fail closed)
 *  4. scan PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers'
 *  5. legacy cache scan (read-only reuse before install)
 *     (skipped when PLAYWRIGHT_BROWSERS_PATH is explicitly set — fail closed)
 *
 * Explicit PLAYWRIGHT_BROWSERS_PATH must not silently fall through to purgeable
 * ~/Library/Caches or ~/.cache paths (F9: that was the root failure mode).
 */
export function resolveChromiumExecutablePathLookup(): string | undefined {
  // Tier 1: explicit override
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (existsSync(override)) return override;
    // Override is set but missing — let the caller handle it; don't silently
    // fall through to the next tier.
    return undefined;
  }

  const explicitBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;

  // Tier 2: playwright's own default
  // Lazy require avoids eager-loading the heavy playwright module. The
  // Chromium handle stays inline (never a bare local) so the sandbox
  // scanner in test/security/playwright-sandbox.test.ts can track it.
  let preferredPath: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    preferredPath = require('playwright').chromium.executablePath();
  } catch {
    // playwright or its browser registry absent — fall through to tier 3 scan.
    preferredPath = undefined;
  }
  if (preferredPath && existsSync(preferredPath)) {
    // When browsers path is pinned, only accept binaries strictly inside that directory.
    const rel = explicitBrowsersPath ? relative(resolve(explicitBrowsersPath), resolve(preferredPath)) : '';
    const insidePinned = !explicitBrowsersPath || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
    if (insidePinned) {
      return preferredPath;
    }
  }

  // Tier 3: reuse Puppeteer's browser only when path is not pinned.
  if (!explicitBrowsersPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const puppeteerPath = require('puppeteer').executablePath();
      if (existsSync(puppeteerPath) && isPuppeteerChromeCompatible(puppeteerPath)) {
        return puppeteerPath;
      }
    } catch {
      // puppeteer/browser absent — fall through to the shared runner scan.
    }
  }

  // Tier 4: scan PLAYWRIGHT_BROWSERS_PATH (or /opt/pw-browsers)
  const browsersPath = explicitBrowsersPath ?? '/opt/pw-browsers';
  if (existsSync(browsersPath)) {
    try {
      const revisionOf = (name: string): number => {
        const m = /(\d+)$/.exec(name);
        return m ? Number.parseInt(m[1], 10) : -1;
      };
      const dirs = readdirSync(browsersPath)
        .filter((d) => d.startsWith('chromium'))
        .sort((a, b) => revisionOf(b) - revisionOf(a) || b.localeCompare(a));
      for (const dir of dirs) {
        for (const subPath of [
          'chrome-linux/chrome',
          'chrome-linux64/chrome',
          // macOS Chrome for Testing layout
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ]) {
          const candidate = `${browsersPath}/${dir}/${subPath}`;
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // Scan failure — fall through.
    }
  }

  // A path the caller pinned that is empty → fail closed (no legacy Caches/ leak).
  // The durable default the preflight itself exports is not a pin: with a throwaway
  // HOME it is empty by construction, so the shared caches are still read.
  if (explicitBrowsersPath && explicitBrowsersPath !== defaultPlaywrightBrowsersPath()) return undefined;

  // Tier 5: legacy caches (reuse only — do not re-home env to Caches/)
  return scanLegacyBrowserCaches();
}

/**
 * Shared chromium executable resolver used by both HeadlessRenderer and
 * rescore-tops preflight.
 *
 * Applies purge-resistant browser env defaults, runs the disk-pressure
 * sentinel (non-blocking), and on miss attempts a one-shot install per process.
 * Returns the resolved absolute path, or undefined when still missing after
 * preflight (callers should fail loud via missingChromiumError).
 */
export function resolveChromiumExecutablePath(
  options: BrowserPreflightOptions & { skipInstall?: boolean } = {},
): string | undefined {
  ensurePurgeResistantBrowserEnv();
  checkDiskPressureOnce(options);

  const found = resolveChromiumExecutablePathLookup();
  if (found) return found;

  if (options.skipInstall) return undefined;

  // One-shot self-heal — never a silent flake cluster.
  attemptBrowserInstallOnce('playwright-chromium', options);
  return resolveChromiumExecutablePathLookup();
}

/**
 * Pure all-degraded guard for rescore-tops.
 *
 * Returns the exit code and diagnostic message that rescore-tops should emit
 * when all scored entries are infra-degraded or scorer-degraded (i.e. no
 * honest evidence was gathered). This function is intentionally side-effect free
 * so it can be unit-tested with zero runtime dependencies (no browser, no LLM).
 *
 * @param totalEntries  Total entries processed in this run.
 * @param honestEntries Count of entries whose evaluation failureClass is NOT
 *                      'infra' AND NOT 'scorer'.
 */
export interface AllDegradedGuardResult {
  /** true when the cadence should halt (all evidence degraded) */
  allDegraded: boolean;
  /** Exit code: 1 when allDegraded, 0 otherwise */
  exitCode: number;
  /** null when allDegraded; the FATAL diagnostic string otherwise */
  message: null | string;
}

export function allDegradedGuard(
  totalEntries: number,
  honestEntries: number,
): AllDegradedGuardResult {
  if (totalEntries > 0 && honestEntries === 0) {
    return {
      allDegraded: true,
      exitCode: 1,
      message: `[rescore] FATAL: all ${totalEntries} entries infra-degraded — render infrastructure down?`,
    };
  }
  return { allDegraded: false, exitCode: 0, message: null };
}
