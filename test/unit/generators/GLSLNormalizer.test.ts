import { describe, expect, it } from 'vitest';

import { hoistGLSLDirectives, normalizeGLSLDialect } from '../../../src/generators/glsl/GLSLNormalizer.js';

const ES1_BODY = [
  'precision mediump float;',
  'uniform float u_time;',
  'uniform vec2 u_resolution;',
  'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
  'void main(){',
  '  vec2 uv = gl_FragCoord.xy / u_resolution;',
  '  float h = hash(uv + u_time * 0.1);',
  '  gl_FragColor = vec4(vec3(h), 1.0);',
  '}',
].join('\n');

describe('normalizeGLSLDialect — C math names', () => {
  it.each([
    ['fabs', 'abs'], ['fabsf', 'abs'], ['fminf', 'min'], ['fmaxf', 'max'],
    ['fmin', 'min'], ['fmax', 'max'], ['fmodf', 'mod'], ['sqrtf', 'sqrt'],
    ['powf', 'pow'], ['floorf', 'floor'], ['ceilf', 'ceil'], ['expf', 'exp'],
    ['logf', 'log'], ['sinf', 'sin'], ['cosf', 'cos'], ['tanf', 'tan'],
    ['atan2f', 'atan'],
  ])('rewrites %s( -> %s(', (from, to) => {
    const code = `void main(){ float d = ${from}(0.5, 1.0); gl_FragColor = vec4(d); }`;
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain(`${to}(`);
    expect(result.code).not.toMatch(new RegExp(`\\b${from}\\s*\\(`));
    expect(result.fixes).toContain(`c-math: ${from}->${to}`);
  });

  it('does not rewrite a C math name the shader defines itself', () => {
    const code = [
      'float fabs(float x){ return x < 0.0 ? -x : x; }',
      'void main(){ gl_FragColor = vec4(fabs(-1.0)); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('float fabs(float x)');
    expect(result.code).toContain('vec4(fabs(-1.0))');
    expect(result.fixes).not.toContain('c-math: fabs->abs');
  });

  it('does not rewrite identifiers that are not call sites', () => {
    const code = 'void main(){ float powf = 1.0; gl_FragColor = vec4(powf); }';
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('float powf = 1.0');
  });
});

describe('normalizeGLSLDialect — host uniform aliases', () => {
  it('renames uTime / uResolution / u_mouse spellings to the exact host names', () => {
    const code = [
      'precision mediump float;',
      'uniform float uTime;',
      'uniform vec2 uResolution;',
      'void main(){',
      '  vec2 uv = gl_FragCoord.xy / uResolution;',
      '  gl_FragColor = vec4(uv, sin(uTime), 1.0);',
      '}',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('uniform float u_time;');
    expect(result.code).toContain('uniform vec2 u_resolution;');
    expect(result.code).toContain('sin(u_time)');
    expect(result.code).not.toMatch(/\buTime\b/);
    expect(result.fixes).toContain('uniform-alias: uTime->u_time');
    expect(result.fixes).toContain('uniform-alias: uResolution->u_resolution');
  });

  it('renames U_Time (case variant) to u_time', () => {
    const code = [
      'precision mediump float;',
      'uniform float U_Time;',
      'void main(){ gl_FragColor = vec4(sin(U_Time)); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('uniform float u_time;');
    expect(result.code).not.toMatch(/\bU_Time\b/);
  });

  it('leaves non-host uniforms and exact host names untouched', () => {
    const code = [
      'precision mediump float;',
      'uniform float u_time;',
      'uniform vec3 uCameraPos;',
      'void main(){ gl_FragColor = vec4(uCameraPos, u_time); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('uniform vec3 uCameraPos;');
    expect(result.fixes.filter(f => f.startsWith('uniform-alias'))).toHaveLength(0);
  });

  it('skips the rename when a local variable shares the alias name (ambiguous)', () => {
    const code = [
      'precision mediump float;',
      'uniform float uTime;',
      'void main(){ float uTime = 2.0; gl_FragColor = vec4(uTime); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('float uTime = 2.0');
    expect(result.fixes).not.toContain('uniform-alias: uTime->u_time');
  });
});

describe('normalizeGLSLDialect — invalid float literals', () => {
  it('rewrites 1e6.0 to 1e6 and 1.5e-3.0 to 1.5e-3', () => {
    const code = 'void main(){ float a = 1e6.0; float b = 1.5e-3.0; gl_FragColor = vec4(a, b, 0.0, 1.0); }';
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('1e6;');
    expect(result.code).toContain('1.5e-3;');
    expect(result.code).not.toContain('1e6.0');
    expect(result.fixes).toContain('literal: 1e6.0->1e6');
  });

  it('leaves valid literals untouched', () => {
    const code = 'void main(){ float a = 1e6; float b = 2.0e3; float c = 1e6f; gl_FragColor = vec4(a, b, c, 1.0); }';
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('1e6;');
    expect(result.code).toContain('2.0e3;');
    expect(result.code).toContain('1e6f;');
    expect(result.fixes.filter(f => f.startsWith('literal'))).toHaveLength(0);
  });
});

describe('normalizeGLSLDialect — ES3 vs WebGL1', () => {
  it('rewrites a desktop #version header to #version 300 es when the shader uses in/out (renderer prefers WebGL2)', () => {
    const code = [
      '#version 330 core',
      'precision highp float;',
      'in vec2 vUv;',
      'out vec4 FragColor;',
      'uniform float u_time;',
      'void main(){ FragColor = vec4(vUv, sin(u_time), 1.0); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toMatch(/^#version 300 es\n/);
    expect(result.code).not.toContain('330');
    expect(result.fixes).toContain('dialect: #version 330 core->#version 300 es');
  });

  it('strips a desktop #version line when the body is pure WebGL1 GLSL', () => {
    const code = ['#version 120', ...ES1_BODY.split('\n')].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).not.toMatch(/#version/);
    expect(result.code).toContain('void main()');
  });

  it('prepends #version 300 es when in/out globals appear with no version', () => {
    const code = [
      'precision highp float;',
      'in vec2 vUv;',
      'out vec4 FragColor;',
      'uniform float u_time;',
      'void main(){ FragColor = vec4(vUv, 0.0, 1.0); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toMatch(/^#version 300 es\n/);
  });

  it('inserts a float precision declaration after the version line when promoting without one', () => {
    const code = [
      '#version 330 core',
      'in vec2 vUv;',
      'out vec4 FragColor;',
      'uniform float u_time;',
      'void main(){ FragColor = vec4(vUv, sin(u_time), 1.0); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code.split('\n').slice(0, 2).join('\n')).toBe('#version 300 es\nprecision highp float;');
  });

  it('rewrites gl_FragColor to a declared out vec4 in a #version 300 es shader', () => {
    const code = [
      '#version 300 es',
      'precision highp float;',
      'out vec4 FragColor;',
      'uniform float u_time;',
      'void main(){ gl_FragColor = vec4(vec3(sin(u_time)), 1.0); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('FragColor = vec4(vec3(sin(u_time)), 1.0);');
    expect(result.code).not.toMatch(/\bgl_FragColor\b/);
    expect(result.fixes).toContain('dialect: gl_FragColor->FragColor');
  });

  it('declares an out vec4 when a #version 300 es shader writes only gl_FragColor', () => {
    const code = [
      '#version 300 es',
      'precision highp float;',
      'uniform float u_time;',
      'void main(){ gl_FragColor = vec4(vec3(sin(u_time)), 1.0); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('out vec4 fragColor;');
    expect(result.code).toContain('fragColor = vec4(vec3(sin(u_time)), 1.0);');
  });

  it('maps texture2D() to texture() in a #version 300 es shader', () => {
    const code = [
      '#version 300 es',
      'precision highp float;',
      'uniform sampler2D u_tex;',
      'out vec4 FragColor;',
      'void main(){ FragColor = texture2D(u_tex, vec2(0.5)); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toContain('texture(u_tex, vec2(0.5))');
    expect(result.code).not.toContain('texture2D(');
  });

  it('maps varying/attribute to in when promoting to #version 300 es', () => {
    const code = [
      '#version 330 core',
      'precision highp float;',
      'attribute vec2 a_pos;',
      'varying vec2 vUv;',
      'out vec4 FragColor;',
      'void main(){ vUv = a_pos; FragColor = vec4(vUv, 0.0, 1.0); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code);
    expect(result.code).toMatch(/^in vec2 a_pos;/m);
    expect(result.code).toMatch(/^in vec2 vUv;/m);
    expect(result.code).not.toMatch(/\b(varying|attribute)\b/);
  });

  it('is a no-op on a clean WebGL1 shader (no fixes)', () => {
    const result = normalizeGLSLDialect(ES1_BODY);
    expect(result.code).toBe(ES1_BODY);
    expect(result.fixes).toHaveLength(0);
  });

  it('is idempotent on a promoted shader', () => {
    const once = normalizeGLSLDialect([
      '#version 330 core',
      'in vec2 vUv;',
      'out vec4 FragColor;',
      'uniform float uTime;',
      'void main(){ float d = fabs(length(vUv)); FragColor = vec4(d, 0.0, sin(uTime), 1.0); }',
    ].join('\n'));
    const twice = normalizeGLSLDialect(once.code);
    expect(twice.code).toBe(once.code);
    expect(twice.fixes).toHaveLength(0);
  });
});

describe('normalizeGLSLDialect — WebGL1 downgrade mode', () => {
  it('downgrades in/out and the fragment output to WebGL1 forms', () => {
    const code = [
      '#version 300 es',
      'precision highp float;',
      'in vec2 vUv;',
      'out vec4 FragColor;',
      'uniform float u_time;',
      'void main(){ FragColor = vec4(vUv, sin(u_time), 1.0); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code, { webgl2: false });
    expect(result.code).not.toMatch(/#version/);
    expect(result.code).toContain('varying vec2 vUv;');
    expect(result.code).toContain('gl_FragColor = vec4(vUv, sin(u_time), 1.0);');
    expect(result.code).not.toMatch(/^\s*out\s+vec4/m);
    expect(result.fixes).toContain('dialect: out FragColor->gl_FragColor');
  });

  it('downgrades texture() to texture2D()', () => {
    const code = [
      'precision mediump float;',
      'uniform sampler2D u_tex;',
      'uniform float u_time;',
      'void main(){ gl_FragColor = texture(u_tex, vec2(0.5)) + vec4(u_time); }',
    ].join('\n');
    const result = normalizeGLSLDialect(code, { webgl2: false });
    expect(result.code).toContain('texture2D(u_tex, vec2(0.5))');
  });
});

describe('normalizeGLSLDialect — standard derivatives', () => {
  const ES1_DERIVS = [
    'precision mediump float;',
    'uniform vec2 u_resolution;',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / u_resolution;',
    '  float edge = fwidth(uv.x) + abs(dFdx(uv.y)) + abs(dFdy(uv.y));',
    '  gl_FragColor = vec4(vec3(edge), 1.0);',
    '}',
  ].join('\n');
  const EXT = '#extension GL_OES_standard_derivatives : enable';

  it('WebGL1 mode: adds the extension before precision and other code', () => {
    const result = normalizeGLSLDialect(ES1_DERIVS, { webgl2: false });
    const lines = result.code.split('\n');
    expect(lines[0]).toBe(EXT);
    expect(lines.indexOf(EXT)).toBeLessThan(lines.findIndex((l) => l.startsWith('precision')));
    expect(result.fixes).toContain('dialect: +#extension GL_OES_standard_derivatives');
  });

  it('WebGL1 mode: places the extension after #version 100', () => {
    const result = normalizeGLSLDialect(`#version 100\n${ES1_DERIVS}`, { webgl2: false });
    expect(result.code.split('\n').slice(0, 2)).toEqual(['#version 100', EXT]);
  });

  it('WebGL1 mode: is idempotent (no duplicate extension line)', () => {
    const once = normalizeGLSLDialect(ES1_DERIVS, { webgl2: false });
    const twice = normalizeGLSLDialect(once.code, { webgl2: false });
    expect(twice.code).toBe(once.code);
    expect(twice.code.match(/GL_OES_standard_derivatives/g)).toHaveLength(1);
    expect(twice.fixes).toEqual([]);
  });

  it('WebGL1 mode: leaves a shader that already declares the extension alone', () => {
    const code = `${EXT}\n${ES1_DERIVS}`;
    const result = normalizeGLSLDialect(code, { webgl2: false });
    expect(result.code).toBe(code);
    expect(result.fixes).toEqual([]);
  });

  it('does not add the extension when no derivative is called', () => {
    const result = normalizeGLSLDialect(ES1_BODY, { webgl2: false });
    expect(result.code).not.toContain('GL_OES_standard_derivatives');
  });

  it('ignores derivative names in comments', () => {
    const code = `// fwidth( is used elsewhere\n${ES1_BODY}`;
    expect(normalizeGLSLDialect(code, { webgl2: false }).code).not.toContain('#extension');
  });

  it('default (WebGL2) mode: upgrades to #version 300 es because ES 1.00 cannot use derivatives in a WebGL2 context', () => {
    const result = normalizeGLSLDialect(ES1_DERIVS);
    expect(result.code.split('\n')[0]).toBe('#version 300 es');
    expect(result.code).not.toContain('#extension');
    expect(result.code).not.toContain('gl_FragColor');
    expect(normalizeGLSLDialect(result.code).code).toBe(result.code);
  });

  it('does not add the extension for #version 300 es, and drops a stale one', () => {
    const es3 = [
      '#version 300 es',
      'precision highp float;',
      'out vec4 o;',
      'void main(){ o = vec4(fwidth(gl_FragCoord.x)); }',
    ].join('\n');
    expect(normalizeGLSLDialect(es3).code).toBe(es3);
    const stale = es3.replace('precision', `${EXT}\nprecision`);
    const fixed = normalizeGLSLDialect(stale);
    expect(fixed.code).toBe(es3);
  });

  it('upgrades an explicit #version 100 derivative shader to 300 es', () => {
    const result = normalizeGLSLDialect(`#version 100\n${ES1_DERIVS}`);
    expect(result.code.split('\n')[0]).toBe('#version 300 es');
  });
});

describe('hoistGLSLDirectives', () => {
  it('puts #version first, then #extension, and keeps the body in order', () => {
    const { header, body } = hoistGLSLDirectives('precision mediump float;\n#extension A : enable\n#version 100\nvoid main(){}');
    expect(header).toBe('#version 100\n#extension A : enable');
    expect(body).toBe('precision mediump float;\nvoid main(){}');
  });
});

describe('ES type and initializer repairs (LFM3 Kaggle canaries, 2026-11-17)', () => {
  const es = (body: string) => `#version 300 es\nprecision highp float;\nout vec4 fragColor;\n${body}\nvoid main() { fragColor = vec4(1.0); }`;

  it('rewrites a C brace array initializer as an ES array constructor', () => {
    const { code } = normalizeGLSLDialect(es('void f() { float xs[N] = {-2.0f, 0.0f, 2.0f}; }'));
    expect(code).toContain('float xs[N] = float[N](-2.0f, 0.0f, 2.0f);');
  });

  it('wraps a const int beside a float literal and leaves loop bounds alone', () => {
    const { code } = normalizeGLSLDialect(es('const int N = 5;\nvoid f() { for (int i = 0; i < N; i++) { float x = -N / 2.0 + 1.5 * N; } }'));
    expect(code).toContain('float x = -float(N) / 2.0 + 1.5 * float(N);');
    expect(code).toContain('i < N;');
  });

  it('gives an int literal under a float declaration a decimal point', () => {
    expect(normalizeGLSLDialect(es('const float STEPS = 64;')).code).toContain('const float STEPS = 64.0;');
  });

  it('makes never-written globals with constant initializers const, in dependency order', () => {
    const { code } = normalizeGLSLDialect(es('vec3 a = vec3(1.0, 0.0, 1.0);\nvec3 b = vec3(1.0, 0.5, 0.0);\nvec3 c = mix(a, b, 0.5);'));
    expect(code).toMatch(/const vec3 a = .*\nconst vec3 b = .*\nconst vec3 c = mix\(a, b, 0\.5\);/);
  });

  it('leaves a written global and a uniform-fed global non-const', () => {
    const { code } = normalizeGLSLDialect(es('uniform float u_time;\nvec3 a = vec3(1.0);\nfloat t = u_time * 2.0;\nvoid g() { a.x = 0.0; }'));
    expect(code).toContain('\nvec3 a = vec3(1.0);');
    expect(code).toContain('\nfloat t = u_time * 2.0;');
  });
});
