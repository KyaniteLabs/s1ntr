import { describe, expect, it } from 'vitest';
import { findUndeclaredIdentifiers } from '../../../src/core/validators/undeclaredIdentifiers.js';
import { BROWSER_GLOBALS, HYDRA_GLOBALS } from '../../../src/core/validators/browserGlobals.generated.js';
import { ThreeValidator } from '../../../src/core/validators/ThreeValidator.js';
import { HydraValidator } from '../../../src/core/validators/HydraValidator.js';

// The shape every #1756 crash shared: the line declaring `canvas` is gone and
// the code below it still uses the name (hy4f/dance-embers-r2, lines 26-36).
const EMBERS_SPRITE = `const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);
canvas.width = 128;
canvas.height = 128;
const ctx = canvas.getContext('2d');
ctx.fillRect(0, 0, 128, 128);
const texture = new THREE.CanvasTexture(canvas);
scene.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: texture })));
renderer.render(scene, camera);`;

const undeclaredErrors = (errors: string[]) => errors.filter((e) => e.includes('never declares it'));

describe('findUndeclaredIdentifiers', () => {
  it('reports a name that nothing binds', () => {
    expect(findUndeclaredIdentifiers(EMBERS_SPRITE, { module: true, provided: ['THREE'] })).toEqual(['canvas']);
  });

  it('accepts names the script, the shell or the browser binds', () => {
    const code = `import * as THREE from 'three';
function helper(n) { return n * devicePixelRatio + innerWidth; }
const later = () => performance.now() + helper(2);
class Thing {}
for (const k of [1]) console.log(k, later(), new Thing(), shellThing);`;
    expect(findUndeclaredIdentifiers(code, { module: true, provided: ['shellThing'] })).toEqual([]);
  });

  it('allows `typeof x` and `window.x = ...` on unbound names', () => {
    expect(findUndeclaredIdentifiers('if (typeof maybe === "undefined") window.made = 1;\nconsole.log(made);', { module: true })).toEqual([]);
  });

  it('treats `x = 1` as a global in a classic script but as a ReferenceError in a module', () => {
    const code = 'speedFactor = 2;\nconsole.log(speedFactor);';
    expect(findUndeclaredIdentifiers(code)).toEqual([]);
    expect(findUndeclaredIdentifiers(code, { module: true })).toEqual(['speedFactor']);
  });

  it('leaves unparseable code to the syntax check', () => {
    expect(findUndeclaredIdentifiers('const = ;')).toEqual([]);
  });
});

describe('generated globals', () => {
  it('come from a real browser and hold no page-specific names', () => {
    expect(BROWSER_GLOBALS).toEqual(expect.arrayContaining(['WebGL2RenderingContext', 'AudioContext', 'requestAnimationFrame', 'innerWidth']));
    for (const name of ['canvas', 'ctx', 'scene', 'mx', 'a']) expect(BROWSER_GLOBALS).not.toContain(name);
  });

  it('match what hydra adds with audio off', () => {
    expect(HYDRA_GLOBALS).toEqual(expect.arrayContaining(['osc', 'src', 'o0', 's0', 'time', 'render']));
    expect(HYDRA_GLOBALS.filter((name) => name === 'a')).toEqual([]); // hydra's audio global stays off
  });
});

describe('ThreeValidator undeclared names (#1756)', () => {
  it('rejects the crash shape: canvas used but never declared', () => {
    expect(undeclaredErrors(ThreeValidator.validate(EMBERS_SPRITE).errors)).toEqual([
      "Three.js code uses 'canvas' but never declares it; the page provides only THREE, so this throws ReferenceError at render",
    ]);
  });

  it('accepts a sketch that declares its own canvas (the wrapper supplies none)', () => {
    const code = EMBERS_SPRITE.replace('canvas.width = 128;', "const canvas = document.createElement('canvas');\ncanvas.width = 128;");
    expect(ThreeValidator.validate(code).errors).toEqual([]);
  });
});

describe('HydraValidator undeclared names', () => {
  it.each([
    ['audio, which the shell turns off', 'osc(10).scale(() => 1 + a.fft[0]).out()', 'a'],
    ['an invented mouse alias', 'osc(10).rotate(() => mx * 0.01).out()', 'mx'],
    ['a hallucinated helper', 'flow(osc(10)).out()', 'flow'],
  ])('rejects %s', (_case, code, name) => {
    expect(HydraValidator.validate(code).errors).toContain(
      `Hydra code uses '${name}' which is neither a hydra global nor defined in the piece — it throws ReferenceError and kills the chain`);
  });

  it('accepts shell names and sloppy-mode globals', () => {
    expect(HydraValidator.validate('depth = 3;\nosc(10 * depth, 0.1, () => canvas.width / 1000).modulate(noise(depth), 0.2).out(o0)\nrender(o0)').errors).toEqual([]);
  });
});
