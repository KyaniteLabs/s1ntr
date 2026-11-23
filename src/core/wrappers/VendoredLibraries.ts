/**
 * VendoredLibraries — the single index of locally-vendored capability
 * libraries (medium-lab batches 1-3, integration phase 1, #1000).
 *
 * Every wrapper draws library <script>/importmap tags from HERE so a new
 * library lands once and every domain can request it. The vendor/
 * manifest.json remains the integrity source of truth (sha256 per asset);
 * the OfflineVendored test cross-checks this index against the manifest so
 * the two cannot drift.
 *
 * Load types:
 *  - script: UMD/global build -> plain <script src="/vendor/...">, exposes a
 *    global (window.culori, window.rough, ...).
 *  - module: ESM build -> importmap entry so generator code can
 *    `import { ... } from "culori"` style-import by id.
 *  - wasm-companion: sidecar bytes fetched by their parent library; no tag.
 *
 * Unknown ids FAIL LOUD (throw) at wrap time — a typo'd library request must
 * never silently render a dead piece (guardrail doctrine).
 */

export type VendoredLibraryId =
  | 'd3' | 'culori' | 'd3-delaunay' | 'd3-contour' | 'perfect-freehand'
  | 'roughjs' | 'tonaljs' | 'matter-js' | 'paper' | 'fontkit'
  | 'd3-geo' | 'twgl' | 'rapier2d' | 'harfbuzz'
  // phase 2 (additive opt-ins; default three stays 0.160.0 for the byte-tie)
  | 'three-webgpu' | 'three-tsl' | 'three-gpu-pathtracer' | 'three-mesh-bvh' | 'xatlas-web'
  | 'holospot' | 'sinter-look' | 'sinter-flow' | 'sinter-music'
  | 'thing'; // the thi.ng umbrella: 45 packages via one importmap PREFIX entry

export interface VendoredLibraryEntry {
  readonly file: string;
  readonly load: 'script' | 'module' | 'module-prefix';
  /** window global for script builds (what generator code calls). */
  readonly global?: string;
  /** npm package name when it differs from the id (CDN URLs use it). */
  readonly npm?: string;
}

import { THING_IMPORTMAP } from './thing-importmap.generated.js';

export const VENDORED_LIBRARIES: Readonly<Record<VendoredLibraryId, VendoredLibraryEntry>> = {
  d3:                { file: '/vendor/d3/7.9.0/d3.min.js',                 load: 'script', global: 'd3' },
  culori:            { file: '/vendor/culori/4.0.2/culori.min.js',              load: 'script', global: 'culori' },
  'd3-delaunay':     { file: '/vendor/d3-delaunay/6.0.4/d3-delaunay.min.js',    load: 'script', global: 'd3' },
  'd3-contour':      { file: '/vendor/d3-contour/4.0.2/d3-contour.min.js',      load: 'script', global: 'd3' },
  'perfect-freehand':{ file: '/vendor/perfect-freehand/1.2.3/index.mjs',        load: 'module' },
  'sinter-look':     { file: '/vendor/sinter-kits/1.0.0/sinter-look.js',        load: 'script', global: 'SinterLook' },
  'sinter-flow':     { file: '/vendor/sinter-kits/1.0.0/sinter-flow.js',        load: 'script', global: 'SinterFlow' },
  'sinter-music':    { file: '/vendor/sinter-kits/1.0.0/sinter-music.js',       load: 'script', global: 'SinterMusic' },
  roughjs:           { file: '/vendor/roughjs/4.6.6/rough.js',                  load: 'script', global: 'rough' },
  tonaljs:           { file: '/vendor/tonaljs/4.10.0/index.mjs',                 load: 'module' },
  'matter-js':       { file: '/vendor/matter-js/0.20.0/matter.min.js',          load: 'script', global: 'Matter' },
  paper:             { file: '/vendor/paper/0.12.18/paper-core.min.js',         load: 'script', global: 'paper' },
  fontkit:           { file: '/vendor/fontkit/2.0.4/fontkit.min.js',               load: 'script', global: 'fontkit' },
  'd3-geo':          { file: '/vendor/d3-geo/3.1.1/d3-geo.min.js',              load: 'script', global: 'd3' },
  twgl:              { file: '/vendor/twgl/7.0.0/twgl-full.js',                 load: 'script', global: 'twgl', npm: 'twgl.js' },
  rapier2d:          { file: '/vendor/rapier2d/0.20.0/rapier.mjs',              load: 'module' },
  harfbuzz:          { file: '/vendor/harfbuzz/1.6.0/harfbuzz.js',              load: 'module' },
  'three-webgpu':    { file: '/vendor/three-webgpu/0.185.1/three.webgpu.min.js',  load: 'module' },
  'three-tsl':       { file: '/vendor/three-tsl/0.185.1/three.tsl.min.js',        load: 'module' },
  'three-gpu-pathtracer': { file: '/vendor/three-gpu-pathtracer/0.0.24/index.module.js', load: 'module' },
  'three-mesh-bvh':   { file: '/vendor/three-mesh-bvh/0.9.14/index.module.js',   load: 'module' },
  'xatlas-web':       { file: '/vendor/xatlas-web/0.1.0/xatlas-web.js',            load: 'module' },
  'holospot':         { file: '/vendor/holospot/0.1.0/dist/holo.js',                    load: 'module' },
  // thi.ng umbrella: one PREFIX mapping — '@thi.ng/' resolves into the
  // vendored tree, so `import { ... } from "@thi.ng/geom"` works directly.
  thing:              { file: '/vendor/thi.ng/',                                  load: 'module-prefix' },
};

/**
 * Library-requested importmap remaps. Requesting three-webgpu deliberately
 * re-points THIS PIECE's bare `three` specifier at the 0.185.1 module build
 * (pathtracer peer floor >=0.180) — an explicit per-piece opt-in; the
 * repo-wide default three@0.160 byte-tie is untouched elsewhere.
 */
const IMPORTMAP_REMAPS: Readonly<Partial<Record<VendoredLibraryId, Record<string, string>>>> = {
  // `three` -> the WebGL module build (WebGLRenderer: pathtracer, holospot,
  // most pieces); WebGPU and TSL live on their own specifiers, the three.js
  // convention. All three share ./three.core.min.js, so classes stay one identity.
  'three-webgpu': {
    three: '/vendor/three-webgpu/0.185.1/three.module.min.js',
    'three/webgpu': '/vendor/three-webgpu/0.185.1/three.webgpu.min.js',
    'three/tsl': '/vendor/three-tsl/0.185.1/three.tsl.min.js',
  },
  // three.tsl.min.js imports from "three/webgpu"; without this it cannot link.
  'three-tsl': { 'three/webgpu': '/vendor/three-webgpu/0.185.1/three.webgpu.min.js' },
  // holo.js imports bare "three" with peer >=0.170 (built on r187, WebGLRenderer
  // only). Left on the 0.160 byte-tie the piece links against the wrong build
  // and the foil never renders, so requesting holospot re-points `three` too.
  holospot: { three: '/vendor/three-webgpu/0.185.1/three.module.min.js' },
};

/** Throw on any id not in the index — fail loud, never dead-render. */
export function assertVendoredLibraries(libs: readonly string[]): void {
  for (const id of libs) {
    if (!(id in VENDORED_LIBRARIES)) {
      throw new Error(
        `Unknown vendored library "${id}". Known: ${Object.keys(VENDORED_LIBRARIES).join(', ')}. ` +
        'Library requests that miss the index must fail at wrap time, not render silently.',
      );
    }
  }
}

export interface LibraryInclude {
  /** <script src> tags for UMD/global builds, in request order. */
  readonly scriptTags: string;
  /** importmap "imports" entries for ESM builds (merged into any existing importmap). */
  readonly importmapEntries: Record<string, string>;
  /** keys whose mapping is a SYSTEM remap (library-requested opt-in like
   *  three-webgpu re-pointing `three`) — the only collisions the injector
   *  may legitimately override; piece-authored shadowing still throws. */
  readonly remappedKeys: readonly string[];
}

/** CSP sources a library needs beyond the medium's default policy.
 *  holospot fetches its bump/foil assets from /vendor (connect-src) and
 *  decodes them in blob: workers (worker-src); without these it renders
 *  degraded or black. */
export const LIBRARY_CSP_GRANTS: Readonly<Partial<Record<VendoredLibraryId, Readonly<Record<string, readonly string[]>>>>> = {
  'holospot': { 'connect-src': ["'self'"], 'worker-src': ['blob:', "'self'"] },
};

/** Widen a CSP string with every grant the requested libraries carry. */
export function widenCspForLibraries(csp: string, libs: readonly string[]): string {
  let out = csp;
  for (const id of libs) {
    const grants = LIBRARY_CSP_GRANTS[id as VendoredLibraryId];
    if (!grants) continue;
    for (const [directive, sources] of Object.entries(grants)) {
      const re = new RegExp(`(^|;\\s*)${directive} ([^;]*)`);
      const m = re.exec(out);
      if (!m) { out = `${out.replace(/;?\s*$/, ';')} ${directive} ${sources.join(' ')};`; continue; }
      const have = m[2].split(/\s+/).filter((t) => t && t !== "'none'");
      const merged = [...have, ...sources.filter((t) => !have.includes(t))].join(' ');
      out = out.replace(re, `${m[1]}${directive} ${merged}`);
    }
  }
  return out;
}

/** Build the include tags for a set of requested library ids. */
export function libraryIncludes(libs: readonly string[]): LibraryInclude {
  assertVendoredLibraries(libs);
  const scriptTags = libs
    .map((id) => VENDORED_LIBRARIES[id as VendoredLibraryId])
    .filter((e) => e.load === 'script')
    .map((e) => `<script src="${e.file}"></script>`)
    .join('\n    ');
  const importmapEntries: Record<string, string> = {};
  const remappedKeys = new Set<string>();
  for (const id of libs) {
    const e = VENDORED_LIBRARIES[id as VendoredLibraryId];
    if (e.load === 'module') importmapEntries[id] = e.file;
    if (e.load === 'module-prefix') Object.assign(importmapEntries, THING_IMPORTMAP);
    const remap = IMPORTMAP_REMAPS[id as VendoredLibraryId];
    if (remap) for (const [k, v] of Object.entries(remap)) { importmapEntries[k] = v; remappedKeys.add(k); }
  }
  return { scriptTags, importmapEntries, remappedKeys: [...remappedKeys] };
}
