import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryActivatedKnowledgeStore, KnowledgeApplication,
  type ActivatedKnowledgeSnapshot } from '../../src/dreaming/research/DreamKnowledgeActivation.js';
import { GovernedCreativeTeachingCompiler }
  from '../../src/runtime-core/GovernedCreativeTeachingCompiler.js';
import { InMemoryLiminalArtifactStore, InMemoryLiminalOperationJournal,
  LiminalCommandService, createTestReceiptAuthority, type LiminalCreativeCommand }
  from '../../src/runtime-core/LiminalCommandService.js';
import { LiminalProductCommandPort, MemoryLiminalProductCommandStore }
  from '../../src/runtime-core/LiminalProductCommandPort.js';
import { CompoundCreateProofPort, compoundCreateExecutionContextDigest,
  sealCompoundCreatePolicy,
  type CompoundCreateJudge, type CompoundCreateJudgment,
  type CompoundCreateProjection }
  from '../../src/runtime-core/CompoundCreateProofPort.js';
import { FileDreamProjectionStore, type DreamActivationProjection }
  from '../../src/runtime-core/DreamTransferActivationPort.js';
import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';

const hex = (char: string) => char.repeat(64);
const hash = (value: unknown) => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');
const snapshot: ActivatedKnowledgeSnapshot = Object.freeze({
  schema: 'sinter.activated-creative-knowledge', schemaVersion: 1, status: 'active',
  admissionDigest: hex('1'), admissionDigests: [hex('1'), hex('4')], repetitions: 2,
  independentStudyDigests: [hex('8'), hex('9')],
  transferEvidenceDigests: [hex('6'), hex('7')], contraindications: [],
  compilerRuleVersion: 1, principleIds: ['depth'], compilerRules: ['layer depth'],
  scope: ['visual'], policyDigest: hex('2'), snapshotDigest: hex('a'), signature: hex('3'),
});

const activationProjection = Object.freeze({ kind: 'dream-activation', status: 'completed',
  commandDigest: hex('4'), activationPolicyDigest: hex('5'),
  transferProjectionDigests: [hex('6'), hex('7')],
  independentStudyDigests: [hex('8'), hex('9')], snapshot }) as DreamActivationProjection;

function judge(identity: string, treatmentArms: ReadonlySet<string>,
  delta = 0.2): CompoundCreateJudge {
  const sign = (judgment: Omit<CompoundCreateJudgment, 'signature'>,
    input: unknown) => hash({ identity, judgment, input });
  return { identityDigest: identity,
    compare: async input => {
      const armScores = Object.fromEntries(input.arms.map(arm => [arm.armId,
        treatmentArms.has(arm.armId) ? 0.6 + delta : 0.6]));
      const body = { judgeIdentityDigest: identity, criterionDigest: hex('c'), armScores };
      return Object.freeze({ ...body, signature: sign(body, input) });
    },
    verify: (judgment, input) => {
      const { signature, ...body } = judgment;
      return signature === sign(body, input);
    } };
}

function createCommand(input: { prompt: string; domain: string; layers: readonly string[];
  maxTransportAttempts: number;
  teaching?: LiminalCreativeCommand['teaching'] }): LiminalCreativeCommand {
  const authorityPackageDigest = hash(input);
  return Object.freeze({ schema: 'sinter.liminal-command', schemaVersion: 1,
    kind: 'generate-candidate', idempotencyKey: `compound:${authorityPackageDigest}`,
    prompt: input.prompt, domain: input.domain, layers: input.layers,
    sourceHeadSha: 'c'.repeat(40), canonicalMainSha: 'd'.repeat(40),
    authorityPackageDigest, maxTransportAttempts: input.maxTransportAttempts,
    evalMode: 'strict-browser', safeMode: 'governed-production',
    roles: { generator: 'fake/generator', evaluator: 'fake/evaluator',
      harness: 'fake/harness', studio: 'fake/studio' },
    rendererIdentity: 'fake-renderer/v1', renderAuthorization: 'test-fake',
    ...(input.teaching ? { teaching: input.teaching } : {}) });
}

function fixture(root: string, deltas: readonly [number, number] = [0.2, 0.18]) {
  const generatedPrompts: string[] = [];
  const knowledge = new InMemoryActivatedKnowledgeStore(); knowledge.save(snapshot);
  const journal = new InMemoryLiminalOperationJournal();
  const service = new LiminalCommandService({ effects: {
    generate: async input => { await input.startTransport();
      generatedPrompts.push(input.prompt); return { source: input.prompt,
        playable: `<html>${input.prompt}</html>`, provenance: 'fake-transport' }; },
    render: async input => ({ status: 'rendered', rendererIdentity: 'fake-renderer/v1',
      earlyFrame: Buffer.from(`early:${input.playable}`),
      lateFrame: Buffer.from(`late:${input.playable}`), runtimeErrors: [],
      audio: { relevant: false, state: 'not-applicable' } }),
    evaluate: async input => { await input.startTransport(); return { score: 0.7,
      degraded: false, identityValid: true, evaluatorIdentity: input.identity,
      evidenceDigest: input.evidenceDigest }; },
  }, artifacts: new InMemoryLiminalArtifactStore(),
  journal,
  authority: createTestReceiptAuthority('compound-test') });
  const product = new LiminalProductCommandPort(service, undefined,
    new MemoryLiminalProductCommandStore(),
    new GovernedCreativeTeachingCompiler(
      new KnowledgeApplication(knowledge, candidate => candidate === snapshot)));
  const policy = sealCompoundCreatePolicy({ tasks: [
    { taskId: 'unseen-a', prompt: 'task a', domain: 'html', layers: ['depth'],
      targetScope: 'visual', maxTransportAttempts: 2 },
    { taskId: 'unseen-b', prompt: 'task b', domain: 'html', layers: ['motion'],
      targetScope: 'visual', maxTransportAttempts: 2 }], assignments: [
    { taskId: 'unseen-a', firstArmId: 'opaque-1', secondArmId: 'opaque-2',
      treatmentPosition: 0 },
    { taskId: 'unseen-b', firstArmId: 'opaque-3', secondArmId: 'opaque-4',
      treatmentPosition: 1 }], judgeIdentityDigests: [hex('e'), hex('f')],
  criterionDigest: hex('c'),
  executionContextDigest: compoundCreateExecutionContextDigest(createCommand({
    prompt: 'context', domain: 'html', layers: ['context'], maxTransportAttempts: 2 })),
  minimumEffectSize: 0.1, maximumJudgeDisagreement: 0.1,
  regressionVetoThreshold: 0.1, aggregation: 'mean-delta', sampleCount: 2,
  minimumTaskWins: 2 });
  const activation = { run: vi.fn(async () => activationProjection) };
  const judges = [judge(hex('e'), new Set(['opaque-1', 'opaque-4']), deltas[0]),
    judge(hex('f'), new Set(['opaque-1', 'opaque-4']), deltas[1])] as const;
  const store = new FileDreamProjectionStore<CompoundCreateProjection>(
    path.join(root, 'compound.json'));
  const build = () => new CompoundCreateProofPort({ product,
    activation: activation as never, createCommand, judges }, policy, store);
  const command = { schema: 'sinter.compound-create-command' as const, schemaVersion: 1 as const,
    idempotencyKey: 'compound-proof', activation: {
      schema: 'sinter.dream-activation-command' as const, schemaVersion: 1 as const,
      idempotencyKey: 'activation', transferKeys: ['transfer-a', 'transfer-b'] } };
  return { build, command, generatedPrompts, product, activation, journal };
}

describe('later Create compound-gain product path', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('proves matched multi-task gain through real Create with zero network', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compound-create-')); roots.push(root);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const f = fixture(root);
    const result = await f.build().run(f.command);

    expect(result.outcome).toBe('compound-proven');
    expect(result.trials).toHaveLength(2);
    expect(result.aggregateEffect).toBeCloseTo(0.19);
    expect(f.generatedPrompts).toHaveLength(4);
    expect(f.generatedPrompts.filter(prompt =>
      prompt.includes('Activated creative principles:'))).toHaveLength(2);
    const durableEffects = f.journal.events().filter(event => event.type === 'effect-result');
    expect(durableEffects).toHaveLength(16);
    expect(f.journal.events().filter(event => event.type === 'transport-started')).toHaveLength(12);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('binds judge source and Dream evidence to the signed command after teaching', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compound-create-')); roots.push(root);
    const f = fixture(root);
    const command = createCommand({ prompt: 'taught depth study', domain: 'html', layers: ['depth'],
      maxTransportAttempts: 2, teaching: { targetScope: 'visual', snapshotDigest: snapshot.snapshotDigest } });

    const create = await f.product.submitCreate('cli', command);
    const signedCommand = create.result.receipt.commandDigest;
    expect(create.commandDigest).not.toBe(signedCommand);
    const bound = await f.product.readBoundJudgeSource(command.idempotencyKey);
    expect(bound.source).toContain('Activated creative principles:');
    expect(bound.evidence.createCommandDigest).toBe(signedCommand);
    const dreamEvidence = await f.product.verifiedJudgeEvidence(command.idempotencyKey, true);
    expect(dreamEvidence.createCommandDigest).toBe(signedCommand);
  });

  it('replays the durable terminal projection without another Create effect', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compound-create-')); roots.push(root);
    const f = fixture(root);
    const first = await f.build().run(f.command);
    const generated = f.generatedPrompts.length;
    const replay = await f.build().run(f.command);
    expect(replay).toEqual(first);
    expect(f.generatedPrompts).toHaveLength(generated);
  });

  it('routes Studio composition through one rendered product Create', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compound-create-')); roots.push(root);
    const f = fixture(root);
    const mint = vi.fn(createCommand);
    const bridge = new TuiBridgeService({ productCommands: f.product,
      productCreateCommand: mint });
    await expect(bridge.submitStudioCreate({ prompt: 'smuggle', domain: 'html',
      layers: ['depth'], authorityPackageDigest: hex('f') } as never))
      .rejects.toThrow('STUDIO_CREATE_INTENT_INVALID');
    const direct = await bridge.submitStudioCreate({ prompt: 'host mint', domain: 'html',
      layers: ['depth'] });
    expect(direct.kind).toBe('create');
    expect(mint).toHaveBeenCalledWith({ prompt: 'host mint', domain: 'html',
      layers: ['depth'], maxTransportAttempts: 2 });
    const result = await bridge.composeStudioLayersGoverned({ title: 'Depth study', layers: [
      { domain: 'html', prompt: 'base plane' },
      { domain: 'shader', prompt: 'light volume', blendMode: 'screen', opacity: 0.5 },
    ] });
    expect(result.renderGate.verdict).toBe('ok');
    expect(result.html).toContain('Create one cohesive playable layered composition.');
    expect(result.productProjection.result.evidence.status).toBe('rendered');
    expect(f.generatedPrompts).toHaveLength(2);
    bridge.destroy();
  });

  it('routes the primary Studio creative submit through host-minted Product Create', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studio-primary-create-'));
    roots.push(root);
    const f = fixture(root);
    const mint = vi.fn(createCommand);
    const bridge = new TuiBridgeService({ productCommands: f.product,
      productCreateCommand: mint });
    const session = bridge.createSession();

    await bridge.submitInput(session.sessionId, { mode: 'chat', clientIntent: 'creative',
      text: 'Create a layered HTML depth study with translucent moving planes.' },
    { getConfig: () => ({ provider: 'fake-transport', model: 'router-only' }) } as never);
    await vi.waitFor(() => expect(f.generatedPrompts).toHaveLength(1));

    expect(mint).toHaveBeenCalledTimes(1);
    expect(bridge.getEvents(session.sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'generation.complete',
        reason: 'governed-product-create', executionMode: 'prove' }),
      expect.objectContaining({ type: 'session.turn', delegatedTo: 'product-command' }),
    ]));
    bridge.destroy();
  });

  it.each([
    { deltas: [0.2, -0.2] as const, outcome: 'regressed' },
    { deltas: [0.12, 0.01] as const, outcome: 'uncertain' },
  ])('records $outcome instead of claiming gain', async ({ deltas, outcome }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compound-create-')); roots.push(root);
    const f = fixture(root, deltas);
    expect((await f.build().run(f.command)).outcome).toBe(outcome);
  });
});
