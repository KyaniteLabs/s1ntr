import { createHash } from 'node:crypto';

/** What an accepted parent artifact does, read from its source (F09). Pure and deterministic: no model call. */
export interface ParentTechnique {
  readonly cues: readonly string[];
  readonly statement: string;
  readonly digest: string;
}

const CUES: ReadonlyArray<readonly [string, RegExp]> = [
  ['webgl-shader', /\b(gl_FragColor|gl_Position|getContext\(\s*['"]webgl2?['"]|precision\s+(?:high|medium|low)p)/i],
  ['canvas-2d', /getContext\(\s*['"]2d['"]/i],
  ['svg-filters', /<fe(?:Turbulence|DisplacementMap|GaussianBlur|ColorMatrix)\b/i],
  ['css-3d-transform', /\b(?:perspective\s*[:(]|translateZ\(|rotate[XY3]\()/i],
  ['blend-modes', /\b(?:mix-blend-mode|globalCompositeOperation)\b/i],
  ['layered-parallax', /\b(?:parallax|z-index\s*:|layers?\s*[[=.])/i],
  ['animation-loop', /\b(?:requestAnimationFrame|@keyframes|setInterval)\b/i],
  ['noise-field', /\b(?:noise\s*\(|simplex|perlin|fbm\s*\()/i],
  ['particle-system', /\bparticles?\b/i],
  ['palette-discipline', /(?:hsl\(|oklch\(|palette\s*[=:])/i],
];

export function extractParentTechnique(source: string): ParentTechnique {
  const cues = CUES.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
  const statement = cues.length
    ? `the accepted parent's technique: ${cues.join(' + ')}`
    : 'the accepted parent artifact (no recognised technique cue)';
  return Object.freeze({ cues: Object.freeze(cues), statement,
    digest: createHash('sha256').update(JSON.stringify({ cues })).digest('hex') });
}
