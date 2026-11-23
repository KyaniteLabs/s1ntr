/**
 * Tests for HydraAdapter: validate/getImports/generateScript, and the
 * sandbox lifecycle. Render/exports behavior lives in SandboxedAdapters.test.ts.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HydraAdapter } from '../../../../src/composition/adapters/HydraAdapter.js';
import type { Layer, GlobalSettings } from '../../../../src/composition/types.js';
import { attachedContainer, makeLayer, STUB_LIB } from './sandboxTestUtils.js';

const loadSandboxLib = vi.fn(async (_path: string) => STUB_LIB);
vi.mock('../../../../src/composition/adapters/sandboxFrame.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/composition/adapters/sandboxFrame.js')>()),
  loadSandboxLib: (path: string) => loadSandboxLib(path),
}));

describe('HydraAdapter', () => {
  let adapter: HydraAdapter;
  let mockLayer: Layer;
  const mockSettings: GlobalSettings = { width: 800, height: 600, frameRate: 60, backgroundColor: '#000000' };

  beforeEach(() => {
    adapter = new HydraAdapter();
    mockLayer = makeLayer('hydra', 'test-hydra-layer', 'osc(10, 0.1, 0.5).out()');
    loadSandboxLib.mockClear();
  });

  describe('initialize()', () => {
    it('should load the vendored Hydra source once', async () => {
      await adapter.initialize();
      await adapter.initialize();
      expect(loadSandboxLib).toHaveBeenCalledTimes(1);
      expect(loadSandboxLib).toHaveBeenCalledWith(expect.stringContaining('/vendor/hydra-synth/'));
    });
  });

  describe('getExports()', () => {
    it('should return empty array if layer not rendered', () => {
      expect(adapter.getExports(mockLayer)).toEqual([]);
    });

    it('should have descriptions for all exports', async () => {
      await adapter.initialize();
      adapter.render(mockLayer, attachedContainer());
      for (const exp of adapter.getExports(mockLayer)) {
        expect(exp.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getImports()', () => {
    it('should return imports array', () => {
      const imports = adapter.getImports();
      expect(Array.isArray(imports)).toBe(true);
    });

    it('should import canvas from p5 layers', () => {
      const imports = adapter.getImports();
      const p5Import = imports.find(i => i.from === 'p5' && i.name === 'canvas');
      
      expect(p5Import?.as).toBe('p5Canvas');
      expect(p5Import?.required).toBe(false);
    });

    it('should import canvas from three layers', () => {
      const imports = adapter.getImports();
      const threeImport = imports.find(i => i.from === 'three' && i.name === 'canvas');
      
      expect(threeImport?.as).toBe('threeCanvas');
      expect(threeImport?.required).toBe(false);
    });
  });

  describe('validate()', () => {
    it('should validate valid Hydra code with osc()', () => {
      const layer = { ...mockLayer, code: 'osc(10, 0.1, 0.5).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should validate valid Hydra code with noise()', () => {
      const layer = { ...mockLayer, code: 'noise(3, 0.1).color(0.5, 0.8, 1).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should validate valid Hydra code with gradient()', () => {
      const layer = { ...mockLayer, code: 'gradient(0.5).color(1, 0, 0).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject empty code', () => {
      const layer = { ...mockLayer, code: '' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Code is empty');
    });

    it('should reject code without .out()', () => {
      const layer = { ...mockLayer, code: 'osc(10, 0.1, 0.5)' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Hydra code MUST end with .out() to render');
    });

    it('should reject code without source function', () => {
      const layer = { ...mockLayer, code: '.color(1, 0, 0).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Hydra code should use a source function: osc(), src(), noise(), shape(), gradient(), solid(), voronoi()');
    });

    it('should reject code with invalid .sin() method', () => {
      const layer = { ...mockLayer, code: 'osc(10).sin(2).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('.sin('))).toBe(true);
    });

    it('should reject code with invalid .cos() method', () => {
      const layer = { ...mockLayer, code: 'osc(10).cos(2).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('.cos('))).toBe(true);
    });

    it('should reject code with invalid .tan() method', () => {
      const layer = { ...mockLayer, code: 'osc(10).tan(2).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('.tan('))).toBe(true);
    });

    it('should validate complex Hydra composition', () => {
      const code = `
osc(60, 0.1, 0.8)
  .rotate(0.5)
  .scale(1.5)
  .color(1, 0.2, 0.5)
  .modulate(noise(3))
  .out()
      `;
      const layer = { ...mockLayer, code };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
    });

    it('should validate Hydra code with multiple outputs', () => {
      const code = `
osc(10).out(o0)
noise(5).out(o1)
render()
      `;
      const layer = { ...mockLayer, code };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
    });

    it('should validate Hydra code with src() and initCam()', () => {
      const code = `
s0.initCam()
src(s0).modulate(osc(5, 0.1)).out()
      `;
      const layer = { ...mockLayer, code };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
    });

    it('should validate Hydra code with voronoi()', () => {
      const layer = { ...mockLayer, code: 'voronoi(5, 0.3, 0.1).color(0.2, 0.8, 1).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
    });

    it('should validate Hydra code with shape()', () => {
      const layer = { ...mockLayer, code: 'shape(3, 0.5, 0.01).color(1, 0.5, 0).repeat(3, 3).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
    });

    it('should validate Hydra code with solid()', () => {
      const layer = { ...mockLayer, code: 'solid(1, 0, 0, 1).out()' };
      const result = adapter.validate(layer);
      
      expect(result.valid).toBe(true);
    });
  });

  describe('generateScript()', () => {
    it('should generate HTML script', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain('<script');
      expect(script).toContain('</script>');
    });

    it('should include Hydra CDN URL', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain('/vendor/hydra-synth/1.3.10/hydra-synth.js'); // vendored (#924)
    });

    it('should create a layer container div', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain("className = 'layer'");
      expect(script).toContain("document.createElement('div')");
    });

    it('should set correct z-index from layer config', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain('zIndex = 1');
    });

    it('should create a canvas element', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain("document.createElement('canvas')");
    });

    it('should initialize Hydra with correct options', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain('new Hydra({');
      expect(script).toContain('autoLoop: true');
      expect(script).toContain('makeGlobal: true');
    });

    it('should include the layer code', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain(mockLayer.code);
    });

    it('should wrap code in IIFE', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain('(function() {');
      expect(script).toContain('})();');
    });

    it('should append container to composition element', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      
      expect(script).toContain("document.getElementById('composition')");
    });
  });


  describe('destroy()', () => {
    it('should remove the sandbox frame from the DOM', async () => {
      await adapter.initialize();
      const container = attachedContainer();
      adapter.render(mockLayer, container);
      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      adapter.destroy(mockLayer, undefined);
      expect(container.querySelector('iframe')).toBeNull();
    });

    it('should handle destroying non-existent layer gracefully', () => {
      expect(() => adapter.destroy(mockLayer, undefined)).not.toThrow();
    });

    it('should remove instance from internal tracking', async () => {
      await adapter.initialize();
      adapter.render(mockLayer, attachedContainer());
      adapter.destroy(mockLayer, undefined);
      expect(adapter.getExports(mockLayer)).toEqual([]);
    });
  });
});

// Singleton export test
describe('hydraAdapter singleton', () => {
  it('should be exported as singleton', async () => {
    const { hydraAdapter } = await import('../../../../src/composition/adapters/HydraAdapter.js');
    expect(hydraAdapter).toBeInstanceOf(HydraAdapter);
  });
});
