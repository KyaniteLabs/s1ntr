/**
 * Unit tests for ShaderAdapter
 *
 * Tests WebGL shader rendering with TDD approach:
 * RED → GREEN → REFACTOR
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ShaderAdapter } from '../../../../src/composition/adapters/ShaderAdapter.js';
import type { Layer, GlobalSettings } from '../../../../src/composition/types.js';
import type { RenderContext } from '../../../../src/composition/CompositionEngine.js';

// Mock WebGL context
const createMockWebGLContext = () => {
  const mockShader = { __type: 'shader' };
  const mockProgram = { __type: 'program' };
  const mockBuffer = { __type: 'buffer' };
  const mockUniformLocation = { __type: 'uniform' };

  return {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COLOR_BUFFER_BIT: 0x00004000,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,

    createShader: vi.fn().mockReturnValue(mockShader),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn().mockReturnValue(true),
    getShaderInfoLog: vi.fn().mockReturnValue(null),
    createProgram: vi.fn().mockReturnValue(mockProgram),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn().mockReturnValue(true),
    getProgramInfoLog: vi.fn().mockReturnValue(null),
    useProgram: vi.fn(),
    createBuffer: vi.fn().mockReturnValue(mockBuffer),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn().mockReturnValue(0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn().mockReturnValue(mockUniformLocation),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform4f: vi.fn(),
    uniform1i: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    drawArrays: vi.fn(),
    deleteShader: vi.fn(),
    deleteProgram: vi.fn(),
    deleteBuffer: vi.fn(),
  };
};

describe('ShaderAdapter', () => {
  let adapter: ShaderAdapter;
  let mockLayer: Layer;
  let mockContainer: HTMLElement;
  let mockContext: RenderContext;
  let mockSettings: GlobalSettings;
  let mockGl: ReturnType<typeof createMockWebGLContext>;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  // Sample shader code for testing
  const vertexShader = `
    attribute vec2 a_position;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const fragmentShader = `
    precision mediump float;
    uniform float u_time;
    uniform vec2 u_resolution;
    void main() {
      vec2 uv = gl_FragCoord.xy / u_resolution;
      gl_FragColor = vec4(uv, sin(u_time) * 0.5 + 0.5, 1.0);
    }
  `;

  const sampleShaderCode = `// Vertex Shader
${vertexShader}

// Fragment Shader
${fragmentShader}`;

  beforeEach(() => {
    adapter = new ShaderAdapter();

    mockLayer = {
      id: 'test-shader-layer',
      type: 'shader',
      code: sampleShaderCode,
      config: {
        zIndex: 1,
        blendMode: 'normal',
        opacity: 1.0,
        position: { x: 0, y: 0 },
        scale: 1.0,
      },
      metadata: {
        prompt: 'test shader',
        generator: 'test',
        model: 'test-model',
        generatedAt: new Date().toISOString(),
      },
      enabled: true,
      locked: false,
    };

    mockSettings = {
      width: 800,
      height: 600,
      frameRate: 60,
      backgroundColor: '#000000',
    };

    mockGl = createMockWebGLContext();

    // Mock canvas getContext
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(function(this: HTMLCanvasElement, contextId: string) {
      if (contextId === 'webgl' || contextId === 'experimental-webgl') {
        return mockGl as unknown as WebGLRenderingContext;
      }
      return originalGetContext.call(this, contextId);
    });

    mockContainer = document.createElement('div');

    mockContext = {
      settings: mockSettings,
      state: new Map(),
    } as unknown as RenderContext;
  });

  afterEach(() => {
    adapter.destroy(mockLayer);
    vi.clearAllMocks();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  describe('render()', () => {
    it('should create WebGL canvas in container', () => {
      const instance = adapter.render(mockLayer, mockContainer, mockContext);

      expect(instance.canvas).toBe(mockContainer.querySelector('canvas'));
      expect(instance.canvas).toMatchObject({ width: 800, height: 600 });
    });

    it('should create WebGL context with shader program', () => {
      adapter.render(mockLayer, mockContainer, mockContext);

      expect(mockGl.createShader).toHaveBeenCalledTimes(2);
      expect(mockGl.createShader).toHaveBeenCalledWith(mockGl.VERTEX_SHADER);
      expect(mockGl.createShader).toHaveBeenCalledWith(mockGl.FRAGMENT_SHADER);
    });

    it('should compile vertex and fragment shaders', () => {
      adapter.render(mockLayer, mockContainer, mockContext);

      expect(mockGl.shaderSource).toHaveBeenCalledTimes(2);
      expect(mockGl.compileShader).toHaveBeenCalledTimes(2);
    });

    it('should create and link shader program', () => {
      adapter.render(mockLayer, mockContainer, mockContext);

      expect(mockGl.createProgram).toHaveBeenCalledTimes(1);
      expect(mockGl.attachShader).toHaveBeenCalledTimes(2);
      expect(mockGl.linkProgram).toHaveBeenCalledTimes(1);
    });

    it('should set up vertex buffer for full-screen quad', () => {
      adapter.render(mockLayer, mockContainer, mockContext);

      expect(mockGl.createBuffer).toHaveBeenCalledTimes(1);
      expect(mockGl.bindBuffer).toHaveBeenCalledWith(mockGl.ARRAY_BUFFER, expect.anything());
      expect(mockGl.bufferData).toHaveBeenCalledWith(mockGl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), mockGl.STATIC_DRAW);
    });

    it('should handle shader without explicit vertex shader', () => {
      mockLayer.code = fragmentShader; // Only fragment shader

      const instance = adapter.render(mockLayer, mockContainer, mockContext);

      expect(instance.canvas).toMatchObject({ width: 800, height: 600 });
      expect(mockGl.createShader).toHaveBeenCalledTimes(2);
    });

    it('should throw error if WebGL is not supported', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);

      expect(() => {
        adapter.render(mockLayer, mockContainer, mockContext);
      }).toThrow('WebGL not supported');
      expect(mockContainer.childElementCount).toBe(0);
    });
  });

  describe('getExports()', () => {
    it('should return uniform values as exports', () => {
      adapter.render(mockLayer, mockContainer, mockContext);
      const exports = adapter.getExports(mockLayer);

      expect(Array.isArray(exports)).toBe(true);
      expect(exports?.length).toBeGreaterThan(0);
    });

    it('should export time uniform', () => {
      adapter.render(mockLayer, mockContainer, mockContext);
      const exports = adapter.getExports(mockLayer);

      const timeExport = exports.find(e => e.name === 'u_time');

      expect(timeExport?.type).toBe('number');
    });

    it('should export resolution uniform', () => {
      adapter.render(mockLayer, mockContainer, mockContext);
      const exports = adapter.getExports(mockLayer);

      const resolutionExport = exports.find(e => e.name === 'u_resolution');

      expect(resolutionExport?.type).toBe('object');
    });

    it('should export canvas reference', () => {
      adapter.render(mockLayer, mockContainer, mockContext);
      const exports = adapter.getExports(mockLayer);

      const canvasExport = exports.find(e => e.name === 'canvas');

      expect(canvasExport?.type).toBe('canvas');
    });

    it('should return empty array if layer not rendered', () => {
      const exports = adapter.getExports(mockLayer);

      expect(exports).toEqual([]);
    });

    it('should have callable getters for exports', () => {
      adapter.render(mockLayer, mockContainer, mockContext);
      const exports = adapter.getExports(mockLayer);

      for (const exp of exports) {
        expect(typeof exp.getter).toBe('function');
        // Should not throw when called
        expect(() => exp.getter()).not.toThrow();
      }
    });
  });

  describe('getImports()', () => {
    it('should return empty array by default', () => {
      const imports = adapter.getImports(mockLayer);

      expect(imports).toEqual([]);
    });

    it('should be callable', () => {
      expect(() => adapter.getImports(mockLayer)).not.toThrow();
    });
  });

  describe('validate()', () => {
    it('should validate shader with both vertex and fragment shaders', () => {
      const result = adapter.validate(mockLayer);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should detect missing fragment shader', () => {
      mockLayer.code = vertexShader; // Only vertex shader

      const result = adapter.validate(mockLayer);

      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.toLowerCase().includes('fragment'))).toBe(true);
    });

    it('should detect missing vertex shader', () => {
      mockLayer.code = fragmentShader; // Only fragment shader

      const result = adapter.validate(mockLayer);

      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.toLowerCase().includes('vertex'))).toBe(true);
    });

    it('should detect missing main function in fragment shader', () => {
      mockLayer.code = `
        precision mediump float;
        void notMain() {
          gl_FragColor = vec4(1.0);
        }
      `;

      const result = adapter.validate(mockLayer);

      expect(result.valid).toBe(false);
    });

    it('should detect missing vertex shader in fragment-only code', () => {
      mockLayer.code = `
        precision mediump float;
        void main() {
          gl_FragColor = vec4(1.0);
        }
      `;

      const result = adapter.validate(mockLayer);

      // Fragment-only code fails validation (no vertex indicators)
      // But render() will still work with default vertex shader
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('vertex'))).toBe(true);
    });

    it('should handle empty code', () => {
      mockLayer.code = '';

      const result = adapter.validate(mockLayer);

      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });

  describe('generateScript()', () => {
    it('should generate valid HTML with shader code', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);

      expect(script).toContain('<canvas');
      expect(script).toContain('</canvas>');
    });

    it('should include vertex shader in output', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);

      expect(script).toContain('VERTEX_SHADER');
      expect(script).toContain('attribute vec2');
    });

    it('should include fragment shader in output', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);

      expect(script).toContain('FRAGMENT_SHADER');
      expect(script).toContain('precision mediump float');
    });

    it('should set canvas dimensions from settings', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);

      expect(script).toContain('800');
      expect(script).toContain('600');
    });

    it('should include animation loop', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);

      expect(script).toContain('requestAnimationFrame');
    });

    it('should handle shader without vertex shader by providing default', () => {
      mockLayer.code = fragmentShader;

      const script = adapter.generateScript(mockLayer, mockSettings);

      expect(script).toContain('VERTEX_SHADER');
      expect(script).toContain('gl_Position');
    });

    it('should be valid JavaScript inside script tags', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);

      // Should have properly formatted JavaScript
      expect(script).toContain('function');
      expect(script).toContain('const');
      expect(script).toContain('getContext');
    });
    it('wires the u_mouse contract uniform in standalone export (wave-10 defect #4)', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);

      // Fetches the u_mouse uniform location alongside time/resolution
      expect(script).toContain("getUniformLocation(program, 'u_mouse')");
      // Tracks pointer position (WebGL origin is bottom-left)
      expect(script).toContain('pointermove');
      // Sets u_mouse in the render loop, not just time/resolution
      expect(script).toMatch(/if\s*\(mouseLocation\)\s*gl\.uniform2f\(mouseLocation/);
    });
  });

  describe('destroy()', () => {
    it('releases a running layer when a later animation frame fails', () => {
      const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(41);
      try {
        adapter.render(mockLayer, mockContainer, mockContext);
        mockGl.drawArrays.mockImplementationOnce(() => { throw new Error('GPU lost'); });
        expect(() => frame.mock.calls[0][0](1)).toThrow('GPU lost');
        expect(mockContainer.childElementCount).toBe(0);
        expect(mockGl.deleteProgram).toHaveBeenCalledTimes(1);
        expect(adapter.getExports(mockLayer)).toEqual([]);
        expect(frame).toHaveBeenCalledTimes(1);
      } finally { frame.mockRestore(); }
    });

    it('keeps the prior layer active if a replacement cannot draw its first frame', () => {
      const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(41);
      try {
        const first = adapter.render(mockLayer, mockContainer, mockContext);
        mockGl.drawArrays.mockImplementationOnce(() => { throw new Error('replacement failed'); });
        expect(() => adapter.render(mockLayer, mockContainer, mockContext)).toThrow('replacement failed');
        expect(mockContainer.querySelector('canvas')).toBe(first.canvas);
        expect(mockContainer.querySelectorAll('canvas')).toHaveLength(1);
        expect(adapter.getExports(mockLayer).find(e => e.name === 'canvas')?.getter()).toBe(first.canvas);
        expect(frame).toHaveBeenCalledTimes(1);
      } finally { frame.mockRestore(); }
    });

    it('replaces a layer without letting its old animation callback render again', () => {
      let nextFrame = 41;
      const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => nextFrame++);
      try {
        const first = adapter.render(mockLayer, mockContainer, mockContext);
        const oldFrame = frame.mock.calls[0][0];
        const second = adapter.render(mockLayer, mockContainer, mockContext);
        const draws = mockGl.drawArrays.mock.calls.length;
        const frames = frame.mock.calls.length;
        oldFrame(0);
        expect(mockGl.drawArrays).toHaveBeenCalledTimes(draws);
        expect(frame).toHaveBeenCalledTimes(frames);
        expect(mockContainer.querySelectorAll('canvas')).toHaveLength(1);
        expect(first.canvas.isConnected).toBe(false);
        expect(mockContainer.querySelector('canvas')).toBe(second.canvas);
        expect(mockGl.deleteProgram).toHaveBeenCalledTimes(1);
        frame.mock.calls[1][0](1);
        expect(mockGl.drawArrays).toHaveBeenCalledTimes(draws + 1);
      } finally { frame.mockRestore(); }
    });

    it('cancels frame id zero instead of leaving its render loop scheduled', () => {
      const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
      const cancel = vi.spyOn(window, 'cancelAnimationFrame');
      try {
        const instance = adapter.render(mockLayer, mockContainer, mockContext);
        adapter.destroy(mockLayer, instance);
        expect(cancel).toHaveBeenCalledWith(0);
      } finally { frame.mockRestore(); cancel.mockRestore(); }
    });

    it('should clean up WebGL resources', () => {
      const instance = adapter.render(mockLayer, mockContainer, mockContext);

      adapter.destroy(mockLayer, instance);

      expect(mockGl.deleteProgram).toHaveBeenCalledWith(instance.program);
      expect(mockGl.deleteShader).toHaveBeenCalledTimes(2);
    });

    it('should delete buffers', () => {
      const instance = adapter.render(mockLayer, mockContainer, mockContext);

      adapter.destroy(mockLayer, instance);

      expect(mockGl.deleteBuffer).toHaveBeenCalledWith(instance.positionBuffer);
    });

    it('should handle destroy when layer not rendered', () => {
      expect(() => {
        adapter.destroy(mockLayer, undefined);
      }).not.toThrow();
    });

    it('should remove canvas from container', () => {
      adapter.render(mockLayer, mockContainer, mockContext);

      adapter.destroy(mockLayer, undefined);

      expect(mockContainer.querySelector('canvas')).toBeNull();
    });
  });

  describe('shader compilation errors', () => {
    it('releases the compiled vertex shader and canvas after fragment failure', () => {
      const vertex = { __type: 'vertex' }, fragment = { __type: 'fragment' };
      mockGl.createShader.mockReturnValueOnce(vertex).mockReturnValueOnce(fragment);
      mockGl.getShaderParameter.mockImplementation((shader) => shader !== fragment);
      expect(() => adapter.render(mockLayer, mockContainer, mockContext)).toThrow('Fragment shader compilation failed');
      expect(mockGl.deleteShader).toHaveBeenCalledWith(vertex);
      expect(mockGl.deleteShader).toHaveBeenCalledWith(fragment);
      expect(mockGl.deleteShader).toHaveBeenCalledTimes(2);
      expect(mockContainer.childElementCount).toBe(0);
      expect(adapter.getExports(mockLayer)).toEqual([]);
    });

    it('releases both compiled shaders and the canvas when linking fails', () => {
      mockGl.getProgramParameter.mockReturnValue(false);
      expect(() => adapter.render(mockLayer, mockContainer, mockContext)).toThrow('Program linking failed');
      expect(mockGl.deleteProgram).toHaveBeenCalledTimes(1);
      expect(mockGl.deleteShader).toHaveBeenCalledTimes(2);
      expect(mockContainer.childElementCount).toBe(0);
      expect(adapter.getExports(mockLayer)).toEqual([]);
    });

    it('should throw if vertex shader fails to compile', () => {
      mockGl.getShaderParameter.mockImplementation((_shader: unknown, param: number) => {
        // Return false for COMPILE_STATUS
        return param !== mockGl.COMPILE_STATUS;
      });
      mockGl.getShaderInfoLog.mockReturnValue('Syntax error in vertex shader');

      expect(() => {
        adapter.render(mockLayer, mockContainer, mockContext);
      }).toThrow('Vertex shader compilation failed');
    });

    it('should throw if fragment shader fails to compile', () => {
      // Mock implementation: fail for fragment shader (second shader created)
      let createShaderCallCount = 0;
      mockGl.createShader.mockImplementation((type: number) => {
        createShaderCallCount++;
        return { __type: 'shader', shaderType: type, id: createShaderCallCount };
      });

      // Fail compilation for fragment shader (type 0x8b30 = FRAGMENT_SHADER)
      mockGl.getShaderParameter.mockImplementation((shader: unknown, param: number) => {
        if (param === mockGl.COMPILE_STATUS) {
          // Access shader type via the mock object we created
          const s = shader as { shaderType: number; id: number };
          // Fail the second shader (fragment)
          return s.id !== 2;
        }
        return true;
      });
      mockGl.getShaderInfoLog.mockReturnValue('Syntax error in fragment shader');

      expect(() => {
        adapter.render(mockLayer, mockContainer, mockContext);
      }).toThrow('Fragment shader compilation failed');
    });

    it('should throw if program linking fails', () => {
      mockGl.getProgramParameter.mockImplementation((_program: unknown, param: number) => {
        // Return false for LINK_STATUS
        return param !== mockGl.LINK_STATUS;
      });
      mockGl.getProgramInfoLog.mockReturnValue('Linking error');

      expect(() => {
        adapter.render(mockLayer, mockContainer, mockContext);
      }).toThrow('Program linking failed');
    });
  });

  describe('uniform handling', () => {
    it('should set up standard uniforms', () => {
      adapter.render(mockLayer, mockContainer, mockContext);

      expect(mockGl.getUniformLocation).toHaveBeenCalledWith(expect.anything(), 'u_time');
      expect(mockGl.getUniformLocation).toHaveBeenCalledWith(expect.anything(), 'u_resolution');
      expect(mockGl.getUniformLocation).toHaveBeenCalledWith(expect.anything(), 'u_mouse');
    });

    it('wires u_mouse in the live render loop and cleans up on destroy (wave-10 defect #4)', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      const instance = adapter.render(mockLayer, mockContainer, mockContext);

      // Live render attaches a pointermove listener for the u_mouse causal bus
      expect(addSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
      // The synchronous first frame set the mouse uniform (location resolves to the mock)
      expect(mockGl.uniform2f).toHaveBeenCalledWith(instance.uniforms.get('u_mouse'), 400, 300);

      adapter.destroy(mockLayer, instance);
      // Destroy detaches the listener — no leaked pointermove handler
      expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    });
  });

  describe('shader parsing edge cases', () => {
    it('should handle shader with explicit section markers', () => {
      mockLayer.code = `// Vertex Shader
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
// Fragment Shader
precision mediump float;
void main() {
  gl_FragColor = vec4(1.0);
}`;

      const result = adapter.validate(mockLayer);
      expect(result.valid).toBe(true);
    });

    it('should handle shader with vertex-only code', () => {
      mockLayer.code = `
        attribute vec2 a_position;
        void main() {
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `;

      const result = adapter.validate(mockLayer);
      expect(result.valid).toBe(false);
      expect(result.errors?.some(e => e.includes('fragment'))).toBe(true);
    });

    it('should handle code with both gl_Position and gl_FragColor', () => {
      mockLayer.code = `
        attribute vec2 a_position;
        void main() {
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
        precision mediump float;
        void main() {
          gl_FragColor = vec4(1.0);
        }
      `;

      const result = adapter.validate(mockLayer);
      expect(result.valid).toBe(true);
    });

    it('should handle vertex shader before fragment in code', () => {
      mockLayer.code = vertexShader + '\n' + fragmentShader;

      const instance = adapter.render(mockLayer, mockContainer, mockContext);
      expect(instance.canvas).toMatchObject({ width: 800, height: 600 });
    });
  });

  describe('generateScript variations', () => {
    it('should include layer id in canvas element', () => {
      const script = adapter.generateScript(mockLayer, mockSettings);
      expect(script).toContain(`shader-${mockLayer.id}`);
    });

    it('should handle different canvas sizes', () => {
      const smallSettings: GlobalSettings = {
        width: 400,
        height: 300,
        frameRate: 30,
        backgroundColor: '#ffffff',
      };

      const script = adapter.generateScript(mockLayer, smallSettings);
      expect(script).toContain('400');
      expect(script).toContain('300');
    });
  });
});
