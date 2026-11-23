import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryLiminalOperationJournal } from '../../../src/runtime-core/LiminalCommandService.js';
import { FileLiminalOperationJournal } from '../../../src/runtime-core/LiminalCommandFilePersistence.js';
import { LiminalEffectBroker } from '../../../src/runtime-core/LiminalEffectBroker.js';

describe('effect broker: an effect that returns nothing journals and replays (site evolve cycle, any void command)', () => {
  it.each(['memory', 'file'] as const)('%s journal', async kind => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'broker-void-'));
    try {
      const journal = kind === 'memory' ? new InMemoryLiminalOperationJournal()
        : new FileLiminalOperationJournal(path.join(dir, 'journal.json'));
      const admission = await journal.begin(`void-${kind}`, { operationId: `operation:void-${kind}`,
        lineageId: `lineage:void-${kind}`, commandDigest: '4'.repeat(64), attemptsConsumed: 0 });
      const effect = vi.fn(async (): Promise<void> => undefined);
      const broker = new LiminalEffectBroker(journal);
      await expect(broker.invoke({ operationId: admission.operationId, kind: 'judgment', authority: {}, effect }))
        .resolves.toBeUndefined();
      // replay of a completed void effect must not run it a second time
      await broker.invoke({ operationId: admission.operationId, kind: 'judgment', authority: {}, effect });
      expect(effect).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
