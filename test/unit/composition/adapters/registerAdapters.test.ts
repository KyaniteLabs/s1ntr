/**
 * @fileoverview Tests for registerAdapters - Central adapter registration
 */

import { describe, it, expect } from 'vitest';
import {
  registerAllAdapters,
  allAdapters,
} from '../../../../src/composition/adapters/registerAdapters.js';
import { CompositionEngine } from '../../../../src/composition/CompositionEngine.js';
import type { LayerAdapter } from '../../../../src/composition/adapters/index.js';
import { P5Adapter, p5Adapter } from '../../../../src/composition/adapters/P5Adapter.js';
import { ToneAdapter, toneAdapter } from '../../../../src/composition/adapters/ToneAdapter.js';
import { ThreeAdapter, threeAdapter } from '../../../../src/composition/adapters/ThreeAdapter.js';
import { ShaderAdapter, shaderAdapter } from '../../../../src/composition/adapters/ShaderAdapter.js';
import { StrudelAdapter, strudelAdapter } from '../../../../src/composition/adapters/StrudelAdapter.js';
import { HydraAdapter, hydraAdapter } from '../../../../src/composition/adapters/HydraAdapter.js';
import { ASCIIArtAdapter, asciiArtAdapter } from '../../../../src/composition/adapters/ASCIIArtAdapter.js';
import { HTMLAdapter, htmlAdapter } from '../../../../src/composition/adapters/HTMLAdapter.js';

function recordRegistrations(): Map<string, LayerAdapter> {
  const registered = new Map<string, LayerAdapter>();
  const engine = {
    registerAdapter: (type: string, adapter: LayerAdapter) => { registered.set(type, adapter); },
  } as unknown as CompositionEngine;
  registerAllAdapters(engine);
  return registered;
}

describe('registerAdapters', () => {
  describe('registerAllAdapters', () => {
    it('registers every domain type with its adapter', () => {
      const registered = recordRegistrations();

      expect([...registered.keys()].sort()).toEqual(
        ['ascii', 'html', 'hydra', 'music', 'p5', 'shader', 'strudel', 'three', 'tone'],
      );
      expect(registered.get('p5')).toBe(p5Adapter);
      expect(registered.get('three')).toBe(threeAdapter);
      expect(registered.get('shader')).toBe(shaderAdapter);
      expect(registered.get('hydra')).toBe(hydraAdapter);
      expect(registered.get('ascii')).toBe(asciiArtAdapter);
      expect(registered.get('strudel')).toBe(strudelAdapter);
      expect(registered.get('html')).toBe(htmlAdapter);
    });

    it('routes both music and tone layers to the Tone adapter', () => {
      const registered = recordRegistrations();

      expect(registered.get('music')).toBe(toneAdapter);
      expect(registered.get('tone')).toBe(toneAdapter);
    });

    it('registers into a real engine without throwing and leaves it empty of layers', () => {
      const engine = new CompositionEngine();

      expect(() => registerAllAdapters(engine)).not.toThrow();
      expect(engine.getLayers()).toEqual([]);
    });
  });

  describe('allAdapters singleton', () => {
    it('holds the module singleton of each adapter class', () => {
      expect(allAdapters.p5).toBe(p5Adapter);
      expect(allAdapters.tone).toBe(toneAdapter);
      expect(allAdapters.three).toBe(threeAdapter);
      expect(allAdapters.shader).toBe(shaderAdapter);
      expect(allAdapters.strudel).toBe(strudelAdapter);
      expect(allAdapters.hydra).toBe(hydraAdapter);
      expect(allAdapters.asciiArt).toBe(asciiArtAdapter);
      expect(allAdapters.html).toBe(htmlAdapter);
    });

    it('holds an instance of the matching adapter class for each key', () => {
      expect(allAdapters.p5).toBeInstanceOf(P5Adapter);
      expect(allAdapters.tone).toBeInstanceOf(ToneAdapter);
      expect(allAdapters.three).toBeInstanceOf(ThreeAdapter);
      expect(allAdapters.shader).toBeInstanceOf(ShaderAdapter);
      expect(allAdapters.strudel).toBeInstanceOf(StrudelAdapter);
      expect(allAdapters.hydra).toBeInstanceOf(HydraAdapter);
      expect(allAdapters.asciiArt).toBeInstanceOf(ASCIIArtAdapter);
      expect(allAdapters.html).toBeInstanceOf(HTMLAdapter);
    });

    it('exposes exactly 8 adapters, each with a render method', () => {
      const adapters: LayerAdapter[] = Object.values(allAdapters);

      expect(adapters).toHaveLength(8);
      expect(new Set(adapters).size).toBe(8);
      for (const adapter of adapters) {
        expect(typeof adapter.render).toBe('function');
      }
    });
  });
});
