import { describe, expect, it } from 'vitest';
import { renderKitPiece } from './kitRender.js';

const CODE = `precision mediump float;
uniform float u_time; uniform vec2 u_resolution;
#include <sinter/warp>
#include <sinter/palette>
#include <sinter/sdf>
#include <sinter/crt>
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = sn_warp((uv - 0.5) * 3.0, u_time);
  float f = sn_fbm(p);
  float ring = sn_fill(sn_sdRing(uv - 0.5, 0.25, 0.04), 0.01);
  vec3 col = sn_pal(f + u_time * 0.05) * (0.4 + 0.6 * f) + ring * 0.5;
  gl_FragColor = vec4(sn_crt(col, uv, u_resolution, u_time), 1.0);
}`;

describe('sinter GLSL chunks through the real harness', () => {
  it('a shader using every chunk compiles and renders non-blank', async () => {
    const { result, analysis } = await renderKitPiece(CODE, 'glsl', []);
    expect(result.success, result.error).toBe(true);
    expect(result.logs.join('\n')).not.toMatch(/compile error/i);
    expect(analysis?.hasVisibleContent).toBe(true);
    expect(analysis?.uniqueColors).toBeGreaterThan(50);
  }, 90_000);
});
