import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock puppeteer at the package level so getOrCreateBrowser (which calls
// puppeteer.launch) can be controlled without needing to match the module path
// of the lazy import inside getOrCreateBrowser.
// ---------------------------------------------------------------------------

function makeFakePage(result: unknown) {
  return {
    goto: vi.fn().mockResolvedValue({} as unknown),
    evaluate: vi.fn().mockResolvedValue(result),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

let fakePage: ReturnType<typeof makeFakePage> = makeFakePage({ error: null });

vi.mock('puppeteer', () => ({
  launch: vi.fn(async () => ({
    newPage: vi.fn(async () => fakePage),
    close: vi.fn(async () => {}),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fakePage = makeFakePage({ error: null });
});

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Shader fixtures
// ---------------------------------------------------------------------------

const validShader = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float n = noise(uv * 4.0 + u_time * 0.5);
  vec3 color1 = vec3(0.2, 0.4, 0.8);
  vec3 color2 = vec3(0.9, 0.3, 0.5);
  gl_FragColor = vec4(mix(color1, color2, n), 1.0);
}
`;

const undeclaredVariableShader = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float n = hash21(uv + u_time);
  float warpedFocal = n * warpedFlow; // warpedFlow is undeclared
  gl_FragColor = vec4(vec3(warpedFocal), 1.0);
}
`;

const syntaxErrorShader = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.3, 45.6))) * 789.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float n = hash21(uv + u_time);
  gl_FragColor = vec4(uv, n, 1.0; // missing closing paren
}
`;

const undeclaredFunctionShader = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.3, 45.6))) * 789.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float n = hash21(uv + u_time);
  float x = unknownFunction(uv); // unknownFunction is undeclared
  gl_FragColor = vec4(vec3(n + x), 1.0);
}
`;

const validGlsl300Shader = `
#version 300 es
precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float n = hash21(uv * 4.0 + u_time * 0.5);
  vec3 color1 = vec3(0.2, 0.4, 0.8);
  vec3 color2 = vec3(0.9, 0.3, 0.5);
  fragColor = vec4(mix(color1, color2, n), 1.0);
}
`;

const shaderWithUnrelatedVec2Uniform = `
precision highp float;
uniform float u_time;
uniform vec2 u_offset;

void main() {
  gl_FragColor = vec4(u_offset, 0.0, 1.0);
}
`;

const shaderWithMissingVar = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.3, 45.6))) * 789.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float n = hash21(uv + u_time);
  float result = n + missingVar;
  gl_FragColor = vec4(vec3(result), 1.0);
}
`;

// ---------------------------------------------------------------------------
// In-process shader compilation harness (mirrors the production page.evaluate
// logic in glsl-compile-check.ts). This lets us test ES3 vs WebGL1 source
// routing WITHOUT needing a real browser or a DOM environment.
// ---------------------------------------------------------------------------
interface HarnessResult {
  error: string | null;
  infra?: boolean;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkGLSLCompile', () => {
  it.each(['Vertex', 'Fragment', 'Link'])('strips control bytes from %s diagnostics before returning them', async stage => {
    fakePage = makeFakePage({
      error: `${stage}: ERROR:\u0000 0:12: 'missingVar'\u0007\u001b\u007f\n\tundeclared identifier\r\n// caf\u00e9`,
    });
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(undeclaredVariableShader);
    expect(result).toEqual({
      success: false,
      status: 'compile-error',
      error: `${stage}: ERROR: 0:12: 'missingVar'\n\tundeclared identifier\r\n// caf\u00e9`,
    });
  });

  it('accepts a valid GLSL shader', async () => {
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(validShader);
    expect(result.success).toBe(true);
    expect(result.status).toBe('pass');
  });

  it('rejects shader with undeclared variable', async () => {
    fakePage = makeFakePage({
      error: 'Fragment: ERROR: 0:12: \'warpedFlow\' : undeclared identifier',
    });
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(undeclaredVariableShader);
    expect(result.success).toBe(false);
    expect(result.status).toBe('compile-error');
    expect(result.error).toMatch(/warpedFlow|undeclared|unknown/i);
  });

  it('rejects shader with syntax error', async () => {
    fakePage = makeFakePage({ error: 'Fragment: ERROR: 0:9: syntax error' });
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(syntaxErrorShader);
    expect(result.success).toBe(false);
    expect(result.status).toBe('compile-error');
    expect(result.error).toMatch(/\S/);
  });

  it('rejects shader with undeclared function', async () => {
    fakePage = makeFakePage({
      error: 'Fragment: ERROR: 0:12: \'unknownFunction\' : undeclared identifier',
    });
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(undeclaredFunctionShader);
    expect(result.success).toBe(false);
    expect(result.status).toBe('compile-error');
    expect(result.error).toMatch(/unknownFunction|undeclared|unknown/i);
  });

  it('returns infra-unavailable when browser launch fails', async () => {
    const { launch } = await import('puppeteer');
    vi.mocked(launch).mockRejectedValueOnce(new Error('ENOENT'));
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(validShader);
    expect(result.status).toBe('infra-unavailable');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unavailable|ENOENT/i);
  });

  it('returns infra-unavailable when WebGL context is null (GPU disabled)', async () => {
    fakePage = makeFakePage({ error: 'WebGL not available', infra: true });
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(validShader);
    expect(result.status).toBe('infra-unavailable');
    expect(result.success).toBe(false);
  });

  it('ES3 routing: buildShaderSources keeps #version first, versions the vertex, injects nothing', async () => {
    const { buildShaderSources } = await import('../../src/utils/glsl-compile-check.js');
    const sources = buildShaderSources(validGlsl300Shader);
    expect(sources.isGlsl300).toBe(true);
    expect(sources.vertexShaderSrc.startsWith('#version 300 es\n')).toBe(true);
    expect(sources.fragmentShaderSrc).toBe(validGlsl300Shader);
    expect(sources.fragmentShaderSrc.match(/#version/g)).toHaveLength(1);
  });

  it('WebGL1 routing: buildShaderSources injects mediump preamble with uniform dedup', async () => {
    const { buildShaderSources } = await import('../../src/utils/glsl-compile-check.js');
    const sources = buildShaderSources(validShader);
    expect(sources.isGlsl300).toBe(false);
    expect(sources.vertexShaderSrc.startsWith('#version 300 es')).toBe(false);
    expect(sources.fragmentShaderSrc.startsWith('precision mediump float;\n')).toBe(true);
    expect(sources.fragmentShaderSrc).toContain(validShader.trim());
    // Dedup: u_resolution/u_time injected only when absent (word-boundary).
    const withUniforms = buildShaderSources('uniform vec2 u_resolution;\nuniform float u_time;\nvoid main(){gl_FragColor=vec4(1.0);}');
    expect(withUniforms.fragmentShaderSrc.match(/uniform vec2 u_resolution/g)).toHaveLength(1);
    expect(withUniforms.fragmentShaderSrc.match(/uniform float u_time/g)).toHaveLength(1);
    const withOffset = buildShaderSources('uniform vec2 u_offset;\nvoid main(){gl_FragColor=vec4(1.0);}');
    expect(withOffset.fragmentShaderSrc).toContain('uniform vec2 u_resolution;');
  });

  it('serialization parity: the exported builder survives evaluate-style stringification', async () => {
    // Regression guard for the #340 eval-scope bug: page.evaluate serializes
    // its callback, so the in-page builder must come from the function's own
    // source. Rebuild from .toString() the same way the browser does and
    // assert identical output on both routing fixtures.
    const { buildShaderSources } = await import('../../src/utils/glsl-compile-check.js');
    const inPage = new Function(`return (${buildShaderSources.toString()})`)() as typeof buildShaderSources;
    for (const fixture of [validShader, validGlsl300Shader]) {
      expect(inPage(fixture)).toEqual(buildShaderSources(fixture));
    }
  });

  it('accepts #version 300 es shaders (ES 3.00)', async () => {
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(validGlsl300Shader);
    expect(result.success).toBe(true);
    expect(result.status).toBe('pass');
  });

  it('injects u_resolution even when other uniform vec2 exists (word-boundary dedup)', async () => {
    const { checkGLSLCompile } = await import('../../src/utils/glsl-compile-check.js');
    const result = await checkGLSLCompile(shaderWithUnrelatedVec2Uniform);
    expect(result.success).toBe(true);
    expect(result.status).toBe('pass');
  });
});

describe('ShaderGenerator with compile check', () => {
  beforeEach(() => {
    fakePage = makeFakePage({ error: null });
  });

  it('validates valid shader through compile check', async () => {
    const { ShaderGenerator } = await import('../../src/generators/glsl/ShaderGenerator.js');
    const gen = new ShaderGenerator();
    const result = await (gen as any).validateForGeneration(validShader);
    expect(result.valid).toBe(true);
  });

  it('rejects shader with undeclared variable through compile check', async () => {
    fakePage = makeFakePage({
      error: 'Fragment: ERROR: 0:11: \'missingVar\' : undeclared identifier',
    });
    const { ShaderGenerator } = await import('../../src/generators/glsl/ShaderGenerator.js');
    const gen = new ShaderGenerator();
    const result = await (gen as any).validateForGeneration(shaderWithMissingVar);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('GLSL compile error');
    expect(result.error).toMatch(/missingVar|undeclared/i);
  });

  it('reports line number for syntax errors', async () => {
    fakePage = makeFakePage({ error: 'Fragment: ERROR: 0:9: syntax error' });
    const { ShaderGenerator } = await import('../../src/generators/glsl/ShaderGenerator.js');
    const gen = new ShaderGenerator();
    const result = await (gen as any).validateForGeneration(syntaxErrorShader);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('GLSL compile error');
  });
});
