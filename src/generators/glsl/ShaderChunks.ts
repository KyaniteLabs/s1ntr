/**
 * Sinter GLSL chunk kit: small tested building blocks a fragment shader pulls
 * in with `#include <sinter/NAME>`. GLSL ES 1.00 (WebGL1) so they compile in
 * the same wrapper every shader goes through. Own code, no third-party text.
 * Only expanded when a shader writes the include; any other shader is
 * byte-for-byte unchanged.
 */

interface Chunk { readonly requires: readonly string[]; readonly src: string }

export const SHADER_CHUNKS: Readonly<Record<string, Chunk>> = {
  noise: { requires: [], src: `
float sn_hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sn_vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sn_hash21(i), sn_hash21(i + vec2(1.0, 0.0)), f.x),
             mix(sn_hash21(i + vec2(0.0, 1.0)), sn_hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float sn_fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * sn_vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}` },
  warp: { requires: ['noise'], src: `
vec2 sn_warp(vec2 p, float t) {
  vec2 q = vec2(sn_fbm(p + vec2(0.0, t * 0.1)), sn_fbm(p + vec2(5.2, 1.3 - t * 0.1)));
  return p + 2.0 * vec2(sn_fbm(p + 3.0 * q + vec2(1.7, 9.2)), sn_fbm(p + 3.0 * q + vec2(8.3, 2.8)));
}` },
  palette: { requires: [], src: `
vec3 sn_palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(6.28318 * (c * t + d)); }
vec3 sn_pal(float t) { return sn_palette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67)); }` },
  sdf: { requires: [], src: `
float sn_sdCircle(vec2 p, float r) { return length(p) - r; }
float sn_sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sn_sdRing(vec2 p, float r, float w) { return abs(length(p) - r) - w; }
float sn_smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float sn_fill(float d, float edge) { return 1.0 - smoothstep(0.0, edge, d); }` },
  crt: { requires: ['noise'], src: `
vec3 sn_crt(vec3 col, vec2 uv, vec2 res, float t) {
  float scan = 0.82 + 0.18 * sin(uv.y * res.y * 3.14159);
  vec3 mask = 0.88 + 0.12 * vec3(sin(uv.x * res.x * 2.094), sin(uv.x * res.x * 2.094 + 2.094), sin(uv.x * res.x * 2.094 + 4.189));
  vec2 c = uv - 0.5;
  float vig = 1.0 - dot(c, c) * 1.4;
  float grain = (sn_hash21(uv * res + fract(t) * 91.7) - 0.5) * 0.06;
  return clamp(col * scan * mask * vig + grain, 0.0, 1.0);
}` },
};

export const SHADER_CHUNK_NAMES = Object.keys(SHADER_CHUNKS);

const INCLUDE_RE = /^[ \t]*#include\s*<sinter\/([a-z0-9-]+)>[ \t]*$/gm;

/** Expand `#include <sinter/NAME>` lines (each chunk and its requirements once). */
export function expandShaderChunks(code: string): string {
  if (!code.includes('#include')) return code;
  const emitted = new Set<string>();
  const emit = (name: string): string => {
    if (emitted.has(name)) return '';
    const chunk = SHADER_CHUNKS[name];
    if (!chunk) return `// unknown sinter chunk: ${name}\n`;
    emitted.add(name);
    return chunk.requires.map(emit).join('') + `// sinter/${name}\n${chunk.src.trim()}\n`;
  };
  return code.replace(INCLUDE_RE, (_m, name: string) => emit(name));
}
