import { describe, expect, it } from 'vitest';
import { findUnknownThreeApi } from '../../../src/core/validators/ThreeValidator.js';

// Shapes from three art runs that rendered "is not a constructor / function"
// against the served three 0.160 core build.
describe('findUnknownThreeApi', () => {
  it('rejects an addon on the THREE global', () => {
    expect(findUnknownThreeApi('const c = new THREE.EffectComposer(renderer);').join()).toContain('THREE.EffectComposer');
  });

  it('rejects an addon on an imported namespace and a named import', () => {
    expect(findUnknownThreeApi("import * as T from 'three';\nnew T.DecalGeometry(m);")).toHaveLength(1);
    expect(findUnknownThreeApi("import { Scene, OrbitControls } from 'three';\nnew Scene();").join()).toContain("'OrbitControls'");
  });

  it('rejects a method the core class lacks, inherited ones included', () => {
    const code = 'const listener = new THREE.AudioListener();\nlistener.getGainNode().connect(a);\nlistener.add(cam);\nlistener.getInput();';
    expect(findUnknownThreeApi(code)).toEqual([expect.stringContaining("'getGainNode()'")]);
  });

  it('accepts core API', () => {
    const code = "import * as THREE from 'three';\nconst s = new THREE.Scene();\nconst m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());\nm.rotateY(0.1);\ns.add(m);\nm.toString();";
    expect(findUnknownThreeApi(code)).toEqual([]);
  });

  it('follows each binding, not each name', () => {
    const code = 'function a() { const g = new THREE.PlaneGeometry(1, 1); return g; }\nfunction b(ctx) { const g = ctx.createLinearGradient(0, 0, 1, 1); g.addColorStop(0, "#000"); }';
    expect(findUnknownThreeApi(code)).toEqual([]);
  });

  it('leaves an instance alone once the piece adds members to it', () => {
    expect(findUnknownThreeApi('const o = new THREE.Object3D();\no.pulse = () => 1;\no.pulse();')).toEqual([]);
  });

  it('ignores a local THREE and full-HTML pieces', () => {
    expect(findUnknownThreeApi('const THREE = { Foo: 1 };\nTHREE.Foo;')).toEqual([]);
    expect(findUnknownThreeApi('<!DOCTYPE html><html><script>new THREE.EffectComposer()</script></html>')).toEqual([]);
  });
});
