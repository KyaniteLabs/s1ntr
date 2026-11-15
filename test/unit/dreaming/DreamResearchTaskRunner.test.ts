import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DreamQueue } from '../../../src/dreaming/DreamQueue.js';
import { CanonicalDreamTaskRunner } from '../../../src/dreaming/research/DreamResearchTaskRunner.js';
import type { DreamResearchRuntime } from '../../../src/dreaming/research/DreamResearchRuntime.js';
import { frozenExperiment } from './dreamResearchFixtures.js';

describe('CanonicalDreamTaskRunner', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

  it('authorizes before dequeue and completes one exact journaled task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-task-')); roots.push(root);
    const queue = new DreamQueue({ persistPath: path.join(root, 'queue.json'), maxConcurrent: 1 });
    const id = queue.enqueue('elite-x-elite', [{ id: 'source', descriptor: [0.5], quality: 0.9,
      artifact: { domain: 'html', prompt: 'source', code: '<html>source</html>' } }], 1)!;
    const run = vi.fn(async () => ({ kind: 'completed' as const,
      aggregateId: id, state: 'finding-proposed' as const }));
    const authorize = vi.fn();
    const updateControllerState = vi.fn();
    const runner = new CanonicalDreamTaskRunner(queue, { run,
      updateControllerState: (_state: unknown) => ({ completedExperiments: 1,
        failureFamilyCounts: {}, remainingAttempts: 0 }) } as unknown as DreamResearchRuntime,
      { hypotheses: () => [{ id: 'depth', statement: 'test', principle: 'depth',
        expectedEffect: 'hierarchy', uncertainty: 1, novelty: 1, learningValue: 1,
        transferRelevance: 1, cost: 0, failureFamily: 'depth' }],
      controllerState: () => ({ completedExperiments: 0, failureFamilyCounts: {}, remainingAttempts: 1 }),
      updateControllerState,
      buildPlan: (task, hypothesis) => ({ ...frozenExperiment(), aggregateId: task.id, hypothesis }),
      assertAuthorized: authorize });
    const result = await runner.runNext();
    expect(authorize).toHaveBeenCalledBefore(run);
    expect(updateControllerState).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ task: { id }, state: 'finding-proposed' });
    expect(queue.getStatus()).toEqual({ queued: 0, running: 0, completed: 1, failed: 0 });
  });
});
