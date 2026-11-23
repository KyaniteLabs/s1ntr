/**
 * Organ: routing (GeneratorBanditRouter + RoutingData).
 * The reader is wired into GeneratorRegistry.route() behind LIMINAL_ROUTING_BANDIT (off by default). The WRITER is the owner-review
 * path in LiminalProductCommandPort (records owner-accepted outcomes; rehydrated on start).
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GeneratorBanditRouter } from '../../src/routing/GeneratorBanditRouter.js';
import { createRoutingOutcomeAdmission } from '../../src/routing/RoutingOutcomeAdmission.js';

const hex = (c: string) => c.repeat(64);
const admit = (model: string, score: number) => createRoutingOutcomeAdmission({
  role: 'generator', domain: 'music', model, criterionScore: score, ownerDecision: 'accepted',
  artifactDigest: hex('a'), evidenceDigest: hex('b'), decisionDigest: hex('c'),
  rendered: true, identityValid: true, digestMatched: true, degraded: false });

describe('organ: routing', () => {
  it('admitted outcomes move the bandit toward the better model; rejected ones cannot', () => {
    const r = new GeneratorBanditRouter({ rng: () => 0.5 });
    expect(r.isReady('music' as never)).toBe(false);
    for (let i = 0; i < 8; i++) { r.recordOutcome(admit('local', 0.9)); r.recordOutcome(admit('cloud', 0.2)); }
    expect(r.isReady('music' as never)).toBe(true);
    expect(r.getBestModel('music' as never)).toBe('local');
    expect(() => r.recordOutcome({ ...admit('cloud', 0.9), ownerDecision: 'rejected' } as never)).toThrow();
  });

  it('wired: with LIMINAL_ROUTING_BANDIT=1 recorded outcomes change the production route() choice; off by default', async () => {
    const { generatorRegistry } = await import('../../src/generators/GeneratorRegistry.js');
    const { generatorBanditRouter } = await import('../../src/routing/GeneratorBanditRouter.js');
    generatorBanditRouter.reset();
    const staticChoice = generatorRegistry.route('music').model;           // static A/B table: local wins music
    const worse = staticChoice === 'local' ? 'cloud' : 'local';
    for (let i = 0; i < 12; i++) { generatorBanditRouter.recordOutcome(admit(worse, 0.95)); generatorBanditRouter.recordOutcome(admit(staticChoice, 0.05)); }
    try {
      vi.stubEnv('LIMINAL_ROUTING_BANDIT', '');
      expect(generatorRegistry.route('music').model).toBe(staticChoice);   // flag off: data is ignored
      vi.stubEnv('LIMINAL_ROUTING_BANDIT', '1');
      const learned = generatorRegistry.route('music');
      expect(learned.model).toBe(worse);                                    // flag on: outcomes decide
      expect(learned.reason).toContain('bandit overrides');
      generatorBanditRouter.reset();
      expect(generatorRegistry.route('music').model).toBe(staticChoice);   // perturbation: no outcomes, no override
    } finally { vi.unstubAllEnvs(); generatorBanditRouter.reset(); }
  });

  it('production writer: an owner-accepted review is persisted, and a fresh process rehydrates it into the bandit', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const { LiminalProductCommandPort, FileLiminalProductCommandStore } = await import('../../src/runtime-core/LiminalProductCommandPort.js');
    const { createTestReceiptAuthority, evaluationBindingDigest } = await import('../../src/runtime-core/LiminalCommandService.js');
    const { createTestCreativeAdmissionSigner } = await import('../../src/runtime-core/CreativeAdmissionAuthority.js');
    const { createTestLiminalOwnerReviewAuthority } = await import('../../src/runtime-core/LiminalOwnerReviewAuthority.js');
    const { generatorBanditRouter } = await import('../../src/routing/GeneratorBanditRouter.js');
    const { getOptimalModelBandit, getBanditStats, resetRoutingHydration } = await import('../../src/routing/RoutingData.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'routing-writer-'));
    vi.stubEnv('SINTER_ROUTING_DIR', path.join(root, 'routing'));
    generatorBanditRouter.reset(); resetRoutingHydration();
    const receiptAuth = createTestReceiptAuthority('routing-writer-secret');
    const signer = createTestCreativeAdmissionSigner('routing-writer-secret');
    const d = (c: string) => c.repeat(64);
    const evaluation = { score: 0.9, degraded: false, identityValid: true, evaluatorIdentity: 'e/x', evidenceDigest: d('b'), admissionEligible: true, rejectionReasons: [] };
    const create = {
      operationId: 'op-1', lineageId: 'lin-1', domain: 'tone', roles: { generator: 'glm/example', evaluator: 'e/x', harness: 'h', studio: 's' },
      artifacts: { sourceDigest: d('1'), playableDigest: d('2'), provenanceDigest: d('3') },
      evidence: { status: 'rendered', evidenceDigest: d('b'), rendererIdentity: 'pw', earlyFrameDigest: d('d'), lateFrameDigest: d('e'), runtimeErrors: [], audio: { relevant: false, state: 'not-relevant' } },
      evaluation, attempts: { consumed: 1, maximum: 4 },
      receipt: receiptAuth.project({ operationId: 'op-1', lineageId: 'lin-1', commandDigest: d('5'), providerInputDigest: d('6'), artifactDigest: d('a'),
        evidenceDigest: d('b'), operationTraceDigest: d('7'), disabledTeachingReaders: [], empiricalContextDigests: [], learningEligible: false,
        evaluationDigest: evaluationBindingDigest(evaluation as never) }),
    } as never;
    const authority = { execute: vi.fn(async () => create), verifyReceipt: (r: never) => receiptAuth.verify(r), sealOwnerReviewAdmission: (v: unknown) => signer.sealAdmission(v) };
    const port = new LiminalProductCommandPort(authority as never, createTestLiminalOwnerReviewAuthority('routing-writer-owner'), new FileLiminalProductCommandStore(path.join(root, 'cmd.json')));
    try {
      for (let i = 0; i < 6; i++) {
        await port.submitCreate('studio', { schema: 'sinter.liminal-command', schemaVersion: 1, kind: 'generate-candidate', idempotencyKey: `c${i}` } as never);
        await port.submitOwnerReview('studio', { schema: 'sinter.liminal-owner-review-command', schemaVersion: 1, idempotencyKey: `r${i}`, createIdempotencyKey: `c${i}`,
          operationId: 'op-1', artifactRootDigest: d('a'), evidenceRootDigest: d('b'), decision: 'accepted', feedback: 'good', criterionDigest: d('c') } as never);
      }
      const persisted = JSON.parse(await readFile(path.join(root, 'routing', 'music.json'), 'utf8'));
      expect(persisted).toHaveLength(6);
      expect(getBanditStats('music').cloud.pulls).toBe(6);              // live bandit fed
      generatorBanditRouter.reset(); resetRoutingHydration();              // "restart"
      expect(getBanditStats('music').cloud.pulls).toBe(0);
      expect(['local', 'cloud', 'hybrid']).toContain(getOptimalModelBandit('music'));             // rehydrates from disk: ready again
      expect(getBanditStats('music').cloud.pulls).toBe(6);
    } finally { vi.unstubAllEnvs(); generatorBanditRouter.reset(); resetRoutingHydration(); await rm(root, { recursive: true, force: true }); }
  });

  it('a rejected owner review never reaches the bandit', async () => {
    const { recordRoutingOutcome } = await import('../../src/routing/RoutingData.js');
    await expect(recordRoutingOutcome({ domain: 'music', model: 'cloud', qualityScore: 0.9, timestamp: 'x',
      admission: { ...admit('cloud', 0.9), ownerDecision: 'rejected' } as never })).rejects.toThrow();
  });
});
