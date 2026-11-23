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


const protocol = { originContextDigest: hex('c'), controlContextDigest: hex('d'),
  treatmentContextDigest: hex('d'), findingDigest: hex('e'), controlFindingDigest: null,
  treatmentFindingDigest: hex('e') };
const meta = { selectorDigest: hex('1'), custodianDigest: hex('2'), protocol };

/** Shipped composition: ONE precommitted holdout, every dream plan carries its commitment (template.context.transferCommitmentDigest). */
describe('F02 one holdout cannot yield two independent transfers; a precommitted pool can', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
  async function harness() {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-f02-')); roots.push(root);
    const journal = new DreamResearchJournal(path.join(root, 'research.sqlite'));
    const decisions = createDreamDecisionAuthority();
    const service = new DreamResearchService(journal, { assertActive: () => undefined }, decisions.resolver);
    const dreamStore = new FileDreamProductProjectionStore(path.join(root, 'dreams.json'));
    const transferStore = new FileDreamProjectionStore<DreamTransferProjection>(path.join(root, 'transfers.json'));
    const vault = new FileDreamHoldoutVault(path.join(root, 'holdouts.json'), 'host-key');
    return { root, journal, decisions, service, dreamStore, transferStore, vault };
  }
  const run = async (h: Awaited<ReturnType<typeof harness>>, holdout: ReturnType<FileDreamHoldoutVault['precommit']> | ((id: string) => ReturnType<FileDreamHoldoutVault['precommit']>),
    id: string, parent: string, source: string, commitment: string) => {
    const dream = projection(id, parent, digest(source), commitment);
    await h.dreamStore.write(`${id}-key`, dream);
    seedKeeper(h.service, h.decisions, dream);
    const port = new DreamTransferCommandPort(h.dreamStore, h.service,
      new DreamTransferRunner(h.service, h.vault, h.decisions.issuer, observer, rendered.resolver),
      { holdout, producer, observer, evaluators }, h.transferStore);
    return port.run({ schema: 'sinter.dream-transfer-command', schemaVersion: 1, idempotencyKey: `${id}-transfer`, dreamKey: `${id}-key` });
  };

  it('the second study on the same holdout fails as REUSE, not as a premature-access leak', async () => {
    const h = await harness();
    const holdout = h.vault.precommit('only', 'unseen-only', meta);
    expect((await run(h, holdout, 'dream-a', hex('3'), 'source-a', holdout.commitment.commitmentDigest)).outcome).toBe('validated');
    await expect(run(h, holdout, 'dream-b', hex('4'), 'source-b', holdout.commitment.commitmentDigest))
      .rejects.toThrow('DREAM_HOLDOUT_REUSED');
    h.journal.close();
  });

  it('two precommitted holdouts assigned per study validate, survive restart and activate; shared commitments are refused at activation', async () => {
    const h = await harness();
    const poolA = h.vault.precommit('pool-a', 'unseen-a', meta);
    const poolB = h.vault.precommit('pool-b', 'unseen-b', meta);
    expect(poolA.commitment.commitmentDigest).not.toBe(poolB.commitment.commitmentDigest);
    const assign = (aggregateId: string) => h.vault.assign(aggregateId);
    // plan time: each study gets its own commitment from the pool (what DreamProductCommandPort does in production)
    const cA = assign('dream-a').commitment.commitmentDigest; const cB = assign('dream-b').commitment.commitmentDigest;
    expect(cA).not.toBe(cB);
    expect(assign('dream-a').commitment.commitmentDigest).toBe(cA);  // idempotent per aggregate
    expect(() => assign('dream-c')).toThrow('DREAM_HOLDOUT_POOL_EXHAUSTED');
    const a = await run(h, assign, 'dream-a', hex('3'), 'source-a', cA);
    const b = await run(h, assign, 'dream-b', hex('4'), 'source-b', cB);
    expect([a.outcome, b.outcome]).toEqual(['validated', 'validated']);
    h.journal.close();
    // restart
    const journal = new DreamResearchJournal(path.join(h.root, 'research.sqlite'));
    const decisions = createDreamDecisionAuthority();
    const service = new DreamResearchService(journal, { assertActive: () => undefined }, decisions.resolver);
    const vault = new FileDreamHoldoutVault(path.join(h.root, 'holdouts.json'), 'host-key');
    const transfer = new DreamTransferCommandPort(h.dreamStore, service,
      new DreamTransferRunner(service, vault, decisions.issuer, observer, rendered.resolver),
      { holdout: (id: string) => vault.assign(id), producer, observer, evaluators }, h.transferStore);
    const policy = sealDreamActivationPolicy({ knowledge: sealCreativeKnowledgePolicy({ minimumRepetitions: 2,
      minimumIndependentStudies: 2, allowedScopes: ['visual'] }), compilerRuleVersion: 1, compilerRulePrefix: 'Rule: ', contraindications: [] });
    const knowledge = new FileActivatedKnowledgeStore(path.join(h.root, 'knowledge.json'));
    const activation = new DreamActivationCommandPort(transfer, h.dreamStore, service,
      new CreativeKnowledgeConsolidator(knowledge, 'host-key', new DreamLearningGateway(service)), policy,
      new FileDreamProjectionStore(path.join(h.root, 'activations.json')));
    const activated = await activation.run({ schema: 'sinter.dream-activation-command', schemaVersion: 1,
      idempotencyKey: 'activate', transferKeys: ['dream-a-transfer', 'dream-b-transfer'] });
    expect(knowledge.isActive(activated.snapshot.snapshotDigest)).toBe(true);
    journal.close();
  });

  it('activation refuses two studies that committed to the same holdout', async () => {
    const h = await harness();
    const shared = hex('9');
    for (const [id, parent, source] of [['dream-a', hex('3'), 'source-a'], ['dream-b', hex('4'), 'source-b']] as const) {
      const dream = projection(id, parent, digest(source), shared);
      await h.dreamStore.write(`${id}-key`, dream); seedKeeper(h.service, h.decisions, dream);
      const event = validateStudy(h.service, h.decisions, dream);
      await h.transferStore.write(`${id}-transfer`, { kind: 'dream-transfer', status: 'completed', commandDigest: digest(`${id}-key`),
        dreamKey: `${id}-key`, dreamProjectionDigest: digest(dream), aggregateId: id, outcome: 'validated', transferEvidenceDigest: event.eventDigest });
    }
    const transfer = new DreamTransferCommandPort(h.dreamStore, h.service,
      new DreamTransferRunner(h.service, h.vault, h.decisions.issuer, observer, rendered.resolver),
      { holdout: h.vault.precommit('x', 'x-bytes', meta), producer, observer, evaluators }, h.transferStore);
    const policy = sealDreamActivationPolicy({ knowledge: sealCreativeKnowledgePolicy({ minimumRepetitions: 2,
      minimumIndependentStudies: 2, allowedScopes: ['visual'] }), compilerRuleVersion: 1, compilerRulePrefix: 'Rule: ', contraindications: [] });
    const activation = new DreamActivationCommandPort(transfer, h.dreamStore, h.service,
      new CreativeKnowledgeConsolidator(new FileActivatedKnowledgeStore(path.join(h.root, 'k.json')), 'host-key', new DreamLearningGateway(h.service)),
      policy, new FileDreamProjectionStore(path.join(h.root, 'act.json')));
    await expect(activation.run({ schema: 'sinter.dream-activation-command', schemaVersion: 1,
      idempotencyKey: 'shared', transferKeys: ['dream-a-transfer', 'dream-b-transfer'] }))
      .rejects.toThrow('DREAM_ACTIVATION_HOLDOUT_REUSED');
    h.journal.close();
  });
});
