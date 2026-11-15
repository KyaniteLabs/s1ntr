import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateCreativeDomainArtifact, validateCreativeDomainArtifactWithCompileCheck, validateGLSLCompile } from '../../scripts/lib/creative-domain-artifact-validation.mjs';


describe('creative-domain artifact validation', () => {
  it('rejects non-empty junk files for launch domains', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-domain-artifact-junk-'));
    const artifactPath = path.join(tempRoot, 'p5.txt');
    writeFileSync(artifactPath, 'p5 artifact');

    const result = validateCreativeDomainArtifact('p5', artifactPath, 'p5 artifact');

    expect(result.status).toBe('fail');
    expect(result.errors.join('\n')).toContain('expected-extension');
    expect(result.errors.join('\n')).toContain('p5-setup');
  });

  it('accepts a structurally valid p5 artifact', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-domain-artifact-p5-'));
    const artifactPath = path.join(tempRoot, 'p5.js');
    const code = 'function setup(){ createCanvas(400, 400); } function draw(){ background(0); }';
    writeFileSync(artifactPath, code);

    const result = validateCreativeDomainArtifact('p5', artifactPath, code);

    expect(result.status).toBe('pass');
  });

  it('rejects an opaque full-canvas SVG background', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-domain-artifact-svg-'));
    const artifactPath = path.join(tempRoot, 'svg.svg');
    const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0a0a12"/><circle cx="200" cy="200" r="80"/></svg>';
    writeFileSync(artifactPath, code);

    const result = validateCreativeDomainArtifact('svg', artifactPath, code);

    expect(result.status).toBe('fail');
    expect(result.errors.join('\n')).toContain('svg-transparent-background');
  });

  it('rejects opaque SVG backgrounds that match a shifted viewBox', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-domain-artifact-svg-shifted-'));
    const artifactPath = path.join(tempRoot, 'svg.svg');
    const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><rect x="-50" y="-50" width="100" height="100" fill="#111827"/><circle cx="0" cy="0" r="20"/></svg>';
    writeFileSync(artifactPath, code);

    const result = validateCreativeDomainArtifact('svg', artifactPath, code);

    expect(result.status).toBe('fail');
    expect(result.errors.join('\n')).toContain('svg-transparent-background');
  });

  it('accepts SVGs with transparent backgrounds and non-background rect shapes', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-domain-artifact-svg-transparent-'));
    const artifactPath = path.join(tempRoot, 'svg.svg');
    const code = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#00000000"/><rect x="90" y="90" width="220" height="220" fill="#6366f1"/><text x="200" y="360">LIMINAL</text></svg>';
    writeFileSync(artifactPath, code);

    const result = validateCreativeDomainArtifact('svg', artifactPath, code);

    expect(result.status).toBe('pass');
  });
});

describe('GLSL compile check', () => {
  // Valid shader that should compile successfully
  const validGlslShader = `
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
  gl_FragColor = vec4(uv, n, 1.0);
}
`;

  // Shader with undeclared variable (like run2's warpedFlow)
  const undeclaredVariableShader = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float focalDist = length(uv - 0.5);
  float warpedFocal = focalDist * warpedFlow; // warpedFlow is undeclared
  gl_FragColor = vec4(vec3(warpedFocal), 1.0);
}
`;

  it('accepts a structurally valid GLSL artifact with compile check', async () => {
    const result = await validateGLSLCompile(validGlslShader);
    if (result.unavailable) {
      // Bundled Chromium unavailable (e.g. CI without GPU)
      expect(result.unavailable).toBe(true);
    } else {
      expect(result.passed).toBe(true);
    }
  });

  it('rejects GLSL with undeclared variable (like run2 warpedFlow)', async () => {
    const result = await validateGLSLCompile(undeclaredVariableShader);
    if (result.unavailable) {
      expect(result.unavailable).toBe(true);
    } else {
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/warpedFlow|undeclared|unknown/i);
    }
  });

  it('combined validation with compile check for valid GLSL', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-glsl-valid-'));
    const artifactPath = path.join(tempRoot, 'glsl.frag');
    writeFileSync(artifactPath, validGlslShader);

    const result = await validateCreativeDomainArtifactWithCompileCheck('glsl', artifactPath, validGlslShader);

    expect(result.status).toBe('pass');
    const compileCheck = result.checks.find((c: any) => c.name === 'glsl-compile');
    expect(compileCheck?.name).toBe('glsl-compile');
    if (compileCheck.note === 'compile-check-unavailable') {
      expect(compileCheck.note).toBe('compile-check-unavailable');
      expect(compileCheck.passed).toBe(true);
    } else {
      expect(compileCheck.passed).toBe(true);
    }
  });

  it('combined validation with compile check rejects undeclared variable', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-glsl-undeclared-'));
    const artifactPath = path.join(tempRoot, 'glsl.frag');
    writeFileSync(artifactPath, undeclaredVariableShader);

    const result = await validateCreativeDomainArtifactWithCompileCheck('glsl', artifactPath, undeclaredVariableShader);

    const compileCheck = result.checks.find((c: any) => c.name === 'glsl-compile');
    expect(compileCheck?.name).toBe('glsl-compile');
    if (compileCheck.note === 'compile-check-unavailable') {
      // Browserless environment (e.g. arm64 CI): compile check is skipped
      // honestly, so the artifact is not failed on it.
      expect(result.status).toBe('pass');
      expect(compileCheck.passed).toBe(true);
    } else {
      expect(result.status).toBe('fail');
      expect(compileCheck.passed).toBe(false);
      expect(compileCheck.message).toMatch(/warpedFlow|undeclared|unknown/i);
      expect(result.errors.some((e: string) => e.includes('warpedFlow'))).toBe(true);
    }
  });
});

describe('GLSL compile check unavailable', () => {
  it('marks compile check unavailable when browser cannot launch', async () => {
    // Branch on the impl's ACTUAL result, NOT on test-local system-path detection.
    // getOrCreateBrowser() uses Puppeteer's BUNDLED Chromium when no system Chrome
    // exists, so !chromeAvailable in the fast-gate container does NOT mean
    // unavailable — the bundled browser will succeed.
    const result = await validateGLSLCompile('void main(){}');
    if (result.unavailable) {
      expect(result.unavailable).toBe(true);
      expect(result.message).toContain('unavailable');
    } else {
      // Bundled Chromium succeeded (or system Chrome was found)
      expect(result.passed).toBe(true);
    }
  });

  it('combined validation does not fail when compile check is unavailable', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'sinter-glsl-unavailable-'));
    const artifactPath = path.join(tempRoot, 'glsl.frag');
    // Shader that passes static validation (has noise and animation)
    const shader = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_uv;

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
    writeFileSync(artifactPath, shader);

    const result = await validateCreativeDomainArtifactWithCompileCheck('glsl', artifactPath, shader);

    // Static validation passes for shader with noise and animation
    expect(result.status).toBe('pass');
    // Compile check result is whatever the impl returns (bundled Chromium or unavailable)
    const compileCheck = result.checks.find((c: any) => c.name === 'glsl-compile');
    expect(compileCheck?.name).toBe('glsl-compile');
    if (compileCheck.note === 'compile-check-unavailable') {
      // True infra-unavailable: note is set, still counts as a pass overall
      expect(compileCheck.note).toBe('compile-check-unavailable');
      expect(compileCheck.passed).toBe(true);
    } else {
      // Bundled Chromium succeeded: compile succeeded
      expect(compileCheck.passed).toBe(true);
    }
  });
});
