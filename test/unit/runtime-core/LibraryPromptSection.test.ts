/**
 * LibraryPromptSection v2 — domain-aware card sampling + worked declaration
 * example (#1072 plan, PE-2 half). The v1 section was ignored by 12/12
 * card-bearing generations; v2 makes the offer relevant and demonstrates the
 * exact declaration the parser (LibraryIntent) expects.
 */
import { describe, it, expect } from 'vitest';
import { libraryPromptSection } from '../../../src/runtime-core/LibraryPromptSection.js';

const frac = (n: number) => Array.from({ length: n }, (_, k) => 0.1 + (0.8 * k) / n);
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('libraryPromptSection v2', () => {
  it('ALWAYS offers the domain-preferred cards for strudel (tonaljs + thing, any rng)', () => {
    for (let k = 0; k < 20; k++) {
      const s = libraryPromptSection(Math.random, 'strudel');
      expect(s).toContain('tonaljs');
      expect(s).toContain('thing');
    }
  });

  it('offers three-addon family for three in rank order (all 4 deterministic slots)', () => {
    const s = libraryPromptSection(Math.random, 'three');
    expect(s).toContain('three-webgpu');
    expect(s).toContain('three-tsl');
    expect(s).toContain('three-gpu-pathtracer');
    expect(s).not.toContain('tonaljs');
  });

  it('aliases shader to the glsl preferences', () => {
    const s = libraryPromptSection(seq(...frac(4)), 'shader');
    expect(s).toContain('twgl');
  });

  it('falls back to the full pool for domains without preferences', () => {
    const s = libraryPromptSection(seq(...frac(4)), 'ascii');
    expect(s.length).toBeGreaterThan(200);
    expect(s).toContain('OPTIONAL LIBRARY CAPABILITIES');
  });

  it('keeps the exact declaration instruction and adds a worked example', () => {
    const s = libraryPromptSection(Math.random, 'p5');
    expect(s).toContain('END YOUR RESPONSE with this exact line AFTER the closing code fence');
    expect(s).toMatch(/EXAMPLE[^\n]*culori[\s\S]*libraries: culori/);
  });

  it('backward compatible: no-arg and rng-only calls still return a section', () => {
    expect(libraryPromptSection()).toContain('OPTIONAL LIBRARY CAPABILITIES');
    expect(libraryPromptSection(seq(...frac(4)))).toContain('- ');
  });

  it('samples without replacement (no duplicated card lines)', () => {
    const s = libraryPromptSection(seq(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5), 'p5');
    const ids = [...s.matchAll(/^- ([a-z0-9-]+) \(/gm)].map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
