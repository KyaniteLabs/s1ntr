/**
 * LibraryPromptSection v2 — domain-aware card sampling + worked declaration
 * example (#1072 plan, PE-2 half). The v1 section was ignored by 12/12
 * card-bearing generations; v2 makes the offer relevant and demonstrates the
 * exact declaration the parser (LibraryIntent) expects.
 */
import { describe, it, expect } from 'vitest';
import { brainHint } from '../../../src/runtime-core/LiminalProductionEffects.js';
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

  it('offers holospot for three (foil materials card)', () => {
    const s = libraryPromptSection(Math.random, 'three');
    expect(s).toContain('holospot');
    expect(s).toContain('import { Holo } from "holospot"');
  });

  it('aliases shader to the glsl preferences', () => {
    const s = libraryPromptSection(seq(...frac(4)), 'shader');
    expect(s).toContain('sinter-glsl');
    expect(s).toContain('#include <sinter/noise>');
    expect(s).not.toContain('twgl');
    expect(libraryPromptSection(Math.random, 'glsl')).toContain('sinter-glsl');
  });

  it('falls back to the full pool for domains without preferences', () => {
    const s = libraryPromptSection(seq(...frac(4)), 'dataviz-unlisted');
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

  it('shows each offered card\'s worked calls so the model uses the real API (holospot: holo.render, never update)', () => {
    const s = libraryPromptSection(Math.random, 'three');
    const holo = s.split('\n- ').find(l => l.startsWith('holospot ('));
    expect(holo).toMatch(/^holospot \(/);
    expect(holo).toContain('calls: ');
    expect(holo).toContain('holo.render(scene, camera)');
    expect(holo).toContain('holo.apply(mesh, { material: "nebula"');
  });

  it('renders the holospot card\'s composition rules (kit best practices) after the calls', () => {
    const s = libraryPromptSection(Math.random, 'three');
    const holo = s.split('\n- ').find(l => l.startsWith('holospot ('));
    expect(holo).toContain('rules: ');
    // the rules the holospot audit found broken in all four wall pieces
    expect(holo).toContain('replace mode');
    expect(holo).toContain('shotCamera');
    expect(holo).toContain('studio.preset');
    expect(holo).toContain('holo.render');
    expect(holo).toContain('iridescence');
    expect(holo).toContain('sizeMm');
    // rules render inside the card block (same continuation shape as calls), not as a new card line
    expect(s.split('\n- ').some(l => l.trim().startsWith('rules:'))).toBe(false);
  });
});

describe('libraryPromptSection brief cues and domain gating', () => {
  it('promotes a domain card the brief cues even from the dead tail', () => {
    const s = libraryPromptSection(Math.random, 'three', 'raycast picking on a dense mesh with a bvh');
    expect(s).toContain('three-mesh-bvh');
  });
  it('does not offer three-only cards to other domains', () => {
    for (let i = 0; i < 40; i++) expect(libraryPromptSection(Math.random, 'p5', 'raycast bvh')).not.toContain('three-mesh-bvh');
  });
  it('a brief without cues leaves the offer unchanged', () => {
    const a = libraryPromptSection(seq(...frac(4)), 'three');
    const b = libraryPromptSection(seq(...frac(4)), 'three', 'a quiet field of fog');
    expect(b).toBe(a);
  });
  it('custom gets the same preferred list as meta', () => {
    const c = libraryPromptSection(seq(...frac(4)), 'custom');
    const m = libraryPromptSection(seq(...frac(4)), 'meta');
    expect(c).toBe(m);
  });
});

describe('kit cards and text domains', () => {
  it('offers no JS library card to text and Python domains', () => {
    for (const d of ['ascii', 'textgen', 'blender']) expect(libraryPromptSection(Math.random, d, 'crt flow particles')).toBe('');
  });
  it.each([
    ['p5', 'a crt scanline phosphor terminal', 'sinter-look'],
    ['p5', 'flow field of particles', 'sinter-flow'],
    ['tone', 'euclid polyrhythm', 'sinter-music'],
    ['strudel', 'verse chorus structure', 'sinter-music'],
    ['hydra', 'film grain retro monitor', 'sinter-look'],
  ])('%s: brief "%s" promotes %s', (domain, brief, id) => {
    expect(libraryPromptSection(Math.random, domain, brief)).toContain(`- ${id} (`);
  });
  it('kit cards stay out of unrelated domains', () => {
    for (let i = 0; i < 40; i++) expect(libraryPromptSection(Math.random, 'svg', 'crt flow')).not.toMatch(/- sinter-(look|flow|music) \(/);
  });

  it('offers no library cards to NBE, and meta and custom share one preference list (Sol G16)', () => {
    expect(libraryPromptSection(() => 0.1, 'nbe')).toBe('');
    expect(libraryPromptSection(() => 0.1, 'meta', 'plain brief')).toBe(libraryPromptSection(() => 0.1, 'custom', 'plain brief'));
  });

  it('glsl and shader get the same technique hint (Sol G16)', () => {
    const shader = brainHint('shader', () => 0);
    expect(shader).not.toBe('');
    expect(brainHint('glsl', () => 0)).toBe(shader);
  });
});
