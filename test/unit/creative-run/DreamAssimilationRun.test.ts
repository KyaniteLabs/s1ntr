import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { CreativeRunCoordinator } from '../../../src/creative-run/CreativeRunCoordinator.js';
import { MemoryCreativeRunPersistence } from '../../../src/creative-run/CreativeRunCoordinatorBase.js';
import {
  DreamAssimilationReviewVeto,
  FileDreamAssimilationRunStore,
  MemoryDreamAssimilationRunStore,
  parseDreamAssimilationCheckpoint,
  parseDreamAssimilationResult,
  sealDreamCampaignProductionSeam,
  sealDreamEvaluatorManifest,
  type DreamAssimilationEvaluator,
  type DreamAssimilationRequest,
  type DreamCampaignBinding,
  type DreamCampaignProductionSeam,
  type DreamCheckpointPhase,
  type DreamEvaluatorDecision,
  type DreamProductionArtifactEvidence,
  type DreamRecommendationStore,
} from '../../../src/creative-run/DreamAssimilationRun.js';
import type { BlindReviewPacket } from '../../../src/creative-run/BlindReviewEvidence.js';
import type { CausalIdentity } from '../../../src/creative-run/AttributableRevision.js';
import { DomainIncubatorStore } from '../../../src/runtime-core/DomainIncubator.js';
import {
  candidateSetDigest,
  learnCreativeJudgment,
} from '../../../src/learning/CreativeJudgmentCalibration.js';

vi.setConfig({ testTimeout: 60_000 }); // Full production graph and file-store recovery.
afterEach(() => { vi.unstubAllEnvs(); });

const NOW = '2026-08-01T12:00:00.000Z';
let nonce = 0;

function learnedProfile() {
  const dimensions = (value: number) => ({ cohesion: value, structuralDepth: value,
    spatialEmbodiment: value, materiality: value, motionPurpose: value,
    composition: value, palette: value, finish: value });
  const candidates = [
    { id: 'preferred', evidenceDigest: 'a'.repeat(64), dimensions: dimensions(0.2) },
    { id: 'lower', evidenceDigest: 'b'.repeat(64), dimensions: dimensions(0.8) },
  ];
  return learnCreativeJudgment({ schema: 'sinter.creative-judgment-comparison',
    candidateSetDigest: candidateSetDigest(candidates),
    referenceRanking: ['preferred', 'lower'], evaluatorRanking: ['lower', 'preferred'],
    candidates });
}

function identity(role: CausalIdentity['role'], suffix: string): CausalIdentity {
  return { role, provider: `provider-${suffix}`, model: `model-${suffix}`,
    pipe: `pipe-${suffix}`, effort: `effort-${suffix}`,
    contributionLineage: `lineage-${suffix}`, assignment: `assignment-${suffix}` };
}

function graph() {
  return { schema: 'sinter.composition-graph' as const, schemaVersion: '2.0' as const,
    status: 'ready' as const, id: 'dream-graph',
    budgets: { maxNodes: 3, maxEdges: 2, maxProviderCalls: 0 },
    nodes: [
      { id: 'a', type: 'layer' as const, layer: { domain: 'html' as const, prompt: 'A', code: '<!doctype html><html><head><title>a</title><style>body { color: #111; background:#eee }</style></head><body>source-a</body></html>' } },
      { id: 'b', type: 'layer' as const, layer: { domain: 'html' as const, prompt: 'B', code: '<!doctype html><html><head><title>b</title><style>body { color: #222; background:#ddd }</style></head><body>source-b</body></html>' } },
      { id: 'c', type: 'layer' as const, layer: { domain: 'html' as const, prompt: 'C', code: '<!doctype html><html><head><title>c</title><style>body { color: #333; background:#ccc }</style></head><body>source-c</body></html>' } },
    ], edges: [{ id: 'ab', type: 'before' as const, from: 'a', to: 'b' },
      { id: 'bc', type: 'before' as const, from: 'b', to: 'c' }] };
}

function judgments(packet: BlindReviewPacket, outcome: 'pass' | 'fail' = 'pass') {
  return packet.candidates.map((candidate) => ({
    blindId: candidate.blindId, outcome,
    claims: candidate.media.map((media) => ({ modality: media.modality,
      artifactDigest: candidate.artifactDigest, evidenceDigest: media.digest,
      claim: `Reviewed ${media.modality} evidence against the sealed artistic criterion.` })),
  }));
}

function evidenceRefs(packet: BlindReviewPacket, artifact: DreamProductionArtifactEvidence) {
  return [...packet.candidates.flatMap((candidate) =>
    candidate.media.map((media) => media.digest)), artifact.artifactDigest,
  artifact.renderedEvidence.earlyFrame.digest, artifact.renderedEvidence.lateFrame.digest];
}

function evaluator(
  role: 'specialist' | 'holistic',
  reviewer: CausalIdentity,
  decide?: (packet: BlindReviewPacket, manifestDigest: string,
    artifact: DreamProductionArtifactEvidence) => DreamEvaluatorDecision,
): DreamAssimilationEvaluator {
  const manifest = sealDreamEvaluatorManifest({
    evaluatorId: `${role}-creative-critic`, evaluatorVersion: '2026.08.01', identity: reviewer,
    criteria: [{ id: `${role}-coherence`,
      description: `${role} coherence and artistic intentionality`, requiredModalities: ['visual'] }],
  });
  return { manifest, evaluate: vi.fn(async ({ packet, productionArtifact }) =>
    decide?.(packet, manifest.manifestDigest, productionArtifact) ?? ({
    identity: reviewer, manifestDigest: manifest.manifestDigest, packetDigest: packet.packetDigest,
    verdict: 'approve', judgments: judgments(packet), disagreement: [],
    criteriaResults: [{ criterionId: `${role}-coherence`, passed: true,
      evidenceRefs: evidenceRefs(packet, productionArtifact),
      explanation: 'The evidence supports the declared artistic criterion.' }],
  })) };
}

class CountingRecommendationStore implements DreamRecommendationStore {
  // Cross-platform temp root: the old `/private/tmp` literal is macOS-only and
  // fails with EACCES on Linux (verified on <fleet-node> 2026-10-10).
  readonly backing = new DomainIncubatorStore(join(tmpdir(), `dream-assimilate-test-${nonce += 1}`));
  effects = 0;
  attempts = 0;
  failBeforeCreate = false;

  async getOrCreate(record: Parameters<DreamRecommendationStore['getOrCreate']>[0]) {
    this.attempts += 1;
    if (this.failBeforeCreate) {
      this.failBeforeCreate = false;
      throw new Error('injected-before-recommendation');
    }
    const result = await this.backing.getOrCreate(record);
    if (result.created) this.effects += 1;
    return result;
  }
}

function fixture(overrides: Partial<DreamAssimilationRequest> = {}) {
  const coordinator = new CreativeRunCoordinator({ now: () => NOW,
    reserveProvider: async () => { throw new Error('provider reservation must not be called'); } });
  const store = new MemoryDreamAssimilationRunStore();
  const generator = identity('generator', 'generator');
  const specialist = identity('specialist', 'specialist');
  const holistic = identity('holistic', 'holistic');
  const recommendationStore = new CountingRecommendationStore();
  const renderer = { identity: 'test-renderer', renderWithEvidence: vi.fn(async () => ({
    timingMs: 10, infraUnavailable: false, candidateFailure: false,
    screenshot: { mimeType: 'image/png', dataBase64: Buffer.from('early').toString('base64') },
    lateScreenshot: { mimeType: 'image/png', dataBase64: Buffer.from('late').toString('base64') },
    logs: [], errors: [],
  })) };
  const request: DreamAssimilationRequest = {
    requestKey: 'dream-replay', prompt: 'A quiet high contrast field', graph: graph(),
    identities: { generator, specialist, holistic },
    evaluators: { specialist: evaluator('specialist', specialist),
      holistic: evaluator('holistic', holistic) },
    store, recommendationStore, renderer, ...overrides,
  };
  return { coordinator, request, store, recommendationStore };
}

function campaignFixture(store: NonNullable<DreamAssimilationRequest['store']>) {
  const base = fixture({ store });
  const binding: DreamCampaignBinding = {
    campaignRunId: 'campaign-dream', manifestDigest: 'a'.repeat(64),
    planDigest: 'b'.repeat(64), stageId: 'dream', origin: {
      rootRunId: 'campaign-dream-root', fundingReservationDigest: 'c'.repeat(64),
      feasibilityDigest: 'd'.repeat(64), routeFreezeDigest: 'e'.repeat(64),
    },
  };
  const reserveProvider = vi.fn(async () => ({ id: 'campaign-funded', status: 'reserved' as const }));
  const coordinator = new CreativeRunCoordinator({ now: () => NOW,
    idFactory: () => binding.origin.rootRunId, reserveProvider,
    persistence: new MemoryCreativeRunPersistence() });
  const composeFunded = vi.fn<DreamCampaignProductionSeam['composeFunded']>(
    (request, options) => coordinator.compose(request, options),
  );
  const assertActive = vi.fn();
  const campaignProduction = sealDreamCampaignProductionSeam({
    binding, composeFunded, assertActive,
  });
  const request: DreamAssimilationRequest = { ...base.request,
    requestKey: `campaign-dream:${binding.origin.rootRunId}`,
    graph: { ...graph(), budgets: { maxNodes: 3, maxEdges: 2, maxProviderCalls: 1 } },
    store, campaignProduction };
  return { ...base, coordinator, request, binding, reserveProvider, composeFunded,
    assertActive, campaignProduction };
}

describe('Dream and Assimilate production run', () => {
  it('uses the full no-spend production graph and replays without a second effect', async () => {
    const { coordinator, request, store, recommendationStore } = fixture();
    const compose = vi.spyOn(coordinator, 'composeNoSpend');
    const first = await coordinator.runDreamAndAssimilate(request);
    const second = await coordinator.runDreamAndAssimilate(request);
    expect(first.production.run.record.status).toBe('completed');
    expect(first.production.run.readiness.source).toBe('synthetic-no-spend');
    expect(first.production.productionArtifact.artifactDigest)
      .toBe(first.production.generatedArtifactDigest);
    expect(first.production.productionArtifact.playableMedia.uri)
      .toMatch(/^data:text\/html;base64,/);
    expect(first.production.candidates.candidates).toHaveLength(1);
    expect(first.production.candidates.candidates[0]?.artifact.artifactDigest)
      .toBe(first.production.generatedArtifactDigest);
    expect(first.production.blindReviewPacket.candidates).toHaveLength(1);
    expect(first.review.specialist.criteriaResults[0].evidenceRefs)
      .toContain(first.production.generatedArtifactDigest);
    expect(first.review.holistic.criteriaResults[0].evidenceRefs)
      .toContain(first.production.generatedArtifactDigest);
    expect(first.review.outcome).toBe('approve');
    expect(first.recommendation.promotion).toBe('forbidden');
    expect(first.authorityBoundary).toEqual({ status: 'owner-action-required',
      ownerPreferenceClaimed: false, ownerReleaseClaimed: false,
      learningAuthorized: false, transferOpened: false, promotionAttempted: false });
    expect(second.recommendation.recommendationDigest).toBe(first.recommendation.recommendationDigest);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(recommendationStore.effects).toBe(1);
    expect(store.writes).toEqual([
      'started', 'produced', 'specialist-reviewed', 'reviewed', 'completed',
    ]);
  }, 30_000); // whole production graph: 5 s default timed out on the public runner (db1b666)

  it('rejects source stacking instead of calling it Dream synthesis', async () => {
    const sourceCode = '<!doctype html><html><body>unchanged parent</body></html>';
    const sourceDigest = createHash('sha256').update(sourceCode).digest('hex');
    const graphWithParentCode = { schema: 'sinter.composition-graph' as const,
      schemaVersion: '2.0' as const, status: 'ready' as const, id: 'replayed-parent',
      budgets: { maxNodes: 1, maxEdges: 0, maxProviderCalls: 0 },
      nodes: [{ id: 'parent', type: 'layer' as const,
        layer: { domain: 'html' as const, prompt: 'parent', code: sourceCode } }],
      edges: [] };
    const value = fixture({ prompt: `source_digest=${sourceDigest}`,
      creativeBrief: 'Create one original runnable artwork.', graph: graphWithParentCode,
      sourceArtifacts: [{ id: 'parent', domain: 'html', prompt: 'parent',
        code: sourceCode, codeDigest: sourceDigest }] });

    await expect(value.coordinator.runDreamAndAssimilate(value.request))
      .rejects.toThrow('DREAM_GENERATIVE_SYNTHESIS_REQUIRED');
    expect(value.request.evaluators.specialist.evaluate).not.toHaveBeenCalled();
    expect(value.request.evaluators.holistic.evaluate).not.toHaveBeenCalled();
  });

  it('rejects a generator that returns an exact parent artifact', async () => {
    const sourceCode = '<main>unchanged parent</main>';
    const sourceDigest = createHash('sha256').update(sourceCode).digest('hex');
    const value = fixture({ prompt: `source_digest=${sourceDigest}`,
      creativeBrief: 'Create one original runnable artwork.',
      graph: { schema: 'sinter.composition-graph', schemaVersion: '2.0', status: 'ready',
        id: 'novel-synthesis', budgets: { maxNodes: 1, maxEdges: 0, maxProviderCalls: 1 },
        nodes: [{ id: 'novel', type: 'layer',
          layer: { domain: 'html', prompt: 'new artifact' } }], edges: [] },
      sourceArtifacts: [{ id: 'parent', domain: 'html', prompt: 'parent',
        code: sourceCode, codeDigest: sourceDigest }] });
    vi.spyOn(value.coordinator, 'composeNoSpend').mockResolvedValue({
      html: `<iframe src="data:text/html;base64,${Buffer.from(sourceCode).toString('base64')}"></iframe>`,
      title: 'replayed', background: '#000', successCount: 1,
      layers: [{ generated: true }], creativeRun: { readiness: {
        source: 'synthetic-no-spend' }, providerReservation: {
        source: 'synthetic-no-spend' } },
    } as never);

    await expect(value.coordinator.runDreamAndAssimilate(value.request))
      .rejects.toThrow('DREAM_SOURCE_ARTIFACT_REPLAYED');
  });

  it('receipts learned judgment only after production and both reviews approve it', async () => {
    const { coordinator, request } = fixture();
    const profile = learnedProfile();
    const prompt = [request.prompt, `profile_digest=${profile.profileDigest}`,
      `weights=${JSON.stringify(profile.weights)}`,
      ...profile.guidance.map((guidance) => `guidance=${guidance}`)].join('\n');
    const result = await coordinator.runDreamAndAssimilate({ ...request, prompt,
      creativeBrief: request.prompt, creativeJudgmentProfile: profile });

    expect(profile.guidance.length).toBeGreaterThan(0);
    expect(result.creativeJudgmentAssimilation).toMatchObject({
      status: 'assimilated', profileDigest: profile.profileDigest,
      requestDigest: result.requestDigest,
      productionDigest: result.production.productionDigest,
      reviewDigest: result.review.reviewDigest,
    });
    expect(() => parseDreamAssimilationResult(result)).not.toThrow();
  });

  it('rejects a profile attached without its learned guidance in the production prompt', async () => {
    const { coordinator, request } = fixture();
    await expect(coordinator.runDreamAndAssimilate({ ...request,
      creativeJudgmentProfile: learnedProfile() }))
      .rejects.toThrow('DREAM_JUDGMENT_PROFILE_NOT_CONSUMED');
  });

  it('binds funded campaign production and restores exactly one recommendation after restart', async () => {
    const root = await mkdtemp(`${tmpdir()}/campaign-dream-`);
    try {
      const firstStore = new FileDreamAssimilationRunStore(root);
      const value = campaignFixture(firstStore);
      const noSpend = vi.spyOn(value.coordinator, 'composeNoSpend');
      const first = await value.coordinator.runDreamAndAssimilate(value.request);
      const [fundedRequest, fundedOptions] = value.composeFunded.mock.calls[0]!;
      expect(fundedOptions.binding).toBe(value.campaignProduction.binding);
      expect(() => value.campaignProduction.composeFunded(fundedRequest, {
        ...fundedOptions,
        binding: { ...value.binding, campaignRunId: 'cross-campaign' },
      })).toThrow('DREAM_CAMPAIGN_PRODUCTION_BINDING_INVALID');
      const checkpointFile = (await readdir(root)).find((name) => name.endsWith('.json'))!;
      const checkpoint = JSON.parse(await readFile(`${root}/${checkpointFile}`, 'utf8'));
      const restored = campaignFixture(new FileDreamAssimilationRunStore(root));
      const second = await restored.coordinator.runDreamAndAssimilate({ ...restored.request,
        recommendationStore: value.recommendationStore });

      expect(first.campaignBinding).toEqual(value.binding);
      expect(first.production.campaignBinding).toEqual(value.binding);
      expect(first.recommendation.campaignBinding).toEqual(value.binding);
      expect(checkpoint.campaignBinding).toEqual(value.binding);
      expect(checkpoint.requestKey).toMatch(/^campaign-dream:[a-f0-9]{64}:/);
      expect(first.production.productionMode).toBe('campaign-funded');
      expect(first.production.run.readiness.source).toBe('injected-provider');
      expect(first.production.run.rootRunId).toBe(value.binding.origin.rootRunId);
      expect(second.recommendation.recommendationDigest)
        .toBe(first.recommendation.recommendationDigest);
      expect(value.composeFunded).toHaveBeenCalledTimes(1);
      expect(value.assertActive).toHaveBeenCalledTimes(2);
      expect(value.reserveProvider).toHaveBeenCalledTimes(1);
      expect(noSpend).not.toHaveBeenCalled();
      expect(restored.composeFunded).not.toHaveBeenCalled();
      expect(value.recommendationStore.effects).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a campaign seam that returns synthetic no-spend production', async () => {
    const store = new MemoryDreamAssimilationRunStore();
    const value = campaignFixture(store);
    const ambient = fixture();
    const campaignProduction = sealDreamCampaignProductionSeam({
      binding: value.binding,
      composeFunded: (request, options) => ambient.coordinator.composeNoSpend(request, options),
      assertActive: () => undefined,
    });

    await expect(value.coordinator.runDreamAndAssimilate({ ...value.request,
      campaignProduction })).rejects.toThrow('DREAM_CAMPAIGN_FUNDED_PRODUCTION_INVALID');
    expect(value.recommendationStore.effects).toBe(0);
  });

  it('rejects tampering with the exact composed artifact evidence', async () => {
    const value = fixture();
    const result = await value.coordinator.runDreamAndAssimilate(value.request);
    const tampered = structuredClone(result);
    (tampered.production.productionArtifact.playableMedia as { uri: string }).uri =
      'data:text/html;base64,PHRhbXBlcmVkPg==';
    expect(() => parseDreamAssimilationResult(tampered))
      .toThrow('DREAM_ASSIMILATION_PRODUCTION_ARTIFACT_INVALID');
  });

  it('fails closed before review when early or late rendered evidence is missing', async () => {
    const value = fixture({ renderer: { identity: 'failed-renderer',
      renderWithEvidence: async () => ({ timingMs: 10, infraUnavailable: false,
        candidateFailure: true }) } });
    await expect(value.coordinator.runDreamAndAssimilate(value.request))
      .rejects.toThrow('DREAM_RENDERED_EVIDENCE_REQUIRED');
    expect(value.request.evaluators.specialist.evaluate).not.toHaveBeenCalled();
    expect(value.recommendationStore.effects).toBe(0);
  });

  it('rejects a critic that reviews candidates but omits the composed output', async () => {
    const value = fixture();
    const specialist = value.request.identities.specialist;
    const candidateOnly = evaluator('specialist', specialist, (packet, manifestDigest) => ({
      identity: specialist, manifestDigest, packetDigest: packet.packetDigest,
      verdict: 'approve', judgments: judgments(packet), disagreement: [],
      criteriaResults: [{ criterionId: 'specialist-coherence', passed: true,
        evidenceRefs: packet.candidates.flatMap((candidate) =>
          candidate.media.map((media) => media.digest)),
        explanation: 'Candidate hypotheses only.' }],
    }));
    await expect(value.coordinator.runDreamAndAssimilate({ ...value.request,
      evaluators: { ...value.request.evaluators, specialist: candidateOnly } }))
      .rejects.toThrow('DREAM_EVALUATOR_CRITERIA_EVIDENCE_INVALID');
  });

  it('requires both exact sealed independent evaluator identities', async () => {
    const value = fixture();
    const wrong = identity('specialist', 'impostor');
    const manifest = sealDreamEvaluatorManifest({ evaluatorId: 'specialist-creative-critic',
      evaluatorVersion: '2026.08.01', identity: wrong,
      criteria: [{ id: 'specialist-coherence', description: 'coherence', requiredModalities: ['visual'] }] });
    const badEvaluator = { manifest, evaluate: value.request.evaluators.specialist.evaluate };
    await expect(value.coordinator.runDreamAndAssimilate({ ...value.request,
      evaluators: { ...value.request.evaluators, specialist: badEvaluator } }))
      .rejects.toThrow('DREAM_EVALUATOR_IDENTITY_MISMATCH');
  });

  it('rejects evaluator seal drift and tampered evidence', async () => {
    // Hermetic: the measured-frame gate launches a real browser; it is not under test here.
    vi.stubEnv('SINTER_COMPOSITE_GATE', '0');
    const drift = fixture();
    const mutable = structuredClone(drift.request.evaluators.specialist.manifest);
    const driftEvaluator: DreamAssimilationEvaluator = { manifest: mutable,
      evaluate: async ({ packet, productionArtifact }) => {
        (mutable.criteria[0] as { description: string }).description = 'changed during review';
        return { identity: mutable.identity, manifestDigest: mutable.manifestDigest,
          packetDigest: packet.packetDigest, verdict: 'approve', judgments: judgments(packet),
          disagreement: [], criteriaResults: [{ criterionId: 'specialist-coherence', passed: true,
            evidenceRefs: evidenceRefs(packet, productionArtifact),
            explanation: 'pass' }] };
      } };
    await expect(drift.coordinator.runDreamAndAssimilate({ ...drift.request,
      evaluators: { ...drift.request.evaluators, specialist: driftEvaluator } }))
      .rejects.toThrow('DREAM_EVALUATOR_SEAL_DRIFT');

    const tamper = fixture();
    const specialist = tamper.request.identities.specialist;
    const badEvidence = evaluator('specialist', specialist, (packet, manifestDigest, artifact) => ({
      identity: specialist, manifestDigest, packetDigest: packet.packetDigest, verdict: 'approve',
      judgments: judgments(packet).map((item) => ({ ...item,
        claims: item.claims.map((claim) => ({ ...claim, evidenceDigest: 'tampered' })) })),
      disagreement: [], criteriaResults: [{ criterionId: 'specialist-coherence', passed: true,
        evidenceRefs: evidenceRefs(packet, artifact),
        explanation: 'claimed pass' }],
    }));
    await expect(tamper.coordinator.runDreamAndAssimilate({ ...tamper.request,
      evaluators: { ...tamper.request.evaluators, specialist: badEvidence } }))
      .rejects.toThrow('REVIEW_CLAIM_EVIDENCE_MISMATCH');
  });

  it('preserves disagreement and vetoes generated work that fails artistic criteria', async () => {
    const value = fixture();
    const specialist = value.request.identities.specialist;
    const adverse = evaluator('specialist', specialist, (packet, manifestDigest, artifact) => ({
      identity: specialist, manifestDigest, packetDigest: packet.packetDigest, verdict: 'veto',
      judgments: judgments(packet), disagreement: ['composition is legible but aesthetically inert'],
      criteriaResults: [{ criterionId: 'specialist-coherence', passed: false,
        evidenceRefs: evidenceRefs(packet, artifact),
        explanation: 'Generated successfully, but the composition lacks intentional hierarchy.' }],
    }));
    const failure = await value.coordinator.runDreamAndAssimilate({ ...value.request,
      evaluators: { ...value.request.evaluators, specialist: adverse } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DreamAssimilationReviewVeto);
    expect((failure as DreamAssimilationReviewVeto).review.disagreement)
      .toContain('composition is legible but aesthetically inert');
    expect(value.recommendationStore.effects).toBe(0);
  });

  it('resumes after interruption before recommendation without rerunning production or review', async () => {
    const value = fixture();
    value.recommendationStore.failBeforeCreate = true;
    const compose = vi.spyOn(value.coordinator, 'composeNoSpend');
    await expect(value.coordinator.runDreamAndAssimilate(value.request))
      .rejects.toThrow('injected-before-recommendation');
    const recovered = await value.coordinator.runDreamAndAssimilate(value.request);
    expect(recovered.recommendation.promotion).toBe('forbidden');
    expect(compose).toHaveBeenCalledTimes(1);
    expect(value.request.evaluators.specialist.evaluate).toHaveBeenCalledTimes(1);
    expect(value.request.evaluators.holistic.evaluate).toHaveBeenCalledTimes(1);
    expect(value.recommendationStore.effects).toBe(1);
  });

  it('checkpoints specialist review before holistic execution and resumes with stable idempotency', async () => {
    const value = fixture();
    const durable = new MemoryDreamAssimilationRunStore();
    let interrupt = true;
    const store = { read: durable.read.bind(durable), claim: durable.claim.bind(durable),
      write: async (checkpoint: Parameters<typeof durable.write>[0]) => {
        await durable.write(checkpoint);
        if (checkpoint.phase === 'specialist-reviewed' && interrupt) {
          interrupt = false;
          throw new Error('injected-between-reviewers');
        }
      } };
    await expect(value.coordinator.runDreamAndAssimilate({ ...value.request, store }))
      .rejects.toThrow('injected-between-reviewers');
    await value.coordinator.runDreamAndAssimilate({ ...value.request, store });
    expect(value.request.evaluators.specialist.evaluate).toHaveBeenCalledTimes(1);
    expect(value.request.evaluators.holistic.evaluate).toHaveBeenCalledTimes(1);
    const specialistContext = vi.mocked(value.request.evaluators.specialist.evaluate).mock.calls[0]![0];
    expect(specialistContext.reviewKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses atomic get-or-create after a final checkpoint interruption', async () => {
    const value = fixture();
    const durable = new MemoryDreamAssimilationRunStore();
    let failCompleted = true;
    const store = { read: durable.read.bind(durable), claim: durable.claim.bind(durable),
      write: async (checkpoint: Parameters<typeof durable.write>[0]) => {
        if (checkpoint.phase === 'completed' && failCompleted) {
          failCompleted = false;
          throw new Error('injected-final-checkpoint-failure');
        }
        await durable.write(checkpoint);
      } };
    const compose = vi.spyOn(value.coordinator, 'composeNoSpend');
    await expect(value.coordinator.runDreamAndAssimilate({ ...value.request, store }))
      .rejects.toThrow('injected-final-checkpoint-failure');
    const recovered = await value.coordinator.runDreamAndAssimilate({ ...value.request, store });
    expect(recovered.recommendation.promotion).toBe('forbidden');
    expect(compose).toHaveBeenCalledTimes(1);
    expect(value.recommendationStore.effects).toBe(1);
    expect(value.recommendationStore.attempts).toBe(2);
  });

  it('serializes independent file-store instances and restores a completed receipt', async () => {
    const root = await mkdtemp(`${tmpdir()}/dream-concurrent-`);
    const value = fixture();
    const compose = vi.spyOn(value.coordinator, 'composeNoSpend');
    try {
      const [first, second] = await Promise.all([
        value.coordinator.runDreamAndAssimilate({ ...value.request,
          store: new FileDreamAssimilationRunStore(root) }),
        value.coordinator.runDreamAndAssimilate({ ...value.request,
          store: new FileDreamAssimilationRunStore(root) }),
      ]);
      expect(second.recommendation.recommendationDigest).toBe(first.recommendation.recommendationDigest);
      expect(compose).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects stale, fabricated, changed-source, invalid-budget, and overlapping identity inputs', async () => {
    expect(() => parseDreamAssimilationCheckpoint({ schema: 'old', schemaVersion: 0 }))
      .toThrow('DREAM_ASSIMILATION_STALE_SCHEMA');
    expect(() => parseDreamAssimilationResult({ schema: 'fabricated' }))
      .toThrow('DREAM_ASSIMILATION_FABRICATED_RESULT');
    const first = fixture();
    await first.coordinator.runDreamAndAssimilate(first.request);
    await expect(first.coordinator.runDreamAndAssimilate({ ...first.request, prompt: 'changed' }))
      .rejects.toThrow('DREAM_ASSIMILATION_FINGERPRINT_MISMATCH');
    const invalid = fixture({ budget: { candidateCount: 2, candidateBudget: 2 } });
    await expect(invalid.coordinator.runDreamAndAssimilate(invalid.request))
      .rejects.toThrow('DREAM_ASSIMILATION_BUDGET_INVALID');
    const same = identity('generator', 'same');
    const overlap = fixture({ identities: { generator: same,
      specialist: { ...same, role: 'specialist' }, holistic: identity('holistic', 'other') } });
    await expect(overlap.coordinator.runDreamAndAssimilate(overlap.request))
      .rejects.toThrow('DREAM_ASSIMILATION_IDENTITY_OVERLAP');
    for (const field of ['provider', 'model', 'pipe', 'effort',
      'contributionLineage', 'assignment'] as const) {
      const generator = identity('generator', `generator-${field}`);
      const specialist = identity('specialist', `specialist-${field}`);
      const planted = fixture({ identities: { generator,
        specialist: { ...specialist, [field]: generator[field] },
        holistic: identity('holistic', `holistic-${field}`) } });
      await expect(planted.coordinator.runDreamAndAssimilate(planted.request))
        .rejects.toThrow('DREAM_ASSIMILATION_IDENTITY_OVERLAP');
    }
  });

  it('records each resumable checkpoint phase in order', async () => {
    const value = fixture();
    await value.coordinator.runDreamAndAssimilate(value.request);
    expect(value.store.writes satisfies readonly DreamCheckpointPhase[])
      .toEqual(['started', 'produced', 'specialist-reviewed', 'reviewed', 'completed']);
  });
});
