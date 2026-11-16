import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import type { GlobalSettings, Layer } from '../../../src/composition/types';
import { strudelAdapter } from '../../../src/composition/adapters/StrudelAdapter';
import { shaderAdapter } from '../../../src/composition/adapters/ShaderAdapter';
import { hydraAdapter } from '../../../src/composition/adapters/HydraAdapter';
import { p5Adapter } from '../../../src/composition/adapters/P5Adapter';
import { threeAdapter } from '../../../src/composition/adapters/ThreeAdapter';
import { toneAdapter } from '../../../src/composition/adapters/ToneAdapter';

/**
 * An exported composition must hand the browser the code the model wrote,
 * byte for byte. Backslashes, `${`, backticks and `</script>` all occur in
 * real model output.
 */
const settings: GlobalSettings = { width: 400, height: 300, frameRate: 60, backgroundColor: '#000' };
const layer = (type: string, code: string) => ({
  id: 'l1', type, code, enabled: true, locked: false,
  config: { zIndex: 1, blendMode: 'normal', opacity: 1, position: { x: 0, y: 0 }, scale: 1 },
  metadata: { prompt: 'p', generator: 'g', model: 'm', generatedAt: '2026-11-16T00:00:00Z' },
}) as unknown as Layer;

function page(script: string, globals: Record<string, unknown> = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="composition"></div>${script}</body></html>`, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.assign(window, globals);
    },
  });
  const inline = [...dom.window.document.querySelectorAll('script:not([src])')].map((s) => s.textContent ?? '');
  return { inline };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('composition export keeps model code intact', () => {
  it('strudel: the pattern reaches evaluate() exactly as written', async () => {
    const code = 'note("c3\\ne3").s(`piano`)\n// ${not a template} </script><b>';
    let evaluated: string | undefined;
    const { inline } = page(strudelAdapter.generateScript(layer('strudel', code), settings), {
      strudel: { initStrudel: async () => undefined, evaluate: (c: string) => { evaluated = c; } },
    });
    await settle();
    expect(inline).toHaveLength(1);
    expect(evaluated).toBe(code);
  });

  it('shader: both shader sources reach WebGL exactly as written', () => {
    const vertex = 'attribute vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }';
    const fragment = '#define WAVE(x) sin(x) \\\n  * 0.5\n// ${t} `q` </script>\nvoid main() { gl_FragColor = vec4(WAVE(1.0)); }';
    const code = `// Vertex Shader\n${vertex}\n// Fragment Shader\n${fragment}`;
    const sources: string[] = [];
    const gl = new Proxy({}, {
      get: (_, key) => key === 'shaderSource' ? (_s: unknown, src: string) => { sources.push(src); }
        : key === 'getShaderParameter' || key === 'getProgramParameter' ? () => true
          : typeof key === 'string' && /^[A-Z_]+$/.test(key) ? key : () => ({}),
    });
    // jsdom has no WebGL, so run the script the HTML parser hands over against a stub context.
    const { inline } = page(shaderAdapter.generateScript(layer('shader', code), settings));
    expect(inline).toHaveLength(1);
    new vm.Script(inline[0]).runInNewContext({
      document: { getElementById: () => ({ getContext: () => gl, addEventListener() {}, getBoundingClientRect: () => ({}) }) },
      requestAnimationFrame: () => 0, performance: { now: () => 0 }, console, window: { addEventListener() {} },
    });
    const { vertexSource, fragmentSource } = (shaderAdapter as unknown as {
      parseShaders(code: string): { vertexSource: string; fragmentSource: string };
    }).parseShaders(code);
    expect(sources).toEqual([vertexSource, `precision mediump float;\n${fragmentSource}`]);
    expect(fragmentSource).toContain('</script>');
  });

  it.each([
    ['hydra', hydraAdapter],
    ['p5', p5Adapter],
    ['three', threeAdapter],
    ['tone', toneAdapter],
  ])('%s: a script that mentions </script> in a string stays one valid script', (type, adapter) => {
    const code = 'const tag = "</script><b>bold</b>";\nwindow.__tag = tag;';
    const { inline } = page(adapter.generateScript(layer(type, code), settings));
    expect(inline).toHaveLength(1);
    expect(() => new vm.Script(inline[0])).not.toThrow();
    const line = inline[0].split('\n').find((l) => l.includes('const tag'))!;
    expect(vm.runInNewContext(`${line}; tag`)).toBe('</script><b>bold</b>');
  });
});
