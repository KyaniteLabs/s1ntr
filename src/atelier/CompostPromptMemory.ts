import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Seed } from '../compost/types.js';
import { SeedSchema } from '../security/JsonSchemas.js';
import { formatSeedForPrompt } from '../core/lir/LIRPromptFormatter.js';

export const DEFAULT_SEED_K = 2;

function turnRng(turn: number): () => number {
  let state = (turn ^ 0x9e3779b9) >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0;
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0;
    return ((state ^ (state >>> 16)) >>> 0) / 0x100000000;
  };
}

export function readSeeds(cwd: string): Seed[] {
  const file = join(cwd, '.sinter', 'compost', 'seeds', 'seeds.json');
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const result = SeedSchema.array().safeParse(parsed);
    return result.success ? result.data : [];
  } catch { return []; }
}

export function sampleSeeds(seeds: Seed[], k: number, turn: number): Seed[] {
  if (k <= 0 || seeds.length === 0) return [];
  const pool = [...seeds];
  const random = turnRng(turn);
  const result: Seed[] = [];
  while (pool.length > 0 && result.length < k) {
    result.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return result;
}

export function injectSeedMotifs(prompt: string, cwd: string, turn: number, k = DEFAULT_SEED_K): string {
  const seeds = sampleSeeds(readSeeds(cwd), k, turn);
  if (seeds.length === 0) return prompt;
  const motifs = seeds.map(seed => `[seed:${seed.id}] ${formatSeedForPrompt(seed, 500)}`);
  return `${prompt}\n\n---\nCreative seed motifs from compost:\n${motifs.join('\n')}`;
}

export function promptMetrics(prompt: string, seedIds: string[] = []): { length: number; motifHits: number; uniqueWords: number } {
  const words = prompt.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  return { length: prompt.length, motifHits: seedIds.filter(id => prompt.includes(`[seed:${id}]`)).length, uniqueWords: new Set(words).size };
}
