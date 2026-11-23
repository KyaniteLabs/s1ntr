import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { normalizeGLSLDialect } from '../../src/generators/glsl/GLSLNormalizer.js';
import { glslangCompileCheck } from '../../src/utils/glsl-compile-check.js';

// The browserless fallback. CI installs glslang-tools and sets
// LIMINAL_REQUIRE_GLSLANG=1, so this suite cannot silently skip there.
const HAS_GLSLANG = !spawnSync('glslangValidator', ['--version']).error;
if (!HAS_GLSLANG && process.env.LIMINAL_REQUIRE_GLSLANG === '1') {
  throw new Error('LIMINAL_REQUIRE_GLSLANG=1 but glslangValidator is not on PATH');
}

const VORONOI_LIKE = [
  'precision mediump float;',
  'uniform float u_time;',
  'uniform vec2 u_resolution;',
  'void main(){',
  '  vec2 uv = gl_FragCoord.xy / u_resolution;',
  '  float d = length(fract(uv * 6.0) - 0.5);',
  '  float edge = smoothstep(0.0, fwidth(d) * 1.5, d - 0.3);',
  '  gl_FragColor = vec4(vec3(edge), 1.0);',
  '}',
].join('\n');

describe.skipIf(!HAS_GLSLANG)('glslang compile fallback', () => {
  it('passes a plain WebGL1 shader', () => {
    const r = glslangCompileCheck('uniform vec2 u_resolution;\nvoid main(){ gl_FragColor = vec4(gl_FragCoord.xy / u_resolution, 0.0, 1.0); }');
    expect(r).toEqual({ success: true, status: 'pass' });
  });

  it('fails an undeclared identifier', () => {
    const r = glslangCompileCheck('void main(){ gl_FragColor = vec4(warpedFlow, 0.0, 0.0, 1.0); }');
    expect(r?.status).toBe('compile-error');
    expect(r?.error).toMatch(/warpedFlow/);
  });

  it('fails an orphan #endif (Kaggle 0/4 fence leak)', () => {
    const r = glslangCompileCheck('#endif\nvoid main(){ gl_FragColor = vec4(1.0); }');
    expect(r?.status).toBe('compile-error');
  });

  it('fails gl_FragColor in ES 3.00', () => {
    const r = glslangCompileCheck('#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ gl_FragColor = vec4(1.0); }');
    expect(r?.status).toBe('compile-error');
    expect(r?.error).toMatch(/gl_FragColor/);
  });

  it('fails raw ES 1.00 fwidth and passes both normalized dialects', () => {
    const raw = glslangCompileCheck(VORONOI_LIKE);
    expect(raw?.status).toBe('compile-error');
    expect(glslangCompileCheck(normalizeGLSLDialect(VORONOI_LIKE).code)).toEqual({ success: true, status: 'pass' });
    expect(glslangCompileCheck(normalizeGLSLDialect(VORONOI_LIKE, { webgl2: false }).code)).toEqual({ success: true, status: 'pass' });
  });
});
