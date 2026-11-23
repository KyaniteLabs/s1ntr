import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIBRARY_CARDS } from '../../../src/creative-vocabulary/LibraryCards.js';
import { VENDORED_LIBRARIES } from '../../../src/core/wrappers/VendoredLibraries.js';

// The cards are prompt text: a name the vendored module does not export becomes
// a piece that passes validation and dies at import (v11 holospot, perfect-freehand).
function moduleExports(file: string): Set<string> {
  const src = readFileSync(`vendor/${file.replace(/^\/vendor\//, '')}`, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

const JS_BUILTINS = new Set(['new', 'await', 'function', 'if', 'for', 'while', 'return', 'typeof', 'Array', 'Math', 'Number', 'String', 'Object', 'Promise', 'Float32Array', 'Uint8Array', 'requestAnimationFrame', 'fetch']);

const moduleCards = LIBRARY_CARDS.filter(c => VENDORED_LIBRARIES[c.id as keyof typeof VENDORED_LIBRARIES]?.load === 'module');

const vendorPath = (file: string) => `vendor/${file.replace(/^\/vendor\//, '')}`;
// Cards whose module imports cleanly in Node, so member calls (Chord.get) are checked at runtime.
const NODE_IMPORTABLE = ['perfect-freehand', 'tonaljs'];

describe('library cards name only what the vendored module exports', () => {
  for (const id of NODE_IMPORTABLE) {
    it(`${id}: Namespace.member calls exist on the real module`, async () => {
      const card = moduleCards.find(c => c.id === id)!;
      const mod = await import(pathToFileURL(resolve(vendorPath(VENDORED_LIBRARIES[id as keyof typeof VENDORED_LIBRARIES]!.file))).href);
      const missing = card.highPayoffCalls
        .flatMap(call => [...call.replace(/\/\/.*$/, '').matchAll(/(?<![\w$.])([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)/g)])
        .filter(([, ns]) => ns in mod)
        .filter(([, ns, member]) => mod[ns]?.[member] === undefined)
        .map(m => m[0]);
      expect(missing).toEqual([]);
    });
  }

  it('covers at least the module libraries with cards', () => {
    expect(moduleCards.map(c => c.id)).toContain('perfect-freehand');
    expect(moduleCards.map(c => c.id)).toContain('holospot');
  });

  for (const card of moduleCards) {
    it(`${card.id}: named imports and bare calls are real exports`, () => {
      const lib = VENDORED_LIBRARIES[card.id as keyof typeof VENDORED_LIBRARIES]!;
      const real = moduleExports(lib.file);
      const named = [...card.access.matchAll(/import\s*\{([^}]*)\}/g)]
        .flatMap(m => m[1].split(',').map(p => p.trim().split(/\s+as\s+/)[0].trim())).filter(Boolean);
      const called = card.highPayoffCalls
        .flatMap(call => [...call.replace(/\/\/.*$/, '').matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))
        .filter(n => !JS_BUILTINS.has(n));
      const ghosts = [...new Set([...named, ...called])].filter(n => !real.has(n));
      expect(ghosts).toEqual([]);
    });
  }
});

// v11 sweep: tonaljs and fontkit were vendored as raw CommonJS, so every page that
// used them threw "module is not defined" / "require is not defined" at load.
describe('vendored browser files are loadable in a page', () => {
  for (const [id, lib] of Object.entries(VENDORED_LIBRARIES)) {
    it(`${id} is not a CommonJS build`, () => {
      const path = `vendor/${lib.file.replace(/^\/vendor\//, '')}`;
      if (statSync(path).isDirectory()) return;
      // Unguarded top-level CommonJS only; UMD/emscripten guard theirs behind typeof checks.
      expect(/^module\.exports\s*=|^(?:var|const|let) \S+ = require\(/m.test(readFileSync(path, 'utf8')), `${lib.file} is CommonJS`).toBe(false);
    });
  }
});

// xatlas-web is emscripten UMD with no ESM export. It is inert only while nothing imports it;
// the exception expires the moment a vendored module references it.
const NO_ESM_EXPORT_OK = new Set(['xatlas-web']);
function filesUnder(path: string): string[] {
  return statSync(path).isDirectory() ? readdirSync(path).flatMap(n => filesUnder(join(path, n))) : [path];
}

describe('module-loaded vendored files export ESM', () => {
  for (const [id, lib] of Object.entries(VENDORED_LIBRARIES)) {
    if (lib.load !== 'module' || NO_ESM_EXPORT_OK.has(id)) continue;
    it(`${id} has an ESM export`, () => {
      const path = vendorPath(lib.file);
      if (statSync(path).isDirectory()) return;
      expect(/(^|[;}\s])export\s*(\{|\*|default|const|let|var|function|class|async)/m.test(readFileSync(path, 'utf8'))).toBe(true);
    });
  }
  it('no vendored module imports xatlas-web (keeps its exception honest)', () => {
    const importers = Object.entries(VENDORED_LIBRARIES)
      .filter(([id, lib]) => id !== 'xatlas-web' && lib.load === 'module')
      .flatMap(([, lib]) => filesUnder(vendorPath(lib.file)))
      .filter(f => /\.m?js$/.test(f) && /["']xatlas-web["']/.test(readFileSync(f, 'utf8')));
    expect(importers).toEqual([]);
  });
});
