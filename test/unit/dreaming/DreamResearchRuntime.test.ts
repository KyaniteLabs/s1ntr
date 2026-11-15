import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DreamHypothesisSelector } from '../../../src/dreaming/research/DreamHypothesisSelector.js';
import { DreamResearchJournal } from '../../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchRuntime,
  type DreamTransportGate } from '../../../src/dreaming/research/DreamResearchRuntime.js';
import { DreamResearchService } from '../../../src/dreaming/research/DreamResearchService.js';
import { frozenExperiment } from './dreamResearchFixtures.js';

describe('DreamResearchRuntime', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

  it('runs the autonomous fake-transport path without provider attempts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-runtime-')); roots.push(root);
    const service = new DreamResearchService(new DreamResearchJournal(path.join(root, 'dream.sqlite')),
      { assertActive: () => undefined });
    const execute = vi.fn(async () => ({ baselineEvidenceDigest: 'a'.repeat(64),
      variantEvidenceDigests: ['b'.repeat(64)], variantArtifactDigests: ['c'.repeat(64)], comparison: {
        outcome: 'rejected' as const, reason: 'depth regressed' } }));
    const runtime = new DreamResearchRuntime(service,
      new DreamHypothesisSelector({ maximumExperiments: 1, maximumFailureFamilyRepeats: 1 }),
      { kind: 'fake', execute });
    const result = await runtime.run([{ id: 'depth', statement: 'test depth', principle: 'depth',
      expectedEffect: 'hierarchy', uncertainty: 0.8, novelty: 0.8, learningValue: 0.9,
      transferRelevance: 0.9, cost: 0.2, failureFamily: 'depth' }],
    { completedExperiments: 0, failureFamilyCounts: {}, remainingAttempts: 3 },
    hypothesis => ({ ...frozenExperiment(), hypothesis }));
    expect(result).toMatchObject({ kind: 'completed', state: 'completed' });
    expect(service.snapshot('dream-1').attemptsStarted).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('counts every nested provider operation and aborts before N plus one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-runtime-')); roots.push(root);
    const service = new DreamResearchService(new DreamResearchJournal(path.join(root, 'dream.sqlite')),
      { assertActive: () => undefined });
    const calls: string[] = [];
    const executor = { kind: 'provider' as const, execute: async (_plan: unknown,
      gate: DreamTransportGate) => {
      await gate('render', async () => { calls.push('render'); return 'render'; },
        { metered: false });
      for (const purpose of ['generate', 'evaluate-1', 'evaluate-2']) {
        await gate(purpose, async () => { calls.push(purpose); return purpose; });
      }
      throw new Error('unreachable');
    } };
    const runtime = new DreamResearchRuntime(service,
      new DreamHypothesisSelector({ maximumExperiments: 1, maximumFailureFamilyRepeats: 1 }), executor);
    await expect(runtime.run([{ id: 'depth', statement: 'depth', principle: 'depth',
      expectedEffect: 'hierarchy', uncertainty: 1, novelty: 1, learningValue: 1,
      transferRelevance: 1, cost: 0, failureFamily: 'depth' }],
    { completedExperiments: 0, failureFamilyCounts: {}, remainingAttempts: 3 },
    hypothesis => ({ ...frozenExperiment(), hypothesis, budget: { maximumAttempts: 2 } })))
      .rejects.toThrow('DREAM_ATTEMPT_CAP_EXHAUSTED');
    expect(calls).toEqual(['render', 'generate', 'evaluate-1']);
    expect(service.snapshot('dream-1').attemptsStarted).toBe(2);
    expect(service.events('dream-1').filter(event => event.type === 'transport-started'))
      .toHaveLength(3);
  });
});
