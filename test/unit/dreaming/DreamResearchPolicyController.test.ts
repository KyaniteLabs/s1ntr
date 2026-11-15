import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DreamResearchController,
  FileDreamResearchPolicyStore,
  MemoryDreamResearchPolicyStore,
  type AdmittedCreativeEvidence,
} from '../../../src/dreaming/research/DreamResearchController.js';

const evidence: readonly AdmittedCreativeEvidence[] = [
  { evidenceDigest: '1'.repeat(64), artifactDigest: 'a'.repeat(64),
    principleIds: ['depth', 'cohesion'], domain: 'p5', quality: 0.82,
    noveltyDescriptor: [0.2, 0.8], outcome: 'accepted',
    rendered: true, admissionEligible: true },
  { evidenceDigest: '2'.repeat(64), artifactDigest: 'b'.repeat(64),
    principleIds: ['depth', 'motion'], domain: 'threejs', quality: 0.77,
    noveltyDescriptor: [0.8, 0.3], outcome: 'accepted',
    rendered: true, admissionEligible: true },
];

describe('DreamResearchController', () => {
  it('proposes a bounded falsifiable principle-level plan', async () => {
    const controller = new DreamResearchController(new MemoryDreamResearchPolicyStore());
    const plan = await controller.select(evidence, { maxCandidates: 3, maxProviderAttempts: 4 });

    expect(plan.hypothesis).toContain('depth');
    expect(plan.criterion).toContain('rendered');
    expect(plan.parentEvidenceDigests).toEqual(['1'.repeat(64), '2'.repeat(64)]);
    expect(plan.budget).toEqual({ maxCandidates: 3, maxProviderAttempts: 4 });
    expect(plan.stopRules).toContain('stop-before-provider-attempt-5');
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unrendered or admission-ineligible evidence', async () => {
    const controller = new DreamResearchController(new MemoryDreamResearchPolicyStore());
    await expect(controller.select([{ ...evidence[0]!, rendered: false }], {
      maxCandidates: 1, maxProviderAttempts: 1,
    })).rejects.toThrow('DREAM_RESEARCH_EVIDENCE_INADMISSIBLE');
  });

  it('balances exploration and exploitation and detects saturation', async () => {
    const controller = new DreamResearchController(new MemoryDreamResearchPolicyStore());
    const first = await controller.select(evidence, { maxCandidates: 2, maxProviderAttempts: 2 });
    await controller.recordOutcome(first.planDigest, 'rejected');
    const second = await controller.select(evidence, { maxCandidates: 2, maxProviderAttempts: 2 });
    await controller.recordOutcome(second.planDigest, 'inconclusive');
    const third = await controller.select(evidence, { maxCandidates: 2, maxProviderAttempts: 2 });

    expect(second.mode).not.toBe(first.mode);
    expect(third.saturation.repeatedNeighborhood).toBe(true);
    expect(third.saturation.previousNegativeOutcomes).toBe(2);
  });

  it('records negative research policy without creating positive guidance', async () => {
    const store = new MemoryDreamResearchPolicyStore();
    const controller = new DreamResearchController(store);
    const plan = await controller.select(evidence, { maxCandidates: 1, maxProviderAttempts: 1 });
    await controller.recordOutcome(plan.planDigest, 'rejected');

    const state = await store.read();
    expect(state.revision).toBe(2);
    expect(state.negativeNeighborhoods[plan.neighborhoodKey]).toBe(1);
    expect(JSON.stringify(state)).not.toContain('promptGuidance');
  });

  it('keeps preview dry and restart preserves committed selection and budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dream-research-'));
    try {
      const file = path.join(root, 'policy.json');
      const first = new DreamResearchController(new FileDreamResearchPolicyStore(file));
      const preview = await first.preview(evidence, { maxCandidates: 2, maxProviderAttempts: 3 });
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const committed = await first.select(evidence, {
        maxCandidates: 2, maxProviderAttempts: 3,
      });
      await first.reserveCandidate(committed.planDigest);
      await first.reserveProviderAttempt(committed.planDigest);
      const resumed = new DreamResearchController(new FileDreamResearchPolicyStore(file));
      expect(await resumed.currentPlan()).toEqual(committed);
      expect(await resumed.currentBudgetState()).toMatchObject({
        planDigest: committed.planDigest, candidatesConsumed: 1, providerAttemptsConsumed: 1,
      });
      expect(preview.budget).toEqual(committed.budget);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aborts budget reservations before N+1 without invoking an effect', async () => {
    const controller = new DreamResearchController(new MemoryDreamResearchPolicyStore());
    const plan = await controller.select(evidence, { maxCandidates: 1, maxProviderAttempts: 1 });
    expect(await controller.reserveProviderAttempt(plan.planDigest, 'attempt-1')).toBe(1);
    expect(await controller.reserveProviderAttempt(plan.planDigest, 'attempt-1')).toBe(1);
    await expect(controller.reserveProviderAttempt(plan.planDigest, 'attempt-2'))
      .rejects.toThrow('DREAM_RESEARCH_BUDGET_EXHAUSTED');
  });

  it('fences concurrent reservations across store instances sharing one file (#1262)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dream-research-race-'));
    try {
      const file = path.join(root, 'policy.json');
      const a = new DreamResearchController(new FileDreamResearchPolicyStore(file));
      const b = new DreamResearchController(new FileDreamResearchPolicyStore(file));
      const plan = await a.select(evidence, { maxCandidates: 3, maxProviderAttempts: 1 });
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? a : b).reserveCandidate(plan.planDigest, `cand-${i}`)));
      const granted = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []).sort();
      const rejected = results.flatMap(r => r.status === 'rejected'
        ? [(r.reason as Error).message] : []);
      expect(granted).toEqual([1, 2, 3]);
      expect(rejected).toEqual(Array(7).fill('DREAM_RESEARCH_BUDGET_EXHAUSTED'));
      expect((await b.currentBudgetState())?.candidatesConsumed).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent in-memory reservations so the cap holds', async () => {
    const controller = new DreamResearchController(new MemoryDreamResearchPolicyStore());
    const plan = await controller.select(evidence, { maxCandidates: 2, maxProviderAttempts: 2 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      controller.reserveProviderAttempt(plan.planDigest, `p-${i}`)));
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(2);
    expect((await controller.currentBudgetState())?.providerAttemptsConsumed).toBe(2);
  });

  it('has no provider, renderer, queue, archive, activation, or source mutation port', async () => {
    const source = await readFile(path.join(process.cwd(),
      'src/dreaming/research/DreamResearchController.ts'), 'utf8');
    for (const forbidden of ['LLMClient', 'HeadlessRenderer', 'DreamQueue', 'QualityArchive',
      'Activation', 'writeSource', 'child_process']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
