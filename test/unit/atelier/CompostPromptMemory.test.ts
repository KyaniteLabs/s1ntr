import { describe, expect, it } from 'vitest';
import { sampleSeeds } from '../../../src/atelier/CompostPromptMemory.js';
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
