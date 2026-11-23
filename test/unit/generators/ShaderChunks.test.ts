import { describe, expect, it } from 'vitest';
import { expandShaderChunks, SHADER_CHUNK_NAMES } from '../../../src/generators/glsl/ShaderChunks.js';
import { parseLibraryIntent } from '../../../src/runtime-core/LibraryIntent.js';

describe('sinter GLSL chunks', () => {
  it('leaves shaders without an include byte-for-byte unchanged', () => {
    const code = 'void main(){ gl_FragColor = vec4(1.0); }';
    expect(expandShaderChunks(code)).toBe(code);
  });
  it('expands each chunk once, requirements first', () => {
    const out = expandShaderChunks('#include <sinter/warp>\n#include <sinter/noise>\nvoid main(){}');
    expect(out.match(/float sn_fbm\(/g)).toHaveLength(1);
    expect(out.indexOf('sn_fbm')).toBeLessThan(out.indexOf('sn_warp'));
    expect(out).not.toContain('#include');
  });
  it('every chunk expands without leftover includes', () => {
    for (const n of SHADER_CHUNK_NAMES) expect(expandShaderChunks(`#include <sinter/${n}>`)).toContain(`// sinter/${n}`);
  });
  it('a declared sinter-glsl kit id is harmless in the libraries line', () => {
    expect(parseLibraryIntent('```glsl\nx\n```\nlibraries: sinter-glsl').libraries).toEqual([]);
  });
});
