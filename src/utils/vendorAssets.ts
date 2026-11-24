/**
 * Vendored browser asset registry — single source of truth for the locally
 * hosted libraries that wrapped artifacts load (issue #924).
 *
 * Artifacts reference these files via ROOT-ABSOLUTE paths (`/vendor/...`) so
 * they resolve on any static server whose docroot contains the repo's
 * `vendor/` directory (fleet-server serves the repo root at `/`; artifact
 * cache roots mirror `vendor/`). Zero CDN: there is no remote fallback. A
 * missing vendor file throws — loud failure at render setup, never a silent
 * blank canvas. The one exception is RUNTIME_FETCHED_ASSETS (GSAP), which the
 * public source tree does not ship: there the bytes come from the pinned CDN
 * URL and must match the pinned sha256.
 *
 * `inlineVendorAssets` exists for the in-process render path only:
 * `page.setContent` runs the page at about:blank where root-absolute URLs
 * never resolve, so scripts must be inlined and import maps rewritten to
 * data: URLs before `setContent`. Artifacts served over HTTP keep the file
 * references untouched.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { VENDORED_LIBRARIES } from '../core/wrappers/VendoredLibraries.js';

export const VENDOR_BASE_PATH = '/vendor';

/** Root-absolute URL paths for every vendored library (see vendor/manifest.json). */
export const VENDOR_ASSETS = {
  p5: '/vendor/p5/1.9.0/p5.min.js',
  p5Sound: '/vendor/p5/1.9.0/p5.sound.min.js',
  threeGlobal: '/vendor/three/r128/three.min.js',
  threeModule: '/vendor/three/0.160.0/three.module.js',
  threeOrbitControls: '/vendor/three/0.160.0/examples/jsm/controls/OrbitControls.js',
  tone: '/vendor/tone/14.8.49/Tone.js',
  hydra: '/vendor/hydra-synth/1.3.10/hydra-synth.js',
  strudel: '/vendor/strudel-web/1.3.0/strudel-web.js',
  strudelClockworker: '/vendor/strudel-web/1.3.0/assets/clockworker-ZDiUtESR.js',
  d3: '/vendor/d3/7.9.0/d3.min.js',
  gsap: '/vendor/gsap/3.15.0/gsap.min.js',
  // three@0.185.1:
  // the webgpu/tsl builds import ./three.core.min.js, so the core and the
  // WebGL module build must be served beside them.
  threeWebgpuCore: '/vendor/three-webgpu/0.185.1/three.core.min.js',
  threeWebgpuModule: '/vendor/three-webgpu/0.185.1/three.module.min.js',
  // holospot (vendored MIT library) — holo.js entry point plus every asset it
  // can fetch at runtime (bump maps, volume subjects, foil logos). The kit
  // resolves assets relative to holo.js, i.e. /vendor/holospot/0.1.0/assets/.
  holospot: '/vendor/holospot/0.1.0/dist/holo.js',
  holospotBumpsScratches: '/vendor/holospot/0.1.0/assets/bumps/scratches.jpg',
  holospotBumpsBrushed: '/vendor/holospot/0.1.0/assets/bumps/brushed.png',
  holospotBumpsCrinkle: '/vendor/holospot/0.1.0/assets/bumps/crinkle.png',
  holospotBumpsHammered: '/vendor/holospot/0.1.0/assets/bumps/hammered.png',
  holospotBumpsLinen: '/vendor/holospot/0.1.0/assets/bumps/linen.png',
  holospotBumpsSandblast: '/vendor/holospot/0.1.0/assets/bumps/sandblast.png',
  holospotVolumeEagle: '/vendor/holospot/0.1.0/assets/holo3d/eagle.sdf',
  holospotVolumeChip: '/vendor/holospot/0.1.0/assets/holo3d/chip.sdf',
  holospotVolumeWolf: '/vendor/holospot/0.1.0/assets/holo3d/wolf.sdf',
  holospotVolumeGlobe: '/vendor/holospot/0.1.0/assets/holo3d/globe.sdf',
  holospotVolumeFalcon: '/vendor/holospot/0.1.0/assets/holo3d/falcon.sdf',
  holospotLogoRosette: '/vendor/holospot/0.1.0/assets/logos/rosette.svg',
  holospotLogoKoru: '/vendor/holospot/0.1.0/assets/logos/koru.svg',
  holospotLogoLeaf: '/vendor/holospot/0.1.0/assets/logos/leaf.svg',
  holospotLogoFacets: '/vendor/holospot/0.1.0/assets/logos/facets.svg',
} as const;

export type VendorAssetPath = (typeof VENDOR_ASSETS)[keyof typeof VENDOR_ASSETS];

// The capability libraries the prompts offer (VendoredLibraries) are served
// too, so the two lists cannot drift: a library a model is told it may use
// must never die at render as "unregistered". Prefix entries (thi.ng) are
// directories, not files, and stay out.
const VENDOR_ASSET_PATHS: ReadonlySet<string> = new Set([
  ...Object.values(VENDOR_ASSETS),
  ...Object.values(VENDORED_LIBRARIES).map((entry) => entry.file).filter((file) => !file.endsWith('/')),
]);

/** True when the path is one of the registered vendored asset URLs. */
export function isVendorAssetPath(path: string): boolean {
  return VENDOR_ASSET_PATHS.has(path);
}

/** Repo `vendor/` directory — resolves from src/ (dev) and dist/ (built). */
export function vendorRoot(): string {
  return fileURLToPath(new URL('../../vendor/', import.meta.url));
}

/**
 * Vendored files the public source tree does not ship. GSAP's Standard
 * "No Charge" License is Webflow's own licence and does not clearly allow
 * redistribution in a public repo, so scripts/atelier/sync-public-mirror.sh
 * leaves vendor/gsap/ out of the public snapshot. Where the file is absent,
 * GSAP is fetched at runtime from its CDN, once per process, and used only if
 * its sha256 matches the manifest pin. The private tree keeps the vendored copy.
 */
export const RUNTIME_FETCHED_ASSETS: Readonly<Record<string, { url: string; sha256: string }>> = Object.freeze({
  '/vendor/gsap/3.15.0/gsap.min.js': {
    url: 'https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js',
    sha256: '92bb9a96476f983d212a2bc4f54c889039c1696dd4461d40a736860938570fbb',
  },
});

const RUNTIME_FETCH_TIMEOUT_MS = 30_000;
const RUNTIME_FETCH_MAX_BYTES = 10 * 1024 * 1024;

/** Fetch a RUNTIME_FETCHED_ASSETS entry from its CDN; rejects unless the bytes match the pin. */
export async function fetchPinnedRuntimeAsset(
  urlPath: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const pin = RUNTIME_FETCHED_ASSETS[urlPath];
  if (!pin) throw new Error(`vendorAssets: no runtime source for ${urlPath}`);
  const res = await fetchImpl(pin.url, { signal: AbortSignal.timeout(RUNTIME_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`vendorAssets: ${pin.url} answered HTTP ${res.status}`);
  const lenHeader = res.headers?.get?.('content-length');
  if (lenHeader && Number(lenHeader) > RUNTIME_FETCH_MAX_BYTES) {
    throw new Error(`vendorAssets: ${pin.url} content-length ${lenHeader} exceeds ${RUNTIME_FETCH_MAX_BYTES} bytes`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > RUNTIME_FETCH_MAX_BYTES) {
    throw new Error(`vendorAssets: ${pin.url} body ${bytes.byteLength} exceeds ${RUNTIME_FETCH_MAX_BYTES} bytes`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.sha256) {
    throw new Error(`vendorAssets: ${pin.url} sha256 ${digest} does not match the pin ${pin.sha256}`);
  }
  return bytes.toString('utf8');
}

const assetCache = new Map<string, Promise<string>>();

/**
 * Read a vendored asset by its absolute URL path (e.g. `/vendor/p5/1.9.0/p5.min.js`).
 * Rejects LOUDLY when the file is missing — artifacts must never fall back to CDNs.
 */
export function readVendorAsset(urlPath: string): Promise<string> {
  if (!urlPath.startsWith(`${VENDOR_BASE_PATH}/`)) {
    return Promise.reject(new Error(`vendorAssets: not a ${VENDOR_BASE_PATH}/ path: ${urlPath}`));
  }
  if (!isVendorAssetPath(urlPath)) {
    return Promise.reject(new Error(`vendorAssets: unregistered vendored asset: ${urlPath}`));
  }
  let cached = assetCache.get(urlPath);
  if (!cached) {
    const rel = urlPath.slice(VENDOR_BASE_PATH.length + 1);
    const pin = RUNTIME_FETCHED_ASSETS[urlPath];
    cached = readFile(`${vendorRoot()}${rel}`, 'utf8').then((content) => {
      if (pin) {
        const digest = createHash('sha256').update(content, 'utf8').digest('hex');
        if (digest !== pin.sha256) return fetchPinnedRuntimeAsset(urlPath);
      }
      return content;
    }).catch((err: unknown) => {
      if (pin && (err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return fetchPinnedRuntimeAsset(urlPath);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `vendorAssets: vendored asset missing on disk: ${urlPath} (${message}). ` +
        'Artifacts must not fall back to CDNs — restore the vendor/ file.',
      );
    }).catch((err: unknown) => {
      assetCache.delete(urlPath);
      throw err;
    });
    assetCache.set(urlPath, cached);
  }
  return cached;
}

const VENDOR_SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*(["'])((?:\/vendor\/)[^"']+)\1[^>]*>\s*<\/script>/gi;
const IMPORT_MAP_RE = /<script\b[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/gi;

function escapeScriptClose(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/** sha256 of a vendored body — the renderer's pinned-asset evidence unit. */
function vendoredDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Convert a vendored file to a data: URL for import maps (about:blank pages). */
async function vendorDataUrl(urlPath: string, onInlineAsset?: (digest: string) => void): Promise<string> {
  const body = await readVendorAsset(urlPath);
  onInlineAsset?.(vendoredDigest(body));
  return `data:text/javascript;base64,${Buffer.from(body, 'utf8').toString('base64')}`;
}

/**
 * Rewrite an artifact HTML for the embedded (setContent) render path:
 * - `<script src="/vendor/...">` tags become inline script bodies.
 * - Import map entries mapping an exact specifier to a `/vendor/...` URL are
 *   rewritten to data: URLs; prefix mappings pointing into `/vendor/` are
 *   dropped (they cannot be expressed as data: URLs; addon imports are banned
 *   by generator validation anyway).
 * Non-vendor URLs are left untouched — the renderer request policy governs them.
 *
 * Each vendored body that is inlined (script tag) or re-encoded (import map
 * entry) is reported through the optional observer as its sha256 digest — the
 * same evidence unit the renderer's network-route fallback records. Without
 * this, the embedded path could never prove a pinned runtime was loaded, and
 * the RENDER_PINNED_RUNTIME_ASSET_REQUIRED guard fired on every correctly
 * vendored piece (#924 regression).
 */
/** True when an import map in the page maps a specifier into `/vendor/`. */
export function hasVendorImportMap(html: string): boolean {
  return [...html.matchAll(IMPORT_MAP_RE)].some(m => m[1].includes(`"${VENDOR_BASE_PATH}/`));
}

export async function inlineVendorAssets(
  html: string,
  onInlineAsset?: (digest: string) => void,
  options: { keepImportMaps?: boolean } = {},
): Promise<string> {
  // HyperFrames previews put the composition in an escaped srcdoc iframe.
  // Its /vendor URLs also inherit about:blank and need inline bodies.
  const entities: Record<string, string> = {
    amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>',
  };
  let embedded = html;
  const frames = [...html.matchAll(/<iframe\b[^>]*\bsrcdoc="([^"]*)"[^>]*>/gi)];
  for (const frame of frames) {
    const source = frame[1].replace(/&(amp|quot|#39|lt|gt);/g,
      (_entity, name: string) => entities[name]);
    const body = await inlineVendorAssets(source, onInlineAsset, options);
    const escaped = body.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    embedded = embedded.replace(frame[0], () => frame[0].replace(
      /\bsrcdoc="[^"]*"/i, () => `srcdoc="${escaped}"`));
  }
  // Inline plain script tags (p5, tone, hydra, strudel, d3, gsap).
  const scriptMatches = [...embedded.matchAll(VENDOR_SCRIPT_SRC_RE)];
  let inlined = embedded;
  if (scriptMatches.length > 0) {
    const replacements = await Promise.all(scriptMatches.map(async (match) => {
      const body = await readVendorAsset(match[2]);
      onInlineAsset?.(vendoredDigest(body));
      return { match, inline: `<script>${escapeScriptClose(body)}</script>` };
    }));
    for (const { match, inline } of replacements) {
      inlined = inlined.replace(match[0], () => inline);
    }
  }

  // Rewrite import map mappings (three module). A page the renderer serves
  // from its own origin keeps the /vendor/ URLs: the wrapper CSP allows
  // 'self' but not data:, so a data: module would never load.
  if (options.keepImportMaps) return inlined;
  const importMaps = [...inlined.matchAll(IMPORT_MAP_RE)];
  for (const mapMatch of importMaps) {
    let mapJson: Record<string, unknown>;
    try {
      mapJson = JSON.parse(mapMatch[1]) as Record<string, unknown>;
    } catch {
      continue; // Not valid JSON — leave untouched; the page will fail visibly.
    }
    const imports = mapJson.imports;
    if (!imports || typeof imports !== 'object') continue;
    const next: Record<string, string> = {};
    let changed = false;
    for (const [specifier, target] of Object.entries(imports as Record<string, unknown>)) {
      if (typeof target !== 'string' || !target.startsWith(`${VENDOR_BASE_PATH}/`)) {
        next[specifier] = String(target);
        continue;
      }
      if (specifier.endsWith('/')) {
        changed = true; // Prefix mapping into /vendor: drop (cannot be a data: URL).
        continue;
      }
      next[specifier] = await vendorDataUrl(target, onInlineAsset);
      changed = true;
    }
    if (changed) {
      mapJson.imports = next;
      inlined = inlined.replace(
        mapMatch[0],
        () => `<script type="importmap">${JSON.stringify(mapJson)}</script>`,
      );
    }
  }

  return inlined;
}
