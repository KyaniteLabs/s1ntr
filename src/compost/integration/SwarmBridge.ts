/**
 * SwarmBridge — bridges compost seeds into the swarm pipeline.
 */

import type { Seed } from '../types.js';
import { SeedBank } from '../SeedBank.js';

export class SwarmBridge {
  /** Exploration seeds cannot be promoted into swarm teaching. */
  getSeedForSwarm(_seedBank: SeedBank): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  /** Get seeds filtered by source domain. */
  async getSeedsByDomain(seedBank: SeedBank, domain: string): Promise<Seed[]> {
    return seedBank.getByDomain(domain);
  }

  /** Get all available seeds sorted by score. */
  async getAllSeeds(seedBank: SeedBank): Promise<Seed[]> {
    return seedBank.getAll();
  }
}
