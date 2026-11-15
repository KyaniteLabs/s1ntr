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
  | 'culori' | 'd3-delaunay' | 'd3-contour' | 'perfect-freehand'
  | 'roughjs' | 'tonaljs' | 'matter-js' | 'paper' | 'fontkit'
  | 'd3-geo' | 'twgl' | 'rapier2d' | 'harfbuzz'
  // phase 2 (additive opt-ins; default three stays 0.160.0 for the byte-tie)
  | 'three-webgpu' | 'three-tsl' | 'three-gpu-pathtracer' | 'three-mesh-bvh' | 'xatlas-web'
  | 'thing'; // the thi.ng umbrella: 45 packages via one importmap PREFIX entry

export interface VendoredLibraryEntry {
  readonly file: string;
  readonly load: 'script' | 'module' | 'module-prefix';
  /** window global for script builds (what generator code calls). */
  readonly global?: string;
}

import { THING_IMPORTMAP } from './thing-importmap.generated.js';

export const VENDORED_LIBRARIES: Readonly<Record<VendoredLibraryId, VendoredLibraryEntry>> = {
  culori:            { file: '/vendor/culori/4.0.2/culori.min.js',              load: 'script', global: 'culori' },
  'd3-delaunay':     { file: '/vendor/d3-delaunay/6.0.4/d3-delaunay.min.js',    load: 'script', global: 'd3' },
  'd3-contour':      { file: '/vendor/d3-contour/4.0.2/d3-contour.min.js',      load: 'script', global: 'd3' },
  'perfect-freehand':{ file: '/vendor/perfect-freehand/1.2.3/index.mjs',        load: 'module' },
  roughjs:           { file: '/vendor/roughjs/4.6.6/rough.js',                  load: 'script', global: 'rough' },
  tonaljs:           { file: '/vendor/tonaljs/4.10.0/index.js',                 load: 'module' },
  'matter-js':       { file: '/vendor/matter-js/0.20.0/matter.min.js',          load: 'script', global: 'Matter' },
  paper:             { file: '/vendor/paper/0.12.18/paper-core.min.js',         load: 'script', global: 'paper' },
  fontkit:           { file: '/vendor/fontkit/2.0.4/browser.cjs',               load: 'script', global: 'fontkit' },
  'd3-geo':          { file: '/vendor/d3-geo/3.1.1/d3-geo.min.js',              load: 'script', global: 'd3' },
  twgl:              { file: '/vendor/twgl/7.0.0/twgl-full.js',                 load: 'script', global: 'twgl' },
  rapier2d:          { file: '/vendor/rapier2d/0.20.0/rapier.mjs',              load: 'module' },
  harfbuzz:          { file: '/vendor/harfbuzz/1.6.0/harfbuzz.js',              load: 'module' },
  'three-webgpu':    { file: '/vendor/three-webgpu/0.182.0/three.webgpu.min.js',  load: 'module' },
  'three-tsl':       { file: '/vendor/three-tsl/0.182.0/three.tsl.min.js',        load: 'module' },
  'three-gpu-pathtracer': { file: '/vendor/three-gpu-pathtracer/0.0.24/index.module.js', load: 'module' },
  'three-mesh-bvh':   { file: '/vendor/three-mesh-bvh/0.9.14/index.module.js',   load: 'module' },
  'xatlas-web':       { file: '/vendor/xatlas-web/0.1.0/xatlas-web.js',            load: 'module' },
  // thi.ng umbrella: one PREFIX mapping — '@thi.ng/' resolves into the
  // vendored tree, so `import { ... } from "@thi.ng/geom"` works directly.
  thing:              { file: '/vendor/thi.ng/',                                  load: 'module-prefix' },
};

/**
 * Library-requested importmap remaps. Requesting three-webgpu deliberately
 * re-points THIS PIECE's bare `three` specifier at the 0.182 WebGPU build
 * (pathtracer peer floor >=0.180) — an explicit per-piece opt-in; the
 * repo-wide default three@0.160 byte-tie is untouched elsewhere.
 */
const IMPORTMAP_REMAPS: Readonly<Partial<Record<VendoredLibraryId, Record<string, string>>>> = {
  'three-webgpu': { three: '/vendor/three-webgpu/0.182.0/three.webgpu.min.js' },
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
