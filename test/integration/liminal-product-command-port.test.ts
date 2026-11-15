import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLiminalProductCommandStore, LiminalProductCommandPort }
  from '../../src/runtime-core/LiminalProductCommandPort.js';
import { createTestReceiptAuthority } from
  '../../src/runtime-core/LiminalCommandService.js';
import { createTestCreativeAdmissionSigner } from
  '../../src/runtime-core/CreativeAdmissionAuthority.js';
import { createTestLiminalOwnerReviewAuthority } from
  '../../src/runtime-core/LiminalOwnerReviewAuthority.js';
import { validateRoutingOutcomeAdmission } from
  '../../src/routing/RoutingOutcomeAdmission.js';
import { validateExplorationDecisionAdmission } from
  '../../src/evolution/ExplorationDecisionAdmission.js';

const keyLease = (file: string, key: string) =>
  path.join(`${file}.leases`, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.lease`);
const digest = (char: string) => char.repeat(64);
const admissionAuthority = createTestReceiptAuthority('product-port-test-secret');
const admissionSigner = createTestCreativeAdmissionSigner('product-port-test-secret');
const createResult = (degraded = false) => ({
  operationId: 'operation-1', lineageId: 'lineage-1', domain: 'p5',
  roles: { generator: 'glm/example', evaluator: 'grok/example',
    harness: 'harness/example', studio: 'studio/example' },
  artifacts: { sourceDigest: digest('1'), playableDigest: digest('2'),
    provenanceDigest: digest('3') },
  evidence: { status: 'rendered', evidenceDigest: digest('b'),
    rendererIdentity: 'playwright', earlyFrameDigest: digest('d'),
    lateFrameDigest: digest('e'), runtimeErrors: [],
    audio: { relevant: false, state: 'not-relevant' } },
  evaluation: { score: 0.65, degraded, identityValid: true,
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
const signedCreateResult = (degraded = false) => {
  const base = createResult(degraded) as Record<string, unknown>;
  const receipt = admissionAuthority.project({ operationId: 'operation-1',
    lineageId: 'lineage-1', commandDigest: digest('5'),
    providerInputDigest: digest('6'), artifactDigest: digest('a'),
    evidenceDigest: digest('b'), operationTraceDigest: digest('7'),
    disabledTeachingReaders: [], empiricalContextDigests: [], learningEligible: false });
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
