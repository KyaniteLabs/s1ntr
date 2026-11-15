import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DreamQueue } from '../../../src/dreaming/DreamQueue.js';
import { createCanonicalDreamResearchConsumer } from
  '../../../src/dreaming/research/DreamResearchBootstrap.js';
import { createDreamRecoveryAuthority } from
  '../../../src/dreaming/research/DreamRecoveryAuthority.js';
import { frozenExperiment } from './dreamResearchFixtures.js';

describe('canonical Dream product bootstrap', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));

  it('constructs the one-command queue to journal path from explicit dependencies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-bootstrap-')); roots.push(root);
    const queue = new DreamQueue({ persistPath: path.join(root, 'queue.json') });
    queue.enqueue('elite-x-elite', [{ id: 'source', descriptor: [1], quality: 1,
      artifact: { domain: 'html', prompt: 'p', code: '<html></html>' } }], 1);
    let state = { completedExperiments: 0, failureFamilyCounts: {}, remainingAttempts: 1 };
    const recovery = createDreamRecoveryAuthority();
    const consumer = createCanonicalDreamResearchConsumer({ queue,
      journalPath: path.join(root, 'journal.sqlite'),
      leaseAuthority: { assertActive: () => undefined },
      recoveryAuthority: recovery.resolver,
      controllerPolicy: { maximumExperiments: 1, maximumFailureFamilyRepeats: 1 },
      executor: () => ({ kind: 'fake', execute: async () => ({
        baselineEvidenceDigest: 'a'.repeat(64), variantEvidenceDigests: ['b'.repeat(64)],
        variantArtifactDigests: ['c'.repeat(64)],
        comparison: { outcome: 'rejected', reason: 'regression' } }) }),
      task: { hypotheses: () => [{ id: 'h', statement: 's', principle: 'p',
        expectedEffect: 'e', uncertainty: 1, novelty: 1, learningValue: 1,
        transferRelevance: 1, cost: 0, failureFamily: 'f' }],
      controllerState: () => state,
      updateControllerState: next => { state = next; },
      buildPlan: (task, hypothesis) => ({ ...frozenExperiment(),
        aggregateId: task.id, hypothesis }), assertAuthorized: () => undefined } });
    const result = await consumer.runNext();
    expect(result?.state).toBe('completed');
    expect(state.completedExperiments).toBe(1);
  });
});
