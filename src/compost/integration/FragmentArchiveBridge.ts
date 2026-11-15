/**
 * FragmentArchiveBridge — bridges compost seeds to/from FragmentArchive.
 */

import type { Seed, CompostFragment } from '../types.js';
import { SeedBank } from '../SeedBank.js';
import { compostContentDigest } from '../CompostProvenance.js';

export class FragmentArchiveBridge {
  /** Convert seeds to fragment format for FragmentArchive. */
  getSeedsAsFragments(seeds: Seed[]): CompostFragment[] {
    return seeds.map(seed => ({
      id: seed.id,
      source: `seed:${seed.id}`,
      domain: seed.source.domains[0] ?? 'unknown',
      layer: 'semantic' as const,
      content: seed.content,
      metadata: {
        fileType: 'seed',
        timestamp: seed.promotedAt,
        hash: compostContentDigest(seed.content),
        size: seed.content.length,
        extractedAt: seed.promotedAt,
      },
      tags: [...seed.source.domains, 'seed', seed.source.collisionType],
      score: seed.score,
      provenance: seed.provenance,
    }));
  }

  /** Exploration seeds cannot be promoted into prompt teaching. */
  getRandomSeedAsPromptSeed(_seedBank: SeedBank): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  /** Sync seeds from seed bank into a fragment archive (data only). */
  async syncSeeds(seedBank: SeedBank, fragments: CompostFragment[]): Promise<number> {
    const seeds = await seedBank.getAll();
    const seedFragments = this.getSeedsAsFragments(seeds);
    const existingIds = new Set(fragments.map(f => f.id));
    let added = 0;

    for (const frag of seedFragments) {
      if (!existingIds.has(frag.id)) {
        fragments.push(frag);
        added++;
      }
    }

    return added;
  }
}
