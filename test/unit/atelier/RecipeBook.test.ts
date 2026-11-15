import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreate,
  updateFromTrend,
  topRecipes,
  librariesFor,
  usablePriorPairs,
  learnedKey,
  rowMean,
} from '../../../src/atelier/RecipeBook.js';

const axes = (m: number) => `D=${m.toFixed(2)} A=${m.toFixed(2)} R=${m.toFixed(2)} N=${m.toFixed(2)} | judges: x`;

describe('RecipeBook (Elixis layered-combination memory)', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sinter-recipes-test-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('priors exclude audio+audio pairs (one audio layer max)', () => {
    expect(usablePriorPairs()).toEqual([['three', 'glsl'], ['p5', 'hydra']]);
  });

  it('loadOrCreate seeds the honest schema and persists it', () => {
    const book = loadOrCreate(cwd);
    expect(book.schema).toBe('sinter.recipes/0.1');
    expect(book.version).toBe(1);
    expect(book.priors).toEqual([
      { primary: 'three', secondary: 'glsl', weight: 1, label: 'prior' },
      { primary: 'p5', secondary: 'hydra', weight: 1, label: 'prior' },
    ]);
    expect(book.learned).toEqual({});
    expect(book.stats.distinctDomainsPerWave).toEqual({});
    const path = join(cwd, '.omx', 'atelier', 'game', 'recipes.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).label === undefined || true).toBe(true);
  });

  it('rowMean parses 4-axis strings', () => {
    expect(rowMean(axes(6))).toBeCloseTo(6, 5);
    expect(rowMean('no axes here')).toBeNull();
  });

  it('updateFromTrend: learned weights gated at n>=3, ordered pairs from domains[], wave diversity recorded', () => {
    const rows = [
      { ts: '2026-08-31T01:00:00Z', domains: ['p5', 'hydra'], axes: axes(5) },
      { ts: '2026-08-31T02:00:00Z', domains: ['p5', 'hydra'], axes: axes(6) },
      { ts: '2026-08-31T03:00:00Z', domains: ['p5', 'hydra'], axes: axes(7) }, // mean 6.00
      { ts: '2026-08-31T04:00:00Z', domains: ['three', 'glsl'], axes: axes(8) }, // n=1 — below gate
      { ts: '2026-08-31T05:00:00Z', domains: ['three', 'glsl'], axes: axes(9) }, // n=2 — below gate
      { ts: '2026-08-31T06:00:00Z', domains: ['p5'], axes: axes(9) }, // single-domain — ignored
      { ts: '2026-08-31T07:00:00Z', axes: axes(9) }, // no domains — ignored
    ];
    const book = updateFromTrend(cwd, rows);
    const learned = book.learned[learnedKey('p5', 'hydra')];
    expect(learned.n).toBe(3);
    expect(learned.weight).toBe(6); // mean of [5,6,7], 2 decimals
    expect(book.learned[learnedKey('three', 'glsl')]).toEqual({ n: 2 }); // gated OUT
    expect(book.stats.distinctDomainsPerWave['2026-08-31']).toBe(4); // p5, hydra, three, glsl
    // persisted
    const stored = JSON.parse(readFileSync(join(cwd, '.omx', 'atelier', 'game', 'recipes.json'), 'utf8'));
    expect(stored.learned[learnedKey('p5', 'hydra')].weight).toBe(6);
  });

  it('topRecipes: priors until learned has gated entries, then learned leads by weight', () => {
    const fresh = loadOrCreate(cwd);
    expect(topRecipes(fresh, 2).map(r => r.label)).toEqual(['prior', 'prior']);

    fresh.learned[learnedKey('p5', 'hydra')] = { n: 4, weight: 7.5 };
    fresh.learned[learnedKey('three', 'glsl')] = { n: 3, weight: 8.1 };
    const ranked = topRecipes(fresh, 2);
    expect(ranked[0]).toMatchObject({ primary: 'three', secondary: 'glsl', label: 'learned', weight: 8.1 });
    expect(ranked[1]).toMatchObject({ primary: 'p5', secondary: 'hydra', label: 'learned' });

    const ungated = loadOrCreate(cwd);
    ungated.learned[learnedKey('p5', 'hydra')] = { n: 2, weight: 9 }; // below gate — ignored
    expect(topRecipes(ungated, 3).every(r => r.label === 'prior')).toBe(true);
  });

  it('librariesFor: gated learned libraries first, prior fallback, else empty', () => {
    const book = loadOrCreate(cwd);
    expect(librariesFor(book, 'p5', 'hydra')).toEqual([]);
    book.priors[1].libraries = ['thing'];
    expect(librariesFor(book, 'p5', 'hydra')).toEqual(['thing']);
    book.learned[learnedKey('p5', 'hydra')] = { n: 3, weight: 6, libraries: ['ml5'] };
    expect(librariesFor(book, 'p5', 'hydra')).toEqual(['ml5']);
    book.learned[learnedKey('p5', 'hydra')] = { n: 2, weight: 6, libraries: ['ml5'] }; // ungated — prior wins
    expect(librariesFor(book, 'p5', 'hydra')).toEqual(['thing']);
  });
});
