/**
 * SeedBank reuse funnel (#1301): distinct, deduplicated retrieved/injected/
 * helpful/harmful counts and a reuse-rate metric that is not a quality score.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { SeedBank } from '../../../src/compost/SeedBank.js';
import type { CompostConfig, Seed } from '../../../src/compost/types.js';

/** Create a temp directory and return its path. */
async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'seedbank-test-'));
}

/** Build a minimal CompostConfig pointing at a temp dir. */
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
    lirEnabled: true,
    lirSummaryBudget: 500,
    lirBatchSize: 10,
    lirMaxSymbolsPerFile: 50,
  };
}

function seed(id: string): Seed {
  return { id, content: `content ${id}`, score: 8, promotedAt: '2026-11-01T00:00:00Z',
    source: { fragments: ['f'], collisionType: 'heuristic', domains: ['code'] },
    usedBy: [], useCount: 0 };
}

describe('SeedBank reuse funnel', () => {
  it('counts stages separately, dedups by attribution, and survives reload', async () => {
    const dir = await tmpDir();
    try {
      const bank = new SeedBank(makeConfig(dir));
      await bank.add(seed('a'));
      await bank.add(seed('b'));
      await bank.add(seed('c'));
      expect(await bank.recordReuse(['a', 'b'], 'retrieved', 'run-1')).toBe(2);
      expect(await bank.recordReuse(['a'], 'injected', 'run-1')).toBe(1);
      expect(await bank.recordReuse(['a'], 'injected', 'run-1')).toBe(0);
      expect(await bank.recordReuse(['a', 'missing'], 'helpful', 'verdict-1')).toBe(1);
      expect(await bank.recordReuse(['b'], 'harmful', 'verdict-2')).toBe(1);

      const reloaded = new SeedBank(makeConfig(dir));
      expect(await reloaded.reuseMetrics()).toEqual({
        available: 3, retrieved: 2, injected: 1, injectionRate: 1 / 3,
        helpful: 1, harmful: 1, verifiedHelpfulRate: 0.5,
      });
      const a = (await reloaded.getAll()).find(s => s.id === 'a')!;
      expect(a.reuse).toMatchObject({ retrieved: 1, injected: 1, helpful: 1, harmful: 0 });
      expect(a.score).toBe(8);
      expect(typeof a.lastUsedAt).toBe('string');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports no helpful rate without verified outcomes and rejects missing attribution', async () => {
    const dir = await tmpDir();
    try {
      const bank = new SeedBank(makeConfig(dir));
      expect(await bank.reuseMetrics()).toEqual({ available: 0, retrieved: 0, injected: 0,
        injectionRate: 0, helpful: 0, harmful: 0, verifiedHelpfulRate: null });
      await bank.add(seed('a'));
      await bank.recordReuse(['a'], 'injected', 'run-1');
      expect((await bank.reuseMetrics()).verifiedHelpfulRate).toBe(null);
      await expect(bank.recordReuse(['a'], 'helpful', '')).rejects.toThrow('SEED_REUSE_ATTRIBUTION_REQUIRED');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('saves atomically: no temp files left and the bank reloads intact (#1302)', async () => {
    const dir = await tmpDir();
    try {
      const bank = new SeedBank(makeConfig(dir));
      await bank.add(seed('a'));
      await bank.add(seed('b'));
      const files = await fs.readdir(dir);
      expect(files.filter(f => f.includes('.tmp'))).toEqual([]);
      const reloaded = new SeedBank(makeConfig(dir));
      expect((await reloaded.getAll()).map(s => s.id).sort()).toEqual(['a', 'b']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
