/**
 * ImportSpecifiers — which module specifiers generated code names, and which
 * vendored library each one resolves to. A specifier the wrapper has no card
 * for renders a blank page ("Failed to resolve module specifier").
 */
import { describe, it, expect } from 'vitest';
import {
  scanImportSpecifiers,
  libraryForSpecifier,
  inferLibrariesFromCode,
} from '../../../src/core/validators/ImportSpecifiers.js';

describe('scanImportSpecifiers', () => {
  it('finds static named, default, namespace, side-effect and re-export forms', () => {
    const code = `
      import { Holo } from "holospot";
      import * as THREE from 'three';
      import culori from "culori";
      import "perfect-freehand";
      export { x } from "tonaljs";
    `;
    expect(scanImportSpecifiers(code).sort()).toEqual(['culori', 'holospot', 'perfect-freehand', 'three', 'tonaljs']);
  });

  it('finds multi-line named imports', () => {
    expect(scanImportSpecifiers(`import {\n  Holo,\n  shotCamera,\n} from "holospot";`)).toEqual(['holospot']);
  });

  it('finds dynamic import() with a literal specifier', () => {
    expect(scanImportSpecifiers(`const m = await import("rapier2d"); const n = import('harfbuzz');`).sort())
      .toEqual(['harfbuzz', 'rapier2d']);
  });

  it('finds the keys of an inline import map', () => {
    const html = `<script type="importmap">{"imports":{"three":"/x.js","holospot":"/y.js"}}</script>`;
    expect(scanImportSpecifiers(html).sort()).toEqual(['holospot', 'three']);
  });

  it('ignores commented-out imports', () => {
    expect(scanImportSpecifiers(`// import { Holo } from "holospot";\n/* import "culori" */\nconst a = 1;`)).toEqual([]);
  });

  it('does not treat the word import in prose or python as a specifier', () => {
    expect(scanImportSpecifiers(`import bpy\nfrom math import pi\nconst s = "we import things";`)).toEqual([]);
  });
});

describe('libraryForSpecifier', () => {
  it('maps vendored ids, three variants and the thi.ng prefix', () => {
    expect(libraryForSpecifier('holospot')).toBe('holospot');
    expect(libraryForSpecifier('three-webgpu')).toBe('three-webgpu');
    expect(libraryForSpecifier('three/webgpu')).toBe('three-webgpu');
    expect(libraryForSpecifier('three/tsl')).toBe('three-tsl');
    expect(libraryForSpecifier('@thi.ng/geom')).toBe('thing');
    expect(libraryForSpecifier('twgl.js')).toBe('twgl');
  });

  it('returns null for the default three build and for non-bare specifiers', () => {
    expect(libraryForSpecifier('three')).toBeNull();
    expect(libraryForSpecifier('./local.js')).toBeNull();
    expect(libraryForSpecifier('/vendor/x.js')).toBeNull();
    expect(libraryForSpecifier('https://unpkg.com/three')).toBeNull();
  });

  it('returns undefined for a bare specifier with no library card', () => {
    expect(libraryForSpecifier('lodash')).toBeUndefined();
    expect(libraryForSpecifier('lodash')).toBeUndefined();
  });
});

describe('inferLibrariesFromCode', () => {
  it('infers a library from an import with no declaration, deduplicated', () => {
    const r = inferLibrariesFromCode(`import { Holo } from "holospot";\nconst m = await import("holospot");`);
    expect(r.libraries).toEqual(['holospot']);
    expect(r.unknown).toEqual([]);
  });

  it('reports unknown bare specifiers by name', () => {
    const r = inferLibrariesFromCode(`import * as _ from "lodash";\nimport { Holo } from "holospot";`);
    expect(r.libraries).toEqual(['holospot']);
    expect(r.unknown).toEqual(['lodash']);
  });

  it('does not flag an unknown specifier that the piece maps in its own import map', () => {
    const html = `<script type="importmap">{"imports":{"d3":"/vendor/d3/d3.js"}}</script>\n<script type="module">import * as d3 from "d3";</script>`;
    expect(inferLibrariesFromCode(html).unknown).toEqual([]);
  });

  it('leaves plain three pieces alone', () => {
    expect(inferLibrariesFromCode(`import * as THREE from "three";`)).toEqual({ libraries: [], unknown: [] });
  });
});
