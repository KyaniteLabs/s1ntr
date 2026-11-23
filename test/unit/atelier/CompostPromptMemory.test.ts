import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptOrgan } from '../../../src/atelier/PromptOrgan.js';
import { injectSeedMotifs, sampleSeeds } from '../../../src/atelier/CompostPromptMemory.js';
import type { Seed } from '../../../src/compost/types.js';

const seed = (id: string): Seed => ({ id, content: id, score: 1,
  source: { fragments: [], collisionType: 'test', domains: [] },
  promotedAt: new Date(0).toISOString(), usedBy: [], useCount: 0 });

describe('compost prompt memory sampler', () => {
  const seeds = Array.from({ length: 8 }, (_, i) => seed(`seed-${i}`));

  it('is reproducible for the same turn', () => {
    expect(sampleSeeds(seeds, 2, 17).map(s => s.id)).toEqual(sampleSeeds(seeds, 2, 17).map(s => s.id));
  });

  it('samples without replacement and respects k', () => {
    const result = sampleSeeds(seeds, 4, 3);
    expect(result).toHaveLength(4);
    expect(new Set(result.map(s => s.id)).size).toBe(4);
  });
});

describe('compost seed budget', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'compost-budget-'));
    const dir = join(cwd, '.sinter', 'compost', 'seeds');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seeds.json'), JSON.stringify(Array.from({ length: 8 }, (_, i) => seed(`motif-${i}`))));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    ['0', 0], ['-1', 0], ['1', 1], ['3.8', 3], ['99', 4],
    ['', 2], ['invalid', 2], ['Infinity', 2],
  ] as const)('uses the configured budget %j for a generated prompt', (configured, expected) => {
    vi.stubEnv('SINTER_COMPOST_SEEDS_K', configured);
    const { text } = new PromptOrgan(cwd, 17).next();
    expect(text.match(/\[seed:motif-\d+\]/g) ?? []).toHaveLength(expected);
  });

  it('caps an explicit budget and leaves a disabled prompt intact', () => {
    expect(injectSeedMotifs('plain', cwd, 3, 100).match(/\[seed:motif-\d+\]/g)).toHaveLength(4);
    expect(injectSeedMotifs('plain', cwd, 3, 0)).toBe('plain');
  });
});
