import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDreamFindingAdmission } from
  '../../../src/dreaming/research/DreamLearningAdmission.js';
import { DreamLearningGateway } from '../../../src/dreaming/research/DreamLearningGateway.js';
import { DreamResearchJournal } from '../../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchService } from '../../../src/dreaming/research/DreamResearchService.js';
import { createDreamDecisionAuthority } from
  '../../../src/dreaming/research/DreamDecisionAuthority.js';
import { frozenExperiment } from './dreamResearchFixtures.js';
import { GovernedCreativeTeachingCompiler } from
  '../../../src/runtime-core/GovernedCreativeTeachingCompiler.js';
import { AuthoredCreativeDoctrineStore } from
  '../../../src/runtime-core/AuthoredCreativeDoctrine.js';
import { LiminalProductCommandPort } from
  '../../../src/runtime-core/LiminalProductCommandPort.js';
import { resolveProductionDreamKeys } from
  '../../../src/runtime-core/ProductionLiminalRuntime.js';
import {
  CreativeKnowledgeConsolidator, FileActivatedKnowledgeStore,
  InMemoryActivatedKnowledgeStore,
  KnowledgeApplication, sealCreativeKnowledgePolicy,
  validateMatchedKnowledgeComparison, verifyActivatedKnowledgeSnapshot,
} from '../../../src/dreaming/research/DreamKnowledgeActivation.js';

const digest = (char: string) => char.repeat(64);
const verifyTestSnapshot = (snapshot: Parameters<typeof verifyActivatedKnowledgeSnapshot>[0]) =>
  verifyActivatedKnowledgeSnapshot(snapshot, 'test-signing-key');
const policy = sealCreativeKnowledgePolicy({ minimumRepetitions: 1,
  minimumIndependentStudies: 1, allowedScopes: ['visual'] });
const finding = { principleIds: ['depth-before-decoration'],
  compilerRules: ['Preserve depth cues before adding surface detail.'],
  scope: ['visual'], contraindications: [], repetitions: 1,
  independentStudyDigests: [digest('1')], compilerRuleVersion: 1 };

function authorized() {
  const decisions = createDreamDecisionAuthority();
  const service = new DreamResearchService(new DreamResearchJournal(':memory:'),
    { assertActive: () => undefined }, decisions.resolver);
  service.plan(frozenExperiment(), 'plan'); service.freeze('dream-1', 1, 'freeze');
  service.recordBaseline('dream-1', 2, 'baseline', digest('b'));
  service.recordVariants('dream-1', 3, 'variants', [digest('c')], [digest('a')]);
  service.compare('dream-1', 4, 'compare', decisions.issuer.issueComparison({
    aggregateId: 'dream-1', outcome: 'keeper', reason: 'depth',
    baselineEvidenceDigest: digest('b'), variantEvidenceDigests: [digest('c')],
    variantArtifactDigests: [digest('a')] }));
  service.freezeTransfer('dream-1', 5, 'transfer-freeze');
  service.recordTransfer('dream-1', 6, 'transfer', digest('d'), digest('e'),
    digest('f'), digest('9'));
  service.validateTransfer('dream-1', 7, 'verdict', decisions.issuer.issueTransfer({
    aggregateId: 'dream-1', outcome: 'validated', treatmentEvidenceDigest: digest('d'),
    controlEvidenceDigest: digest('e'), treatmentArtifactDigest: digest('f'),
    controlArtifactDigest: digest('9') }));
  const events = service.events('dream-1');
  const admission = createDreamFindingAdmission({ aggregateId: 'dream-1',
    findingDigest: events.find(event => event.type === 'finding-proposed')!.eventDigest,
    artifactDigests: [digest('a'), digest('f'), digest('9')],
    evidenceDigests: [digest('b'), digest('c'), digest('d'), digest('e')],
    transferEvidenceDigest: events.find(event => event.type === 'transfer-observed')!.eventDigest,
    state: 'validated' });
  const gateway = new DreamLearningGateway(service);
  return { gateway, capabilities: [gateway.authorize(admission)], candidate: {
    ...finding, transferEvidenceDigests: [admission.transferEvidenceDigest] } };
}

/** Seeds one validated study `id` into a shared service; `art` = [variant, treatment, control]. */
function seedStudy(service: DreamResearchService,
  decisions: ReturnType<typeof createDreamDecisionAuthority>, id: string,
  art: [string, string, string]) {
  const [variant, treatment, control] = art.map(digest) as [string, string, string];
  service.plan({ ...frozenExperiment(), aggregateId: id }, `${id}:plan`);
  service.freeze(id, 1, `${id}:freeze`);
  service.recordBaseline(id, 2, `${id}:baseline`, digest('b'));
  service.recordVariants(id, 3, `${id}:variants`, [digest('c')], [variant]);
  service.compare(id, 4, `${id}:compare`, decisions.issuer.issueComparison({
    aggregateId: id, outcome: 'keeper', reason: 'depth',
    baselineEvidenceDigest: digest('b'), variantEvidenceDigests: [digest('c')],
    variantArtifactDigests: [variant] }));
  service.freezeTransfer(id, 5, `${id}:transfer-freeze`);
  service.recordTransfer(id, 6, `${id}:transfer`, digest('d'), digest('e'), treatment, control);
  service.validateTransfer(id, 7, `${id}:verdict`, decisions.issuer.issueTransfer({
    aggregateId: id, outcome: 'validated', treatmentEvidenceDigest: digest('d'),
    controlEvidenceDigest: digest('e'), treatmentArtifactDigest: treatment,
    controlArtifactDigest: control }));
  const events = service.events(id);
  return createDreamFindingAdmission({ aggregateId: id,
    findingDigest: events.find(event => event.type === 'finding-proposed')!.eventDigest,
    artifactDigests: [variant, treatment, control],
    evidenceDigests: [digest('b'), digest('c'), digest('d'), digest('e')],
    transferEvidenceDigest: events.find(event => event.type === 'transfer-observed')!.eventDigest,
    state: 'validated' });
}

function twoStudies(second: [string, string, string]) {
  const decisions = createDreamDecisionAuthority();
  const service = new DreamResearchService(new DreamResearchJournal(':memory:'),
    { assertActive: () => undefined }, decisions.resolver);
  const admissions = [seedStudy(service, decisions, 'study-a', ['1', '2', '3']),
    seedStudy(service, decisions, 'study-b', second)];
  const gateway = new DreamLearningGateway(service);
  return { gateway, capabilities: admissions.map(item => gateway.authorize(item)),
    candidate: { ...finding, repetitions: 2,
      independentStudyDigests: [digest('5'), digest('6')],
      transferEvidenceDigests: admissions.map(item => item.transferEvidenceDigest) } };
}

const twoStudyPolicy = sealCreativeKnowledgePolicy({ minimumRepetitions: 2,
  minimumIndependentStudies: 2, allowedScopes: ['visual'] });

describe('Dream knowledge activation', () => {
  it('activates two studies from distinct roots with disjoint artifact bytes (#1260)', async () => {
    const { gateway, capabilities, candidate } = twoStudies(['4', '7', '8']);
    const snapshot = await new CreativeKnowledgeConsolidator(
      new InMemoryActivatedKnowledgeStore(), 'test-signing-key', gateway)
      .activate(candidate, twoStudyPolicy, capabilities);
    expect(snapshot.admissionDigests).toHaveLength(2);
    expect(snapshot.independentStudyDigests).toEqual([digest('5'), digest('6')]);
  });

  it('rejects studies sharing artifact bytes despite distinct study digests (#1260)', async () => {
    // study-b re-uses study-a's variant artifact: one root rewrapped under new hashes.
    const { gateway, capabilities, candidate } = twoStudies(['1', '7', '8']);
    await expect(new CreativeKnowledgeConsolidator(
      new InMemoryActivatedKnowledgeStore(), 'test-signing-key', gateway)
      .activate(candidate, twoStudyPolicy, capabilities))
      .rejects.toThrow('KNOWLEDGE_INDEPENDENCE_POLICY_FAILED');
  });

  it('persists activation and rollback across process-shaped store restarts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-knowledge-'));
    try {
      const file = path.join(root, 'activated.json');
      const { gateway, capabilities, candidate } = authorized();
      const snapshot = await new CreativeKnowledgeConsolidator(
        new FileActivatedKnowledgeStore(file), 'test-signing-key', gateway)
        .activate(candidate, policy, capabilities);
      const restarted = new FileActivatedKnowledgeStore(file);
      expect(restarted.read(snapshot.snapshotDigest)).toEqual(snapshot);
      expect(restarted.isActive(snapshot.snapshotDigest)).toBe(true);
      restarted.rollback(snapshot.snapshotDigest, 'owner rollback');
      expect(new FileActivatedKnowledgeStore(file).isActive(snapshot.snapshotDigest)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets Consolidate alone create an immutable signed scoped snapshot', async () => {
    const store = new InMemoryActivatedKnowledgeStore();
    const { gateway, capabilities, candidate } = authorized();
    const consolidator = new CreativeKnowledgeConsolidator(store, 'test-signing-key', gateway);
    const snapshot = await consolidator.activate(candidate, policy, capabilities);
    expect(snapshot.status).toBe('active');
    expect(snapshot.scope).toEqual(['visual']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(consolidator.verify(snapshot)).toBe(true);
    expect(consolidator.verify({ ...snapshot,
      compilerRules: ['tampered'] })).toBe(false);
    await expect(consolidator.activate({ ...candidate, repetitions: 0 }, policy, []))
      .rejects.toThrow('KNOWLEDGE_REPETITION_POLICY_FAILED');
  });

  it('rejects dependent studies, forbidden scope, and contraindications', async () => {
    const { gateway, capabilities, candidate } = authorized();
    const consolidator = new CreativeKnowledgeConsolidator(
      new InMemoryActivatedKnowledgeStore(), 'test-signing-key', gateway);
    await expect(consolidator.activate({ ...candidate,
      independentStudyDigests: [] }, policy, capabilities))
      .rejects.toThrow('KNOWLEDGE_INDEPENDENCE_POLICY_FAILED');
    await expect(consolidator.activate({ ...candidate, scope: ['audio'] }, policy, capabilities))
      .rejects.toThrow('KNOWLEDGE_SCOPE_POLICY_FAILED');
    await expect(consolidator.activate({ ...candidate,
      contraindications: ['motion-sickness'] }, policy, capabilities))
      .rejects.toThrow('KNOWLEDGE_CONTRAINDICATION_POLICY_FAILED');
  });

  it('binds exact activation and transformation into later Create input', async () => {
    const store = new InMemoryActivatedKnowledgeStore();
    const { gateway, capabilities, candidate } = authorized();
    const keys = resolveProductionDreamKeys('test-signing-key', 'distinct-holdout-key');
    const snapshot = await new CreativeKnowledgeConsolidator(
      store, keys.knowledgeSigningKey, gateway)
      .activate(candidate, policy, capabilities);
    const result = new KnowledgeApplication(store, verifyTestSnapshot).apply({ snapshotDigest:
      snapshot.snapshotDigest, targetScope: 'visual', basePlan: { prompt: 'Make depth' },
      providerInput: 'Make depth' });
    expect(result.snapshotDigest).toBe(snapshot.snapshotDigest);
    expect(result.principleIds).toEqual(['depth-before-decoration']);
    expect(result.prePlanDigest).not.toBe(result.postPlanDigest);
    expect(result.finalProviderInputDigest).toBe(createHash('sha256')
      .update(result.finalProviderInput).digest('hex'));
    expect(result.transformationDelta).toContain('Preserve depth cues');
    const tamperedStore = { read: () => ({ ...snapshot, signature: digest('0') }),
      isActive: () => true, save: () => undefined, rollback: () => undefined };
    expect(() => new KnowledgeApplication(tamperedStore, verifyTestSnapshot).apply({
      snapshotDigest: snapshot.snapshotDigest, targetScope: 'visual',
      basePlan: {}, providerInput: 'must fail' }))
      .toThrow('KNOWLEDGE_SNAPSHOT_AUTHORITY_INVALID');
  });

  it('requires matched multi-task applied wins and permits rollback', async () => {
    const store = new InMemoryActivatedKnowledgeStore();
    const { gateway, capabilities, candidate } = authorized();
    const consolidator = new CreativeKnowledgeConsolidator(store, 'test-signing-key', gateway);
    const snapshot = await consolidator.activate(candidate, policy, capabilities);
    const application = new KnowledgeApplication(store, verifyTestSnapshot);
    const applied = ['task-a', 'task-b'].map(taskId => application.apply({
      snapshotDigest: snapshot.snapshotDigest, targetScope: 'visual',
      basePlan: { taskId }, providerInput: taskId,
    }));
    expect(validateMatchedKnowledgeComparison({ snapshotDigest: snapshot.snapshotDigest,
      frozenAssignmentDigest: digest('f'), trials: applied.map((receipt, index) => ({
        taskId: `task-${index}`, receipt, controlScore: 0.5,
        treatmentScore: 0.7, vetoedRegression: false,
      })) })).toEqual({ valid: true, wins: 2, losses: 0, ties: 0,
      signTestPValue: 0.25, statisticallyConfirmed: false });
    expect(() => validateMatchedKnowledgeComparison({
      snapshotDigest: snapshot.snapshotDigest, frozenAssignmentDigest: digest('f'),
      trials: [{ taskId: 'only', receipt: applied[0], controlScore: 0.5,
        treatmentScore: 0.7, vetoedRegression: false }] }))
      .toThrow('KNOWLEDGE_MATCHED_MULTI_TASK_REQUIRED');
    consolidator.rollback(snapshot.snapshotDigest, 'owner rollback');
    expect(() => application.apply({ snapshotDigest: snapshot.snapshotDigest,
      targetScope: 'visual', basePlan: {}, providerInput: 'later' }))
      .toThrow('KNOWLEDGE_SNAPSHOT_INACTIVE');
  });

  it('fails closed on leakage, unapplied bindings, stochastic wins, and regressions', async () => {
    const store = new InMemoryActivatedKnowledgeStore();
    const { gateway, capabilities, candidate } = authorized();
    const snapshot = await new CreativeKnowledgeConsolidator(
      store, 'test-signing-key', gateway).activate(candidate, policy, capabilities);
    const receipts = ['a', 'b'].map(taskId => new KnowledgeApplication(
      store, verifyTestSnapshot).apply({
      snapshotDigest: snapshot.snapshotDigest, targetScope: 'visual',
      basePlan: { taskId }, providerInput: taskId }));
    const base = { snapshotDigest: snapshot.snapshotDigest,
      frozenAssignmentDigest: digest('f'), trials: receipts.map((receipt, index) => ({
        taskId: `task-${index}`, receipt, controlScore: 0.5,
        treatmentScore: 0.7, vetoedRegression: false })) };
    expect(() => validateMatchedKnowledgeComparison({ ...base, trials: base.trials.map(
      (trial, index) => index ? trial : { ...trial, ambientSnapshotDigests: [digest('0')] }) }))
      .toThrow('KNOWLEDGE_AMBIENT_LEAKAGE');
    expect(() => validateMatchedKnowledgeComparison({ ...base, trials: base.trials.map(
      (trial, index) => index ? trial : { ...trial, receipt: { ...trial.receipt,
        postPlanDigest: trial.receipt.prePlanDigest } }) }))
      .toThrow('KNOWLEDGE_SNAPSHOT_BOUND_BUT_UNAPPLIED');
    expect(() => validateMatchedKnowledgeComparison({ ...base, trials: base.trials.map(
      (trial, index) => index ? { ...trial, treatmentScore: 0.4 } : trial) }))
      .toThrow('KNOWLEDGE_SINGLE_STOCHASTIC_WIN');
    expect(() => validateMatchedKnowledgeComparison({ ...base, trials: base.trials.map(
      (trial, index) => index ? trial : { ...trial, vetoedRegression: true }) }))
      .toThrow('KNOWLEDGE_REGRESSION_VETOED');
  });

  it('separates the two-win screen from statistical confirmation (#1261)', async () => {
    const store = new InMemoryActivatedKnowledgeStore();
    const { gateway, capabilities, candidate } = authorized();
    const snapshot = await new CreativeKnowledgeConsolidator(
      store, 'test-signing-key', gateway).activate(candidate, policy, capabilities);
    const application = new KnowledgeApplication(store, verifyTestSnapshot);
    const trials = (scores: Array<[number, number]>) => scores.map(([control, treatment],
      index) => ({ taskId: `task-${index}`, receipt: application.apply({
      snapshotDigest: snapshot.snapshotDigest, targetScope: 'visual',
      basePlan: { taskId: `task-${index}` }, providerInput: `task-${index}` }),
      controlScore: control, treatmentScore: treatment, vetoedRegression: false }));
    const compare = (scores: Array<[number, number]>) => validateMatchedKnowledgeComparison({
      snapshotDigest: snapshot.snapshotDigest, frozenAssignmentDigest: digest('f'),
      trials: trials(scores) });

    // Two wins buried under eight losses used to pass as "valid".
    expect(() => compare([[0.5, 0.7], [0.5, 0.7],
      ...Array.from({ length: 8 }, () => [0.7, 0.5] as [number, number])]))
      .toThrow('KNOWLEDGE_NO_NET_BENEFIT');
    // Five of five wins clears the one-sided sign test (p = 1/32).
    expect(compare(Array.from({ length: 5 }, () => [0.5, 0.7] as [number, number])))
      .toEqual({ valid: true, wins: 5, losses: 0, ties: 0, signTestPValue: 0.03125,
        statisticallyConfirmed: true });
    // Ties are excluded from the sign test: 3 wins, 1 loss, 1 tie -> p = 5/16.
    expect(compare([[0.5, 0.7], [0.5, 0.7], [0.5, 0.7], [0.7, 0.5], [0.5, 0.5]]))
      .toMatchObject({ wins: 3, losses: 1, ties: 1, signTestPValue: 0.3125,
        statisticallyConfirmed: false });
  });

  it('rejects legacy episode teaching and compiles only the activated snapshot', async () => {
    const store = new InMemoryActivatedKnowledgeStore();
    const { gateway, capabilities, candidate } = authorized();
    const snapshot = await new CreativeKnowledgeConsolidator(
      store, 'test-signing-key', gateway).activate(candidate, policy, capabilities);
    const compiler = new GovernedCreativeTeachingCompiler(
      new KnowledgeApplication(store, verifyTestSnapshot));
    const command = { prompt: 'create', domain: 'html', layers: ['depth'],
      teaching: { snapshotDigest: snapshot.snapshotDigest, targetScope: 'visual' } } as never;
    const compiled = await compiler.compile(command);
    expect(compiled.command.prompt).toContain('Preserve depth cues');
    expect(compiled.receipt.finalProviderInputDigest).toBe(createHash('sha256')
      .update(compiled.command.prompt).digest('hex'));
    await expect(compiler.compile({ ...command, teaching: { ...command.teaching,
      legacyEpisodeIds: ['failed-episode'] } } as never))
      .rejects.toThrow('LIMINAL_TEACHING_CATEGORY_UNCLASSIFIED');
  });

  it('binds distinct doctrine and empirical digests for chat and autonomous Create', async () => {
    const store = new InMemoryActivatedKnowledgeStore();
    const { gateway, capabilities, candidate } = authorized();
    const snapshot = await new CreativeKnowledgeConsolidator(
      store, 'test-signing-key', gateway).activate(candidate, policy, capabilities);
    const doctrineStore = new AuthoredCreativeDoctrineStore();
    const doctrine = doctrineStore.register({ version: 1,
      sourceReviewDigest: digest('4'), scope: ['visual'],
      principles: ['Depth is structural.'], promptContracts: ['Keep occlusion coherent.'],
      vocabulary: ['occlusion'] }).record;
    const execute = vi.fn(async () => ({ operationId: 'one', lineageId: 'one' }) as never);
    const port = new LiminalProductCommandPort({ execute } as never, undefined, undefined,
      new GovernedCreativeTeachingCompiler(
        new KnowledgeApplication(store, verifyTestSnapshot), doctrineStore));
    const base = { prompt: 'create', domain: 'html', layers: ['depth'], teaching: {
      targetScope: 'visual', snapshotDigest: snapshot.snapshotDigest,
      doctrineDigest: doctrine.doctrineDigest } } as never;
    const chat = await port.submitCreate('chat', { ...base, idempotencyKey: 'chat' } as never);
    const autonomous = await port.submitCreate('campaign',
      { ...base, idempotencyKey: 'campaign' } as never);
    for (const projection of [chat, autonomous]) {
      expect(projection.kind === 'create'
        && projection.teachingReceipt?.doctrine?.doctrineDigest).toBe(doctrine.doctrineDigest);
      expect(projection.kind === 'create'
        && projection.teachingReceipt?.empirical?.snapshotDigest).toBe(snapshot.snapshotDigest);
    }
    expect(doctrineStore.list()).toEqual([doctrine]);
  });
});
