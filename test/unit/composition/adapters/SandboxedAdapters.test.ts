/**
 * @vitest-environment jsdom
 *
 * p5 / Hydra / Three behind the sandbox boundary: what mounts, what is
 * refused by the pre-check, and what the frame reports back (#1533).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P5Adapter } from '../../../../src/composition/adapters/P5Adapter.js';
import { HydraAdapter } from '../../../../src/composition/adapters/HydraAdapter.js';
import { ThreeAdapter } from '../../../../src/composition/adapters/ThreeAdapter.js';
import { attachedContainer, frameReports, makeLayer, srcdocOf, STUB_LIB } from './sandboxTestUtils.js';

const loadSandboxLib = vi.fn(async (_path: string) => STUB_LIB);
vi.mock('../../../../src/composition/adapters/sandboxFrame.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/composition/adapters/sandboxFrame.js')>()),
  loadSandboxLib: (path: string) => loadSandboxLib(path),
}));

afterEach(() => { document.body.innerHTML = ''; loadSandboxLib.mockClear(); });

describe('P5Adapter (sandboxed)', () => {
  let adapter: P5Adapter;
  beforeEach(async () => { adapter = new P5Adapter(); await adapter.initialize(); });
  const layer = (code: string) => makeLayer('p5', 'p5-layer', code);
  const SKETCH = 'function setup() { createCanvas(100, 100); }\nfunction draw() { background(0); }';

  it('loads the vendored p5 source once', async () => {
    await adapter.initialize();
    expect(loadSandboxLib).toHaveBeenCalledTimes(1);
    expect(loadSandboxLib).toHaveBeenCalledWith(expect.stringContaining('/vendor/p5/'));
  });

  it('throws when initialize() was not awaited', () => {
    expect(() => new P5Adapter().render(layer(SKETCH), attachedContainer())).toThrow('p5.js not loaded');
  });

  it('mounts the sketch, sized from settings, in a sandbox frame', () => {
    const ctx = { settings: { width: 320, height: 200 }, state: { get: () => undefined } } as never;
    const inst = adapter.render(layer(SKETCH), attachedContainer(), ctx);
    expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(inst.iframe?.getAttribute('width')).toBe('320');
    expect(inst.iframe?.getAttribute('height')).toBe('200');
    expect(srcdocOf(inst)).toContain('function setup()');
  });

  it('refuses a sketch with escape hatches in setup', () => {
    const inst = adapter.render(layer('function setup() { fetch("https://evil.test"); }\nfunction draw() {}'), attachedContainer());
    expect(inst.iframe).toBeNull();
    expect(inst.blocked).toContain('fetch API');
  });

  it('refuses string timers in draw', () => {
    const inst = adapter.render(layer('function setup() {}\nfunction draw() { setTimeout("alert(1)", 0); }'), attachedContainer());
    expect(inst.iframe).toBeNull();
  });

  it('exports read what the frame reported', () => {
    const l = layer(SKETCH);
    const inst = adapter.render(l, attachedContainer());
    frameReports(inst, { mouseX: 12, frameCount: 30, width: 100 });
    const byName = Object.fromEntries(adapter.getExports(l).map((e) => [e.name, e.getter()]));
    expect(byName).toMatchObject({ mouseX: 12, frameCount: 30, width: 100 });
    expect(byName).not.toHaveProperty('canvas');
  });

  it('destroy removes the frame and clears exports', () => {
    const l = layer(SKETCH);
    const container = attachedContainer();
    adapter.render(l, container);
    adapter.destroy(l, undefined);
    expect(container.querySelector('iframe')).toBeNull();
    expect(adapter.getExports(l)).toEqual([]);
  });
});

describe('HydraAdapter (sandboxed)', () => {
  let adapter: HydraAdapter;
  beforeEach(async () => { adapter = new HydraAdapter(); await adapter.initialize(); });
  const layer = (code: string) => makeLayer('hydra', 'hydra-layer', code);

  it('throws when initialize() was not awaited', () => {
    expect(() => new HydraAdapter().render(layer('osc().out()'), attachedContainer())).toThrow('Hydra not loaded');
  });

  it('mounts the code with Hydra built inside the frame', () => {
    const inst = adapter.render(layer('osc(10, 0.1, 0.5).out()'), attachedContainer());
    expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    const doc = srcdocOf(inst);
    expect(doc).toContain('new Hydra({');
    expect(doc).toContain('osc(10, 0.1, 0.5).out()');
  });

  it('refuses code with escape hatches', () => {
    const inst = adapter.render(layer('fetch("https://evil.test"); osc().out()'), attachedContainer());
    expect(inst.iframe).toBeNull();
    expect(inst.blocked).toContain('fetch API');
  });

  it('exports width and height from the frame', () => {
    const l = layer('osc().out()');
    const inst = adapter.render(l, attachedContainer());
    frameReports(inst, { width: 800, height: 600 });
    const byName = Object.fromEntries(adapter.getExports(l).map((e) => [e.name, e.getter()]));
    expect(byName).toEqual({ width: 800, height: 600 });
  });
});

describe('ThreeAdapter (sandboxed)', () => {
  let adapter: ThreeAdapter;
  beforeEach(async () => { adapter = new ThreeAdapter(); await adapter.initialize(); });
  const layer = (code: string, over = {}) => makeLayer('three', 'three-layer', code, over);

  it('throws when initialize() was not awaited', () => {
    expect(() => new ThreeAdapter().render(layer('camera.position.z = 5;'), attachedContainer())).toThrow('Three.js not loaded');
  });

  it('mounts scene, camera and renderer inside the frame, code in its own function scope', () => {
    const inst = adapter.render(layer('const scene2 = new THREE.Scene(); camera.position.z = 5;'), attachedContainer());
    expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    const doc = srcdocOf(inst);
    expect(doc).toContain('new THREE.WebGLRenderer');
    expect(doc).toContain('(function (THREE, scene, camera, renderer, objects, width, height) {');
    expect(doc).toContain('camera.position.z = 5;');
  });

  it('a rejected candidate throws, so the working layer is kept', () => {
    const l = layer('camera.position.z = 1;');
    const container = attachedContainer();
    adapter.render(l, container);
    expect(() => adapter.render(layer('fetch("https://evil.test");'), container)).toThrow('Blocked unsafe Three.js layer code');
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('replacing a layer retires the previous frame once the replacement reports', () => {
    const container = attachedContainer();
    adapter.render(layer('camera.position.z = 1;'), container);
    const second = adapter.render(layer('camera.position.z = 2;'), container);
    frameReports(second, { cameraZ: 2 });
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('transparent layers ask for an alpha renderer', () => {
    const inst = adapter.render(layer('camera.position.z = 5;', { transparentBackground: true }), attachedContainer());
    expect(srcdocOf(inst)).toContain('{ alpha: true }');
    expect(srcdocOf(inst)).toContain('setClearColor(0x000000, 0)');
  });

  it('exports camera position and scene contents from the frame', () => {
    const l = layer('camera.position.z = 5;');
    const inst = adapter.render(l, attachedContainer());
    frameReports(inst, { cameraX: 1, cameraY: 2, cameraZ: 3, sceneObjects: ['Mesh'] });
    const byName = Object.fromEntries(adapter.getExports(l).map((e) => [e.name, e.getter()]));
    expect(byName).toEqual({ cameraX: 1, cameraY: 2, cameraZ: 3, sceneObjects: ['Mesh'] });
  });
});
