/**
 * RecipeBook — Elixis layered-combination recipe memory (PRD 2026-09-01
 * item C). Pairs of art forms worth combining, with HONEST priors: the
 * static starting pairs are labeled `prior` and weighted 1 (a prior, not
 * evidence); learned weights only appear once a pair has n>=3 scored rows,
 * as the mean of those rows' 4-axis means (2 decimals). Diversity telemetry
 * (distinct domains per wave) accumulates in stats for the auto-disable and
 * the wave reports.
 *
 * State: .omx/atelier/game/recipes.json (atomic). All functions are
 * load-modify-save over the whole file — no partial writes, no backfills.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import { Logger } from '../utils/Logger.js';

/** Static starting pairs (CEO direction). (strudel,tone) is audio+audio and
 *  is filtered out by usablePriorPairs — ONE audio layer max. */
export const PRIOR_PAIRS: Array<[string, string]> = [
  ['three', 'glsl'],
  ['p5', 'hydra'],
  ['strudel', 'tone'],
];

const AUDIO_DOMAINS = new Set(['strudel', 'tone', 'audio']);

/** Priors that respect the one-audio-layer-max rule. */
export function usablePriorPairs(): Array<[string, string]> {
  return PRIOR_PAIRS.filter(([a, b]) => !(AUDIO_DOMAINS.has(a) && AUDIO_DOMAINS.has(b)));
}

export interface RecipePair {
  primary: string;
  secondary: string;
  weight: number;
  label: 'prior';
  libraries?: string[];
}

export interface LearnedRecipe {
  n: number;
  /** Mean of the rows' 4-axis means, 2 decimals. Present only at n>=3. */
  weight?: number;
  /** Library ids seen declared on this pair's rows (forward-compatible). */
  libraries?: string[];
}

export interface RecipesFile {
  schema: 'sinter.recipes/0.1';
  version: 1;
  priors: RecipePair[];
  learned: Record<string, LearnedRecipe>;
  stats: { distinctDomainsPerWave: Record<string, number> };
}

/** Trend row shape we read (subset — sss-score's artifact_scored envelope). */
export interface TrendRowLike {
  ts?: string;
  domain?: string;
  domains?: string[];
  axes?: string;
  libraries?: string[];
}

const RECIPES = (cwd: string) => join(cwd, '.omx', 'atelier', 'game', 'recipes.json');

/** Load recipes.json, creating the seeded file when absent. */
export function loadOrCreate(cwd: string): RecipesFile {
  try {
    const parsed = JSON.parse(readFileSync(RECIPES(cwd), 'utf8')) as RecipesFile;
    if (parsed && parsed.schema === 'sinter.recipes/0.1') return parsed;
  } catch (err) {
    // ENOENT: first run, reseed below. A torn file is reseeded too, which discards learned recipes.
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') Logger.warn('RecipeBook', `recipes.json unreadable (reseeding, learned recipes lost): ${RECIPES(cwd)}:`, err);
  }
  const fresh: RecipesFile = {
    schema: 'sinter.recipes/0.1',
    version: 1,
    priors: usablePriorPairs().map(([primary, secondary]) => ({ primary, secondary, weight: 1, label: 'prior' as const })),
    learned: {},
    stats: { distinctDomainsPerWave: {} },
  };
  save(cwd, fresh);
  return fresh;
}

function save(cwd: string, book: RecipesFile): void {
  mkdirSync(join(cwd, '.omx', 'atelier', 'game'), { recursive: true });
  writeAtomicSync(RECIPES(cwd), JSON.stringify(book, null, 1));
}

/** 4-axis mean from a `D=x A=y R=z N=w ...` axes string, or null. */
export function rowMean(axes?: string): number | null {
  const m = /D=([\d.]+) A=([\d.]+) R=([\d.]+) N=([\d.]+)/.exec(axes ?? '');
  if (!m) return null;
  return m.slice(1).map(Number).reduce((a, b) => a + b, 0) / 4;
}

export function learnedKey(primary: string, secondary: string): string {
  return `${primary}>${secondary}`;
}

/**
 * Re-derive learned weights and wave diversity from scored trend rows and
 * persist. A row counts toward a pair only when it carries a domains array of
 * >=2 entries; the pair is ORDERED (primary = domains[0]). Learned weights
 * stay gated at n>=3 (mean of row means, 2 decimals).
 */
export function updateFromTrend(cwd: string, trendRows: TrendRowLike[]): RecipesFile {
  const book = loadOrCreate(cwd);
  const tally = new Map<string, { primary: string; secondary: string; means: number[]; libraries: Set<string> }>();
  const waveDomains = new Map<string, Set<string>>();
  for (const row of trendRows) {
    const domains = Array.isArray(row?.domains) ? row.domains.filter(d => typeof d === 'string' && d) : [];
    if (domains.length < 2) continue;
    const mean = rowMean(row.axes);
    if (mean === null) continue;
    const [primary, secondary] = domains;
    const key = learnedKey(primary, secondary);
    if (!tally.has(key)) tally.set(key, { primary, secondary, means: [], libraries: new Set() });
    const entry = tally.get(key)!;
    entry.means.push(mean);
    for (const lib of Array.isArray(row.libraries) ? row.libraries : []) {
      if (typeof lib === 'string' && lib) entry.libraries.add(lib);
    }
    const wave = (row.ts ?? '').slice(0, 10);
    if (wave) {
      if (!waveDomains.has(wave)) waveDomains.set(wave, new Set());
      for (const d of domains) waveDomains.get(wave)!.add(d);
    }
  }
  const learned: Record<string, LearnedRecipe> = {};
  for (const [key, entry] of tally) {
    const rec: LearnedRecipe = { n: entry.means.length };
    if (entry.means.length >= 3) {
      const mean = entry.means.reduce((a, b) => a + b, 0) / entry.means.length;
      rec.weight = Math.round(mean * 100) / 100;
    }
    if (entry.libraries.size > 0) rec.libraries = [...entry.libraries];
    learned[key] = rec;
  }
  book.learned = learned;
  const distinctPerWave: Record<string, number> = {};
  for (const [wave, set] of waveDomains) distinctPerWave[wave] = set.size;
  book.stats.distinctDomainsPerWave = distinctPerWave;
  save(cwd, book);
  return book;
}

export interface RankedRecipe {
  primary: string;
  secondary: string;
  weight: number;
  label: 'prior' | 'learned';
  libraries?: string[];
}

/** Top-n recipes: learned pairs (n>=3) by weight desc first; priors fill the
 *  rest in static order — so the list IS priors until learned has entries. */
export function topRecipes(book: RecipesFile, n: number): RankedRecipe[] {
  const learnedRanked: RankedRecipe[] = Object.entries(book.learned)
    .filter(([, rec]) => (rec.n ?? 0) >= 3 && typeof rec.weight === 'number')
    .map(([key, rec]) => {
      const [primary, secondary] = key.split('>');
      return { primary, secondary, weight: rec.weight!, label: 'learned' as const, libraries: rec.libraries };
    })
    .sort((a, b) => b.weight - a.weight);
  const priorRanked: RankedRecipe[] = book.priors.map(p => ({
    primary: p.primary, secondary: p.secondary, weight: p.weight, label: 'prior' as const, libraries: p.libraries,
  }));
  return [...learnedRanked, ...priorRanked].slice(0, Math.max(0, n));
}

/** Library ids known for a pair (learned first, then the prior), for filling
 *  the `layers: primary[id] secondary[id]` declaration brackets. */
export function librariesFor(book: RecipesFile, primary: string, secondary: string): string[] {
  const learned = book.learned[learnedKey(primary, secondary)];
  if (learned && (learned.n ?? 0) >= 3 && Array.isArray(learned.libraries) && learned.libraries.length > 0) {
    return learned.libraries;
  }
  const prior = book.priors.find(p => p.primary === primary && p.secondary === secondary);
  if (prior && Array.isArray(prior.libraries) && prior.libraries.length > 0) return prior.libraries;
  return [];
}
