import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryLiminalOperationJournal } from '../../src/runtime-core/LiminalCommandService.js';
import { FileLiminalOperationJournal } from '../../src/runtime-core/LiminalCommandFilePersistence.js';
import { LiminalEffectBroker, UnsentTransportError } from '../../src/runtime-core/LiminalEffectBroker.js';

describe.each(['memory', 'file'] as const)('effect failure safety (%s)', backend => {
  it('does not retry historical failed effects whose commitment is unknown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-failure-'));
    try {
      const file = path.join(root, 'journal.json');
      const journal = backend === 'file' ? new FileLiminalOperationJournal(file)
        : new InMemoryLiminalOperationJournal();
      await journal.begin('legacy', { operationId: 'operation:legacy',
        lineageId: 'lineage:legacy', commandDigest: 'c'.repeat(64), attemptsConsumed: 0 });
      const reservation = await journal.reserveEffect('operation:legacy', 'generation', {});
      await journal.startEffect(reservation);
      await journal.finishEffect(reservation, 'failed', { error: 'PROVIDER_TIMEOUT' });
      const resumed = backend === 'file' ? new FileLiminalOperationJournal(file) : journal;
      await expect(resumed.reserveEffect('operation:legacy', 'generation', {}))
        .rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps failed transport attempts consumed across restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'attempt-failure-'));
    try {
      const file = path.join(root, 'journal.json');
      const journal = backend === 'file' ? new FileLiminalOperationJournal(file)
        : new InMemoryLiminalOperationJournal();
      await journal.begin('attempt', { operationId: 'operation:attempt',
        lineageId: 'lineage:attempt', commandDigest: 'b'.repeat(64), attemptsConsumed: 0 });
      await journal.reserveTransportAttempt('operation:attempt', 1, {});
      await journal.failTransportAttempt('operation:attempt');
      const resumed = backend === 'file' ? new FileLiminalOperationJournal(file) : journal;
      expect(await resumed.attemptsConsumed('operation:attempt')).toBe(1);
      await expect(resumed.reserveTransportAttempt('operation:attempt', 1, {}))
        .rejects.toThrow('TRANSPORT_ATTEMPT_CAP_EXHAUSTED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('a later local refusal cannot release an earlier dispatched call', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'partial-effect-'));
    try {
      const journal = backend === 'file' ? new FileLiminalOperationJournal(path.join(root, 'journal.json'))
        : new InMemoryLiminalOperationJournal();
      const operationId = 'operation:partial';
      await journal.begin('partial', { operationId, lineageId: 'lineage:partial', commandDigest: 'c'.repeat(64), attemptsConsumed: 0 });
      const run = () => new LiminalEffectBroker(journal).invoke({ operationId, kind: 'evaluation', authority: {},
        effect: async () => {
          await journal.reserveTransportAttempt(operationId, 1, {});
          throw new UnsentTransportError('second call refused');
        } });
      await expect(run()).rejects.toThrow('second call refused');
      await expect(run()).rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
      expect(await journal.attemptsConsumed(operationId)).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not reinvoke an external effect after a timeout that may follow commitment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'effect-failure-'));
    try {
      const file = path.join(root, 'journal.json');
      const journal = backend === 'file' ? new FileLiminalOperationJournal(file)
        : new InMemoryLiminalOperationJournal();
      await journal.begin('timeout', { operationId: 'operation:timeout',
        lineageId: 'lineage:timeout', commandDigest: 'a'.repeat(64), attemptsConsumed: 0 });
      let externalCommits = 0;
      const input = { operationId: 'operation:timeout', kind: 'generation' as const,
        authority: {}, effect: async () => {
          externalCommits++;
          throw new Error('PROVIDER_TIMEOUT');
        } };
      await expect(new LiminalEffectBroker(journal).invoke(input)).rejects.toThrow('PROVIDER_TIMEOUT');
      const resumed = backend === 'file' ? new FileLiminalOperationJournal(file) : journal;
      await expect(new LiminalEffectBroker(resumed).invoke(input))
        .rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
      expect(externalCommits).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
