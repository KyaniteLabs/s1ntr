import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompositionGraph } from '../../../src/composition/CompositionGraph.js';
import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import {
  campaignActualSource, campaignCreativeThesisDigest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';
import {
  buildCampaignExecutionPlan, createCampaignManifest, ownerReviewStageIds,
  type CampaignManifest, type CampaignRouteFreeze, type CampaignSlotGraph,
} from '../../../src/creative-run/CampaignManifest.js';
import { CampaignService, type CampaignExecutionInputV1 } from '../../../src/creative-run/CampaignService.js';
import { unitTestCampaignAuthorityBoundary } from '../../fixtures/campaignAuthorityBoundary.js';
import { assertOwnerReviewAdmission, bootstrapCampaignFundingAuthority,
  digestCampaignProviderEndpoint,
  type CampaignFundingReservationAuthority } from '../../../src/creative-run/CampaignExecutionAuthority.js';
import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../../src/creative-run/CreativeRunCoordinator.js';
import { createBlindReviewSession } from '../../../src/creative-run/BlindReviewEvidence.js';
import { subscriptionFunding } from '../../../src/identity/fundingTruth.js';
import { bootstrapTestCampaignExecutorAuthority } from '../../../src/identity/executorAuthorityBootstrap.js';
import { createCampaignAuthority, InMemoryCampaignAdmissionStore } from '../../../src/runtime-core/CampaignOrigin.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function graph(briefId: string, candidate: number): CompositionGraph & { renderGate: false } {
  const slotId = `${briefId}-candidate-${candidate}`;
  const thesis = compileCreativeThesis(`${briefId} actual candidate ${candidate}`);
  const count = candidate;
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `${slotId}-node-${index + 1}`, type: 'layer' as const,
    layer: { domain: 'html' as const, prompt: `${slotId} layer ${index + 1}`,
      code: `<main data-slot="${slotId}" data-node="${index + 1}">${briefId}</main>`,
      blendMode: 'normal' as const, opacity: 1 },
  }));
  return { schema: 'sinter.composition-graph', schemaVersion: '2.0', status: 'ready',
    id: `graph-${slotId}`, title: slotId, creativeThesis: thesis, renderGate: false,
    budgets: { maxNodes: count, maxEdges: Math.max(0, count - 1), maxProviderCalls: 0 },
    nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${slotId}-${index}`,
      type: 'before' as const, from: nodes[index]!.id, to: node.id })) };
}

interface BatchFixture {
  readonly manifest: CampaignManifest;
  readonly bindings: readonly CampaignSlotGraph[];
  readonly plan: ReturnType<typeof buildCampaignExecutionPlan>;
  readonly input: CampaignExecutionInputV1;
}

async function batchFixture(campaignRunId = 'batch-campaign'): Promise<BatchFixture> {
  const briefIds = ['temporal', 'narrative', 'information'];
  const prepared = briefIds.flatMap((briefId) => [1, 2, 3].map((candidate) =>
    ({ briefId, candidate, graph: graph(briefId, candidate) })));
  const briefs = briefIds.map((briefId) => ({ id: briefId,
    sealedBriefDigest: sha(`brief:${briefId}`), unseenAt: '2026-08-02T00:00:00.000Z',
    exampleFree: true, candidateSlots: prepared.filter((item) => item.briefId === briefId)
      .map(({ candidate, graph: candidateGraph }) => {
        const candidateId = `${briefId}-candidate-${candidate}`;
        const requiredEvidenceClasses = ['source', 'visual', 'temporal', 'interaction',
          'runtime', 'clock', 'accessibility'] as const;
        const body = { campaignRunId, briefId, candidateId, nodeId: candidateGraph.nodes[0]!.id,
          audioRequirement: 'not-applicable' as const, requiredEvidenceClasses,
          evidenceScheduleDigest: sha(`schedule:${candidateId}`) };
        return { id: candidateId, graphNodeIds: candidateGraph.nodes.map((node) => node.id),
          ownerEvidence: { ...body, slotDigest: sha(stable(body)) } };
      }) }));
  const reviewIds = briefs.flatMap((brief) => brief.candidateSlots.flatMap((slot) => [
    `specialist-review-${brief.id}-${slot.id}`, `holistic-review-${brief.id}-${slot.id}`,
  ]));
  const manifest = createCampaignManifest({ campaignRunId,
    owner: { authorityId: 'owner-batch', selectionMethod: 'host-sealed' }, briefs,
    transfer: { mode: 'sealed-brief', sealedBriefDigest: sha('transfer-brief'),
      unseenAt: '2026-08-02T00:00:00.000Z', treatmentControlAllocation: 'treatment-first',
      routeDigest: sha('route'), randomSourceDigest: sha('transfer-random'),
      evidenceScheduleDigest: sha('transfer-schedule'), nonOverlapDigest: sha('non-overlap') },
    rolesDigest: sha('roles'), executorRequirementsDigest: sha('executor-requirements'),
    evidenceModalitiesDigest: sha('modalities'), ownerCheckpointsDigest: sha('owner-checkpoints'),
    qualityRubricVersion: 'v1', randomSourceDigest: sha('random'),
    evidenceScheduleDigest: sha('schedule'), requiredReviewStageIds: reviewIds,
    stopStates: ['complete'], ceilings: { providerCalls: 128, inputTokens: 5_000_000,
      outputTokens: 2_000_000, activeMinutes: 960 } });
  const bindings = manifest.briefs.flatMap((brief) => brief.candidateSlots.map((slot) => ({
    briefId: brief.id, candidateSlotId: slot.id,
    graph: prepared.find((item) => item.briefId === brief.id
      && `${brief.id}-candidate-${item.candidate}` === slot.id)!.graph,
  })));
  const routeFreeze: CampaignRouteFreeze = {
    routes: [
      { role: 'generator', seatId: 'generator', provider: 'openai', model: 'gpt-generator',
        seed: 'generator-seed', retryBudget: 1 },
      { role: 'evaluator', seatId: 'specialist-review', provider: 'google', model: 'gemini-review',
        seed: 'specialist-seed', retryBudget: 1 },
      { role: 'evaluator', seatId: 'holistic-review', provider: 'anthropic', model: 'claude-review',
        seed: 'holistic-seed', retryBudget: 1 },
      { role: 'harness', seatId: 'dream', provider: 'openai', model: 'gpt-dream',
        seed: 'dream-seed', retryBudget: 1 },
    ],
    transportBudgets: {}, transferTargetDigest: sha('transfer-target'),
    diversityDimensions: [
      { id: 'composition', description: 'layout' }, { id: 'motion', description: 'timing' },
      { id: 'material', description: 'surface' },
    ],
    candidateDiversity: bindings.map((binding, index) => ({
      briefId: binding.briefId, candidateSlotId: binding.candidateSlotId,
      thesisDigest: campaignCreativeThesisDigest(binding.graph.creativeThesis!),
      dimensions: { composition: `composition-${index}`, motion: `motion-${index}`,
        material: `material-${index}` },
    })),
  };
  const plan = buildCampaignExecutionPlan(manifest, bindings, routeFreeze);
  const input: CampaignExecutionInputV1 = { schema: 'sinter.campaign-execution-input',
    schemaVersion: 1, slotGraphs: bindings };
  return { manifest, bindings, plan, input };
}

let dir = '';
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'campaign-batch-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function fundingAuthority(root: string): CampaignFundingReservationAuthority {
  const routes = [
    { seatId: 'generator', provider: 'openai', model: 'gpt-generator', effort: 'medium', surface: 'openai-direct' },
    { seatId: 'specialist-review', provider: 'google', model: 'gemini-review', effort: 'high', surface: 'google-direct' },
    { seatId: 'holistic-review', provider: 'anthropic', model: 'claude-review', effort: 'medium', surface: 'anthropic-direct' },
    { seatId: 'dream', provider: 'openai', model: 'gpt-dream', effort: 'medium', surface: 'cliproxy-seat' },
  ] as const;
  const capacities = Object.fromEntries(routes.map((route) => {
    const seatDigest = sha(route.seatId);
    const endpoint = route.surface === 'google-direct' ? 'https://generativelanguage.googleapis.com'
      : route.surface === 'anthropic-direct' ? 'https://api.anthropic.com/v1'
        : route.surface === 'cliproxy-seat' ? 'http://localhost:8317/v1'
          : 'https://api.openai.com/v1';
    return [route.seatId, { seat: { seatId: route.seatId, seatDigest, surface: route.surface },
      identity: { provider: route.provider, model: route.model, effort: route.effort },
      funding: subscriptionFunding({ seatDigest, quotaCounters: {
        calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0,
      }, quotaSurface: route.surface }),
      surface: route.surface, endpointDigest: digestCampaignProviderEndpoint(endpoint),
      remaining: { providerCalls: 256, inputTokens: 20_000_000,
        outputTokens: 8_000_000, activeSeconds: 200_000 } }];
  }));
  return bootstrapCampaignFundingAuthority({ rootDir: root,
    env: { ...process.env, SINTER_CAMPAIGN_CAPACITY_JSON: JSON.stringify(capacities) } });
}

function serviceHarness(root: string, trustGenerationSettlement = true) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const authority = createCampaignAuthority({ keyId: 'batch-origin',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    admissionStore: new InMemoryCampaignAdmissionStore() });
  const finalize = vi.spyOn(authority, 'finalize');
  const admitOrigin = vi.spyOn(authority, 'admit');
  const reserveProvider = vi.fn(async () => ({ id: 'batch-provider', status: 'reserved' as const }));
  const coordinator = new CreativeRunCoordinator({ releaseRoot: root,
    persistence: new MemoryCreativeRunPersistence(), reserveProvider, campaignAuthority: authority,
    campaignPreflight: async () => ({ releaseHead: 'a'.repeat(40), sourceFingerprint: sha('source'),
      schemaDigest: sha('schema'), implementationDigest: sha('implementation'),
      wave8ReleaseRootDigest: sha('wave8-root') }) });
  const funding = fundingAuthority(root);
  if (trustGenerationSettlement) {
    vi.spyOn(funding, 'assertSuccessfulStageGroups').mockResolvedValue();
  }
  return { service: new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: funding,
    executorAuthorityFactory: (binding) => bootstrapTestCampaignExecutorAuthority(binding, root) }),
    coordinator, finalize, admitOrigin, reserveProvider };
}

function retainedCapabilityCount(coordinator: CreativeRunCoordinator): number {
  return (coordinator as unknown as { campaignCapabilities: Map<string, unknown> })
    .campaignCapabilities.size;
}

async function runBatch(fixture: BatchFixture, root = dir,
  completeOwnerReviews?: Parameters<CampaignService['runGovernedCampaign']>[4]) {
  const harness = serviceHarness(root);
  const admission = await harness.service.startCampaign(
    { entryPoint: 'cli-compose', requestKey: fixture.manifest.campaignRunId },
    fixture.manifest, fixture.plan,
  );
  const result = await harness.service.runGovernedCampaign(admission, fixture.manifest,
    fixture.input, { entryPoint: 'cli-compose' }, completeOwnerReviews ?? (async (manifests) =>
      manifests.map((item) => ({ briefId: item.briefId,
        packetDigest: sha(`packet:${item.briefId}`),
        reviewBundleDigest: sha(`bundle:${item.briefId}`) }))));
  return { ...harness, admission, result };
}

describe('campaign manifest v3 output/evidence boundary', () => {
  it('rejects non-legacy/non-SHA256 cross-modal candidate digest lengths', () => {
    expect(() => buildCrossModalArtifact({ brief: 'invalid digest',
      sourceCandidateArtifactDigest: 'a'.repeat(32) }))
      .toThrow('Cross-modal source candidate artifact digest is invalid');
  });

  it('rejects a v2 manifest before governed execution admission', async () => {
    const fixture = await batchFixture('reject-v2');
    const harness = serviceHarness(dir);
    const legacy = { ...fixture.manifest, schemaVersion: 2 } as unknown as CampaignManifest;
    expect(() => harness.service.assertGovernedInput(legacy, fixture.plan, fixture.input))
      .toThrow('CAMPAIGN_MANIFEST_V3_REQUIRED');
    expect(harness.reserveProvider).not.toHaveBeenCalled();
  });

  it('accepts output digests known only after execution', async () => {
    const fixture = await batchFixture('post-execution-digests');
    const harness = serviceHarness(dir);
    const admission = await harness.service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: fixture.manifest.campaignRunId },
      fixture.manifest, fixture.plan,
    );
    const compose = CompositionOrchestrator.compose.bind(CompositionOrchestrator);
    let ordinal = 0;
    vi.spyOn(CompositionOrchestrator, 'compose').mockImplementation(async (...args) => {
      const result = await compose(...args);
      ordinal += 1;
      return { ...result, html: `${result.html}<!-- generated-output-${ordinal}-${Math.random()} -->` };
    });
    let admittedDuringSettlement = false;
    let ownerAdmission: ReturnType<CampaignService['admitOwnerReview']> | undefined;
    const result = await harness.service.runGovernedCampaign(admission, fixture.manifest,
      fixture.input, { entryPoint: 'cli-compose' }, async (manifests) => {
        ownerAdmission = harness.service.admitOwnerReview(admission, fixture.manifest, manifests);
        admittedDuringSettlement = true;
        const forged = manifests.map((manifest, index) => index === 0
          ? { ...manifest, candidates: manifest.candidates.map((candidate, candidateIndex) => candidateIndex === 0
            ? { ...candidate, artifact: { ...candidate.artifact, artifactDigest: sha('forged') } }
            : candidate) }
          : manifest);
        expect(() => harness.service.admitOwnerReview(admission, fixture.manifest, forged))
          .toThrow('CAMPAIGN_OWNER_REVIEW_CANDIDATES_UNSETTLED');
        return manifests.map((item) => ({ briefId: item.briefId,
          packetDigest: sha(`packet:${item.briefId}`),
          reviewBundleDigest: sha(`bundle:${item.briefId}`) }));
      });
    expect(admittedDuringSettlement).toBe(true);
    expect(() => assertOwnerReviewAdmission(ownerAdmission!))
      .toThrow('OWNER_REVIEW_ADMISSION_NOT_HOST_ISSUED');
    expect(() => harness.service.admitOwnerReview(admission, fixture.manifest,
      result.candidateManifests)).toThrow('CAMPAIGN_OWNER_REVIEW_CANDIDATES_UNSETTLED');
    expect(result.candidateManifests.flatMap((item) => item.candidates))
      .toHaveLength(9);
    expect(result.candidateManifests[0]!.manifestDigest)
      .toBe(fixture.manifest.manifestDigest);
    expect(result.candidateManifests[0]!.candidates[0]!.artifact.html)
      .toContain('generated-output-1-');
  });

  it('revokes candidate settlement authority when owner review fails', async () => {
    const fixture = await batchFixture('failed-owner-review-revocation');
    const harness = serviceHarness(dir);
    const admission = await harness.service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: fixture.manifest.campaignRunId },
      fixture.manifest, fixture.plan,
    );
    let captured: Parameters<CampaignService['admitOwnerReview']>[2] = [];
    await expect(harness.service.runGovernedCampaign(admission, fixture.manifest,
      fixture.input, { entryPoint: 'cli-compose' }, async (manifests) => {
        captured = manifests;
        throw new Error('owner review failed');
      })).rejects.toThrow('owner review failed');
    expect(() => harness.service.admitOwnerReview(admission, fixture.manifest, captured))
      .toThrow('CAMPAIGN_OWNER_REVIEW_CANDIDATES_UNSETTLED');
  });

  it('waits for escaped owner-review work before revoking the governed scope', async () => {
    const fixture = await batchFixture('escaped-owner-review-work');
    const harness = serviceHarness(dir);
    const admission = await harness.service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: fixture.manifest.campaignRunId },
      fixture.manifest, fixture.plan,
    );
    let release!: () => void;
    const escaped = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const scopeReached = new Promise<void>((resolve) => { reached = resolve; });
    let ownerAdmission: ReturnType<CampaignService['admitOwnerReview']> | undefined;
    const running = harness.service.runGovernedCampaign(admission, fixture.manifest,
      fixture.input, { entryPoint: 'cli-compose' }, async (manifests) => {
        ownerAdmission = harness.service.admitOwnerReview(admission, fixture.manifest, manifests);
        const scopes = (harness.service as unknown as { activeOwnerReviewScopes: WeakMap<object,
          { pending: Set<Promise<unknown>> }> }).activeOwnerReviewScopes;
        scopes.get(admission)!.pending.add(escaped);
        reached();
        return manifests.map((item) => ({ briefId: item.briefId,
          packetDigest: sha(`packet:${item.briefId}`),
          reviewBundleDigest: sha(`bundle:${item.briefId}`) }));
      });
    await scopeReached;
    let settled = false;
    void running.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(() => assertOwnerReviewAdmission(ownerAdmission!)).not.toThrow();
    release();
    await running;
    expect(() => assertOwnerReviewAdmission(ownerAdmission!))
      .toThrow('OWNER_REVIEW_ADMISSION_NOT_HOST_ISSUED');
  });
});

describe('finite campaign batch validation', () => {
  it.each([
    ['omitted', (input: CampaignExecutionInputV1) => ({ ...input,
      slotGraphs: input.slotGraphs.slice(0, -1) })],
    ['duplicate', (input: CampaignExecutionInputV1) => ({ ...input,
      slotGraphs: [...input.slotGraphs.slice(0, -1), input.slotGraphs[0]!] })],
    ['reordered', (input: CampaignExecutionInputV1) => ({ ...input,
      slotGraphs: [input.slotGraphs[1]!, input.slotGraphs[0]!, ...input.slotGraphs.slice(2)] })],
  ])('rejects %s slots before admission or provider access', async (_label, mutate) => {
    const fixture = await batchFixture(`invalid-${_label}`);
    const harness = serviceHarness(dir);
    expect(() => harness.service.assertGovernedInput(
      fixture.manifest, fixture.plan, mutate(fixture.input),
    )).toThrow('CAMPAIGN_EXECUTION_SLOT_ORDER_MISMATCH');
    expect(harness.reserveProvider).not.toHaveBeenCalled();
  });

  it('rejects a tampered graph before admission or provider access', async () => {
    const fixture = await batchFixture('tampered-graph');
    const harness = serviceHarness(dir);
    const first = fixture.input.slotGraphs[0]!;
    const tampered = { ...first, graph: { ...first.graph,
      title: `${first.graph.title}-tampered` } };
    const input = { ...fixture.input, slotGraphs: [tampered, ...fixture.input.slotGraphs.slice(1)] };
    expect(() => harness.service.assertGovernedInput(fixture.manifest, fixture.plan, input))
      .toThrow('CAMPAIGN_EXECUTION_GRAPH_DIGEST_MISMATCH');
    expect(harness.reserveProvider).not.toHaveBeenCalled();
  });
});

describe('finite campaign batch execution', () => {
  it('rejects a static-code batch before owner review when no generator transport settled', async () => {
    const fixture = await batchFixture('static-code-bypass');
    const harness = serviceHarness(dir, false);
    const admission = await harness.service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: fixture.manifest.campaignRunId },
      fixture.manifest, fixture.plan,
    );
    const ownerReview = vi.fn(async () => []);
    await expect(harness.service.runGovernedCampaign(admission, fixture.manifest,
      fixture.input, { entryPoint: 'cli-compose' }, ownerReview))
      .rejects.toThrow('CAMPAIGN_GENERATION_SUCCESS_MISSING');
    expect(ownerReview).not.toHaveBeenCalled();
    expect(retainedCapabilityCount(harness.coordinator)).toBe(0);
  });

  it('checkpoints all 3x3 slots and owner reviews without finalizing the origin', async () => {
    const fixture = await batchFixture('complete-batch');
    let reviewPackets = 0;
    const { result, coordinator, finalize } = await runBatch(fixture, dir, async (manifests) => {
      expect(manifests.map((item) => item.briefId))
        .toEqual(fixture.manifest.briefs.map((item) => item.id));
      for (const manifest of manifests) {
        const session = createBlindReviewSession(manifest, manifest.candidates.map((candidate) => ({
          candidateId: candidate.id,
          sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
          requiredModalities: ['visual'] as const,
        })));
        expect(session.packet.candidates.map((item) => item.artifactDigest))
          .toEqual(manifest.candidates.map((item) => item.artifact.artifactDigest));
        reviewPackets += 1;
      }
      return manifests.map((item) => ({ briefId: item.briefId,
        packetDigest: sha(`packet:${item.briefId}`),
        reviewBundleDigest: sha(`bundle:${item.briefId}`) }));
    });
    expect(result.executions).toHaveLength(9);
    expect(result.candidateManifests.map((item) => item.candidates.length)).toEqual([3, 3, 3]);
    expect(reviewPackets).toBe(3);
    expect(finalize).not.toHaveBeenCalled();
    expect(retainedCapabilityCount(coordinator)).toBe(1);
    const checkpoint = result.campaignEvidenceCheckpoint;
    expect(checkpoint).toMatchObject({ schema: 'sinter.campaign-evidence-checkpoint',
      schemaVersion: 1, originPending: true });
    expect(checkpoint.receipts).toHaveLength(24);
    expect(checkpoint.receipts.slice(0, 18).map((item) => item.kind))
      .toEqual(Array.from({ length: 9 }, () => ['composition', 'actual-candidate']).flat());
    expect(checkpoint.receipts.slice(18).map((item) => item.kind))
      .toEqual(Array.from({ length: 3 }, () => ['owner-packet', 'owner-review-bundle']).flat());
    expect(checkpoint.receipts.slice(18).map((item) => item.resultDigest))
      .toEqual(fixture.manifest.briefs.flatMap((brief) =>
        [sha(`packet:${brief.id}`), sha(`bundle:${brief.id}`)]));
    expect(checkpoint.receipts.some((item) => item.kind === 'campaign-origin')).toBe(false);
    const { checkpointDigest, ...checkpointBody } = checkpoint;
    expect(checkpointDigest).toBe(sha(stable(checkpointBody)));
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(checkpoint.receipts)).toBe(true);
    expect(result.candidateManifests[0]!.candidates[0]).not.toHaveProperty('quality');
  });

  it('binds the post-execution source projection to each actual candidate', async () => {
    const fixture = await batchFixture('actual-source-binding');
    const { result } = await runBatch(fixture);
    const first = result.candidateManifests[0]!.candidates[0]!;
    expect(sha(campaignActualSource(first.artifact.layers))).toBe(first.artifact.sourceDigest);
    expect(first.slotDigest).toBe(fixture.manifest.briefs[0]!.candidateSlots[0]!.ownerEvidence.slotDigest);
  });

  it('rejects a truncated v3 actual artifact digest before blind review', async () => {
    const fixture = await batchFixture('actual-digest-tamper');
    const { result } = await runBatch(fixture);
    const actual = result.candidateManifests[0]!;
    const candidate = actual.candidates[0]!;
    const tampered = { ...actual, candidates: [{ ...candidate,
      artifact: { ...candidate.artifact,
        artifactDigest: candidate.artifact.artifactDigest.slice(0, 16) } },
    ...actual.candidates.slice(1)] };
    expect(() => createBlindReviewSession(tampered, tampered.candidates.map((item) => ({
      candidateId: item.id, sourceCandidateArtifactDigest: item.artifact.artifactDigest,
      requiredModalities: ['visual'] as const,
    })))).toThrow('CAMPAIGN_ACTUAL_CANDIDATE_DIGEST_INVALID');
  });

  it('leaves no checkpoint or retained capability when owner review fails', async () => {
    const fixture = await batchFixture('owner-review-failure');
    const harness = serviceHarness(dir);
    const admission = await harness.service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: fixture.manifest.campaignRunId },
      fixture.manifest, fixture.plan,
    );
    await expect(harness.service.runGovernedCampaign(admission, fixture.manifest,
      fixture.input, { entryPoint: 'cli-compose' }, async () => {
        throw new Error('owner-review-failed');
      })).rejects.toThrow('owner-review-failed');
    expect(harness.finalize).not.toHaveBeenCalled();
    expect(retainedCapabilityCount(harness.coordinator)).toBe(0);
    expect(harness.admitOrigin).toHaveBeenCalledOnce();
    await expect(harness.service.runGovernedCampaign(admission, fixture.manifest,
      fixture.input, { entryPoint: 'cli-compose' }, async () => []))
      .rejects.toThrow('Campaign has already been admitted');
    expect(harness.admitOrigin).toHaveBeenCalledTimes(2);
  });

  it('does not mint a campaign origin after a partial batch failure', async () => {
    const fixture = await batchFixture('partial-batch');
    const harness = serviceHarness(dir);
    const admission = await harness.service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: fixture.manifest.campaignRunId },
      fixture.manifest, fixture.plan,
    );
    const compose = CompositionOrchestrator.compose.bind(CompositionOrchestrator);
    let calls = 0;
    vi.spyOn(CompositionOrchestrator, 'compose').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('candidate-two-failed');
      return compose(...args);
    });
    await expect(harness.service.runGovernedCampaign(admission, fixture.manifest,
      fixture.input, { entryPoint: 'cli-compose' }, async () => []))
      .rejects.toThrow('candidate-two-failed');
    expect(calls).toBe(2);
    expect(harness.finalize).not.toHaveBeenCalled();
  });
});
