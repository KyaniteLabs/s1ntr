import { afterAll, describe, expect, it } from 'vitest';

import { ShaderGenerator } from '../../src/generators/glsl/ShaderGenerator.js';
import { browserShutdown, checkGLSLCompile, getOrCreateBrowser } from '../../src/utils/glsl-compile-check.js';
import { normalizeGLSLDialect } from '../../src/generators/glsl/GLSLNormalizer.js';

// Real headless-Chrome compile through the repo's own compile path. Skips
// (loudly) when Chrome/WebGL is unavailable, like the validator's
// infra-unavailable branch.
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

describe('derivative shader real compile (headless Chrome)', () => {
  afterAll(async () => { await browserShutdown(); });

  it('raw ES 1.00 fails; the normalized shader compiles', async () => {
    const raw = await checkGLSLCompile(VORONOI_LIKE);
    if (raw.status === 'infra-unavailable') {
      console.warn(`SKIP real compile: ${raw.error}`);
      return;
    }
    expect(raw.status).toBe('compile-error');
    expect(raw.error).toMatch(/fwidth|GL_OES_standard_derivatives/);

    const normalized = normalizeGLSLDialect(VORONOI_LIKE).code;
    const fixed = await checkGLSLCompile(normalized);
    expect({ status: fixed.status, error: fixed.error }).toEqual({ status: 'pass', error: undefined });

    // WebGL1 branch: extension line first, harness requests the extension.
    const webgl1 = await checkGLSLCompile(normalizeGLSLDialect(VORONOI_LIKE, { webgl2: false }).code);
    expect({ status: webgl1.status, error: webgl1.error }).toEqual({ status: 'pass', error: undefined });
  }, 60_000);

  it('the gallery page (wrapForGallery) boots with no shader error', async () => {
    const browser = await getOrCreateBrowser();
    if (!browser) {
      console.warn('SKIP gallery boot: Chrome unavailable');
      return;
    }
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await page.setContent(new ShaderGenerator().wrapForGallery(VORONOI_LIKE));
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await page.close();
    }
    expect(errors).toEqual([]);
  }, 60_000);
});
