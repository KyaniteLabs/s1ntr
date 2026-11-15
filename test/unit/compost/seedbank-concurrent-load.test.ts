/**
 * Regression: SeedBank.ensureLoaded() flipped `loaded = true` before its awaits,
 * so a concurrent add() ran before the disk load finished and the load then
 * overwrote this.seeds, dropping the added seed.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { SeedBank } from '../../../src/compost/SeedBank.js';
import type { CompostConfig, Seed } from '../../../src/compost/types.js';

function makeConfig(seedDir: string): CompostConfig {
  return {
    heapDir: path.join(seedDir, 'heap'),
    maxHeapSizeBytes: 10_000_000,
    digestDir: path.join(seedDir, 'digest'),
    seedDir,
    digestSchedule: 'manual',
    digestDayOfWeek: 1,
    soupEnabled: false,
    soupPopulationSize: 10,
    soupMaxStepsPerCycle: 5,
    soupSeedPromotionThreshold: 7,
    soupCycleIntervalMs: 1000,
    llm: {
      provider: 'local',
      localBaseUrl: 'http://localhost:11434',
      localModel: 'test',
      cloudProvider: 'anthropic',
      cloudApiKeyEnvVar: 'ANTHROPIC_API_KEY',
      cloudModel: 'claude-3',
      localTimeoutMs: 5000,
    },
    seedPromotionThreshold: 7,
    maxSeedsPerDigest: 5,
    nuggetRetentionDays: 30,
    lirEnabled: false,
    lirSummaryBudget: 500,
    lirBatchSize: 10,
    lirMaxSymbolsPerFile: 50,
  };
}

function makeSeed(id: string, score: number): Seed {
  return {
    id,
    content: `content ${id}`,
    score,
    source: { fragments: ['f1'], collisionType: 'heuristic', domains: ['code'] },
    promotedAt: '2026-03-22T12:00:00Z',
    usedBy: [],
    useCount: 0,
  };
}

describe('SeedBank concurrent first load', () => {
  it('keeps seeds added concurrently with the first load plus the seeds already on disk', async () => {
    const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seedbank-race-'));
    try {
      await new SeedBank(makeConfig(seedDir)).add(makeSeed('on-disk', 9));

      const bank = new SeedBank(makeConfig(seedDir));
      await Promise.all([bank.add(makeSeed('added-a', 8)), bank.add(makeSeed('added-b', 7))]);

      const ids = (await bank.getAll()).map(s => s.id);
      expect(ids).toEqual(['on-disk', 'added-a', 'added-b']);

      const persisted = JSON.parse(await fs.readFile(path.join(seedDir, 'seeds.json'), 'utf-8')) as Seed[];
      expect(persisted.map(s => s.id).sort()).toEqual(['added-a', 'added-b', 'on-disk']);
    } finally {
      await fs.rm(seedDir, { recursive: true, force: true });
    }
  });

  it('concurrent readers all see the loaded seeds', async () => {
    const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seedbank-race-'));
    try {
      await new SeedBank(makeConfig(seedDir)).add(makeSeed('on-disk', 9));
      const bank = new SeedBank(makeConfig(seedDir));
      const [a, b] = await Promise.all([bank.getAll(), bank.getAll()]);
      expect(a.map(s => s.id)).toEqual(['on-disk']);
      expect(b.map(s => s.id)).toEqual(['on-disk']);
    } finally {
      await fs.rm(seedDir, { recursive: true, force: true });
    }
  });
});
