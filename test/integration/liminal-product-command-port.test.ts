import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLiminalProductCommandStore, LiminalProductCommandPort }
  from '../../src/runtime-core/LiminalProductCommandPort.js';
import { createTestReceiptAuthority, evaluationBindingDigest } from
  '../../src/runtime-core/LiminalCommandService.js';
import { createTestCreativeAdmissionSigner } from
  '../../src/runtime-core/CreativeAdmissionAuthority.js';
import { createTestLiminalOwnerReviewAuthority } from
  '../../src/runtime-core/LiminalOwnerReviewAuthority.js';
import { verifyLegacyBackfillRow } from '../../src/learning/LegacyBackfill.js';
import { judgeNegativeRow } from '../../src/learning/JudgeNegativeRow.js';
import { isCreativeLabelAdmitted } from '../../src/learning/CreativeLabelAdmission.js';
import { validateRoutingOutcomeAdmission } from
  '../../src/routing/RoutingOutcomeAdmission.js';
import { validateExplorationDecisionAdmission } from
  '../../src/evolution/ExplorationDecisionAdmission.js';

const keyLease = (file: string, key: string) =>
  path.join(`${file}.leases`, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.lease`);
const digest = (char: string) => char.repeat(64);
const admissionAuthority = createTestReceiptAuthority('product-port-test-secret');
const admissionSigner = createTestCreativeAdmissionSigner('product-port-test-secret');
const createResult = (degraded = false, score = 0.65, failureClass?: string) => ({
  operationId: 'operation-1', lineageId: 'lineage-1', domain: 'p5',
  roles: { generator: 'glm/example', evaluator: 'grok/example',
    harness: 'harness/example', studio: 'studio/example' },
  artifacts: { sourceDigest: digest('1'), playableDigest: digest('2'),
    provenanceDigest: digest('3') },
  evidence: { status: 'rendered', evidenceDigest: digest('b'),
    rendererIdentity: 'playwright', earlyFrameDigest: digest('d'),
    lateFrameDigest: digest('e'), runtimeErrors: [],
    audio: { relevant: false, state: 'not-relevant' } },
  evaluation: { score, degraded, identityValid: true, ...(failureClass ? { failureClass } : {}),
    evaluatorIdentity: 'grok/example', evidenceDigest: digest('b'),
    admissionEligible: !degraded, rejectionReasons: degraded ? ['evaluation-degraded'] : [] },
  attempts: { consumed: 2, maximum: 4 },
  receipt: { schema: 'sinter.liminal-authority-receipt', schemaVersion: 1,
    authorityTier: 'test-proof', authorityKeyDigest: digest('4'),
    operationId: 'operation-1', lineageId: 'lineage-1', commandDigest: digest('5'),
    providerInputDigest: digest('6'), artifactDigest: digest('a'),
    evidenceDigest: digest('b'), operationTraceDigest: digest('7'),
    disabledTeachingReaders: [], empiricalContextDigests: [], learningEligible: false,
    signature: digest('8') },
}) as never;
const signedCreateResult = (degraded = false, score = 0.65, failureClass?: string,
  tamper?: (evaluation: Record<string, unknown>) => void) => {
  const base = createResult(degraded, score, failureClass) as Record<string, any>;
  const evaluationDigest = evaluationBindingDigest(base.evaluation);
  if (tamper) base.evaluation = { ...base.evaluation, ...(() => { const t: Record<string, unknown> = {}; tamper(t); return t; })() };
  const receipt = admissionAuthority.project({ operationId: 'operation-1',
    lineageId: 'lineage-1', commandDigest: digest('5'),
    providerInputDigest: digest('6'), artifactDigest: digest('a'),
    evidenceDigest: digest('b'), operationTraceDigest: digest('7'),
    disabledTeachingReaders: [], empiricalContextDigests: [], learningEligible: false,
    evaluationDigest });
  return { ...base, receipt } as never;
};

/** A Create exactly as the current writer emits it: a low real judgment is NOT admission-eligible. */
const lowJudgmentCreate = (score: number, rejectionReasons: string[], extra: Record<string, unknown> = {}) => {
  const base = createResult(false, score) as Record<string, any>;
  base.evaluation = { ...base.evaluation, admissionEligible: false, rejectionReasons, ...extra };
  const receipt = admissionAuthority.project({ operationId: 'operation-1',
    lineageId: 'lineage-1', commandDigest: digest('5'),
    providerInputDigest: digest('6'), artifactDigest: digest('a'),
    evidenceDigest: digest('b'), operationTraceDigest: digest('7'),
    disabledTeachingReaders: [], empiricalContextDigests: [], learningEligible: false,
    evaluationDigest: evaluationBindingDigest(base.evaluation) });
  return { ...base, receipt } as never;
};

describe('Liminal product command port', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));

  it('converges the same idempotency key across Create surfaces', async () => {
    const execute = vi.fn(async () => ({ operationId: 'operation-1',
      lineageId: 'lineage-1' }) as never);
    const port = new LiminalProductCommandPort({ execute }, undefined);
    const command = { schema: 'sinter.liminal-command' as const, schemaVersion: 1 as const,
      kind: 'generate-candidate' as const, idempotencyKey: 'shared-create' } as never;
    const cli = await port.submitCreate('cli', command);
    const studio = await port.submitCreate('studio', command);
    const chat = await port.submitCreate('chat', command);
    const campaign = await port.submitCreate('campaign', command);
    expect([cli, studio, chat, campaign].every(value => value === cli)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent submissions and rejects key rebinding', async () => {
    const execute = vi.fn(async () => ({ operationId: 'one', lineageId: 'one' }) as never);
    const port = new LiminalProductCommandPort({ execute }, undefined);
    const command = { schema: 'sinter.liminal-command' as const, schemaVersion: 1 as const,
      kind: 'generate-candidate' as const, idempotencyKey: 'concurrent' } as never;
    const [first, second] = await Promise.all([
      port.submitCreate('cli', command), port.submitCreate('studio', command),
    ]);
    expect(first).toBe(second);
    expect(execute).toHaveBeenCalledOnce();
    await expect(port.submitCreate('chat', { ...command, prompt: 'changed' } as never))
      .rejects.toThrow('IDEMPOTENCY_KEY_REBOUND');
  });

  it('coalesces the same key across independent file-backed processes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-product-lease-'));
    roots.push(root);
    const file = path.join(root, 'commands.json');
    const execute = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { operationId: 'one', lineageId: 'one' } as never;
    });
    const command = { schema: 'sinter.liminal-command' as const, schemaVersion: 1 as const,
      kind: 'generate-candidate' as const, idempotencyKey: 'cross-process' } as never;
    const first = new LiminalProductCommandPort({ execute }, undefined,
      new FileLiminalProductCommandStore(file));
    const second = new LiminalProductCommandPort({ execute }, undefined,
      new FileLiminalProductCommandStore(file));

    const [left, right] = await Promise.all([
      first.submitCreate('cli', command), second.submitCreate('studio', command),
    ]);

    expect(left).toEqual(right);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not steal an aged lease from a live long-running operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-product-live-lease-'));
    roots.push(root);
    const file = path.join(root, 'commands.json');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async () => {
      await blocked;
      return { operationId: 'one', lineageId: 'one' } as never;
    });
    const command = { schema: 'sinter.liminal-command' as const, schemaVersion: 1 as const,
      kind: 'generate-candidate' as const, idempotencyKey: 'live-aged-lease' } as never;
    const firstPort = new LiminalProductCommandPort({ execute }, undefined,
      new FileLiminalProductCommandStore(file));
    const secondPort = new LiminalProductCommandPort({ execute }, undefined,
      new FileLiminalProductCommandStore(file));
    const first = firstPort.submitCreate('cli', command);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const stale = new Date(Date.now() - 120_000);
    await utimes(keyLease(file, 'live-aged-lease'), stale, stale);
    const second = secondPort.submitCreate('studio', command);
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(execute).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('preserves different keys across independent file-backed processes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-product-file-lease-'));
    roots.push(root);
    const file = path.join(root, 'commands.json');
    const execute = vi.fn(async (command: { idempotencyKey: string }) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { operationId: command.idempotencyKey, lineageId: 'lineage' } as never;
    });
    const first = new LiminalProductCommandPort({ execute } as never, undefined,
      new FileLiminalProductCommandStore(file));
    const second = new LiminalProductCommandPort({ execute } as never, undefined,
      new FileLiminalProductCommandStore(file));
    const command = { schema: 'sinter.liminal-command' as const, schemaVersion: 1 as const,
      kind: 'generate-candidate' as const };

    await Promise.all([
      first.submitCreate('cli', { ...command, idempotencyKey: 'left' } as never),
      second.submitCreate('studio', { ...command, idempotencyKey: 'right' } as never),
    ]);

    expect(await first.projection('left')).toMatchObject({ kind: 'create', status: 'completed' });
    expect(await first.projection('right')).toMatchObject({ kind: 'create', status: 'completed' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reclaims a stale product-store lease after a crashed writer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-product-stale-'));
    roots.push(root);
    const file = path.join(root, 'commands.json');
    await mkdir(keyLease(file, 'recovered'), { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    await utimes(keyLease(file, 'recovered'), stale, stale);
    const execute = vi.fn(async () => ({ operationId: 'recovered', lineageId: 'lineage' }) as never);
    const port = new LiminalProductCommandPort({ execute } as never, undefined,
      new FileLiminalProductCommandStore(file));
    const command = { schema: 'sinter.liminal-command' as const, schemaVersion: 1 as const,
      kind: 'generate-candidate' as const, idempotencyKey: 'recovered' } as never;

    await expect(port.submitCreate('cli', command)).resolves.toMatchObject({ status: 'completed' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps schedulers proposal-only and projections effect-free', async () => {
    const execute = vi.fn();
    const port = new LiminalProductCommandPort({ execute } as never, undefined);
    const proposal = { schema: 'sinter.liminal-proposal' as const, schemaVersion: 1 as const,
      idempotencyKey: 'garden-proposal', requestedKind: 'generate-candidate' as const,
      briefDigest: digest('a'), authorityDigest: digest('b') };
    for (const surface of ['cortex', 'gardener', 'daemon', 'scheduler'] as const) {
      const projection = await port.propose(surface, proposal);
      expect(projection.status).toBe('proposed');
    }
    expect(execute).not.toHaveBeenCalled();
    await expect(port.submitCreate('gardener' as never, {} as never))
      .rejects.toThrow('LIMINAL_SURFACE_CREATE_FORBIDDEN');
  });

  it('persists owner review bound to exact artifact and evidence roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-product-port-'));
    roots.push(root);
    const file = path.join(root, 'commands.json');
    const firstReviewAuthority = createTestLiminalOwnerReviewAuthority('owner-review-secret');
    const submit = vi.spyOn(firstReviewAuthority, 'submit');
    const authority = { execute: vi.fn(async () => signedCreateResult()),
      verifyReceipt: vi.fn(receipt => admissionAuthority.verify(receipt)),
      sealOwnerReviewAdmission: (value: unknown) => admissionSigner.sealAdmission(value) };
    const store = new FileLiminalProductCommandStore(file);
    const first = new LiminalProductCommandPort(authority, firstReviewAuthority, store);
    await first.submitCreate('studio', { schema: 'sinter.liminal-command', schemaVersion: 1,
      kind: 'generate-candidate', idempotencyKey: 'create-1' } as never);
    const command = { schema: 'sinter.liminal-owner-review-command' as const,
      schemaVersion: 1 as const, idempotencyKey: 'owner-review-1',
      createIdempotencyKey: 'create-1',
      operationId: 'operation-1', artifactRootDigest: digest('a'),
      evidenceRootDigest: digest('b'), decision: 'accepted' as const,
      feedback: 'accepted with visible line flaw', criterionDigest: digest('c') };
    const result = await first.submitOwnerReview('studio', command);
    const resumedReviewAuthority = createTestLiminalOwnerReviewAuthority('owner-review-secret');
    const resumed = new LiminalProductCommandPort(authority, resumedReviewAuthority,
      new FileLiminalProductCommandStore(file));
    expect(await resumed.projection(command.idempotencyKey)).toEqual(result);
    expect(await resumed.submitOwnerReview('cli', command)).toEqual(result);
    expect(submit).toHaveBeenCalledOnce();
    expect(result.kind === 'owner-review'
      && resumedReviewAuthority.verify(command, result.receipt)).toBe(true);
    expect(result.kind === 'owner-review' && result.admissions.creativeLabel.allowedUses)
      .toEqual(['few-shot', 'evaluator-training']);
    expect(result.kind === 'owner-review' && result.admissions.routing.model)
      .toBe('glm/example');
    const evidence = await resumed.verifiedOwnerEvidence('create-1', 'owner-review-1');
    expect(evidence).toMatchObject({ createKey: 'create-1', ownerReviewKey: 'owner-review-1',
      operationId: 'operation-1', lineageId: 'lineage-1', artifactDigest: digest('a'),
      evidenceDigest: digest('b'), criterionDigest: digest('c'), domain: 'p5', quality: 0.65,
      decision: 'accepted' });
    for (const value of [evidence.createCommandDigest, evidence.createReceiptDigest,
      evidence.reviewCommandDigest, evidence.reviewDecisionDigest, evidence.reviewReceiptDigest]) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('projects a signed exact-artifact reevaluation without regeneration', async () => {
    const parent = signedCreateResult(true) as any;
    const reevaluation = { ...signedCreateResult(), operationId: 'operation-2',
      attempts: { consumed: 1, maximum: 1 },
      receipt: admissionAuthority.project({ operationId: 'operation-2',
        lineageId: 'lineage-1', commandDigest: digest('5'),
        providerInputDigest: digest('6'), artifactDigest: digest('a'),
        evidenceDigest: digest('b'), actionAuthorityDigest: digest('9'),
        operationTraceDigest: digest('7'), disabledTeachingReaders: [],
        empiricalContextDigests: [], learningEligible: false }) } as never;
    const authority = { execute: vi.fn(async () => parent),
      verifyReceipt: vi.fn(receipt => admissionAuthority.verify(receipt)),
      readVerifiedResult: vi.fn(async (key: string) => {
        if (key === 'parent') return parent;
        if (key === 'forged-result') return { ...(reevaluation as any), lineageId: 'wrong-lineage' };
        if (key === 'degraded-result') return { ...(reevaluation as any),
          evaluation: { ...(reevaluation as any).evaluation, degraded: true,
            admissionEligible: false } };
        if (key === 'artifact-result') return { ...(reevaluation as any),
          artifacts: { ...(reevaluation as any).artifacts, sourceDigest: digest('f') } };
        return reevaluation;
      }),
      readVerifiedArtifact: vi.fn(async () => ({ source: 's', playable: 'p', provenance: 'v' })),
      restoreVerifiedArtifact: vi.fn(async () => undefined),
      restoreVerifiedRenderedEvidence: vi.fn(async () => undefined),
      readVerifiedRenderedEvidence: vi.fn(async () => undefined) };
    const port = new LiminalProductCommandPort(authority as never);
    await port.submitCreate('cli', { schema: 'sinter.liminal-command', schemaVersion: 1,
      kind: 'generate-candidate', idempotencyKey: 'parent' } as never);

    const projected = await port.submitReevaluation('cli', {
      idempotencyKey: 'accepted-rendered', parentCreateIdempotencyKey: 'parent',
      reevaluationIdempotencyKey: 'canonical-result', parentCommand: { domain: 'p5' } as never,
      renderedEvidence: {} as never,
    });

    expect(projected).toMatchObject({ kind: 'create', result: { operationId: 'operation-2' } });
    expect(authority.execute).toHaveBeenCalledOnce();
    expect(authority.restoreVerifiedArtifact).toHaveBeenCalledWith(parent, reevaluation);
    expect(authority.readVerifiedRenderedEvidence).toHaveBeenCalledWith(reevaluation);
    await expect(port.verifiedArtifact('accepted-rendered')).resolves
      .toEqual({ source: 's', playable: 'p', provenance: 'v' });
    expect(authority.readVerifiedArtifact).toHaveBeenCalledWith(reevaluation);
    await expect(port.submitReevaluation('studio', {
      idempotencyKey: 'forged', parentCreateIdempotencyKey: 'parent',
      reevaluationIdempotencyKey: 'forged-result', parentCommand: { domain: 'p5' } as never,
      renderedEvidence: {} as never,
    })).rejects.toThrow('LIMINAL_REEVALUATION_PROJECTION_INVALID');
    for (const reevaluationIdempotencyKey of ['degraded-result', 'artifact-result']) {
      await expect(port.submitReevaluation('cli', {
        idempotencyKey: `reject-${reevaluationIdempotencyKey}`,
        parentCreateIdempotencyKey: 'parent', reevaluationIdempotencyKey,
        parentCommand: { domain: 'p5' } as never, renderedEvidence: {} as never,
      })).rejects.toThrow('LIMINAL_REEVALUATION_PROJECTION_INVALID');
    }
  });

  it('types rejection telemetry but blocks it from routing and exploration reward', async () => {
    const authority = { execute: vi.fn(async () => signedCreateResult()),
      verifyReceipt: vi.fn(receipt => admissionAuthority.verify(receipt)),
      sealOwnerReviewAdmission: (value: unknown) => admissionSigner.sealAdmission(value) };
    const port = new LiminalProductCommandPort(authority,
      createTestLiminalOwnerReviewAuthority('rejected-owner-review-secret'));
    await port.submitCreate('studio', { schema: 'sinter.liminal-command', schemaVersion: 1,
      kind: 'generate-candidate', idempotencyKey: 'create-rejected' } as never);
    const command = { schema: 'sinter.liminal-owner-review-command' as const,
      schemaVersion: 1 as const, idempotencyKey: 'review-rejected',
      createIdempotencyKey: 'create-rejected', operationId: 'operation-1',
      artifactRootDigest: digest('a'), evidenceRootDigest: digest('b'),
      decision: 'rejected' as const, feedback: 'composition lacks depth',
      criterionDigest: digest('c') };
    const result = await port.submitOwnerReview('studio', command);
    expect(result.kind).toBe('owner-review');
    if (result.kind !== 'owner-review') throw new Error('owner review expected');
    expect(result.admissions.creativeLabel.allowedUses).toEqual(['hard-negative']);
    expect(result.admissions.routing.ownerDecision).toBe('rejected');
    expect(result.admissions.exploration.ownerDecision).toBe('rejected');
    expect(() => validateRoutingOutcomeAdmission(result.admissions.routing, {
      role: 'generator', domain: 'p5', model: 'glm/example',
    })).toThrow('ROUTING_OUTCOME_REJECTED_NOT_ADMISSIBLE');
    expect(() => validateExplorationDecisionAdmission(result.admissions.exploration, {
      purpose: 'evolution-reward', artifactId: 'operation-1',
      role: 'generator', domain: 'p5',
    })).toThrow('EXPLORATION_REJECTED_NOT_ADMISSIBLE');
    await expect(port.verifiedOwnerEvidence('create-rejected', 'review-rejected'))
      .rejects.toThrow('LIMINAL_VERIFIED_OWNER_EVIDENCE_INVALID');
  });

  it('cannot mint admissions from degraded owner-review evidence', async () => {
    const authority = { execute: vi.fn(async () => signedCreateResult(true)),
      verifyReceipt: vi.fn(receipt => admissionAuthority.verify(receipt)),
      sealOwnerReviewAdmission: (value: unknown) => admissionSigner.sealAdmission(value) };
    const port = new LiminalProductCommandPort(authority,
      createTestLiminalOwnerReviewAuthority('degraded-owner-review-secret'));
    await port.submitCreate('studio', { schema: 'sinter.liminal-command', schemaVersion: 1,
      kind: 'generate-candidate', idempotencyKey: 'create-degraded' } as never);
    const command = { schema: 'sinter.liminal-owner-review-command' as const,
      schemaVersion: 1 as const, idempotencyKey: 'degraded-review',
      createIdempotencyKey: 'create-degraded', operationId: 'operation-1',
      artifactRootDigest: digest('a'), evidenceRootDigest: digest('b'),
      decision: 'accepted' as const, feedback: 'looks good', criterionDigest: digest('c') };

    await expect(port.submitOwnerReview('studio', command))
      .rejects.toThrow('LIMINAL_OWNER_REVIEW_CREATE_EVIDENCE_INVALID');
  });

  it('cannot mint admissions from a forged create receipt', async () => {
    const signed = signedCreateResult() as Record<string, unknown>;
    const forged = { ...signed, receipt: {
      ...signed.receipt as object, signature: digest('0') } } as never;
    const authority = { execute: vi.fn(async () => forged),
      verifyReceipt: vi.fn(receipt => admissionAuthority.verify(receipt)),
      sealOwnerReviewAdmission: (value: unknown) => admissionSigner.sealAdmission(value) };
    const port = new LiminalProductCommandPort(authority,
      createTestLiminalOwnerReviewAuthority('forged-owner-review-secret'));
    await port.submitCreate('studio', { schema: 'sinter.liminal-command', schemaVersion: 1,
      kind: 'generate-candidate', idempotencyKey: 'create-forged' } as never);
    const review = { schema: 'sinter.liminal-owner-review-command' as const,
      schemaVersion: 1 as const, idempotencyKey: 'review-forged',
      createIdempotencyKey: 'create-forged', operationId: 'operation-1',
      artifactRootDigest: digest('a'), evidenceRootDigest: digest('b'),
      decision: 'accepted' as const, feedback: 'accepted', criterionDigest: digest('c') };
    await expect(port.submitOwnerReview('studio', review))
      .rejects.toThrow('LIMINAL_OWNER_REVIEW_CREATE_EVIDENCE_INVALID');
  });

  describe('judge/scoring evidence as admitted review evidence', () => {
    const make = async (result: unknown, key = 'create-judge') => {
      const authority = { execute: vi.fn(async () => result as never),
        verifyReceipt: vi.fn(receipt => admissionAuthority.verify(receipt)),
        sealOwnerReviewAdmission: (value: unknown) => admissionSigner.sealAdmission(value) };
      const reviewAuthority = createTestLiminalOwnerReviewAuthority('judge-evidence-secret');
      const submit = vi.spyOn(reviewAuthority, 'submit');
      const port = new LiminalProductCommandPort(authority, reviewAuthority);
      await port.submitCreate('cli', { schema: 'sinter.liminal-command', schemaVersion: 1,
        kind: 'generate-candidate', idempotencyKey: key } as never);
      return { port, submit };
    };

    it('admits a signed, rendered, eligible Create at or above the 0.3 positive floor without any review', async () => {
      const { port, submit } = await make(signedCreateResult());
      const evidence = await port.judgeScoringEvidence('create-judge');
      expect(evidence).toMatchObject({ createKey: 'create-judge', decision: 'accepted',
        provenance: 'judge-scoring-evidence', judge: 'grok/example', score: 0.65,
        ruleId: 'judge-score-floor-v2-simon40', artifactDigest: digest('a'),
        evidenceDigest: digest('b'), domain: 'p5', quality: 0.65 });
      expect(evidence.label.trustKind).toBe('judge-scoring');
      expect(evidence.label.allowedUses).toEqual(['few-shot', 'evaluator-training']);
      expect(await port.verifiedJudgeEvidence('create-judge')).toMatchObject({
        ownerReviewKey: expect.stringMatching(/^judge-scoring:[a-f0-9]{64}$/),
        provenance: 'judge-scoring-evidence', decision: 'accepted' });
      expect(submit).not.toHaveBeenCalled();
    });

    it("admits a healthy real Create whose failureClass is 'none'", async () => {
      const { port } = await make(signedCreateResult(false, 0.65, 'none'));
      expect(await port.judgeScoringEvidence('create-judge')).toMatchObject({ decision: 'accepted', score: 0.65 });
    });

    it('records a score below 0.2 as a persisted hard-negative lesson and refuses it as dream evidence', async () => {
      const { port } = await make(signedCreateResult(false, 0.1));
      const evidence = await port.judgeScoringEvidence('create-judge');
      expect(evidence.decision).toBe('rejected');
      expect(evidence.label.allowedUses).toEqual(['hard-negative']);
      const row = judgeNegativeRow(evidence)!;
      expect(isCreativeLabelAdmitted(row.label.creative_label, 'hard-negative')).toBe(true);
      await expect(port.verifiedJudgeEvidence('create-judge')).rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_REJECTED');
    });

    it('treats 0.2 to 0.3 as a gray zone that teaches nothing', async () => {
      for (const score of [0.2, 0.25, 0.2999]) {
        const { port } = await make(signedCreateResult(false, score));
        await expect(port.judgeScoringEvidence('create-judge')).rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_GRAY_ZONE');
      }
    });

    it('L3-15: a real 0.19 Create (not art-admitted) is a hard negative; 0.25 reaches its gray band', async () => {
      const neg = await (await make(lowJudgmentCreate(0.19, ['below-quality-floor']))).port.judgeScoringEvidence('create-judge');
      expect(neg.decision).toBe('rejected');
      expect(neg.label.allowedUses).toEqual(['hard-negative']);
      await expect((await make(lowJudgmentCreate(0.25, ['below-quality-floor']))).port.judgeScoringEvidence('create-judge'))
        .rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_GRAY_ZONE');
    });

    it('L3-15: each signed non-lesson is refused with its specific reason', async () => {
      const cases: Array<[string, unknown, string]> = [
        ['render/containment failure', lowJudgmentCreate(0.1, ['below-quality-floor', 'render-containment-invalid']), 'LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID'],
        ['unadmitted positive', lowJudgmentCreate(0.5, ['audio-floor-failed']), 'LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID'],
        // admissionEligible stays true here, so only an explicit unscored check can refuse it
        ['unscored outage that looks admissible', lowJudgmentCreate(0.1, [], { admissionEligible: true, scoreState: 'unscored', unscoredReason: 'judge timed out' }), 'LIMINAL_JUDGE_EVIDENCE_INFRA_FAILURE'],
        ['unscored outage, not admissible', lowJudgmentCreate(0.1, ['below-quality-floor'], { scoreState: 'unscored', unscoredReason: 'judge timed out' }), 'LIMINAL_JUDGE_EVIDENCE_INFRA_FAILURE'],
      ];
      for (const [label, result, code] of cases) {
        await expect((await make(result)).port.judgeScoringEvidence('create-judge'), label).rejects.toThrow(new RegExp(`^${code}$`));
      }
    });

    it('has no caller-adjustable floor', async () => {
      const { port } = await make(signedCreateResult(false, 0.1));
      expect(port.judgeScoringEvidence.length).toBe(1);
      expect((await (port as any).judgeScoringEvidence('create-judge', { minScore: 0.1 })).decision).toBe('rejected');
      expect(port.verifiedJudgeEvidence.length).toBe(1);
    });

    it('rejects a stored score that the signed receipt does not bind', async () => {
      const signed = signedCreateResult(false, 0.4) as any;
      const edited = { ...signed, evaluation: { ...signed.evaluation, score: 0.99 } };
      const { port } = await make(edited);
      await expect(port.judgeScoringEvidence('create-judge')).rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
    });

    it('rejects historical receipts that bind no evaluation', async () => {
      const signed = signedCreateResult() as any;
      const { evaluationDigest: _drop, ...rest } = signed.receipt;
      const { port } = await make({ ...signed, receipt: { ...rest, signature: digest('0') } });
      await expect(port.judgeScoringEvidence('create-judge')).rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
    });

    // Real pre-#1790 Create (test/fixtures/legacy-receipts): its receipt never carried evaluationDigest.
    // The receipt is re-signed here by the test authority; the fields are the real build's.
    const legacyCreate = (mutate?: (r: any) => void) => {
      const real = Object.values(JSON.parse(readFileSync(
        'test/fixtures/legacy-receipts/legacy-creates.json', 'utf8')) as Record<string, any>)[0];
      const result = JSON.parse(JSON.stringify(real.result));
      mutate?.(result);
      const { schema: _s, schemaVersion: _v, authorityTier: _t, authorityKeyDigest: _k,
        signature: _g, evaluationDigest: _e, ...fields } = result.receipt;
      return { ...real, result: { ...result, receipt: admissionAuthority.project(fields) } };
    };

    it('keeps an honest legacy Create (no evaluationDigest in its scheme) eligible and flags the score as unbound', async () => {
      const legacy = legacyCreate();
      expect(legacy.result.receipt.evaluationDigest).toBeUndefined();
      const { port } = await make({ ...legacy.result });
      const evidence = await port.judgeScoringEvidence('create-judge');
      expect(evidence).toMatchObject({ decision: 'accepted', evaluationBinding: 'legacy-unbound',
        judge: 'glm/glm-5.3', score: legacy.result.evaluation.score });
      const bound = await (await make(signedCreateResult())).port.judgeScoringEvidence('create-judge');
      expect(bound.evaluationBinding).toBe('bound');
    });

    it('cannot turn an unsigned historical score or edited rejection reasons into a hard negative', async () => {
      const legacy = legacyCreate(result => { result.evaluation.score = 0.1; });
      const rejected = lowJudgmentCreate(0.1, ['render-containment-invalid']) as any;
      const altered = { ...rejected,
        evaluation: { ...rejected.evaluation, rejectionReasons: ['below-quality-floor'] } };
      for (const result of [legacy.result, altered, lowJudgmentCreate(0.1, [])]) {
        await expect((await make(result)).port.judgeScoringEvidence('create-judge'))
          .rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
      }
    });

    it('still rejects a legacy Create whose own scheme fails (evidence link broken, tampered signature)', async () => {
      const broken = legacyCreate(r => { r.evaluation.evidenceDigest = digest('9'); });
      await expect((await make({ ...broken.result })).port.judgeScoringEvidence('create-judge'))
        .rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
      const forged = legacyCreate();
      const result = { ...forged.result, receipt: { ...forged.result.receipt, signature: digest('0') } };
      await expect((await make(result)).port.judgeScoringEvidence('create-judge'))
        .rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
    });

    it('rejects a receipt that carries an evaluationDigest the evaluation does not match', async () => {
      const legacy = legacyCreate();
      const { schema: _s, schemaVersion: _v, authorityTier: _t, authorityKeyDigest: _k, signature: _g,
        ...fields } = legacy.result.receipt;
      const receipt = admissionAuthority.project({ ...fields, evaluationDigest: digest('7') });
      await expect((await make({ ...legacy.result, receipt })).port.judgeScoringEvidence('create-judge'))
        .rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
    });

    it('never turns a judge outage or infra failure into a lesson', async () => {
      for (const result of [signedCreateResult(true, 0, 'infra'), signedCreateResult(false, 0.1, 'infra'),
        signedCreateResult(false, 0.1, 'timeout')]) {
        const { port } = await make(result);
        await expect(port.judgeScoringEvidence('create-judge'))
          .rejects.toThrow(/LIMINAL_JUDGE_EVIDENCE_(CREATE_INVALID|INFRA_FAILURE)/);
      }
    });

    it('pins judge identity and rule into the label so judges never mix', async () => {
      const a = await (await make(signedCreateResult())).port.judgeScoringEvidence('create-judge');
      const other = signedCreateResult() as any;
      other.roles = { ...other.roles, evaluator: 'other/judge' };
      other.evaluation = { ...other.evaluation, evaluatorIdentity: 'other/judge' };
      const b = await (await make({ ...other, receipt: admissionAuthority.project({
        ...(({ schema: _s, schemaVersion: _v, authorityTier: _t, authorityKeyDigest: _k, signature: _g, ...r }) => r)(other.receipt),
        evaluationDigest: evaluationBindingDigest(other.evaluation) }) })).port.judgeScoringEvidence('create-judge');
      expect(a.label.decisionDigest).not.toBe(b.label.decisionDigest);
      expect(a.judge).toBe('grok/example'); expect(b.judge).toBe('other/judge');
      expect(a.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('seals legacy backfill rows with the production authority and keeps them out of dream evidence', async () => {
      const { port } = await make(signedCreateResult());
      const row = port.legacyBackfillRow({ sourceBytes: '<html>old</html>', renderDigest: 'd'.repeat(64),
        judge: 'glm-5.3-flash', judgeVersion: 'v1', score: 0.7 });
      expect(verifyLegacyBackfillRow(row)).toBe(true);
      expect(row.label.allowedUses).not.toContain('few-shot');
      await expect(port.verifiedJudgeEvidence('legacy:' + row.fileDigest)).rejects.toThrow();
    });

    it('keeps the authority checks: degraded and forged Creates never become evidence', async () => {
      const degraded = await make(signedCreateResult(true));
      await expect(degraded.port.judgeScoringEvidence('create-judge'))
        .rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
      const signed = signedCreateResult() as Record<string, unknown>;
      const forged = await make({ ...signed, receipt: {
        ...signed.receipt as object, signature: digest('0') } });
      await expect(forged.port.judgeScoringEvidence('create-judge'))
        .rejects.toThrow('LIMINAL_JUDGE_EVIDENCE_CREATE_INVALID');
    });
  });

  it('keeps scheduler and surface ports free of raw authority bypasses', async () => {
    const sources = await Promise.all([
      'src/runtime-core/LiminalProductCommandPort.ts',
      'src/autonomy/AutonomousGardener.ts',
    ].map(file => readFile(path.join(process.cwd(), file), 'utf8')));
    const gardener = sources[1];
    expect(gardener).not.toMatch(/DreamQueue|\.enqueue\(|LLMClient|HeadlessRenderer/);
    for (const forbidden of ['LiminalEffectBroker', 'HeadlessRenderer', 'LLMClient',
      'HarnessMemory', 'CompostMill', 'QualityArchive', 'DreamQueue', 'receipt.sign(']) {
      expect(sources[0]).not.toContain(forbidden);
    }
  });

  it('applies the same governed teaching compiler to Studio and autonomous Create', async () => {
    const execute = vi.fn(async () => ({ operationId: 'one', lineageId: 'one' }) as never);
    const compile = vi.fn(async (command: Record<string, unknown>) => ({
      command: { ...command, prompt: `${command.prompt}\nactivated-principle` },
      receipt: { snapshotDigest: digest('a'), finalProviderInputDigest: digest('b') },
    }));
    const port = new LiminalProductCommandPort({ execute } as never, undefined,
      undefined, { compile } as never);
    const command = { schema: 'sinter.liminal-command' as const, schemaVersion: 1 as const,
      kind: 'generate-candidate' as const, idempotencyKey: 'studio-learning',
      prompt: 'create', teaching: { snapshotDigest: digest('a'), targetScope: 'visual' } } as never;
    const studio = await port.submitCreate('studio', command);
    const autonomous = await port.submitCreate('campaign', { ...command,
      idempotencyKey: 'autonomous-learning' } as never);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(call => call[0].prompt.includes('activated-principle')))
      .toBe(true);
    expect(studio).toMatchObject({ kind: 'create',
      teachingReceipt: { snapshotDigest: digest('a'), finalProviderInputDigest: digest('b') } });
    expect(autonomous).toMatchObject({ kind: 'create',
      teachingReceipt: { snapshotDigest: digest('a'), finalProviderInputDigest: digest('b') } });
  });
});
