/**
 * ThreeAdapter Tests: getImports/validate/generateScript and the sandbox
 * lifecycle. Render/exports behavior lives in SandboxedAdapters.test.ts.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreeAdapter } from '../../../../src/composition/adapters/ThreeAdapter.js';
import type { Layer, GlobalSettings } from '../../../../src/composition/types.js';
import { attachedContainer, frameFails, frameReports, makeLayer, STUB_LIB } from './sandboxTestUtils.js';

const loadSandboxLib = vi.fn(async (_path: string) => STUB_LIB);
vi.mock('../../../../src/composition/adapters/sandboxFrame.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/composition/adapters/sandboxFrame.js')>()),
  loadSandboxLib: (path: string) => loadSandboxLib(path),
}));


// validate() and generateScript() expect self-contained export code; render()
// supplies scene/camera/renderer and blocks document access.
const exportCode = `
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, 800/600, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer();
        renderer.setSize(800, 600);
        document.body.appendChild(renderer.domElement);
      `;

describe('ThreeAdapter', () => {
  let adapter: ThreeAdapter;
  let mockLayer: Layer;
  const mockSettings: GlobalSettings = { width: 800, height: 600, frameRate: 60, backgroundColor: '#000000' };

  beforeEach(() => {
    adapter = new ThreeAdapter();
    mockLayer = makeLayer('three', 'test-layer-1', `
        const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
        scene.add(cube);
        camera.position.z = 5;
      `);
    loadSandboxLib.mockClear();
  });

  describe('initialize', () => {
    it('should load the vendored Three.js source once', async () => {
      await adapter.initialize();
      await adapter.initialize();
      expect(loadSandboxLib).toHaveBeenCalledTimes(1);
      expect(loadSandboxLib).toHaveBeenCalledWith(expect.stringContaining('/vendor/three/'));
    });
  });

  describe('getExports', () => {
    it('should return empty array if layer not rendered', () => {
      expect(adapter.getExports(mockLayer)).toEqual([]);
    });
  });


  describe('getImports', () => {
    it('should request mouseX from p5', () => {
      const imports = adapter.getImports?.(mockLayer);
      
      expect(imports?.some(i => i.from === 'p5' && i.name === 'mouseX')).toBe(true);
    });

    it('should request mouseY from p5', () => {
      const imports = adapter.getImports?.(mockLayer);
      
      expect(imports?.some(i => i.from === 'p5' && i.name === 'mouseY')).toBe(true);
    });

    it('should map imports to camera control aliases', () => {
      const imports = adapter.getImports?.(mockLayer);
      
      const mouseXImport = imports?.find(i => i.name === 'mouseX');
      expect(mouseXImport?.as).toBe('cameraControlX');
      
      const mouseYImport = imports?.find(i => i.name === 'mouseY');
      expect(mouseYImport?.as).toBe('cameraControlY');
    });

    it('should mark imports as optional', () => {
      const imports = adapter.getImports?.(mockLayer);
      
      expect(imports?.every(i => i.required === false)).toBe(true);
    });
  });

  describe('validate', () => {
    it('should pass validation for valid code', () => {
      const result = adapter.validate?.({ ...mockLayer, code: exportCode });
      
      expect(result?.valid).toBe(true);
      expect(result?.errors).toBeUndefined();
    });

    it('should catch missing scene', () => {
      const invalidLayer = {
        ...mockLayer,
        code: 'const camera = new THREE.PerspectiveCamera();',
      };
      
      const result = adapter.validate?.(invalidLayer);
      
      expect(result?.valid).toBe(false);
      expect(result?.errors).toContain('Missing THREE.Scene creation');
    });

    it('should catch missing camera', () => {
      const invalidLayer = {
        ...mockLayer,
        code: 'const scene = new THREE.Scene();',
      };
      
      const result = adapter.validate?.(invalidLayer);
      
      expect(result?.valid).toBe(false);
      expect(result?.errors).toContain('Missing THREE.PerspectiveCamera creation');
    });

    it('should catch missing renderer', () => {
      const invalidLayer = {
        ...mockLayer,
        code: `
          const scene = new THREE.Scene();
          const camera = new THREE.PerspectiveCamera();
        `,
      };
      
      const result = adapter.validate?.(invalidLayer);
      
      expect(result?.valid).toBe(false);
      expect(result?.errors).toContain('Missing THREE.WebGLRenderer creation');
    });

    it('should return all missing elements in errors', () => {
      const invalidLayer = {
        ...mockLayer,
        code: 'console.log("no three.js code");',
      };
      
      const result = adapter.validate?.(invalidLayer);
      
      expect(result?.valid).toBe(false);
      expect(result?.errors?.length).toBe(3);
    });
  });

  describe('generateScript', () => {
    const mockSettings: GlobalSettings = {
      width: 800,
      height: 600,
      frameRate: 60,
      backgroundColor: '#000000',
    };

    it('should output valid HTML', () => {
      const script = adapter.generateScript?.(mockLayer, mockSettings);
      
      expect(script).toContain('<script');
      expect(script).toContain('</script>');
    });

    it('should include the vendored Three.js build (#924, zero CDN)', () => {
      const script = adapter.generateScript?.(mockLayer, mockSettings);
      
      expect(script).toContain('/vendor/three/r128/three.min.js');
    });

    it('should include layer code', () => {
      const script = adapter.generateScript?.({ ...mockLayer, code: exportCode }, mockSettings);
      
      expect(script).toContain('THREE.Scene');
      expect(script).toContain('THREE.PerspectiveCamera');
      expect(script).toContain('THREE.WebGLRenderer');
    });

    it('should create container element', () => {
      const script = adapter.generateScript?.(mockLayer, mockSettings);
      
      expect(script).toContain('document.createElement');
      expect(script).toContain('className');
    });

    it('should set z-index from layer config', () => {
      const script = adapter.generateScript?.(mockLayer, mockSettings);
      
      expect(script).toContain('zIndex = 1');
    });
  });

  describe('destroy', () => {
    it('removes the sandbox frame and forgets the layer', async () => {
      await adapter.initialize();
      const container = attachedContainer();
      adapter.render(mockLayer, container);
      adapter.destroy(mockLayer);
      expect(container.querySelector('iframe')).toBeNull();
      expect(adapter.getExports(mockLayer)).toEqual([]);
    });

    it('should handle unrendered layer gracefully', () => {
      expect(() => adapter.destroy?.(mockLayer, null)).not.toThrow();
    });
  });

  describe('replacing a rendered layer (#1533 review)', () => {
    it('keeps the working frame and exports when the replacement throws inside its frame', async () => {
      await adapter.initialize();
      const container = attachedContainer();
      const first = adapter.render(mockLayer, container);
      frameReports(first, { cameraZ: 5 });

      const second = adapter.render(makeLayer('three', mockLayer.id, 'throw new Error("boom");'), container);
      expect(container.querySelectorAll('iframe')).toHaveLength(2);
      frameFails(second, 'boom');

      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      expect(container.querySelector('iframe')).toBe(first.iframe);
      expect(adapter.getExports(mockLayer).find((e) => e.name === 'cameraZ')?.getter()).toBe(5);
    });

    it('retires the old frame only after the replacement reports its first frame', async () => {
      await adapter.initialize();
      const container = attachedContainer();
      const first = adapter.render(mockLayer, container);
      frameReports(first, { cameraZ: 5 });

      const second = adapter.render(mockLayer, container);
      expect(second.iframe?.style.visibility).toBe('hidden');
      expect(container.querySelectorAll('iframe')).toHaveLength(2);
      frameReports(second, { cameraZ: 9 });

      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      expect(container.querySelector('iframe')).toBe(second.iframe);
      expect(second.iframe?.style.visibility).toBe('');
      expect(adapter.getExports(mockLayer).find((e) => e.name === 'cameraZ')?.getter()).toBe(9);
    });
  });
});
