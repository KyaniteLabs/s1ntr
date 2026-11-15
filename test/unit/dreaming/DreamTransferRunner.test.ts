import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DreamHoldoutVault } from '../../../src/dreaming/research/DreamHoldoutVault.js';
import { DreamResearchJournal } from '../../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchService } from '../../../src/dreaming/research/DreamResearchService.js';
import { DreamTransferRunner } from '../../../src/dreaming/research/DreamTransferRunner.js';
import { frozenExperiment } from './dreamResearchFixtures.js';
import { createDreamDecisionAuthority } from
  '../../../src/dreaming/research/DreamDecisionAuthority.js';
import { createDreamFindingAdmission } from
  '../../../src/dreaming/research/DreamLearningAdmission.js';
import { createDreamRenderedEvidenceAuthority } from
  '../../../src/dreaming/research/DreamResearchEvidence.js';
import { DreamLearningGateway } from '../../../src/dreaming/research/DreamLearningGateway.js';
import { CreativeKnowledgeConsolidator, InMemoryActivatedKnowledgeStore,
  KnowledgeApplication, sealCreativeKnowledgePolicy,
  validateMatchedKnowledgeComparison } from
  '../../../src/dreaming/research/DreamKnowledgeActivation.js';

const digest = (char: string) => char.repeat(64);
const pixelFrames = ['pixel-early', 'pixel-late'].map(dataBase64 => ({
  mimeType: 'image/png', dataBase64,
  digest: createHash('sha256').update(dataBase64).digest('hex'),
}));
const evidence = { artifactDigest: digest('a'), playableDigest: digest('b'),
  rendererEnvironmentDigest: digest('c'), runtimeErrors: [], degraded: false,
  identityValid: true, digestMatched: true, frames: pixelFrames.map(frame => frame.digest),
  pixelFrames,
  temporalSamples: [digest('f')], containment: { networkIsolated: true,
    permissionsDenied: true, resourceLimitsObserved: true,
    cleanupSucceeded: true, outputBytes: 1, assetDigests: [],
    runtimeDigest: digest('7'), postRunCensus: { durationMs: 1,
      usedHeapBytes: 1, eventListeners: 0, eventsDispatched: 0, timers: 0,
      audioContexts: 0, pagesBefore: 0, pagesAfter: 0 } } };

describe('DreamTransferRunner', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));

  it('journals holdout access and validates only rendered unseen transfer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-transfer-')); roots.push(root);
    const isolation = { originContextDigest: digest('5'), controlContextDigest: digest('6'),
      treatmentContextDigest: digest('6'), findingDigest: digest('7'),
      controlFindingDigest: null, treatmentFindingDigest: digest('7') };
    const vault = new DreamHoldoutVault();
    const holdout = vault.seal('unseen', { selectorDigest: digest('3'),
      custodianDigest: digest('4'), protocol: isolation });
    const decisions = createDreamDecisionAuthority();
    const service = new DreamResearchService(new DreamResearchJournal(path.join(root, 'db.sqlite')),
      { assertActive: () => undefined }, decisions.resolver);
    const plan = frozenExperiment();
    service.plan({ ...plan, budget: { maximumAttempts: 4 }, context: { ...plan.context,
      transferCommitmentDigest: holdout.commitment.commitmentDigest,
      evaluatorManifestDigests: [digest('1'), digest('3')] } }, 'plan');
    service.freeze('dream-1', 1, 'freeze');
    service.recordBaseline('dream-1', 2, 'baseline', digest('1'));
    service.recordVariants('dream-1', 3, 'variants', [digest('2')], [digest('8')]);
    service.compare('dream-1', 4, 'compare', decisions.issuer.issueComparison({
      aggregateId: 'dream-1', outcome: 'keeper', reason: 'depth',
      baselineEvidenceDigest: digest('1'), variantEvidenceDigests: [digest('2')],
      variantArtifactDigests: [digest('8')] }));
    const knowledgeStore = new InMemoryActivatedKnowledgeStore();
    expect(service.snapshot('dream-1').finding).toBe('proposed');
    expect(knowledgeStore.isActive(digest('0'))).toBe(false);
    const evaluator = (identity: string, host: string) => ({ identity: {
      identityDigest: digest(identity), hostDigest: digest(host) },
      compare: async () => 'validated' as const });
    const rendered = createDreamRenderedEvidenceAuthority();
    const outcome = await new DreamTransferRunner(service, vault, decisions.issuer,
      { observe: async candidate => {
        const observed = { ...evidence, artifactDigest:
          createHash('sha256').update(candidate.source).digest('hex') };
        rendered.issuer.attest(observed);
        return observed;
      } }, rendered.resolver).run({ aggregateId: 'dream-1',
      holdout, requiredModalities: ['visual'], producer: { produce: async input => ({
        id: input.findingDigest ? 'treatment' : 'control',
        source: input.findingDigest ? 'with-finding' : 'without-finding',
        graphDigest: input.findingDigest ? digest('9') : digest('0'),
        layerIds: ['one'], domains: ['html'] }) },
      evaluators: [evaluator('1', '2'), evaluator('3', '4')] });
    expect(outcome).toBe('validated');
    expect(service.snapshot('dream-1').finding).toBe('validated');
    expect(service.snapshot('dream-1').attemptsStarted).toBe(4);
    expect(service.events('dream-1').filter(event => event.type === 'transport-started'))
      .toHaveLength(6);
    expect(service.events('dream-1').map(event => event.type)).toContain('holdout-accessed');
    const order = service.events('dream-1').map(event => event.type);
    // #1259: every transfer pin freezes before held-out bytes are read.
    expect(order.indexOf('transfer-frozen')).toBeLessThan(order.indexOf('holdout-accessed'));
    expect(order.indexOf('transfer-frozen')).toBeGreaterThan(order.indexOf('finding-proposed'));
    const events = service.events('dream-1');
    const findingEvent = events.find(event => event.type === 'finding-proposed')!;
    const transferEvent = events.find(event => event.type === 'transfer-observed')!;
    const admission = createDreamFindingAdmission({ aggregateId: 'dream-1',
      findingDigest: findingEvent.eventDigest,
      artifactDigests: [digest('8'), transferEvent.payload.treatmentArtifactDigest as string,
        transferEvent.payload.controlArtifactDigest as string],
      evidenceDigests: [digest('1'), digest('2'),
        transferEvent.payload.treatmentEvidenceDigest as string,
        transferEvent.payload.controlEvidenceDigest as string],
      transferEvidenceDigest: transferEvent.eventDigest, state: 'validated' });
    const gateway = new DreamLearningGateway(service);
    const consolidator = new CreativeKnowledgeConsolidator(
      knowledgeStore, 'test-signing-key', gateway);
    const snapshot = await consolidator.activate({
      principleIds: ['depth-before-decoration'],
      compilerRules: ['Preserve depth cues before surface detail.'], scope: ['visual'],
      contraindications: [], repetitions: 1, compilerRuleVersion: 1,
      independentStudyDigests: [digest('a')],
      transferEvidenceDigests: [admission.transferEvidenceDigest],
    }, sealCreativeKnowledgePolicy({ minimumRepetitions: 1,
      minimumIndependentStudies: 1, allowedScopes: ['visual'] }),
    [gateway.authorize(admission)]);
    const application = new KnowledgeApplication(knowledgeStore,
      candidate => consolidator.verify(candidate));
    const receipts = ['later-a', 'later-b'].map(taskId => application.apply({
      snapshotDigest: snapshot.snapshotDigest, targetScope: 'visual',
      basePlan: { taskId }, providerInput: taskId }));
    expect(validateMatchedKnowledgeComparison({ snapshotDigest: snapshot.snapshotDigest,
      frozenAssignmentDigest: digest('d'), trials: receipts.map((receipt, index) => ({
        taskId: `later-${index}`, receipt, controlScore: 0.4,
        treatmentScore: 0.7, vetoedRegression: false })) })).toEqual({ valid: true, wins: 2,
      losses: 0, ties: 0, signTestPValue: 0.25, statisticallyConfirmed: false });
  });
});
