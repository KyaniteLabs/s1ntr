/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToneAdapter } from '../../../../src/composition/adapters/ToneAdapter.js';
import type { SandboxedInstance } from '../../../../src/composition/adapters/sandboxFrame.js';
import type { GlobalSettings } from '../../../../src/composition/types.js';
import { attachedContainer, frameReports, makeLayer, srcdocOf, STUB_LIB } from './sandboxTestUtils.js';

const loadSandboxLib = vi.fn(async () => STUB_LIB);
vi.mock('../../../../src/composition/adapters/sandboxFrame.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/composition/adapters/sandboxFrame.js')>()),
  loadSandboxLib: (path: string) => loadSandboxLib(path),
}));

const createLayer = (code: string) => makeLayer('tone', 'tone-test-layer', code);
const settings: GlobalSettings = { width: 800, height: 600, frameRate: 60, backgroundColor: '#000', audio: { volume: 0.5 } } as GlobalSettings;

describe('ToneAdapter (sandboxed)', () => {
  let adapter: ToneAdapter;

  beforeEach(async () => {
    loadSandboxLib.mockClear();
    adapter = new ToneAdapter();
    await adapter.initialize();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('loads the vendored Tone.js source once', async () => {
    await adapter.initialize();
    expect(loadSandboxLib).toHaveBeenCalledTimes(1);
    expect(loadSandboxLib).toHaveBeenCalledWith(expect.stringContaining('/vendor/tone/'));
  });

  it('throws when initialize() was not awaited', () => {
    expect(() => new ToneAdapter().render(createLayer('Tone.Transport.start()'), attachedContainer())).toThrow('Tone.js not loaded');
  });

  it('mounts the layer code in a sandbox frame, with synth tracking', () => {
    const inst = adapter.render(createLayer('const s = new Tone.Synth().toDestination();'), attachedContainer()) as SandboxedInstance;
    expect(inst.iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    const doc = srcdocOf(inst);
    expect(doc).toContain(STUB_LIB);
    expect(doc).toContain('__trackSynth(s)');
    expect(doc).toContain('default-src \'none\'');
  });

  it('blocks code that tries to reach browser globals', () => {
    const inst = adapter.render(createLayer('fetch("https://evil.test"); Tone.start();'), attachedContainer());
    expect(inst.iframe).toBeNull();
    expect(inst.blocked).toContain('fetch API');
  });

  it('blocks string-based dynamic execution patterns', () => {
    const inst = adapter.render(createLayer('setTimeout("alert(1)", 0); Tone.start();'), attachedContainer());
    expect(inst.iframe).toBeNull();
    expect(inst.blocked.length).toBeGreaterThan(0);
  });

  it('start and stop buttons command the frame, not the host', () => {
    const container = attachedContainer();
    const inst = adapter.render(createLayer('Tone.Transport.bpm.value = 90;'), container);
    const post = vi.spyOn(inst.iframe!.contentWindow!, 'postMessage');
    (container.querySelector('#tone-start-tone-test-layer') as HTMLButtonElement).click();
    (container.querySelector('#tone-stop-tone-test-layer') as HTMLButtonElement).click();
    expect(post.mock.calls.map((c) => (c[0] as { cmd: string }).cmd)).toEqual(['start', 'stop']);
  });

  it('puts only plain-data imports into the frame', () => {
    const state = new Map<string, unknown>([['__imports_tone-test-layer', { modulationX: 4, handle: () => 1 }]]);
    const context = { settings, state: { get: (k: string) => state.get(k) } } as never;
    const inst = adapter.render(createLayer('Tone.Transport.start();'), attachedContainer(), context);
    const doc = srcdocOf(inst);
    expect(doc).toContain('var __import_modulationX = 4;');
    expect(doc).not.toContain('__import_handle');
  });

  it('generates Tone script with layer code', () => {
    const layer = createLayer('const synth = new Tone.Synth().toDestination();');
    const script = adapter.generateScript(layer, settings);
    expect(script).toContain('Tone.js');
    expect(script).toContain(layer.code);
  });

  it('generates script with default volume when audio settings missing', () => {
    const layer = createLayer('const synth = new Tone.Synth().toDestination();');
    const noAudio: GlobalSettings = { width: 800, height: 600, frameRate: 60, backgroundColor: '#000' };
    expect(adapter.generateScript(layer, noAudio)).toContain('Tone.js');
  });

  it('validates layer with Tone. references as valid', () => {
    const result = adapter.validate(createLayer('const synth = new Tone.Synth().toDestination();'));
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validates layer without Tone. references as invalid', () => {
    const result = adapter.validate(createLayer('const x = 42;'));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Code does not reference Tone.js (Tone. not found)']);
  });

  it('returns empty exports when no instance exists', () => {
    expect(adapter.getExports(createLayer('Tone.Transport.start();'))).toEqual([]);
  });

  it('exports read what the frame reported', () => {
    const layer = createLayer('Tone.Transport.start();');
    const inst = adapter.render(layer, attachedContainer());
    frameReports(inst, { isPlaying: true, bpm: 128, activeSynths: 2 });
    const byName = Object.fromEntries(adapter.getExports(layer).map((e) => [e.name, e.getter()]));
    expect(byName.isPlaying).toBe(true);
    expect(byName.bpm).toBe(128);
    expect(byName.activeSynths).toBe(2);
    expect(Object.keys(byName)).toEqual(['isPlaying', 'bpm', 'currentTime', 'masterVolume', 'activeSynths', 'elapsedTime']);
  });

  it('destroy stops the frame, removes it and clears exports', () => {
    const layer = createLayer('Tone.Transport.start();');
    const container = attachedContainer();
    const inst = adapter.render(layer, container);
    adapter.destroy(layer);
    expect(container.querySelector('iframe')).toBeNull();
    expect(inst.iframe?.tagName).toBe('IFRAME');
    expect(adapter.getExports(layer)).toEqual([]);
  });

  it('destroy is safe when no instance exists', () => {
    expect(() => adapter.destroy(createLayer('x'))).not.toThrow();
  });
});
