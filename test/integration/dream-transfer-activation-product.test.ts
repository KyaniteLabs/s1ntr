import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DreamHoldoutVault, FileDreamHoldoutVault }
  from '../../src/dreaming/research/DreamHoldoutVault.js';
import { createDreamDecisionAuthority } from '../../src/dreaming/research/DreamDecisionAuthority.js';
import { DreamResearchJournal } from '../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchService } from '../../src/dreaming/research/DreamResearchService.js';
import { DreamTransferRunner } from '../../src/dreaming/research/DreamTransferRunner.js';
import { createDreamRenderedEvidenceAuthority } from
  '../../src/dreaming/research/DreamResearchEvidence.js';
import { CreativeKnowledgeConsolidator, FileActivatedKnowledgeStore,
  sealCreativeKnowledgePolicy } from '../../src/dreaming/research/DreamKnowledgeActivation.js';
import { DreamLearningGateway } from '../../src/dreaming/research/DreamLearningGateway.js';
import { FileDreamProductProjectionStore, type DreamProductProjection }
  from '../../src/runtime-core/DreamProductCommandPort.js';
import { DreamActivationCommandPort, DreamTransferCommandPort, FileDreamProjectionStore,
  sealDreamActivationPolicy, type DreamTransferProjection }
  from '../../src/runtime-core/DreamTransferActivationPort.js';

const hex = (char: string) => char.repeat(64);
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

const rendered = createDreamRenderedEvidenceAuthority('transfer-render-secret');
const pixelFrames = ['pixel-early', 'pixel-late'].map(dataBase64 => ({ mimeType: 'image/png',
  dataBase64, digest: createHash('sha256').update(dataBase64).digest('hex') }));
const observed = (artifactDigest: string) => ({ artifactDigest,
  playableDigest: hex('b'), rendererEnvironmentDigest: hex('c'), runtimeErrors: [],
  degraded: false, identityValid: true, digestMatched: true,
  frames: pixelFrames.map(frame => frame.digest), pixelFrames, temporalSamples: [hex('f')],
  containment: { networkIsolated: true, permissionsDenied: true,
    resourceLimitsObserved: true, cleanupSucceeded: true, outputBytes: 1,
    assetDigests: [], runtimeDigest: hex('7'), postRunCensus: { durationMs: 1,
      usedHeapBytes: 1, eventListeners: 0, eventsDispatched: 0, timers: 0,
      audioContexts: 0, pagesBefore: 0, pagesAfter: 0 } } });

function projection(id: string, parent: string, source: string,
  commitment: string): DreamProductProjection {
  const plan = { aggregateId: id, schemaVersion: 1 as const, campaignId: 'campaign',
    hypothesis: { id: 'depth-principle', statement: 'depth survives transfer',
      principle: 'preserve spatial depth', expectedEffect: 'stronger hierarchy' },
    context: { sourceDigests: [source], knowledgeProfileDigest: hex('1'),
      parentSetDigest: parent, operatorDigest: hex('2'), policyDigest: hex('3'),
      rendererEnvironmentDigest: hex('4'), evaluatorManifestDigests: [hex('5'), hex('6')],
      transferCommitmentDigest: commitment, liminalParentBindings: [{
        createKey: `create-${id}`, ownerReviewKey: `review-${id}`,
        operationId: `operation-${id}`, lineageId: `lineage-${id}`,
        createCommandDigest: hex('a'), createReceiptDigest: hex('b'),
        reviewCommandDigest: hex('c'), reviewDecisionDigest: hex('d'),
        reviewReceiptDigest: hex('e'), artifactDigest: source, evidenceDigest: hex('f'),
      }] }, budget: { maximumAttempts: 4 },
    requiredModalities: ['visual' as const], lease: { token: 'lease', fencingSequence: 1 } };
  return { kind: 'dream-research', status: 'completed', commandDigest: digest(id),
    researchPlan: { schema: 'sinter.dream-research-plan', schemaVersion: 1,
      revision: 1, mode: 'explore', planDigest: 'depth-principle', hypothesis: 'depth',
      criterion: 'hierarchy', domains: ['visual'], parentEvidenceDigests: [source],
      operators: ['ablation'], budget: { maxCandidates: 1, maxProviderAttempts: 4 },
      stopRules: ['bounded'], neighborhoodKey: 'depth', saturation: {
        repeatedNeighborhood: false, previousNegativeOutcomes: 0 } },
    experimentPlan: plan, outcome: 'keeper', state: 'finding-proposed' };
}

function seedKeeper(service: DreamResearchService,
  decisions: ReturnType<typeof createDreamDecisionAuthority>, dream: DreamProductProjection): void {
  const id = dream.experimentPlan.aggregateId;
  service.plan(dream.experimentPlan, `${id}:plan`);
  service.freeze(id, 1, `${id}:freeze`);
  service.recordBaseline(id, 2, `${id}:baseline`, hex('8'));
  service.recordVariants(id, 3, `${id}:variants`, [hex('9')], [digest(`${id}:origin`)]);
  service.compare(id, 4, `${id}:compare`, decisions.issuer.issueComparison({ aggregateId: id,
    outcome: 'keeper', reason: 'rendered improvement', baselineEvidenceDigest: hex('8'),
      variantEvidenceDigests: [hex('9')], variantArtifactDigests: [digest(`${id}:origin`)] }));
}

function validateStudy(service: DreamResearchService,
  decisions: ReturnType<typeof createDreamDecisionAuthority>, dream: DreamProductProjection) {
  const id = dream.experimentPlan.aggregateId;
  const treatmentEvidenceDigest = digest(`${id}:treatment-evidence`);
  const controlEvidenceDigest = digest(`${id}:control-evidence`);
  const treatmentArtifactDigest = digest(`${id}:treatment-artifact`);
  const controlArtifactDigest = digest(`${id}:control-artifact`);
  service.freezeTransfer(id, 5, `${id}:transfer-freeze`);
  service.recordTransfer(id, 6, `${id}:transfer-observed`, treatmentEvidenceDigest,
    controlEvidenceDigest, treatmentArtifactDigest, controlArtifactDigest);
  service.validateTransfer(id, 7, `${id}:transfer-verdict`, decisions.issuer.issueTransfer({
    aggregateId: id, outcome: 'validated', treatmentEvidenceDigest, controlEvidenceDigest,
    treatmentArtifactDigest, controlArtifactDigest }));
  return service.events(id).find(event => event.type === 'transfer-observed')!;
}

// Output depends on the study's own holdout, so two studies never share bytes (#1260).
const producer = { produce: vi.fn(async (input: { holdout: string;
  findingDigest: string | null }) => ({
  id: input.findingDigest ? 'treatment' : 'control',
  source: input.findingDigest ? `${input.holdout}:with:${input.findingDigest}`
    : `${input.holdout}:without`,
  graphDigest: digest(input.findingDigest ? 'treatment' : 'control'),
  layerIds: ['one'], domains: ['html'] })) };
const observer = { observe: vi.fn(async (candidate: { source: string }) => {
  const evidence = observed(digest(candidate.source));
  rendered.issuer.attest(evidence);
  return evidence;
}) };
const evaluators = [{ identity: { identityDigest: hex('5'), hostDigest: hex('a') },
  compare: vi.fn(async () => 'validated' as const) },
{ identity: { identityDigest: hex('6'), hostDigest: hex('b') },
  compare: vi.fn(async () => 'validated' as const) }] as const;

describe('Dream transfer and activation product path', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('survives restart and activates only repeated independent validated studies', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const root = await mkdtemp(path.join(tmpdir(), 'dream-product-transfer-')); roots.push(root);
    const db = path.join(root, 'research.sqlite');
    const journal = new DreamResearchJournal(db);
    const decisions = createDreamDecisionAuthority();
    const service = new DreamResearchService(journal, { assertActive: () => undefined },
      decisions.resolver);
    const dreamStore = new FileDreamProductProjectionStore(path.join(root, 'dreams.json'));
    const transferStore = new FileDreamProjectionStore<DreamTransferProjection>(
      path.join(root, 'transfers.json'));
    const protocol = { originContextDigest: hex('c'), controlContextDigest: hex('d'),
      treatmentContextDigest: hex('d'), findingDigest: hex('e'), controlFindingDigest: null,
      treatmentFindingDigest: hex('e') };
    const vaultA = new FileDreamHoldoutVault(path.join(root, 'holdout-a.json'), 'host-key');
    const holdoutA = vaultA.precommit('a', 'unseen-a', { selectorDigest: hex('1'),
      custodianDigest: hex('2'), protocol });
    const dreamA = projection('dream-a', hex('3'), digest('source-a'),
      holdoutA.commitment.commitmentDigest);
    await dreamStore.write('dream-a-key', dreamA);
    seedKeeper(service, decisions, dreamA);
    const runnerA = new DreamTransferRunner(service, vaultA, decisions.issuer, observer,
      rendered.resolver);
    const transferPort = new DreamTransferCommandPort(dreamStore, service, runnerA,
      { holdout: holdoutA, producer, observer, evaluators }, transferStore);
    const transferCommand = { schema: 'sinter.dream-transfer-command' as const,
      schemaVersion: 1 as const, idempotencyKey: 'transfer-a', dreamKey: 'dream-a-key' };
    const resultA = await transferPort.run(transferCommand);
    expect(resultA.outcome).toBe('validated');
    expect(service.snapshot('dream-a').attemptsStarted).toBe(4);

    const vaultB = new FileDreamHoldoutVault(path.join(root, 'holdout-b.json'), 'host-key');
    const holdoutB = vaultB.precommit('b', 'unseen-b', { selectorDigest: hex('1'),
      custodianDigest: hex('2'), protocol });
    const dreamB = projection('dream-b', hex('4'), digest('source-b'),
      holdoutB.commitment.commitmentDigest);
    await dreamStore.write('dream-b-key', dreamB);
    seedKeeper(service, decisions, dreamB);
    await new DreamTransferRunner(service, vaultB, decisions.issuer, observer,
      rendered.resolver).run({
      aggregateId: 'dream-b', holdout: holdoutB, requiredModalities: ['visual'], producer,
      evaluators });
    const transferEventB = service.events('dream-b')
      .find(event => event.type === 'transfer-observed')!;
    const commandB = { schema: 'sinter.dream-transfer-command' as const,
      schemaVersion: 1 as const, idempotencyKey: 'transfer-b', dreamKey: 'dream-b-key' };
    await transferStore.write('transfer-b', { kind: 'dream-transfer', status: 'completed',
      commandDigest: digest(commandB), dreamKey: 'dream-b-key',
      dreamProjectionDigest: digest(dreamB), aggregateId: 'dream-b', outcome: 'validated',
      transferEvidenceDigest: transferEventB.eventDigest });
    journal.close();

    const restartedJournal = new DreamResearchJournal(db);
    const restartedDecisions = createDreamDecisionAuthority();
    const restartedService = new DreamResearchService(restartedJournal,
      { assertActive: () => undefined }, restartedDecisions.resolver);
    const restartedTransfer = new DreamTransferCommandPort(dreamStore, restartedService,
      new DreamTransferRunner(restartedService,
        new FileDreamHoldoutVault(path.join(root, 'holdout-a.json'), 'host-key'),
        restartedDecisions.issuer, observer, rendered.resolver),
      { holdout: holdoutA, producer, observer, evaluators },
      transferStore);
    const callsBeforeReplay = producer.produce.mock.calls.length;
    expect(await restartedTransfer.run(transferCommand)).toEqual(resultA);
    expect(producer.produce).toHaveBeenCalledTimes(callsBeforeReplay);
    const knowledge = new FileActivatedKnowledgeStore(path.join(root, 'knowledge.json'));
    const knowledgePolicy = sealCreativeKnowledgePolicy({ minimumRepetitions: 2,
      minimumIndependentStudies: 2, allowedScopes: ['visual'] });
    const policy = sealDreamActivationPolicy({ knowledge: knowledgePolicy,
      compilerRuleVersion: 1, compilerRulePrefix: 'Validated rule: ', contraindications: [] });
    const consolidator = new CreativeKnowledgeConsolidator(knowledge, 'host-key',
      new DreamLearningGateway(restartedService));
    const activation = new DreamActivationCommandPort(restartedTransfer, dreamStore,
      restartedService, consolidator, policy,
      new FileDreamProjectionStore(path.join(root, 'activations.json')));
    const activationCommand = { schema: 'sinter.dream-activation-command' as const,
      schemaVersion: 1 as const, idempotencyKey: 'activate-depth',
      transferKeys: ['transfer-a', 'transfer-b'] };
    const activated = await activation.run(activationCommand);
    expect(knowledge.isActive(activated.snapshot.snapshotDigest)).toBe(true);
    expect(activated.snapshot.compilerRules).toEqual([
      'Validated rule: preserve spatial depth: stronger hierarchy']);
    expect(consolidator.verify(activated.snapshot)).toBe(true);
    const tamperedSnapshots = [
      { ...activated.snapshot, admissionDigests: [activated.snapshot.admissionDigests[0]!, hex('f')] },
      { ...activated.snapshot, repetitions: activated.snapshot.repetitions + 1 },
      { ...activated.snapshot, independentStudyDigests: [hex('f'), hex('e')] },
      { ...activated.snapshot, transferEvidenceDigests: [hex('f'), hex('e')] },
      { ...activated.snapshot, contraindications: ['hidden-risk'] },
      { ...activated.snapshot, compilerRuleVersion: activated.snapshot.compilerRuleVersion + 1 },
    ];
    for (const tampered of tamperedSnapshots) expect(consolidator.verify(tampered)).toBe(false);
    const crashRecovered = new DreamActivationCommandPort(restartedTransfer, dreamStore,
      restartedService, new CreativeKnowledgeConsolidator(knowledge, 'host-key',
        new DreamLearningGateway(restartedService)), policy,
      new FileDreamProjectionStore(path.join(root, 'activation-after-crash.json')));
    expect((await crashRecovered.run(activationCommand)).snapshot).toEqual(activated.snapshot);
    expect(fetchSpy).not.toHaveBeenCalled();
    restartedJournal.close();
  });

  it('rejects one study, correlated studies, and forged projection digests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-product-negative-')); roots.push(root);
    const journal = new DreamResearchJournal(path.join(root, 'research.sqlite'));
    const decisions = createDreamDecisionAuthority();
    const service = new DreamResearchService(journal, { assertActive: () => undefined },
      decisions.resolver);
    const dreamStore = new FileDreamProductProjectionStore(path.join(root, 'dreams.json'));
    const transferStore = new FileDreamProjectionStore<DreamTransferProjection>(
      path.join(root, 'transfers.json'));
    const commitment = hex('9');
    const first = projection('first', hex('1'), digest('same-source'), commitment);
    const correlated = projection('second', hex('1'), digest('other-source'), commitment);
    await dreamStore.write('first-dream', first);
    await dreamStore.write('second-dream', correlated);
    seedKeeper(service, decisions, first);
    seedKeeper(service, decisions, correlated);
    const firstTransferEvent = validateStudy(service, decisions, first);
    const secondTransferEvent = validateStudy(service, decisions, correlated);
    const transfer = (dreamKey: string, dream: DreamProductProjection,
      transferEvidenceDigest: string,
      projectionDigest = digest(dream)): DreamTransferProjection => ({ kind: 'dream-transfer',
      status: 'completed', commandDigest: digest(dreamKey), dreamKey,
      dreamProjectionDigest: projectionDigest, aggregateId: dream.experimentPlan.aggregateId,
      outcome: 'validated', transferEvidenceDigest });
    await transferStore.write('first-transfer', transfer('first-dream', first,
      firstTransferEvent.eventDigest));
    await transferStore.write('second-transfer', transfer('second-dream', correlated,
      secondTransferEvent.eventDigest));
    await transferStore.write('forged-transfer', transfer('first-dream', first,
      firstTransferEvent.eventDigest, hex('f')));
    const vault = new DreamHoldoutVault();
    const holdout = vault.seal('unused', { selectorDigest: hex('1'), custodianDigest: hex('2'),
      protocol: { originContextDigest: hex('3'), controlContextDigest: hex('4'),
        treatmentContextDigest: hex('4'), findingDigest: hex('5'), controlFindingDigest: null,
        treatmentFindingDigest: hex('5') } });
    const transferPort = new DreamTransferCommandPort(dreamStore, service,
      new DreamTransferRunner(service, vault, decisions.issuer, observer, rendered.resolver),
      { holdout, producer, observer, evaluators }, transferStore);
    const historicalBase = projection('historical', hex('2'), digest('historical'), commitment);
    const { liminalParentBindings: _bindings, ...historicalContext } =
      historicalBase.experimentPlan.context;
    const historical = { ...historicalBase, experimentPlan: {
      ...historicalBase.experimentPlan, context: historicalContext } };
    await dreamStore.write('historical-dream', historical);
    seedKeeper(service, decisions, historical);
    await expect(transferPort.run({ schema: 'sinter.dream-transfer-command', schemaVersion: 1,
      idempotencyKey: 'historical-transfer', dreamKey: 'historical-dream' }))
      .rejects.toThrow('DREAM_TRANSFER_HISTORICAL_NON_ADMISSIBLE');
    const policy = sealDreamActivationPolicy({ knowledge: sealCreativeKnowledgePolicy({
      minimumRepetitions: 2, minimumIndependentStudies: 2, allowedScopes: ['visual'] }),
    compilerRuleVersion: 1, compilerRulePrefix: 'Rule: ', contraindications: [] });
    const knowledge = new FileActivatedKnowledgeStore(path.join(root, 'knowledge.json'));
    const activation = new DreamActivationCommandPort(transferPort, dreamStore, service,
      new CreativeKnowledgeConsolidator(knowledge, 'host-key', new DreamLearningGateway(service)),
      policy, new FileDreamProjectionStore(path.join(root, 'activations.json')));
    await expect(activation.run({ schema: 'sinter.dream-activation-command', schemaVersion: 1,
      idempotencyKey: 'one', transferKeys: ['first-transfer'] }))
      .rejects.toThrow('DREAM_ACTIVATION_REPETITIONS_INSUFFICIENT');
    await expect(activation.run({ schema: 'sinter.dream-activation-command', schemaVersion: 1,
      idempotencyKey: 'correlated', transferKeys: ['first-transfer', 'second-transfer'] }))
      .rejects.toThrow('DREAM_ACTIVATION_STUDIES_CORRELATED');
    await expect(activation.run({ schema: 'sinter.dream-activation-command', schemaVersion: 1,
      idempotencyKey: 'forged', transferKeys: ['forged-transfer', 'second-transfer'] }))
      .rejects.toThrow('DREAM_TRANSFER_PROJECTION_INVALID');
    expect(knowledge.isActive(hex('0'))).toBe(false);
    journal.close();
  });
});
