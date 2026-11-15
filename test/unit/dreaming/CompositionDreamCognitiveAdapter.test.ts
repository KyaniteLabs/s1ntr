import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostGenerationCognitiveWriter } from '../../../src/tui-bridge/PostGenerationCognitiveWriter.js';
import { StudioLineageLedger } from '../../../src/tui-bridge/StudioLineage.js';
import { CompositionDreamCognitiveAdapter } from '../../../src/dreaming/CompositionDreamCognitiveAdapter.js';
import type { DreamTask } from '../../../src/dreaming/DreamQueue.js';
import type { CompositionDreamPlan, CompositionDreamRecord } from '../../../src/dreaming/CompositionDreamTypes.js';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  type ControlRecipe,
} from '../../../src/composition/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root =>
  fs.rmSync(root, { recursive: true, force: true })
));

function recipe(): ControlRecipe {
  return {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: CONTROL_RECIPE_VERSION,
    id: 'parent-recipe',
    layers: [],
    transport: {
      clock: 'interval', cadenceMs: 20, bufferSize: 1,
      staleAfterMs: 20, staleBehavior: 'hold',
    },
    signals: [], targets: [], mappings: [], resources: [],
    lifecycle: { startOrder: [], teardownOrder: [] },
    audio: { unlock: 'not-required' },
    lineage: { parentRecipeIds: [], createdAt: '2026-07-30T00:00:00.000Z' },
  };
}

describe('CompositionDreamCognitiveAdapter', () => {
  it('preserves composition artifacts but blocks learning until a production authority is wired', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-cognition-'));
    roots.push(root);
    const ledger = new StudioLineageLedger({
      ledgerPath: path.join(root, 'lineage.jsonl'),
    });
    const recordEpisode = vi.fn()
      .mockReturnValueOnce('episode-admitted')
      .mockReturnValueOnce('episode-failed');
    const memory = {
      initialize: vi.fn(async () => undefined),
      getRelevantEpisodesByDomain: vi.fn(async () => []),
      recordEpisode,
      save: vi.fn(async () => ({ isErr: () => false })),
    };
    const compost = { add: vi.fn(async () => undefined) };
    const dreamQueue = {
      enqueue: vi.fn()
        .mockReturnValueOnce('next-dream-admitted')
        .mockReturnValueOnce('next-dream-failed'),
    };
    const writer = new PostGenerationCognitiveWriter({
      memory,
      compost,
      dreamQueue,
      artifactRoot: path.join(root, 'artifacts'),
      lineageLedger: ledger,
    });
    const adapter = new CompositionDreamCognitiveAdapter(writer, ledger);
    const planFor = (lineageId: string): CompositionDreamPlan => ({
      parentRecipe: recipe(),
      mutation: { kind: 'timing', cadenceMs: 30 },
      provenance: {
        lineageId,
        sourceDigest: 'b'.repeat(64),
        origin: 'overnight-dream',
        trust: 'untrusted-external',
        taint: 'tainted',
        taintSources: ['imported-parent'],
        corroboration: ['archive-entry'],
      },
    });
    const taskFor = (id: string, plan: CompositionDreamPlan): DreamTask => ({
      id,
      kind: 'composition',
      strategy: 'cross-modal',
      sources: [{ id: 'parent-recipe', descriptor: [0.5], quality: 0.7 }],
      priority: 0.7,
      status: 'running',
      compositionPlan: plan,
      enqueuedAt: '2026-07-30T00:00:00.000Z',
    });
    const admittedPlan = planFor('admitted-lineage');
    await ledger.start({
      lineageId: admittedPlan.provenance.lineageId,
      sessionId: 'session-admitted',
      origin: 'test-owner',
    });
    const admittedReceipts = await adapter.record({
      task: taskFor('dream-admitted', admittedPlan),
      plan: admittedPlan,
      recipe: recipe(),
      artifact: '<!doctype html><title>admitted</title>',
      evaluation: { outcome: 'PASS' } as CompositionDreamRecord['evaluation'],
      verdict: 'admitted',
      reason: 'Composition dream PASS',
    });
    const failedPlan = planFor('failed-lineage');
    await ledger.start({
      lineageId: failedPlan.provenance.lineageId,
      sessionId: 'session-failed',
      origin: 'test-owner',
    });
    const failedReceipts = await adapter.record({
      task: taskFor('dream-failed', failedPlan),
      plan: failedPlan,
      evaluation: { outcome: 'PASS' } as CompositionDreamRecord['evaluation'],
      verdict: 'failed',
      reason: 'mutation invalid',
    });

    expect(recordEpisode).not.toHaveBeenCalled();
    expect(compost.add).toHaveBeenCalledTimes(2);
    expect(dreamQueue.enqueue).not.toHaveBeenCalled();
    expect(admittedReceipts.map(receipt => receipt.organ)).toEqual(
      expect.arrayContaining(['lineage', 'memory', 'compost', 'dreaming']),
    );
    expect(failedReceipts.find(receipt => receipt.organ === 'memory')?.status).toBe('pending');
    expect(failedReceipts.find(receipt => receipt.organ === 'dreaming')?.status).toBe('pending');
    expect(admittedReceipts.find(receipt => receipt.organ === 'memory')?.status).toBe('pending');
    expect(admittedReceipts.find(receipt => receipt.organ === 'dreaming')?.status).toBe('pending');
    expect(failedReceipts.map(receipt => receipt.organ)).toEqual(
      expect.arrayContaining(['lineage', 'memory', 'compost', 'dreaming']),
    );
    const admittedTrace = await ledger.query('admitted-lineage');
    const dreamRecord = admittedTrace.records.find(record =>
      record.stage === 'dream' && record.origin === 'overnight-dream'
    )!;
    expect(dreamRecord).toMatchObject({
      trust: 'untrusted-external',
      taint: 'tainted',
      taintSources: ['imported-parent'],
      corroboration: ['archive-entry'],
      payload: { verdict: 'admitted', sourceDigest: 'b'.repeat(64) },
    });
    const failedTrace = await ledger.query('failed-lineage');
    expect(failedTrace.records.some(record =>
      record.stage === 'dream'
      && record.status === 'unavailable'
      && record.payload.verdict === 'failed'
    )).toBe(true);
  });
});
