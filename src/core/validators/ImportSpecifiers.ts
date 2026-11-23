/**
 * ImportSpecifiers — which module specifiers generated code names, and which
 * vendored library each one resolves to.
 *
 * Why: a piece that writes `import { Holo } from "holospot"` but omits the
 * trailing `libraries:` line used to get the default wrapper (three 0.160
 * only), so the specifier failed to resolve and the page rendered blank. The
 * code itself is the stronger signal, so the library set is inferred from it
 * and unioned with the declaration; a bare specifier with no library card is
 * a validation error instead of a blank page.
 */

import { stripComments } from './stripComments.js';
import { VENDORED_LIBRARIES, type VendoredLibraryId } from '../wrappers/VendoredLibraries.js';

// import a from "x" | import {a,\n b} from "x" | import * as a from "x" | import "x" | export {a} from "x"
// The clause excludes quotes, parens and semicolons so `import(` and prose never match.
const STATIC_IMPORT = /\bimport\s+(?:[^'"();]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g;
const REEXPORT = /\bexport\s+[^'"();]*?\bfrom\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const IMPORTMAP_BLOCK = /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;

function importMapKeys(code: string): string[] {
  const keys: string[] = [];
  for (const block of code.matchAll(IMPORTMAP_BLOCK)) {
    try {
      const parsed = JSON.parse(block[1]) as { imports?: Record<string, unknown> };
      keys.push(...Object.keys(parsed.imports ?? {}));
    } catch {
      for (const m of block[1].matchAll(/"([^"]+)"\s*:/g)) {
        if (m[1] !== 'imports' && m[1] !== 'scopes') keys.push(m[1]);
      }
    }
  }
  return keys;
}

/** Every distinct specifier the code imports statically, dynamically, or maps. */
export function scanImportSpecifiers(code: string): string[] {
  const found = new Set<string>();
  // The import map is JSON inside a <script>, so scan it from the raw text;
  // comment stripping would blank nothing of value there.
  for (const key of importMapKeys(code)) found.add(key);
  const surface = stripComments(code);
  for (const re of [STATIC_IMPORT, REEXPORT, DYNAMIC_IMPORT]) {
    for (const m of surface.matchAll(new RegExp(re.source, re.flags))) found.add(m[2]);
  }
  return [...found];
}

const THREE_SUBPATH_LIBRARY: Readonly<Record<string, VendoredLibraryId>> = {
  'three/webgpu': 'three-webgpu',
  'three/tsl': 'three-tsl',
};

/**
 * The vendored library a specifier needs.
 *  - a library id: that id (npm names such as twgl.js included)
 *  - null: nothing to inject (default three, relative, absolute or URL specifiers)
 *  - undefined: a bare specifier no library card covers
 */
export function libraryForSpecifier(specifier: string): VendoredLibraryId | null | undefined {
  if (/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return null;
  if (specifier === 'three' || specifier.startsWith('three/')) {
    return THREE_SUBPATH_LIBRARY[specifier] ?? null;
  }
  if (specifier.startsWith('@thi.ng/')) return 'thing';
  if (specifier in VENDORED_LIBRARIES) return specifier as VendoredLibraryId;
  for (const [id, entry] of Object.entries(VENDORED_LIBRARIES)) {
    if (entry.npm === specifier) return id as VendoredLibraryId;
  }
  return undefined;
}

export interface InferredLibraries {
  /** Vendored library ids the code's specifiers need, deduplicated, in source order. */
  readonly libraries: string[];
  /** Bare specifiers with no library card and no mapping in the piece's own import map. */
  readonly unknown: string[];
}

export function inferLibrariesFromCode(code: string): InferredLibraries {
  const mapped = new Set(importMapKeys(code));
  const libraries: string[] = [];
  const unknown: string[] = [];
  for (const specifier of scanImportSpecifiers(code)) {
    const lib = libraryForSpecifier(specifier);
    if (lib === null) continue;
    if (lib === undefined) {
      if (!mapped.has(specifier)) unknown.push(specifier);
      continue;
    }
    if (!libraries.includes(lib)) libraries.push(lib);
  }
  return { libraries, unknown };
}
