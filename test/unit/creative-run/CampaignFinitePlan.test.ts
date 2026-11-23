import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GLM_CODING_PLAN_MODEL } from '../../../src/identity/GLMCodingPlanSeat.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const dnsFixture = vi.hoisted(() => ({ enabled: false }));
vi.mock('dns/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('dns/promises')>();
  return {
    ...original,
    lookup: (...args: Parameters<typeof original.lookup>) => {
      if (!dnsFixture.enabled) return original.lookup(...args);
      if (args[0] === 'api.openai.com') return Promise.resolve({ address: '203.0.113.1', family: 4 });
      if (args[0] === '127.0.0.1') return Promise.resolve({ address: '127.0.0.1', family: 4 });
      throw new Error(`Unexpected DNS lookup: ${args[0]}`);
    },
  };
});
import {
  buildCampaignExecutionPlan,
  createCampaignManifest,
  validateCampaignSlotGraph,
  type CampaignManifestInput,
  type CampaignSlotGraph,
  type CampaignRouteFreeze,
} from '../../../src/creative-run/CampaignManifest.js';
import {
  CampaignFundingReservationAuthority,
  consumeCurrentSubscriptionCampaignBinding,
  assertOwnerReviewAdmission,
  bootstrapCampaignFundingAuthority,
  claimCurrentCampaignTransportProof,
  debitCurrentCampaignFunding,
  digestCampaignProviderEndpoint,
  validateCurrentSubscriptionCampaignBinding,
  type CampaignFundingAllocation,
  type CampaignFundingCapacitySource,
  type CampaignFundingDebitReceipt,
} from '../../../src/creative-run/CampaignExecutionAuthority.js';
import {
  bootstrapProductionOwnerReviewHost,
  bootstrapTestOwnerReviewHost,
  runOwnerReviewLifecycle,
  type OwnerReviewLifecycleResult,
} from '../../../src/creative-run/OwnerReviewLifecycle.js';
import { HostAdapterRegistry, mintTrustKey, sha256Hex } from '../../../src/identity/hostAdapterRegistry.js';
import { bootstrapExecutorAuthority, bootstrapHostAuthority,
  bootstrapTestCampaignExecutorAuthority } from '../../../src/identity/executorAuthorityBootstrap.js';
import { meteredFunding, subscriptionFunding } from '../../../src/identity/fundingTruth.js';
import { issueExecutorAttestation } from '../../../src/identity/executorAttestation.js';
import { issueExecutorReservation, ReservationTracker } from '../../../src/identity/executorReservation.js';
import { NonceLedger } from '../../../src/identity/executorAttestation.js';
import { HarnessTransportGuard, type HarnessTransportAuthority } from '../../../src/identity/harnessTransportGuard.js';
import { buildRegistry } from '../identity/helpers.js';
import {
  CampaignStageCounters,
  DurableCampaignCandidateLedger,
  FileCampaignLedgerPersistence,
} from '../../../src/creative-run/CampaignPersistence.js';
import { CampaignService } from '../../../src/creative-run/CampaignService.js';
import { unitTestCampaignAuthorityBoundary } from '../../fixtures/campaignAuthorityBoundary.js';
import { closeCampaignCliClosure, recordCampaignCliRevisionClosure,
  runCampaignCliJourney, runCampaignCliOwnerDecision, runCampaignCliOwnerReview } from '../../../src/cli/CampaignCli.js';
import { closeCampaignStudioClosure, recordCampaignStudioRevisionClosure,
  runGovernedCampaignStudioJourney, runCampaignStudioJourney, runCampaignStudioOwnerReview } from '../../../src/tui-bridge/CampaignStudio.js';
import { TuiBridgeService, type BridgeHostAuthorityRegistry } from '../../../src/tui-bridge/TuiBridgeService.js';
import { TuiBridgeServer } from '../../../src/tui-bridge/TuiBridgeServer.js';
import { ManagedOwnerReviewRenderer } from '../../../src/creative-run/ManagedOwnerReviewRenderer.js';
import {
  createCaptureAuthority,
  createEnvelopeAuthority,
  type OwnerReviewPacket,
  type OwnerReviewPacketRenderer,
  type OwnerReviewPacketStore,
  type OwnerCaptureInputs,
} from '../../../src/creative-run/OwnerQualityReview.js';
import { buildCandidateManifest, campaignCreativeThesisDigest,
  campaignActualArtifactDigest,
  campaignActualSource,
  campaignActualSourceDigest,
  type CampaignActualCandidateManifest } from '../../../src/creative-run/CandidateHypothesisProduction.js';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { FIGURE_GROUND_METRIC, FIGURE_GROUND_TARGET, WCAG_CONTRAST_METRIC } from '../../../src/creative-run/HtmlCssContrast.js';
import { createBlindReviewSession, type BlindReviewJudgment, type BlindReviewSession,
  type CandidateEvidenceAssignment } from '../../../src/creative-run/BlindReviewEvidence.js';
import {
  createAttributableRevisionSession,
  createCanonicalCreativeArtifact,
  createIndependentBlindTreatmentPreference,
  type CriticContribution,
  type ExperimentPlan,
  type IndependentBlindTreatmentPreference,
} from '../../../src/creative-run/AttributableRevision.js';
import {
  bootstrapCampaignClosureEvidenceAuthority,
  type CampaignClosureEvidenceAuthority,
} from '../../../src/creative-run/CampaignClosure.js';
import {
  CreativeRunCoordinator,
  MemoryCreativeRunPersistence,
  type OwnerAuthorityCapability,
  type TrustedAuthorityAssertion,
} from '../../../src/creative-run/CreativeRunCoordinator.js';
import type { CampaignRunAdmission } from '../../../src/creative-run/CreativeRunCoordinatorBase.js';
import type { CompositionGraph } from '../../../src/composition/CompositionGraph.js';
import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';
import { createCampaignAuthority, InMemoryCampaignAdmissionStore } from '../../../src/runtime-core/CampaignOrigin.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { generatorRegistry } from '../../../src/generators/GeneratorRegistry.js';
import { registerAllGenerators } from '../../../src/generators/registerGenerators.js';
import { err, ok } from 'neverthrow';
import { LLMError } from '../../../src/llm/errors.js';
import { createWave8LiveProtocolFixture } from '../../fixtures/wave8LiveProtocol.js';
import { loadProductionOwnerReviewPackage } from '../../../src/cli/ProductionOwnerReview.js';
import {
  configureWave8LivePreSpendInterlockForTests,
  resetPreSpendInterlockForTests,
  runWithPreSpendCallContext,
  SubscriptionHostAdapterRegistry,
} from '../../../src/llm/PreSpendInterlock.js';
import {
  createGLMCodingPlanHostAdapter,
  GLMCodingPlanReviewClient,
} from '../../../src/llm/GLMCodingPlanHostAdapter.js';
import {
  GLM_CODING_PLAN_ENDPOINT,
  installGLMCodingPlanTransportTrustForTests,
  provisionGLMCodingPlanOwnerProvenance,
  provisionGLMCodingPlanSeat,
} from '../../../src/identity/GLMCodingPlanSeat.js';

const D = (seed: string): string => seed.repeat(64).slice(0, 64);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The terminal-closure fixture has no audio requirement, so its real owner packet can be built from deterministic local media. */
function closureManifestInput(campaignRunId: string): CampaignManifestInput {
  const input = manifestInput(campaignRunId);
  return {
    ...input,
    briefs: input.briefs.map((brief) => ({
      ...brief,
      candidateSlots: brief.candidateSlots.map((slot) => {
        const body = {
          ...slot.ownerEvidence,
          audioRequirement: 'not-applicable' as const,
          requiredEvidenceClasses: ['source', 'visual', 'temporal', 'interaction', 'runtime', 'clock', 'accessibility'] as const,
        };
        const { slotDigest: _slotDigest, ...unsigned } = body;
        return { ...slot, ownerEvidence: {
          ...unsigned,
          slotDigest: createHash('sha256').update(stableJson(unsigned)).digest('hex'),
        } };
      }),
    })),
  };
}

function slotGraph(slotId: string, nodeIds: string[], opts: Partial<CompositionGraph> = {}): CompositionGraph {
  const nodes = nodeIds.map((id, i) => ({
    id,
    type: 'layer' as const,
    layer: {
      domain: i === 0 ? 'p5' : 'tone',
      prompt: `node-${id}`,
      blendMode: 'normal' as const,
      opacity: 1,
      generated: false,
    },
  }));
  return {
    schema: 'sinter.composition-graph',
    schemaVersion: '2.0',
    status: 'ready',
    id: `graph-${slotId}`,
    title: slotId,
    budgets: {
      maxNodes: Math.max(nodes.length, 1),
      maxEdges: Math.max(0, nodes.length - 1),
      maxProviderCalls: nodes.length,
    },
    nodes,
    edges: nodes.slice(1).map((n, i) => ({
      id: `e-${i}`,
      type: 'before' as const,
      from: nodes[i]!.id,
      to: n.id,
    })),
    ...opts,
  };
}

function manifestInput(campaignRunId = 'campaign-run-1'): CampaignManifestInput {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') { const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`; }
    return JSON.stringify(value);
  };
  return {
    campaignRunId,
    owner: { authorityId: 'owner-1', selectionMethod: 'sealed-owner-selection' },
    briefs: ['temporal', 'narrative', 'information'].map((id, bi) => ({
      id,
      sealedBriefDigest: D(String(bi + 1)),
      unseenAt: '2026-08-01T00:00:00.000Z',
      exampleFree: true,
      candidateSlots: [0, 1, 2].map((ci) => {
        const candidateId = `${id}-candidate-${ci + 1}`;
        const graphNodeIds = Array.from(
          { length: bi === 0 ? (ci === 0 ? 5 : 8) : ci + 1 },
          (_, n) => `${id}-${ci}-${n}`,
        );
        const body = { campaignRunId, briefId: id, candidateId, nodeId: graphNodeIds[0]!,
          audioRequirement: 'required' as const,
          requiredEvidenceClasses: ['source', 'visual', 'temporal', 'audio', 'interaction', 'runtime', 'clock', 'accessibility'] as const,
          evidenceScheduleDigest: D('7') };
        return { id: candidateId, graphNodeIds, ownerEvidence: { ...body,
          slotDigest: createHash('sha256').update(stable(body)).digest('hex') } };
      }),
    })),
    transfer: {
      mode: 'sealed-brief' as const,
      sealedBriefDigest: D('4'),
      unseenAt: '2026-08-01T00:00:00.000Z',
      treatmentControlAllocation: 'treatment-first',
      routeDigest: D('5'),
      randomSourceDigest: D('6'),
      evidenceScheduleDigest: D('7'),
      nonOverlapDigest: D('b'),
    },
    rolesDigest: D('8'),
    executorRequirementsDigest: D('c'),
    evidenceModalitiesDigest: D('d'),
    ownerCheckpointsDigest: D('e'),
    qualityRubricVersion: 'creative-quality-rubric-v1',
    randomSourceDigest: D('9'),
    evidenceScheduleDigest: D('a'),
    requiredReviewStageIds: ['temporal', 'narrative', 'information'].flatMap((brief) =>
      [1, 2, 3].flatMap((candidate) => [
        `specialist-review-${brief}-${brief}-candidate-${candidate}`,
        `holistic-review-${brief}-${brief}-candidate-${candidate}`,
      ])),
    stopStates: ['no-eligible-candidate', 'budget-exhausted'],
    // gen/recovery stage profiles are 12 activeMinutes each; multi-node fixtures exceed 720.
    ceilings: { providerCalls: 128, inputTokens: 6_000_000, outputTokens: 2_000_000, activeMinutes: 2_400 },
  };
}

function buildGraphs(manifest: ReturnType<typeof createCampaignManifest>): CampaignSlotGraph[] {
  return manifest.briefs.flatMap((b) =>
    b.candidateSlots.map((s) => ({
      briefId: b.id,
      candidateSlotId: s.id,
      graph: slotGraph(s.id, [...s.graphNodeIds]),

    })),
  );
}

function routeFreeze(): CampaignRouteFreeze {
  const routes = [
    { role: 'generator', seatId: 'gen-seat', provider: 'openai', model: 'kimi-k3', seed: D('g1'), retryBudget: 1 },
    { role: 'evaluator', seatId: 'specialist-review', provider: 'openai', model: 'gemini-3.1-pro-low', seed: D('r1'), retryBudget: 1 },
    { role: 'evaluator', seatId: 'holistic-review', provider: 'openai', model: 'gemini-3.1-pro-low', seed: D('r2'), retryBudget: 1 },
    { role: 'harness', seatId: 'dream-seat', provider: 'openai', model: 'kimi-k3', seed: D('d1'), retryBudget: 1 },
  ];
  return {
    routes,
    transportBudgets: {
      recovery: { retries: 1, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' },
      revision: { retries: 0, fallbacks: 0, toolTurns: 1, primaryMode: 'generate' },
      'transfer-treatment': { retries: 0, fallbacks: 1, toolTurns: 0, primaryMode: 'generate' },
      review: { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' },
    },
    transferTargetDigest: D('c'),
    diversityDimensions: [
      { id: 'conceptual', description: 'distinct governing concept' },
      { id: 'structural', description: 'distinct graph topology' },
      { id: 'temporal', description: 'distinct clock/phase behavior' },
    ],
    candidateDiversity: ['temporal', 'narrative', 'information'].flatMap((briefId, briefIndex) =>
      [1, 2, 3].map((candidate, candidateIndex) => ({
        briefId,
        candidateSlotId: `${briefId}-candidate-${candidate}`,
        thesisDigest: D((briefIndex * 3 + candidateIndex + 1).toString(16)),
        dimensions: {
          conceptual: `${briefId}-concept-${candidate}`,
          structural: `${briefId}-structure-${candidate}`,
          temporal: `${briefId}-time-${candidate}`,
        },
      }))),
  };
}

function fundingAuthority(root = dir, calls = 128,
  registry = new HostAdapterRegistry(mintTrustKey('test-host'), []),
  now: () => Date = () => new Date()): CampaignFundingReservationAuthority {
  const source: CampaignFundingCapacitySource = {
    resolve(route) {
      const seatDigest = D(route.seatId);
      return {
        seat: { seatId: route.seatId, seatDigest, surface: 'cliproxy-seat' },
        identity: { provider: route.provider, model: route.model, effort: 'medium' },
        funding: subscriptionFunding({ seatDigest, quotaCounters: {
          calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0,
        }, quotaSurface: 'cliproxy-seat' }),
        surface: 'cliproxy-seat',
        endpointDigest: digestCampaignProviderEndpoint('http://127.0.0.1:8317/v1'),
        remaining: { providerCalls: calls, inputTokens: 20_000_000,
          outputTokens: 8_000_000, activeSeconds: 2_000_000 },
      };
    },
  };
  return new CampaignFundingReservationAuthority(registry, source, root, now);
}

function bootstrappedFundingAuthority(root: string, freeze: CampaignRouteFreeze,
  calls = 128, seatKeys: Readonly<Record<string, string>> = {}): CampaignFundingReservationAuthority {
  const capacities = Object.fromEntries(freeze.routes.map((route) => {
    const seatDigest = seatKeys[route.seatId] ? sha256Hex(seatKeys[route.seatId]!) : D(route.seatId);
    const surface = route.provider === 'google' ? 'google-direct'
      : route.provider === 'anthropic' ? 'anthropic-direct'
        : route.provider === 'kimi' ? 'kimi-cliproxy' : 'openai-direct';
    const configuredEndpoint = process.env[`SINTER_CAMPAIGN_SEAT_BASE_URL_${route.seatId
      .replace(/[^a-z0-9]/gi, '_').toUpperCase()}`];
    const endpoint = configuredEndpoint ?? (surface === 'kimi-cliproxy' ? 'http://127.0.0.1:8317/v1'
      : surface === 'google-direct' ? 'https://generativelanguage.googleapis.com'
        : surface === 'anthropic-direct' ? 'https://api.anthropic.com/v1'
          : 'https://api.openai.com/v1');
    return [route.seatId, { seat: { seatId: route.seatId, seatDigest, surface },
      identity: { provider: route.provider, model: route.model,
        effort: route.seed === D('r2') ? 'high' : 'medium' },
      funding: surface === 'kimi-cliproxy' || surface === 'cliproxy-seat'
        ? subscriptionFunding({ seatDigest, quotaCounters: { calls: 0, inputTokens: 0,
          outputTokens: 0, activeSeconds: 0 }, quotaSurface: 'cliproxy-seat' })
        : meteredFunding({ meteredReceiptDigest: D('f'), approvedUsdCeiling: 1,
          quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 } }),
      surface, endpointDigest: digestCampaignProviderEndpoint(endpoint),
      remaining: { providerCalls: calls, inputTokens: 20_000_000,
        outputTokens: 8_000_000, activeSeconds: 2_000_000 } }];
  }));
  return bootstrapCampaignFundingAuthority({ rootDir: root,
    env: { ...process.env, SINTER_CAMPAIGN_CAPACITY_JSON: JSON.stringify(capacities) } });
}

const testExecutorFactory = (rootDir = dir) =>
  (binding: NonNullable<Parameters<typeof bootstrapExecutorAuthority>[0]['binding']>) =>
    bootstrapTestCampaignExecutorAuthority(binding, rootDir);

function debitRequest(allocation: CampaignFundingAllocation, suffix = '1') {
  return {
    stageId: allocation.stageId, logicalAttemptId: allocation.logicalAttemptId,
    transportOrdinal: allocation.transportOrdinal,
    requestTemplateDigest: allocation.requestTemplateDigest,
    routeDigest: allocation.routeDigest, executorRouteDigest: D(`e${suffix}`), requestDigest: D(`f${suffix}`),
    role: allocation.role, identity: allocation.identity, phase: allocation.phase, mode: allocation.mode,
    attemptOrdinal: allocation.purpose === 'primary' || allocation.purpose === 'stream' ? 0 : 1,
    fallbackOrdinal: allocation.purpose === 'fallback' ? 1 : 0,
    retryOrdinal: allocation.purpose === 'retry' ? 1 : 0,
    maxInputTokens: 1, maxOutputTokens: 1,
  };
}

function signedCompletion(
  registry: HostAdapterRegistry,
  allocation: CampaignFundingAllocation,
  receipt: CampaignFundingDebitReceipt,
  delta = { calls: 1, inputTokens: 1, outputTokens: 1, activeSeconds: 0 },
) {
  return issueExecutorAttestation(registry, {
    attestationId: `att-${receipt.allocationId}-${delta.outputTokens}`, runDigest: 'run',
    requestDigest: receipt.requestDigest, attemptDigest: D('a'), routeDigest: receipt.executorRouteDigest,
    attemptOrdinal: receipt.attemptOrdinal, fallbackOrdinal: receipt.fallbackOrdinal,
    retryOrdinal: receipt.retryOrdinal, priorTraceDigest: null, policyTraceDigest: D('b'),
    requestedIdentity: allocation.identity, resolvedIdentity: allocation.identity,
    effort: allocation.identity.effort, fallbackChain: [{ ordinal: 0, identity: allocation.identity }],
    seat: allocation.seat, funding: allocation.funding, quotaSurface: allocation.funding.quotaSurface,
    issuedAt: new Date().toISOString(), nonce: `nonce-${receipt.allocationId}-${delta.outputTokens}`,
    surface: allocation.surface, durationMs: 0, success: true, quotaCounterDelta: delta,
  });
}

function providerClient(
  allocation: CampaignFundingAllocation,
  registry: HostAdapterRegistry,
  root: string,
  failFirst = false,
  role: 'generator' | 'evaluator' = 'generator',
  content: (request: { readonly userPrompt: string }) => string = () => 'function setup(){createCanvas(32,32);}',
) {
  const baseUrl = allocation.surface === 'kimi-cliproxy' || allocation.surface === 'cliproxy-seat'
    ? 'http://127.0.0.1:8317/v1'
    : allocation.surface === 'google-direct' ? 'https://generativelanguage.googleapis.com'
      : allocation.surface === 'anthropic-direct' ? 'https://api.anthropic.com/v1'
        : 'https://api.openai.com/v1';
  let nonce = 0;
  const guard = new HarnessTransportGuard(registry, {
    reservations: new ReservationTracker(path.join(root, 'executor-reservations')),
    nonces: new NonceLedger(path.join(root, 'executor-nonces')),
  });
  const authority: HarnessTransportAuthority = {
    guard,
    reserveAttempt: context => issueExecutorReservation(registry, {
      reservationId: `studio-reservation-${nonce}`, runDigest: 'studio-run',
      requestDigest: context.requestDigest, routeDigest: context.routeDigest,
      identity: context.resolvedIdentity, seat: allocation.seat, funding: allocation.funding,
      surface: allocation.surface, issuedAt: new Date().toISOString(), nonce: `reserve-${nonce++}`,
    }),
    attestCompletion: ({ context, response }) => issueExecutorAttestation(registry, {
      attestationId: `studio-attestation-${nonce}`, runDigest: 'studio-run',
      requestDigest: context.requestDigest,
      attemptDigest: createHash('sha256').update(`${root}:attempt-${nonce}`).digest('hex'),
      routeDigest: context.routeDigest, attemptOrdinal: context.attemptOrdinal,
      fallbackOrdinal: context.fallbackOrdinal, retryOrdinal: context.retryOrdinal,
      priorTraceDigest: context.priorTraceDigest, policyTraceDigest: context.policyTraceDigest,
      requestedIdentity: context.requestedIdentity, resolvedIdentity: context.resolvedIdentity,
      effort: context.resolvedIdentity.effort, fallbackChain: context.fallbackChain,
      seat: allocation.seat, funding: allocation.funding, quotaSurface: allocation.funding.quotaSurface,
      issuedAt: new Date().toISOString(), nonce: `attest-${nonce++}`, surface: allocation.surface,
      durationMs: response.durationMs, success: response.success,
      quotaCounterDelta: { calls: 1, inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0, activeSeconds: response.durationMs / 1_000 },
    }),
  };
  const client = new LLMClient({ role, provider: allocation.identity.provider, model: allocation.identity.model,
    baseUrl, apiKey: 'test', harnessTransportAuthority: authority,
    thinking: { enabled: true, effort: allocation.identity.effort as 'low' | 'medium' | 'high' } });
  let providerCalls = 0;
  const generate = vi.fn(async (request: { readonly userPrompt: string }) => {
    providerCalls += 1;
    return failFirst && providerCalls === 1
      ? err(new LLMError('graph retry', allocation.identity.provider, 400, false))
      : ok({ content: content(request),
        model: allocation.identity.model, success: true, usage: { inputTokens: 2, outputTokens: 4 } });
  });
  vi.spyOn(client as never, 'resolveModel' as never).mockResolvedValue(allocation.identity.model as never);
  vi.spyOn(client as never, 'getProvider' as never).mockResolvedValue({
    name: allocation.identity.provider, getModel: () => allocation.identity.model,
    getConfig: () => ({ baseUrl, apiKey: 'test', model: allocation.identity.model }),
    reserveTransport: () => Object.freeze({ capability: Object.freeze({}),
      provider: allocation.identity.provider, model: allocation.identity.model, baseUrl,
      credentialDigest: allocation.seat.seatDigest }),
    cancelReservedTransport: vi.fn(),
    generate, supportsToolUse: () => true, capabilities: { thinking: false, streaming: false,
      jsonMode: false, toolUse: true, maxContextTokens: 4096,
      thinkingStyle: 'none', streamingStyle: 'sse' },
  } as never);
  return { client, generate };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'w8c05-')); });
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function stableString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableString(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function signedOwnerAssertion(
  keys: ReturnType<typeof generateKeyPairSync>,
  role: 'owner' | 'issuer' | 'reviewer',
  nonce: string,
): TrustedAuthorityAssertion {
  const now = Date.now();
  const body = {
    schema: 'sinter.application-authority-assertion' as const, schemaVersion: 1 as const,
    registryId: 'terminal-closure-registry', principalId: `${role}-principal`, role,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(), nonce,
  };
  return { ...body, signatureBase64: sign(null, Buffer.from(JSON.stringify(body)), keys.privateKey).toString('base64') };
}

async function buildTerminalRevision(
  briefId: string,
  source: Readonly<{ readonly session: ReturnType<typeof createBlindReviewSession>;
    readonly result: Awaited<ReturnType<typeof runOwnerReviewLifecycle>>;
    readonly actualManifest: CampaignActualCandidateManifest }>,
): Promise<Readonly<{
  plan: ExperimentPlan;
  revision: ReturnType<ReturnType<typeof createAttributableRevisionSession>['apply']>;
  preference: IndependentBlindTreatmentPreference;
}>> {
  const { session: blind, actualManifest } = source;
  const review = source.result.bundle.blindReview;
  const unmasked = source.result.bundle.unmasked;
  const evidence = blind.packet.candidates[0]!;
  const baseline = actualManifest.candidates[0]!.artifact.html;
  const postHtml = baseline.replace('#777777', '#111111');
  const before = createCanonicalCreativeArtifact(baseline, evidence.artifactDigest).analysis.contrastRatio;
  const after = createCanonicalCreativeArtifact(postHtml, evidence.artifactDigest).analysis.contrastRatio;
  const treatment = { id: `contrast-${briefId}`, targetKind: 'principle' as const,
    targetId: FIGURE_GROUND_TARGET, before, after };
  const identity = (role: 'specialist' | 'holistic') => ({ role, provider: `${role}-provider`,
    model: `${role}-model`, pipe: `${role}-pipe`, effort: `${role}-effort`, contributionLineage: `${role}-${briefId}`,
    assignment: `${role}-assignment-${briefId}` }) as const;
  const claim = review.judgments[0]!.claims[0]!;
  const critics: CriticContribution[] = [
    { id: `specialist-${briefId}`, identity: identity('specialist'), blindId: evidence.blindId,
      artifactDigest: evidence.artifactDigest, claims: [claim], treatment, priority: 2 },
    { id: `holistic-${briefId}`, identity: identity('holistic'), blindId: evidence.blindId,
      artifactDigest: evidence.artifactDigest, claims: [claim], treatment: { ...treatment, id: `density-${briefId}`,
        targetKind: 'parameter', targetId: 'density', before: 2, after: 3 }, priority: 1 },
  ];
  const route = { provider: 'fixed-provider', model: 'fixed-model', pipe: 'fixed-pipe', effort: 'high' } as const;
  const runtime = { id: 'html-css-static-runtime', version: '1.0.0', seed: `seed-${briefId}` } as const;
  const revisionSession = createAttributableRevisionSession({ packet: blind.packet, review, unmasked, critics,
    route, runtime, allowedDiffs: [`principles.${FIGURE_GROUND_TARGET}`],
    forbiddenDiffs: ['graphElements', 'parameters'], captureSchedule: [{ id: 'visual-final', atMs: 0, modality: 'visual' }],
    causalPredicate: { metricId: FIGURE_GROUND_METRIC, direction: 'increase', minimumDelta: 1 },
    hardFloors: [{ metricId: WCAG_CONTRAST_METRIC, minimum: 4.5 }],
  });
  const postArtifact = createCanonicalCreativeArtifact(postHtml, revisionSession.plan.baselineArtifact.artifactDigest);
  const independent = { role: 'specialist' as const, provider: 'independent-provider',
    model: 'independent-model', pipe: 'independent-pipe', effort: 'independent-effort',
    contributionLineage: `independent-${briefId}`, assignment: `independent-assignment-${briefId}` };
  const preference = createIndependentBlindTreatmentPreference(revisionSession.plan, postArtifact,
    independent, 'treatment-preferred');
  const revision = revisionSession.apply({ route, runtime,
    captureSchedule: [{ id: 'visual-final', atMs: 0, modality: 'visual' }],
    causalPredicate: { metricId: FIGURE_GROUND_METRIC, direction: 'increase', minimumDelta: 1 },
    postArtifact, independentBlindPreference: preference,
  });
  return Object.freeze({ plan: revisionSession.plan, revision, preference });
}

async function runTerminalOwnerReview(
  service: CampaignService,
  admission: Awaited<ReturnType<CampaignService['startCampaign']>>,
  manifest: ReturnType<typeof createCampaignManifest>,
  ownerAdmission: ReturnType<CampaignService['admitOwnerReview']>,
  briefId: string,
  captureAuthority: ReturnType<typeof createCaptureAuthority>,
  envelopeAuthority: ReturnType<typeof createEnvelopeAuthority>,
  store: OwnerReviewPacketStore,
  settledManifest?: CampaignActualCandidateManifest,
) {
  const generated = settledManifest ? undefined
    : await buildCandidateManifest(`Published owner packet ${briefId}`, {});
  const brief = manifest.briefs.find((item) => item.id === briefId)!;
  const sources = new Map<string, string>();
  const actualManifest: CampaignActualCandidateManifest = settledManifest ?? {
    schema: 'sinter.campaign-actual-candidate-manifest', schemaVersion: 1,
    campaignRunId: manifest.campaignRunId, manifestDigest: manifest.manifestDigest, briefId,
    candidates: brief.candidateSlots.map((slot, index) => {
      const candidate = generated!.candidates[index]!;
      const html = `<!doctype html><html><head><title>${briefId}-${index}</title><style>body { color: #777777; background-color: #ffffff; }</style></head><body>${briefId}-${index}</body></html>`;
      const source = `<main>${briefId}:${slot.id}</main>`;
      sources.set(slot.id, source);
      return { id: slot.id, briefId, slotDigest: slot.ownerEvidence.slotDigest,
        graphDigest: D(`${index + 1}`), graphNodeIds: slot.graphNodeIds,
        thesisDigest: campaignCreativeThesisDigest(generated!.creativeThesis),
        diversity: { fixture: `${briefId}-${index}` }, artifact: {
          html,
          artifactDigest: createHash('sha256').update(html).digest('hex'),
          sourceDigest: createHash('sha256').update(source).digest('hex'), layers: [],
          successCount: candidate.artifact.successCount, layerCount: candidate.artifact.layerCount,
        } };
    }),
  };
  if (settledManifest) {
    for (const candidate of settledManifest.candidates) {
      sources.set(candidate.id, campaignActualSource(candidate.artifact.layers));
    }
  }
  const session = createBlindReviewSession(actualManifest, actualManifest.candidates.map((candidate, index) => {
    const identity = createHash('sha256').update(`owner-review-identity:${briefId}:${index}`).digest('hex');
    return ({
    candidateId: candidate.id, sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: ['visual'] as const, generationIdentity: {
      role: 'generator' as const, provider: identity.slice(0, 12), model: identity.slice(12, 24),
      pipe: identity.slice(24, 36), effort: identity.slice(36, 48),
      contributionLineage: identity.slice(48), assignment: identity,
    },
  }); }));
  const evidenceJudgments = session.packet.candidates.map((candidate) => ({
    blindId: candidate.blindId, outcome: 'pass' as const,
    claims: candidate.media.map((media) => ({ modality: media.modality, artifactDigest: candidate.artifactDigest,
      evidenceDigest: media.digest, claim: 'Canonical packet media inspected.' })),
  }));
  const evidence = session.packet.candidates.map((candidate, index) => {
    const actual = actualManifest.candidates[index]!;
    return {
      source: { ref: `${candidate.blindId}.source`, mimeType: 'text/plain', payload: sources.get(actual.id)! },
      timeSamples: [{ ref: `${candidate.blindId}.time`, mimeType: 'text/plain', payload: 'frame-0' }],
      interactionTrace: { ref: `${candidate.blindId}.interaction`, mimeType: 'text/plain', payload: 'click' },
      runtimeState: { ref: `${candidate.blindId}.runtime`, mimeType: 'application/json', payload: '{"ready":true}' },
      clockEvents: { ref: `${candidate.blindId}.clock`, mimeType: 'text/plain', payload: '0,1' },
      accessibility: { ref: `${candidate.blindId}.a11y`, mimeType: 'text/plain', payload: 'contrast:pass' },
      knownFailures: [] as const, hardFloorFailures: [] as const,
    };
  });
  const renderer = new ManagedOwnerReviewRenderer({ readyTimeoutMs: 10_000 });
  try {
    const result = await service.runOwnerReview('studio', admission, {
      campaign: { manifest, fundingReservation: admission.fundingReservation }, admission: ownerAdmission,
      briefId, session, evidence, evidenceJudgments, captureAuthority, envelopeAuthority, store, renderer,
    });
    return Object.freeze({ result, session, actualManifest });
  } finally {
    await renderer.close();
  }
}

const execFileAsync = promisify(execFile);

async function startOwnerReviewTransport(port = 0) {
  let requestCount = 0;
  let maxRequestBytes = 0;
  let audioPayloadRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gemini-3.6-flash-high' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      maxRequestBytes = Math.max(maxRequestBytes, Buffer.byteLength(raw));
      if (raw.includes('data:audio/wav;base64')) audioPayloadRequestCount += 1;
      if (!raw) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      const body = JSON.parse(raw) as { model?: string;
        messages?: readonly { role: string; content: string }[] };
      const user = JSON.parse(body.messages?.find((message) => message.role === 'user')?.content ?? '{}') as {
        evidencePacket: { candidates: OwnerReviewPacket['candidates'] }; blindId: string };
      const candidate = user.evidencePacket.candidates.find((item) => item.blindId === user.blindId);
      if (!candidate) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'missing blind candidate' }));
        return;
      }
      requestCount += 1;
      const anchor = candidate.evidence[0]!.digest;
      const content = JSON.stringify({ verdict: 'pass',
        scores: (['coherence', 'specificity', 'surprise', 'emotionalTemporalArc',
          'crossModalCausality', 'intentionality', 'revisitDesire'] as const).map((dimension) =>
          ({ dimension, score: 4, evidenceDigests: [anchor] })),
        finding: { text: 'Loopback reviewer verified canonical evidence.', evidenceDigests: [anchor] },
        criticalFlaws: [], disagreement: [] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 4 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback review transport did not bind');
  return Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requestCount,
    maxRequestBytes: () => maxRequestBytes,
    audioPayloadRequestCount: () => audioPayloadRequestCount,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) });
}

/** An admission holding one subscription-seat allocation per generation stage. */
function generationOnlyAdmission(plan: ReturnType<typeof buildCampaignExecutionPlan>): CampaignRunAdmission {
  const allocations = plan.stages.filter((stage) => stage.kind === 'generation').map((stage) => ({
    allocationId: `allocation-${stage.id}`, stageId: stage.id, logicalAttemptId: `attempt-${stage.id}`,
    transportOrdinal: 0, purpose: 'primary' as const, requestTemplateDigest: D('a'), routeDigest: D('b'), role: 'generator',
    identity: { provider: 'openai', model: 'test-generator', effort: 'low' },
    seat: { seatId: 'gen-seat', seatDigest: D('c'), surface: 'openai-direct' },
    funding: { mode: 'subscription-seat', quotaSurface: 'subscription-seat', seatDigest: D('c'),
      resourceBudgetDigest: D('d'), quotaCounters: {
        calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 } },
  })) as CampaignFundingAllocation[];
  return { plan, fundingReservation: { subject: { allocations } } } as CampaignRunAdmission;
}

function generatedP5Code(slotId: string): string {
  const shade = [...slotId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 200;
  return `function setup(){createCanvas(16,16);} function draw(){background(${shade});} // ${slotId}`;
}

async function startGoogleGenerationTransport(port = 0) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gemini-3.6-flash-high' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        contents?: readonly { parts?: readonly { text?: string }[] }[] };
      const prompt = body.contents?.flatMap((content) => content.parts ?? [])
        .map((part) => part.text ?? '').join('\n') ?? '';
      const slotId = /sealed ([a-z0-9-]+)/i.exec(prompt)?.[1];
      if (!slotId) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'missing sealed slot id' }));
        return;
      }
      requestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ modelVersion: 'gemini-3.6-flash-high',
        candidates: [{ content: { parts: [{ text: generatedP5Code(slotId) }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback generation transport did not bind');
  return Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}/generativelanguage`,
    requestCount: () => requestCount,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) });
}

describe('W8C-05 sealed canonical execution plan (not caller-declared)', () => {
  it('rejects streamed owner-review routes before funding or provider access', () => {
    const manifest = createCampaignManifest(manifestInput());
    const freeze = routeFreeze();
    const streamed = { ...freeze, transportBudgets: { ...freeze.transportBudgets,
      review: { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'stream' as const } } };
    const provider = vi.fn();
    expect(() => buildCampaignExecutionPlan(manifest, buildGraphs(manifest), streamed))
      .toThrow(/complete-only/);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects an invalid transport mode while constructing the sealed plan', () => {
    const manifest = createCampaignManifest(manifestInput());
    const freeze = routeFreeze();
    const invalid = { ...freeze, transportBudgets: { ...freeze.transportBudgets,
      generation: { retries: 0, fallbacks: 0, toolTurns: 0,
        primaryMode: 'invalid' as 'generate' } } };
    expect(() => buildCampaignExecutionPlan(manifest, buildGraphs(manifest), invalid))
      .toThrow(/primary mode/i);
  });

  it('derives canonical stages from the manifest and seals the plan', () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());

    expect(plan.manifestDigest).toBe(manifest.manifestDigest);
    expect(plan.routeFreezeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/);
    const genCount = manifest.briefs.flatMap((b) => b.candidateSlots.flatMap((s) => s.graphNodeIds)).length;
    expect(plan.stages.filter((s) => s.kind === 'generation')).toHaveLength(genCount);
    expect(plan.stages.filter((s) => s.kind === 'recovery')).toHaveLength(genCount);
    expect(plan.stages.filter((s) => s.kind === 'revision')).toHaveLength(3);
    expect(plan.stages.filter((s) => s.kind === 'transfer-treatment')).toHaveLength(1);
    expect(plan.stages.filter((s) => s.kind === 'transfer-control')).toHaveLength(1);
    expect(plan.stages.filter((s) => s.kind === 'review')).toHaveLength(18);
    expect(plan.stages.filter((s) => s.kind === 'dream')).toHaveLength(1);
  });

  it('rejects unlisted stages appended to the sealed plan', () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const rogue = [...plan.stages, { ...plan.stages[0]!, id: 'rogue-gen', candidateSlotId: 'fourth-candidate' }];
    expect(() => buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze(), rogue))
      .toThrow(/outside the frozen topology|unlisted/i);
  });

  it('permits Luna only in generator/evaluator-shaped campaign roles', () => {
    const manifest = createCampaignManifest(manifestInput());
    const rf = routeFreeze();
    rf.routes[0] = { ...rf.routes[0]!, model: 'gpt-5.6-luna' };
    expect(() => buildCampaignExecutionPlan(manifest, buildGraphs(manifest), rf)).not.toThrow();
    const dreamLuna = routeFreeze();
    dreamLuna.routes[3] = { ...dreamLuna.routes[3]!, model: 'gpt-5.6-luna' };
    expect(() => buildCampaignExecutionPlan(manifest, buildGraphs(manifest), dreamLuna)).toThrow(/luna/i);
  });

  it('freezes exact routes, models, seeds, transfer target, retries, and diversity dimensions', () => {
    const manifest = createCampaignManifest(manifestInput());
    const rf = routeFreeze();
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), rf);
    expect(plan.routeFreeze.routes.length).toBeGreaterThan(0);
    expect(plan.routeFreeze.transferTargetDigest).toBe(D('c'));
    expect(plan.routeFreeze.diversityDimensions).toHaveLength(3);
    expect(plan.routeFreeze.candidateDiversity).toHaveLength(9);
    expect(plan.routeFreeze.routes.every((r) => r.retryBudget === 1)).toBe(true);
  });

  it('rejects candidates that repeat a conceptual or structural diversity value', () => {
    const manifest = createCampaignManifest(manifestInput());
    const freeze = routeFreeze();
    const first = freeze.candidateDiversity[0]!;
    const second = freeze.candidateDiversity[1]!;
    freeze.candidateDiversity[1] = { ...second, dimensions: { ...second.dimensions,
      conceptual: first.dimensions.conceptual! } };
    expect(() => buildCampaignExecutionPlan(manifest, buildGraphs(manifest), freeze)).toThrow(/distinct|diversity/i);
  });
});

describe('W8C-05 canonical CompositionGraphV2 per slot', () => {
  it('accepts 1, 2, 3, 5+, and 8 node graphs with groups, controls, scenes, clocks, and teardown', () => {
    const manifest = createCampaignManifest(manifestInput());
    // Map each target node count to a slot that carries exactly that many nodes.
    const cases: Array<{ count: number; briefId: string; slotId: string }> = [
      { count: 1, briefId: 'narrative', slotId: 'narrative-candidate-1' },
      { count: 2, briefId: 'narrative', slotId: 'narrative-candidate-2' },
      { count: 3, briefId: 'narrative', slotId: 'narrative-candidate-3' },
      { count: 5, briefId: 'temporal', slotId: 'temporal-candidate-1' },
      { count: 8, briefId: 'temporal', slotId: 'temporal-candidate-2' },
    ];
    for (const { count, briefId, slotId } of cases) {
      const brief = manifest.briefs.find((b) => b.id === briefId)!;
      const slot = brief.candidateSlots.find((s) => s.id === slotId)!;
      const ids = [...slot.graphNodeIds];
      const g = slotGraph(slotId, ids, count >= 2 ? {
        groups: count >= 3 ? [{ id: 'grp', children: [ids[0]!, ids[1]!] }] : undefined,
        controls: count >= 2 ? [{
          id: 'ctl',
          from: { nodeId: ids[0]!, port: 'p', type: 'number' as const },
          to: { nodeId: ids[1]!, port: 'q', type: 'number' as const },
        }] : undefined,
        scenes: count >= 4 ? [{ id: 'scene', children: [ids[2]!, ids[3]!] }] : undefined,
        timingIslands: count >= 5 ? [{ id: 'isle', clock: 'animation-frame' as const, nodeIds: [ids[0]!, ids[1]!] }] : undefined,
        lifecycle: { teardownOrder: [...ids].reverse() },
      } : undefined);
      const proof = validateCampaignSlotGraph(manifest, briefId, slotId, g);
      expect(proof.nodeCount).toBe(count);
      expect(proof.graphDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('rejects cycles, dangling dependencies, multiple clock authorities, and resource stop without teardown', () => {
    const manifest = createCampaignManifest(manifestInput());
    const slot = manifest.briefs[0]!.candidateSlots[0]!;
    const ids = [...slot.graphNodeIds];
    // cycle among the slot's nodes
    const cyc = slotGraph(slot.id, ids);
    cyc.edges = [
      { id: 'e0', type: 'before', from: ids[0]!, to: ids[1]! },
      { id: 'e1', type: 'before', from: ids[1]!, to: ids[0]! },
    ];
    expect(() => validateCampaignSlotGraph(manifest, 'temporal', slot.id, cyc)).toThrow(/cycle/i);
    // dangling edge reference
    const dang = slotGraph(slot.id, ids);
    dang.edges = [{ id: 'e0', type: 'before', from: ids[0]!, to: 'ghost' }];
    expect(() => validateCampaignSlotGraph(manifest, 'temporal', slot.id, dang)).toThrow(/invalid/i);
    // multiple unbridged clock authorities
    const multi = slotGraph(slot.id, ids);
    multi.timingIslands = [
      { id: 'i1', clock: 'animation-frame', nodeIds: [ids[0]!] },
      { id: 'i2', clock: 'audio', nodeIds: [ids[1]!] },
    ];
    expect(() => validateCampaignSlotGraph(manifest, 'temporal', slot.id, multi)).toThrow(/clock/i);
    // resource declared without a complete teardown order
    const res = slotGraph(slot.id, ids);
    res.resources = [{ id: 'r1', kind: 'audio-context', ownerNodeId: ids[0]! }];
    expect(() => validateCampaignSlotGraph(manifest, 'temporal', slot.id, res)).toThrow(/teardown|resource/i);
  });

  it('accepts nested groups, multiple scenes, shared controls, and bridged clock authorities', () => {
    const manifest = createCampaignManifest(manifestInput());
    const slot = manifest.briefs[0]!.candidateSlots[1]!;
    const ids = [...slot.graphNodeIds];
    const graph = slotGraph(slot.id, ids, {
      groups: [
        { id: 'outer', children: ['inner', ids[2]!] },
        { id: 'inner', parentId: 'outer', children: [ids[0]!, ids[1]!] },
      ],
      scenes: [
        { id: 'scene-a', children: [ids[3]!, ids[4]!] },
        { id: 'scene-b', children: [ids[5]!, ids[6]!] },
      ],
      controls: [{
        id: 'shared-control',
        from: { nodeId: ids[0]!, port: 'value', type: 'number' },
        to: { nodeId: ids[7]!, port: 'value', type: 'number' },
      }],
      timingIslands: [
        { id: 'visual-clock', clock: 'animation-frame', nodeIds: [ids[0]!] },
        { id: 'audio-clock', clock: 'audio', nodeIds: [ids[1]!] },
      ],
      bridges: [{ id: 'clock-bridge', fromIslandId: 'visual-clock', toIslandId: 'audio-clock', mode: 'sample' }],
      lifecycle: { teardownOrder: [...ids].reverse() },
    });
    expect(validateCampaignSlotGraph(manifest, 'temporal', slot.id, graph).nodeCount).toBe(8);
  });

  it('rejects a slot graph whose node ids diverge from the manifest slot', () => {
    const manifest = createCampaignManifest(manifestInput());
    const g = slotGraph('s', ['alien-node']);
    expect(() => validateCampaignSlotGraph(manifest, 'temporal', 'temporal-candidate-1', g)).toThrow(/topology|node/i);
  });
});

describe('W8C-05 host-owned campaign funding reservation', () => {
  it('reserves only the authenticated phase stage set and rejects a conflicting expansion', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const freeze = routeFreeze();
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), freeze);
    const authority = bootstrappedFundingAuthority(path.join(dir, 'phase-only'), freeze, 128);
    const allowedStageIds = plan.stages.filter(stage =>
      stage.kind === 'generation' || stage.kind === 'recovery' || stage.kind === 'review')
      .map(stage => stage.id);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const reservation = await authority.reserve({ campaignRunId: manifest.campaignRunId,
      plan, expiresAt, allowedStageIds });
    expect(new Set(reservation.subject.allocations.map(allocation => allocation.stageId)))
      .toEqual(new Set(allowedStageIds));
    await expect(authority.reserve({ campaignRunId: manifest.campaignRunId, plan, expiresAt,
      allowedStageIds: plan.stages.map(stage => stage.id) }))
      .rejects.toThrow('CAMPAIGN_FUNDING_RESERVATION_CONFLICT');
  });

  it('settles the exact GLM Coding Plan review allocation around one host-adapter call', async () => {
    const key = 'dedicated-coding-plan-test-key';
    const freeze = routeFreeze();
    const routes = freeze.routes.map(route => route.seatId === 'specialist-review'
      ? { ...route, provider: 'glm', model: GLM_CODING_PLAN_MODEL } : route);
    const glmFreeze = { ...freeze, routes };
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), glmFreeze);
    const hostRoot = path.join(dir, 'glm-host');
    const host = bootstrapHostAuthority({ rootDir: hostRoot });
    const source: CampaignFundingCapacitySource = { resolve(route) {
      const glm = route.seatId === 'specialist-review';
      const seatDigest = glm ? sha256Hex(key) : D(route.seatId);
      return { seat: { seatId: route.seatId, seatDigest,
        surface: glm ? 'glm-coding-plan-seat' : 'cliproxy-seat' },
      identity: { provider: route.provider, model: route.model, effort: glm ? 'max' : 'medium' },
      funding: subscriptionFunding({ seatDigest, quotaCounters: {
        calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0,
      }, quotaSurface: glm ? 'glm-coding-plan-seat' : 'cliproxy-seat' }),
      surface: glm ? 'glm-coding-plan-seat' : 'cliproxy-seat',
      endpointDigest: digestCampaignProviderEndpoint(glm
        ? GLM_CODING_PLAN_ENDPOINT : 'http://127.0.0.1:8317/v1'),
      remaining: { providerCalls: 128, inputTokens: 20_000_000,
        outputTokens: 8_000_000, activeSeconds: 2_000_000 } };
    } };
    const authority = new CampaignFundingReservationAuthority(host.registry, source,
      path.join(dir, 'glm-funding'));
    const owner = generateKeyPairSync('ed25519');
    const bindingPath = path.join(dir, 'glm-seat.json');
    const provenancePath = path.join(dir, 'glm-owner-provenance.json');
    const ownerPublicKeyPath = path.join(dir, 'glm-owner-public.pem');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    provisionGLMCodingPlanOwnerProvenance({ seatId: 'specialist-review', expiresAt,
      ownerPrivateKeyPem: owner.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      ownerPublicKeyPem: owner.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      credentialResolver: () => key, provenancePath, ownerPublicKeyPath });
    const binding = provisionGLMCodingPlanSeat({ registry: host.registry,
      seatId: 'specialist-review', expiresAt, credentialResolver: () => key,
      outputPath: bindingPath, provenancePath, ownerPublicKeyPath });
    const stage = plan.stages.find(item => item.id.startsWith('specialist-review-'))!;
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId,
      plan, expiresAt, allowedStageIds: [stage.id] });
    const allocation = reservation.subject.allocations.find(item => item.stageId === stage.id)!;
    expect(allocation.identity).toMatchObject({ provider: 'glm', model: GLM_CODING_PLAN_MODEL, effort: 'max' });
    const live = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat', declaredSlots: [
        { id: 'sol-approval', purpose: 'sol-review-bootstrap', provider: 'openai',
          model: 'kimi-k3', role: 'harness', pipe: 'kimi-k3', effort: 'high',
          subscriptionTransport: 'campaign-host', seatId: 'kimi-seat', minCalls: 1,
          maxCalls: 1, maxInputTokens: 1000, maxOutputTokens: 1000, minActiveMinutes: 1 },
        { id: 'generator', purpose: 'product', provider: 'openai', model: 'gpt-5.6-luna',
          role: 'generator', pipe: 'luna-max', effort: 'max', subscriptionTransport: 'campaign-host',
          seatId: 'gen-seat', minCalls: 1, maxCalls: 1, maxInputTokens: 1000,
          maxOutputTokens: 1000, minActiveMinutes: 1 },
        { id: 'critic', purpose: 'product', provider: 'openai', model: 'gpt-5.6-terra',
          role: 'critic', pipe: 'terra-high', effort: 'high', subscriptionTransport: 'campaign-host',
          seatId: 'critic-seat', minCalls: 1, maxCalls: 1, maxInputTokens: 1000,
          maxOutputTokens: 1000, minActiveMinutes: 1 },
        { id: stage.id, purpose: 'product', provider: 'glm', model: GLM_CODING_PLAN_MODEL,
          role: 'evaluator', identityId: 'specialist-review', pipe: 'claude-glm-coding-plan',
          effort: 'max', subscriptionTransport: 'host-adapter', seatId: 'specialist-review',
          minCalls: 1, maxCalls: 1, maxInputTokens: allocation.inputTokens,
          maxOutputTokens: allocation.outputTokens, minActiveMinutes: 1 },
      ] });
    const disposeTransportTrust = installGLMCodingPlanTransportTrustForTests({
      registry: host.registry, bindingPath, provenancePath, ownerPublicKeyPath,
      credentialResolver: () => key,
    });
    try {
      const config = JSON.parse(readFileSync(live.configPath, 'utf8'));
      config.credentialBindingRefs[stage.id] = binding.subject.bindingId;
      writeFileSync(live.configPath, JSON.stringify(config));
      const trust = JSON.parse(readFileSync(live.trustStorePath, 'utf8'));
      trust.credentialBindings.find((item: { provider: string }) => item.provider === 'glm').bindingId
        = binding.subject.bindingId;
      writeFileSync(live.trustStorePath, JSON.stringify(trust), { mode: 0o600 });
      const invoke = vi.fn(async () => ({ stdout: JSON.stringify({ result: '{"verdict":"pass"}',
        usage: { input_tokens: 4, output_tokens: 5 } }) }));
      const adapter = createGLMCodingPlanHostAdapter({ registry: host.registry, bindingPath,
        provenancePath, ownerPublicKeyPath, credentialResolver: () => key, executor: invoke,
        configDir: path.join(dir, 'glm-claude-config') });
      configureWave8LivePreSpendInterlockForTests(live.configPath, live.trustStorePath,
        new SubscriptionHostAdapterRegistry(new Map([[binding.subject.bindingId, adapter]])));
      const client = new GLMCodingPlanReviewClient(allocation, host.registry, { bindingPath,
        provenancePath, ownerPublicKeyPath, credentialResolver: () => key,
        executorAuthority: bootstrapTestCampaignExecutorAuthority({
          seat: allocation.seat, funding: allocation.funding }, hostRoot) });
      await authority.runStage(reservation, stage.id, () => runWithPreSpendCallContext(
        { slotId: stage.id, purpose: 'product', callerClass: 'product-review' },
        () => client.generate('system', 'user')));
      expect(invoke).toHaveBeenCalledOnce();
      await expect(authority.settledStage(reservation, stage.id)).resolves.toMatchObject({
        allocationId: allocation.allocationId, stageId: stage.id,
      });
      await expect(runWithPreSpendCallContext(
        { slotId: stage.id, purpose: 'product', callerClass: 'product-review' },
        () => client.generate('system', 'outside funding context')))
        .rejects.toThrow('CAMPAIGN_FUNDING_CONTEXT_MISSING');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      resetPreSpendInterlockForTests();
      disposeTransportTrust();
      live.cleanup();
    }
  });
  it('rejects owner-review minting by a caller-created registry and trust key authority', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const caller = fundingAuthority(`${dir}/caller`, 128,
      new HostAdapterRegistry(mintTrustKey('caller-owned-key'), []));
    const reservation = await caller.reserve({ campaignRunId: manifest.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(caller.runOwnerReviewScope(async (mint) => mint({ reservation, manifest,
      briefIds: manifest.briefs.map((brief) => brief.id),
      candidateSetDigests: manifest.briefs.map((brief) => ({
        briefId: brief.id, digest: sha256Hex(brief.id),
      })) })))
      .rejects.toThrow(/OWNER_REVIEW_ADMISSION_ISSUER_NOT_HOST_BOOTSTRAPPED/);
  });

  it('revokes scoped owner-review admissions and disables an escaped mint capability', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const authority = bootstrappedFundingAuthority(dir, routeFreeze(), 128);
    const reservation = await authority.reserve({ campaignRunId: manifest.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    type Mint = Parameters<Parameters<typeof authority.runOwnerReviewScope>[0]>[0];
    let escapedMint: Mint | undefined;
    let issued: ReturnType<Mint> | undefined;
    await authority.runOwnerReviewScope(async (mint) => {
      escapedMint = mint;
      issued = mint({ reservation, manifest, briefIds: manifest.briefs.map((brief) => brief.id),
        candidateSetDigests: manifest.briefs.map((brief) => ({
          briefId: brief.id, digest: sha256Hex(brief.id),
        })) });
      expect(assertOwnerReviewAdmission(issued)).toBe(issued);
    });
    expect(() => assertOwnerReviewAdmission(issued!))
      .toThrow('OWNER_REVIEW_ADMISSION_NOT_HOST_ISSUED');
    expect(() => escapedMint!({ reservation, manifest,
      briefIds: manifest.briefs.map((brief) => brief.id),
      candidateSetDigests: manifest.briefs.map((brief) => ({
        briefId: brief.id, digest: sha256Hex(brief.id),
      })) }))
      .toThrow('OWNER_REVIEW_ADMISSION_SCOPE_INACTIVE');
  });

  it('signs exact allocations with the shared host registry and rejects tampering', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const authority = fundingAuthority();
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(authority.verify(reservation)).toBe(true);
    expect(reservation.subject.allocations).toHaveLength(
      plan.stages.reduce((sum, stage) => sum + stage.providerCalls, 0),
    );
    expect(new Set(reservation.subject.allocations.map(item => item.stageId)))
      .toEqual(new Set(plan.stages.map(item => item.id)));
    expect(authority.verify({ ...reservation, reservationDigest: D('tampered') })).toBe(false);
    await expect(authority.reserve({ campaignRunId: plan.campaignRunId,
      plan: { ...plan, planDigest: D('tampered') }, expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      .rejects.toThrow(/PLAN_DIGEST|plan digest/i);
  });

  it('reserves globally under one lock and fails closed when capacity is exhausted', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const otherManifest = createCampaignManifest(manifestInput('campaign-run-2'));
    const otherPlan = buildCampaignExecutionPlan(otherManifest, buildGraphs(otherManifest), routeFreeze());
    const authority = fundingAuthority(dir, plan.stages.reduce((sum, stage) => sum + stage.providerCalls, 0));
    const expiry = new Date(Date.now() + 60_000).toISOString();
    const results = await Promise.allSettled([
      authority.reserve({ campaignRunId: plan.campaignRunId, plan, expiresAt: expiry }),
      authority.reserve({ campaignRunId: otherPlan.campaignRunId, plan: otherPlan, expiresAt: expiry }),
    ]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
  });

  it('releases unused remainder while retaining burned calls against capacity', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const otherManifest = createCampaignManifest(manifestInput('campaign-run-2'));
    const otherPlan = buildCampaignExecutionPlan(otherManifest, buildGraphs(otherManifest), routeFreeze());
    const calls = plan.stages.reduce((sum, stage) => sum + stage.providerCalls, 0);
    const authority = fundingAuthority(dir, calls);
    const expiry = new Date(Date.now() + 60_000).toISOString();
    const released = await authority.reserve({ campaignRunId: plan.campaignRunId, plan, expiresAt: expiry });
    await authority.releaseUnused(released);
    await expect(authority.releaseUnused(released)).resolves.toBeUndefined();
    await expect(authority.debit(released, debitRequest(released.subject.allocations[0]!)))
      .rejects.toThrow('CAMPAIGN_FUNDING_RESERVATION_MISSING_OR_EXPIRED');
    await expect(authority.reserve({ campaignRunId: otherPlan.campaignRunId,
      plan: otherPlan, expiresAt: expiry })).resolves.toMatchObject({
      subject: { campaignRunId: otherPlan.campaignRunId },
    });

    const usedAuthority = fundingAuthority(`${dir}/used`, calls + 1);
    const used = await usedAuthority.reserve({ campaignRunId: plan.campaignRunId, plan, expiresAt: expiry });
    await usedAuthority.debit(used, debitRequest(used.subject.allocations[0]!));
    await expect(usedAuthority.releaseUnused(used)).resolves.toBeUndefined();
    await expect(usedAuthority.debit(used, debitRequest(used.subject.allocations[1]!)))
      .rejects.toThrow('CAMPAIGN_FUNDING_RESERVATION_MISSING_OR_EXPIRED');
    await expect(usedAuthority.reserve({ campaignRunId: otherPlan.campaignRunId,
      plan: otherPlan, expiresAt: expiry })).resolves.toMatchObject({
      subject: { campaignRunId: otherPlan.campaignRunId },
    });

    const generatorCalls = plan.stages
      .filter(stage => stage.seatId === 'gen-seat')
      .reduce((sum, stage) => sum + stage.providerCalls, 0);
    const tight = fundingAuthority(`${dir}/tight`, generatorCalls);
    const tightReservation = await tight.reserve({ campaignRunId: plan.campaignRunId, plan, expiresAt: expiry });
    await tight.debit(tightReservation, debitRequest(tightReservation.subject.allocations[0]!));
    await tight.releaseUnused(tightReservation);
    await expect(tight.reserve({ campaignRunId: otherPlan.campaignRunId,
      plan: otherPlan, expiresAt: expiry })).rejects.toThrow(/EXHAUSTED/);
  });

  it('rejects a tampered unused-reservation release marker', async () => {
    const plan = buildCampaignExecutionPlan(
      createCampaignManifest(manifestInput()),
      buildGraphs(createCampaignManifest(manifestInput())), routeFreeze());
    const registry = buildRegistry();
    const authority = fundingAuthority(dir, 128, registry);
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await authority.releaseUnused(reservation);
    const ledgerPath = path.join(dir,
      `${createHash('sha256').update('campaign-funding-global').digest('hex')}.json`);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    ledger.reservations[reservation.reservationDigest].release.releasedAt = new Date(0).toISOString();
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    await expect(fundingAuthority(dir, 128, registry).reserve({ campaignRunId: plan.campaignRunId,
      plan, expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      .rejects.toThrow('CAMPAIGN_FUNDING_RELEASE_INVALID');
  });

  it('burns an exact allocation atomically and rejects replay after restart', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const registry = new HostAdapterRegistry(mintTrustKey('test-host'), []);
    const authority = fundingAuthority(dir, 128, registry);
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const allocation = reservation.subject.allocations[0]!;
    const request = debitRequest(allocation);
    await authority.debit(reservation, request);
    const restarted = fundingAuthority(dir, 128, registry);
    await expect(restarted.debit(reservation, request)).rejects.toThrow(/unavailable/i);
  });

  it('mints one subscription provider authorization only after an exact durable debit', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const authority = fundingAuthority();
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const allocation = reservation.subject.allocations[0]!;
    const request = debitRequest(allocation);
    const binding = { stageId: allocation.stageId, provider: allocation.identity.provider,
      model: allocation.identity.model, seatId: allocation.seat.seatId,
      requestDigest: request.requestDigest, mode: allocation.mode,
      baseUrl: 'http://127.0.0.1:8317/v1', credentialDigest: allocation.seat.seatDigest };
    await authority.runStage(reservation, allocation.stageId, async () => {
      expect(() => validateCurrentSubscriptionCampaignBinding(binding))
        .toThrow('CAMPAIGN_SUBSCRIPTION_HOST_BINDING_MISMATCH');
      const { stageId: _stage, logicalAttemptId: _attempt, routeDigest: _route, ...attempt } = request;
      expect(() => claimCurrentCampaignTransportProof({ ...attempt,
        baseUrl: 'http://127.0.0.1:8317/redirected', credentialDigest: binding.credentialDigest,
        transportProvider: binding.provider, transportModel: binding.model }))
        .toThrow('CAMPAIGN_FUNDING_TRANSPORT_BINDING_MISMATCH');
      expect(claimCurrentCampaignTransportProof({ ...attempt,
        baseUrl: binding.baseUrl, credentialDigest: binding.credentialDigest,
        transportProvider: binding.provider, transportModel: binding.model })).toMatchObject({
        transportOrdinal: allocation.transportOrdinal,
      });
      await debitCurrentCampaignFunding(attempt);
      expect(() => validateCurrentSubscriptionCampaignBinding({ ...binding, requestDigest: D('wrong') }))
        .toThrow('CAMPAIGN_SUBSCRIPTION_HOST_BINDING_MISMATCH');
      expect(() => validateCurrentSubscriptionCampaignBinding({ ...binding, mode: 'stream' }))
        .toThrow('CAMPAIGN_SUBSCRIPTION_HOST_BINDING_MISMATCH');
      expect(() => validateCurrentSubscriptionCampaignBinding({ ...binding,
        baseUrl: 'http://127.0.0.1:8317/redirected' }))
        .toThrow('CAMPAIGN_SUBSCRIPTION_HOST_BINDING_MISMATCH');
      const capability = validateCurrentSubscriptionCampaignBinding(binding);
      expect(() => consumeCurrentSubscriptionCampaignBinding(capability)).not.toThrow();
      expect(() => consumeCurrentSubscriptionCampaignBinding(capability))
        .toThrow('CAMPAIGN_SUBSCRIPTION_BINDING_INVALID_OR_CONSUMED');
      expect(() => validateCurrentSubscriptionCampaignBinding(binding))
        .toThrow('CAMPAIGN_SUBSCRIPTION_HOST_BINDING_MISMATCH');
    });
  });

  it('serializes concurrent debits so one frozen call cannot be spent twice', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const authority = fundingAuthority();
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const generationStage = plan.stages.find(item => item.kind === 'generation')!;
    const allocation = reservation.subject.allocations.find(item => item.stageId === generationStage.id)!;
    const results = await Promise.allSettled([
      authority.debit(reservation, debitRequest(allocation)),
      authority.debit(reservation, debitRequest(allocation)),
    ]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
  });

  it('reconciles an expired same-run reservation by issuing a fresh signed reservation', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    let nowMs = Date.parse('2026-08-01T00:00:00.000Z');
    const registry = new HostAdapterRegistry(mintTrustKey('renew-host'), []);
    const authority = fundingAuthority(dir, 128, registry, () => new Date(nowMs));
    const first = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(nowMs + 1_000).toISOString() });
    nowMs += 2_000;
    const renewed = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(nowMs + 1_000).toISOString() });
    expect(renewed.reservationDigest).not.toBe(first.reservationDigest);
    expect(authority.verify(renewed)).toBe(true);
  });

  it('settles only an exact signed completion and rejects tamper, swap, oversize, and overwrite', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const registry = buildRegistry();
    const authority = fundingAuthority(dir, 128, registry);
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const primaries = reservation.subject.allocations.filter(item => item.purpose === 'primary');
    const [first, second, third] = primaries;
    const firstReceipt = await authority.debit(reservation, debitRequest(first!, '1'));
    const firstAttestation = signedCompletion(registry, first!, firstReceipt);
    await authority.settle(firstReceipt, firstAttestation);
    await expect(authority.settle(firstReceipt, firstAttestation)).rejects.toThrow(/IMMUTABLE/);

    const secondReceipt = await authority.debit(reservation, debitRequest(second!, '2'));
    await expect(authority.settle({ ...secondReceipt, debitedAt: new Date(0).toISOString() },
      signedCompletion(registry, second!, secondReceipt))).rejects.toThrow(/TAMPERED/);
    await expect(authority.settle(secondReceipt, signedCompletion(registry, second!, secondReceipt, {
      calls: 1, inputTokens: 1, outputTokens: second!.outputTokens + 1, activeSeconds: 0,
    }))).rejects.toThrow(/MISMATCH/);
    expect(second!.activeSeconds).toBe(720);
    await expect(authority.settle(secondReceipt, signedCompletion(registry, second!, secondReceipt, {
      calls: 1, inputTokens: 1, outputTokens: 1, activeSeconds: second!.activeSeconds + 0.001,
    }))).rejects.toThrow(/MISMATCH/);

    const thirdReceipt = await authority.debit(reservation, debitRequest(third!, '3'));
    await expect(authority.settle(thirdReceipt, signedCompletion(registry, second!, secondReceipt)))
      .rejects.toThrow(/MISMATCH/);
  });

  it('cryptographically verifies the original settled V2 completion after restart', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const registry = buildRegistry();
    const authority = fundingAuthority(dir, 128, registry);
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const allocation = reservation.subject.allocations.find(item => item.purpose === 'primary')!;
    const receipt = await authority.debit(reservation, debitRequest(allocation));
    await authority.settle(receipt, signedCompletion(registry, allocation, receipt));
    const ledgerPath = path.join(dir,
      `${createHash('sha256').update('campaign-funding-global').digest('hex')}.json`);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    ledger.reservations[reservation.reservationDigest]
      .settled[allocation.allocationId].subject.attemptDigest = D('tampered');
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const restarted = fundingAuthority(dir, 128, registry);
    await expect(restarted.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      .rejects.toThrow(/LEDGER_ATTESTATION_INVALID:signature-invalid/);
  });

  it('derives a restart-safe revision settlement from one exact debited and signed allocation', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const registry = buildRegistry();
    const authority = fundingAuthority(dir, 128, registry);
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const revisionStage = plan.stages.find((stage) => stage.id === 'revision-temporal')!;
    const allocations = reservation.subject.allocations.filter((item) => item.stageId === revisionStage.id);
    expect(allocations).toHaveLength(2);
    const allocation = allocations.find((item) => item.purpose === 'primary')!;
    const debit = await authority.debit(reservation, debitRequest(allocation, 'revision'));
    await authority.settle(debit, signedCompletion(registry, allocation, debit));

    const restarted = fundingAuthority(dir, 128, registry);
    await expect(restarted.settledStage(reservation, revisionStage.id)).resolves.toMatchObject({
      stageId: revisionStage.id,
      allocationId: allocation.allocationId,
      reservationDigest: reservation.reservationDigest,
      debitDigest: debit.debitDigest,
    });
  });

  it('cannot charge a same-route allocation through another stage or logical attempt', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const authority = fundingAuthority();
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const [first, second] = reservation.subject.allocations.filter(item => item.purpose === 'primary');
    const request = debitRequest(first!);
    await expect(authority.debit(reservation, { ...request, stageId: second!.stageId }))
      .rejects.toThrow(/ALLOCATION_UNAVAILABLE/);
    await expect(authority.debit(reservation, { ...request,
      logicalAttemptId: second!.logicalAttemptId })).rejects.toThrow(/ALLOCATION_UNAVAILABLE/);
  });

  it('requires exact ordinal/template proof and frozen transport order', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const authority = fundingAuthority();
    const reservation = await authority.reserve({ campaignRunId: plan.campaignRunId, plan,
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const recoveryStage = plan.stages.find(stage => stage.kind === 'recovery')!;
    const recovery = reservation.subject.allocations.filter(item => item.stageId === recoveryStage.id);
    const primary = recovery.find(item => item.purpose === 'primary')!;
    const retry = recovery.find(item => item.purpose === 'retry')!;
    await expect(authority.debit(reservation, debitRequest(retry))).rejects.toThrow(/MISMATCH/);
    await expect(authority.debit(reservation, { ...debitRequest(primary),
      requestTemplateDigest: D('wrong') })).rejects.toThrow(/MISMATCH/);
    await expect(authority.debit(reservation, { ...debitRequest(primary),
      transportOrdinal: retry.transportOrdinal })).rejects.toThrow(/MISMATCH/);
    await authority.debit(reservation, debitRequest(primary, 'p'));
    await authority.debit(reservation, debitRequest(retry, 'r'));

    for (const kind of ['revision', 'transfer-treatment'] as const) {
      const stage = plan.stages.find(candidate => candidate.kind === kind)!;
      const allocations = reservation.subject.allocations.filter(item => item.stageId === stage.id);
      await authority.debit(reservation, debitRequest(allocations[0]!, `${kind}-p`));
      await authority.debit(reservation, debitRequest(allocations[1]!, `${kind}-x`));
    }
  });
});

describe('W8C-05 durable per-stage counters and atomic candidate insertion', () => {
  it('persists per-stage counters durably and survives restart', async () => {
    const counters = new CampaignStageCounters(dir);
    await counters.increment('stage-a', { providerCalls: 1, inputTokens: 100, outputTokens: 50, activeMinutes: 1 });
    await counters.increment('stage-a', { providerCalls: 1, inputTokens: 100, outputTokens: 50, activeMinutes: 1 });
    const reloaded = new CampaignStageCounters(dir);
    const record = reloaded.read('stage-a');
    expect(record?.providerCalls).toBe(2);
    expect(record?.inputTokens).toBe(200);
  });

  it('serializes counter increments across independent instances', async () => {
    const a = new CampaignStageCounters(dir);
    const b = new CampaignStageCounters(dir);
    await Promise.all([
      a.increment('stage-a', { providerCalls: 1, inputTokens: 1, outputTokens: 1, activeMinutes: 1 }),
      b.increment('stage-a', { providerCalls: 1, inputTokens: 1, outputTokens: 1, activeMinutes: 1 }),
    ]);
    expect(new CampaignStageCounters(dir).read('stage-a')?.providerCalls).toBe(2);
  });

  it('inserts candidates atomically and durably across restart, idempotently', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const ledger = new DurableCampaignCandidateLedger(manifest, new FileCampaignLedgerPersistence(dir));
    const slot = manifest.briefs[0]!.candidateSlots[0]!;
    await ledger.insert({ briefId: 'temporal', candidateSlotId: slot.id, artifactDigest: D('b'), status: 'failed' });
    const reloaded = new DurableCampaignCandidateLedger(manifest, new FileCampaignLedgerPersistence(dir));
    expect(reloaded.records()).toHaveLength(1);
    expect(reloaded.records()[0]!.status).toBe('failed');
    await reloaded.insert({ briefId: 'temporal', candidateSlotId: slot.id, artifactDigest: D('b'), status: 'failed' });
    expect(reloaded.records()).toHaveLength(1);
    await expect(reloaded.insert({ briefId: 'temporal', candidateSlotId: slot.id, artifactDigest: D('c'), status: 'completed' }))
      .rejects.toThrow(/immutable|already/i);
  });

  it('serializes concurrent candidate insertion and rejects a racing conflict', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const slot = manifest.briefs[0]!.candidateSlots[0]!;
    const a = new DurableCampaignCandidateLedger(manifest, new FileCampaignLedgerPersistence(dir));
    const b = new DurableCampaignCandidateLedger(manifest, new FileCampaignLedgerPersistence(dir));
    const first = { briefId: 'temporal', candidateSlotId: slot.id, artifactDigest: D('b'), status: 'failed' as const };
    const conflict = { ...first, artifactDigest: D('c'), status: 'completed' as const };
    const results = await Promise.allSettled([a.insert(first), b.insert(conflict)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});

describe('W8C-05 shared Studio/CLI campaign service parity', () => {
  it('persists plan, route, feasibility, and funding reservation digests with the run', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const reserve = vi.fn(async () => ({ id: 'res-1', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: reserve,
    });
    const service = new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: fundingAuthority(),
      executorAuthorityFactory: testExecutorFactory() });
    const admission = await service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: manifest.campaignRunId }, manifest, plan,
    );
    expect(admission.creativeRun.providerReservation.id).toBe('res-1');
    expect(admission.creativeRun.record.campaignOrigin?.manifestDigest).toBe(manifest.manifestDigest);
    expect(admission.creativeRun.record.campaignOrigin?.planDigest).toBe(plan.planDigest);
    expect(admission.creativeRun.record.campaignOrigin?.campaignFundingReservationDigest)
      .toBe(admission.fundingReservation.reservationDigest);
    expect(admission.creativeRun.record.campaignOrigin?.feasibilityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(admission.creativeRun.record.campaignOrigin?.routeFreezeDigest).toBe(plan.routeFreezeDigest);
    expect(service.governedBinding(admission)).toMatchObject({
      campaignRunId: manifest.campaignRunId, manifestDigest: manifest.manifestDigest,
      campaignPlanDigest: plan.planDigest,
      campaignFundingReservationDigest: admission.fundingReservation.reservationDigest,
    });
    expect(reserve).toHaveBeenCalledOnce();
  });

  it('refuses to start when host-owned capacity is insufficient', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const reserve = vi.fn(async () => ({ id: 'res-2', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: reserve,
    });
    const service = new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: fundingAuthority(dir, 1),
      executorAuthorityFactory: testExecutorFactory() });
    await expect(service.startCampaign({ entryPoint: 'cli-compose', requestKey: manifest.campaignRunId }, manifest, plan))
      .rejects.toThrow(/exhausted/i);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects request-key reuse with a different campaign origin', async () => {
    const first = createCampaignManifest(manifestInput());
    const changedInput = manifestInput();
    changedInput.owner.authorityId = 'owner-2';
    const second = createCampaignManifest(changedInput);
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: async () => ({ id: 'res-origin', status: 'reserved' as const }),
    });
    const authority = fundingAuthority();
    const make = (_manifest: typeof first) => new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: authority,
      executorAuthorityFactory: testExecutorFactory() });
    await make(first).startCampaign({ entryPoint: 'cli-compose', requestKey: first.campaignRunId }, first,
      buildCampaignExecutionPlan(first, buildGraphs(first), routeFreeze()));
    await expect(make(second).startCampaign({ entryPoint: 'cli-compose', requestKey: second.campaignRunId }, second,
      buildCampaignExecutionPlan(second, buildGraphs(second), routeFreeze()))).rejects.toThrow(/origin|manifest|request key/i);
  });

  it('renews an expired host reservation without reserving the provider twice', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    let nowMs = Date.now();
    const authority = fundingAuthority(dir, 128,
      new HostAdapterRegistry(mintTrustKey('service-renew-host'), []), () => new Date(nowMs));
    const reserve = vi.fn(async () => ({ id: 'res-renew', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve,
    });
    const service = new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: authority,
      executorAuthorityFactory: testExecutorFactory(), reservationLifetimeMs: 1_000,
      now: () => new Date(nowMs) });
    const first = await service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: manifest.campaignRunId }, manifest, plan,
    );
    nowMs += 2_000;
    const renewed = await service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: manifest.campaignRunId }, manifest, plan,
    );
    expect(renewed.fundingReservation.reservationDigest)
      .not.toBe(first.fundingReservation.reservationDigest);
    expect(renewed.creativeRun.record.campaignOrigin?.campaignFundingReservationDigest)
      .toBe(renewed.fundingReservation.reservationDigest);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it('Studio and CLI call the same service and expose an identical projection', async () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const service = new CampaignService(new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(), reserveProvider: async () => ({ id: 'res-parity', status: 'reserved' as const }),
    }), { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: fundingAuthority(), executorAuthorityFactory: testExecutorFactory() });
    const cli = await runCampaignCliJourney(service, { entryPoint: 'cli-compose', requestKey: manifest.campaignRunId }, manifest, plan);
    const studio = runCampaignStudioJourney(service, cli.admission);
    expect(studio.projection).toEqual(cli.projection);
  });

  it('routes both surfaces through the common immutable revision-closure lifecycle', async () => {
    const calls: string[] = [];
    const service = {
      recordRevisionClosure: vi.fn(async () => { calls.push('record'); return { briefId: 'temporal' }; }),
      closeCampaignClosure: vi.fn(async () => { calls.push('close'); return { status: 'passed' }; }),
    } as unknown as CampaignService;
    const admission = {} as never;
    const manifest = {} as never;
    const input = {} as never;
    await expect(recordCampaignCliRevisionClosure(service, admission, manifest, input))
      .resolves.toEqual({ briefId: 'temporal' });
    await expect(recordCampaignStudioRevisionClosure(service, admission, manifest, input))
      .resolves.toEqual({ briefId: 'temporal' });
    await expect(closeCampaignCliClosure(service, admission, manifest)).resolves.toEqual({ status: 'passed' });
    await expect(closeCampaignStudioClosure(service, admission, manifest)).resolves.toEqual({ status: 'passed' });
    expect(calls).toEqual(['record', 'record', 'close', 'close']);
  });

  it('canonical CLI governed journey invokes generation then shared owner review', async () => {
    const calls: string[] = [];
    const admission = { creativeRun: { requestKey: 'cli-governed' } } as never;
    const service = {
      startCampaign: vi.fn(async () => admission),
      assertGovernedInput: vi.fn(() => calls.push('assert')),
      assertOwnerReviewBriefCoverage: vi.fn(() => calls.push('brief-coverage')),
      preflightOwnerReview: vi.fn(() => calls.push('preflight')),
      runGovernedCampaign: vi.fn(async (_admission, _manifest, _input, _options, completeOwnerReviews) => {
        calls.push('campaign');
        await completeOwnerReviews([{ briefId: 'brief' }]);
        return { executions: [], candidateManifests: [] };
      }),
      assertOwnerReviewCoverage: vi.fn(() => calls.push('coverage')),
      runOwnerReview: vi.fn(async () => { calls.push('owner-review'); return { surface: 'cli',
        packet: { packetDigest: 'a'.repeat(64) },
        bundle: { reviewDigest: 'b'.repeat(64) } }; }),
      project: vi.fn(() => ({ requestKey: 'cli-governed' })),
    } as unknown as CampaignService;
    const result = await runCampaignCliJourney(service,
      { entryPoint: 'cli-compose', requestKey: 'cli-governed' },
      { briefs: [{ id: 'brief' }] } as never, {} as never,
      { input: { schema: 'sinter.campaign-execution-input', schemaVersion: 1,
          slotGraphs: [] }, ownerReviewBriefIds: ['brief'],
        ownerReviews: () => [{ briefId: 'brief' } as never] }, () => undefined);
    expect(calls).toEqual(['assert', 'brief-coverage', 'preflight', 'campaign', 'coverage', 'owner-review']);
    expect(result.ownerReviews?.[0]?.surface).toBe('cli');
  });

  it('production CLI governed journey fails before service execution without live authority', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousConfig = process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
    process.env.NODE_ENV = 'test';
    delete process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
    try {
      await expect(runCampaignCliJourney({} as CampaignService,
        { entryPoint: 'cli-compose', requestKey: 'authority-required' }, {} as never, {} as never,
        { input: {} as never, ownerReviewBriefIds: [], ownerReviews: () => [] }))
        .rejects.toThrow('SINTER_WAVE8_LIVE_EXECUTION_CONFIG is required');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousConfig === undefined) delete process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
      else process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG = previousConfig;
    }
  });

  it('production Studio governed journey fails before service execution without live authority', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousConfig = process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
    process.env.NODE_ENV = 'test';
    delete process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
    try {
      await expect(runGovernedCampaignStudioJourney({} as CampaignService,
        { entryPoint: 'studio-layers', requestKey: 'authority-required' }, {} as never, {} as never,
        { input: {} as never, ownerReviewBriefIds: [], ownerReviews: () => [] }))
        .rejects.toThrow('SINTER_WAVE8_LIVE_EXECUTION_CONFIG is required');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousConfig === undefined) delete process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
      else process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG = previousConfig;
    }
  });

  // Nine candidates and three evidence packets share the full CI runner.
  it('closes one manifest-first three-brief campaign only after real CLI and host-authenticated Studio decisions', async () => {
    const campaignRunId = 'terminal-governed-real';
    const cliTimeoutMs = 30_000;
    const manifest = createCampaignManifest(closureManifestInput(campaignRunId));
    expect(manifest.briefs.flatMap((brief) => brief.candidateSlots)).toHaveLength(9);
    const campaignGraphs = buildGraphs(manifest).map((binding) => {
      const crossModal = buildCrossModalArtifact({ brief: `Terminal ${binding.candidateSlotId}`,
        artifactId: `terminal-${binding.candidateSlotId}` });
      const graph = { ...binding.graph, creativeThesis: crossModal.thesis, renderGate: false as const,
        nodes: binding.graph.nodes.map((node) => ({ ...node,
          layer: { ...node.layer, domain: 'p5' as const, generated: true,
            code: 'function setup(){createCanvas(32,32)} function draw(){background(0)}' } })) };
      return { ...binding, graph };
    });
    const baseFreeze = routeFreeze();
    const freeze = { ...baseFreeze, candidateDiversity: baseFreeze.candidateDiversity.map((item) => ({
      ...item, thesisDigest: campaignCreativeThesisDigest(campaignGraphs.find((binding) =>
        binding.briefId === item.briefId && binding.candidateSlotId === item.candidateSlotId)!.graph.creativeThesis!),
    })) };
    const routes = freeze.routes.map((route) => route.seatId === 'specialist-review'
      ? { ...route, provider: 'google', model: 'gemini-3.1-pro-low' }
      : route.seatId === 'holistic-review'
        ? { ...route, provider: 'anthropic', model: 'claude-review' } : route);
    const plan = buildCampaignExecutionPlan(manifest, campaignGraphs, { ...freeze, routes });
    const ownerKeys = generateKeyPairSync('ed25519');
    const campaignKeys = generateKeyPairSync('ed25519');
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence(),
      ownerAuthority: { registryId: 'terminal-closure-registry',
        publicKeyPem: ownerKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        applicationBoundary: 'terminal-closure-test' },
      reserveProvider: async () => ({ id: 'terminal-reservation', status: 'reserved' as const }),
      campaignAuthority: createCampaignAuthority({ keyId: 'terminal-campaign-host',
        privateKeyPem: campaignKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        admissionStore: new InMemoryCampaignAdmissionStore() }),
      campaignPreflight: async () => ({ releaseHead: 'a'.repeat(40), sourceFingerprint: D('b'),
        schemaDigest: D('c'), implementationDigest: D('d'), wave8ReleaseRootDigest: D('e') }),
    });
    const ownerCapability = coordinator.acceptOwnerAuthorityCapability(
      signedOwnerAssertion(ownerKeys, 'owner', 'terminal-owner'),
    );
    const funding = bootstrappedFundingAuthority(dir, { ...freeze, routes });
    const persistence = new FileCampaignLedgerPersistence(path.join(dir, 'terminal-closure-ledger'));
    const captureKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const envelopeKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const captureAuthority = createCaptureAuthority({ keyId: 'terminal-capture',
      privateKeyPem: captureKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const envelopeAuthority = createEnvelopeAuthority({ keyId: 'terminal-envelope',
      privateKeyPem: envelopeKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const closureAuthority = bootstrapCampaignClosureEvidenceAuthority({ persistence, captureAuthority, envelopeAuthority });
    const service = new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: funding,
      executorAuthorityFactory: testExecutorFactory(dir),
      closureEvidenceAuthority: closureAuthority, closurePersistence: persistence });
    const admission = await service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: campaignRunId }, manifest, plan,
    );
    const hostRegistry = bootstrapHostAuthority({ rootDir: dir }).registry;
    const reviewContent = ({ userPrompt }: { readonly userPrompt: string }) => {
      const request = JSON.parse(userPrompt) as {
        readonly evidencePacket: { readonly candidates: OwnerReviewPacket['candidates'] };
        readonly blindId: string };
      const candidate = request.evidencePacket.candidates.find((item) => item.blindId === request.blindId)!;
      const anchor = candidate.evidence[0]!.digest;
      return JSON.stringify({ verdict: 'pass', scores: ['coherence', 'specificity', 'surprise',
        'emotionalTemporalArc', 'crossModalCausality', 'intentionality', 'revisitDesire'].map((dimension) =>
        ({ dimension, score: 4, evidenceDigests: [anchor] })),
      finding: { text: 'Canonical evidence reviewed.', evidenceDigests: [anchor] }, criticalFlaws: [], disagreement: [] });
    };
    const specialistAllocation = admission.fundingReservation.subject.allocations
      .find((allocation) => allocation.stageId.startsWith('specialist-review-'))!;
    const holisticAllocation = admission.fundingReservation.subject.allocations
      .find((allocation) => allocation.stageId.startsWith('holistic-review-'))!;
    const specialist = providerClient(specialistAllocation, hostRegistry, path.join(dir, 'specialist'), false,
      'evaluator', reviewContent);
    const holistic = providerClient(holisticAllocation, hostRegistry, path.join(dir, 'holistic'), false,
      'evaluator', reviewContent);
    bootstrapTestOwnerReviewHost(specialist.client, holistic.client);
    vi.spyOn(funding, 'assertSuccessfulStageGroups').mockResolvedValue();
    let ownerAdmission: ReturnType<CampaignService['admitOwnerReview']> | undefined;
    const publishedPackets = new Map<string, { readonly packet: OwnerReviewPacket;
      readonly envelope: ReturnType<typeof envelopeAuthority.seal> }>();
    const store: OwnerReviewPacketStore = {
      read: async (briefId) => publishedPackets.get(briefId)?.packet ?? null,
      readPublished: async (briefId) => publishedPackets.get(briefId) ?? null,
      putPublishedIfAbsent: async (envelope, packet) => {
        const existing = publishedPackets.get(packet.briefId);
        if (existing) return { packet: existing.packet, created: false };
        publishedPackets.set(packet.briefId, { envelope, packet });
        return { packet, created: true };
      },
      putIfAbsent: async (packet) => ({ packet, created: !publishedPackets.has(packet.briefId) }),
      compareAndSwap: async (briefId, _expected, packet) => ({ packet, created: !publishedPackets.has(briefId) }),
    };
    const ownerRuns: Awaited<ReturnType<typeof runTerminalOwnerReview>>[] = [];
    const compose = CompositionOrchestrator.compose.bind(CompositionOrchestrator);
    const compactCompose = vi.spyOn(CompositionOrchestrator, 'compose')
      .mockImplementation(async (...args) => {
        const result = await compose(...args);
        return { ...result, html: '<!doctype html><html><head><title>settled candidate</title>'
          + '<style>body { color: #777777; '
          + 'background-color: #ffffff; }</style></head><body>'
          + `${result.graphExecution.completed.join(',')}</body></html>` };
      });
    try {
      await service.runGovernedCampaign(admission, manifest,
        { schema: 'sinter.campaign-execution-input', schemaVersion: 1,
          slotGraphs: campaignGraphs },
        { entryPoint: 'cli-compose' }, async (manifests) => {
          ownerAdmission = service.admitOwnerReview(admission, manifest, manifests);
          for (const brief of manifest.briefs) {
            ownerRuns.push(await runTerminalOwnerReview(service, admission, manifest,
              ownerAdmission, brief.id, captureAuthority, envelopeAuthority, store,
              manifests.find((candidate) => candidate.briefId === brief.id)));
          }
          return ownerRuns.map((run) => ({ briefId: run.result.packet.briefId,
            packetDigest: run.result.packet.packetDigest,
            reviewBundleDigest: run.result.bundle.reviewDigest }));
        });
    } finally {
      compactCompose.mockRestore();
    }
    if (!ownerAdmission) throw new Error('terminal campaign did not admit owner review');
    const reviews = ownerRuns.map((run) => run.result);
    expect(reviews.map((review) => review.packet.packetDigest)).toHaveLength(3);
    expect(publishedPackets.size).toBe(3);

    const authorizedSessions = new Set<string>();
    const bridgeAuthorities: BridgeHostAuthorityRegistry = {
      resolveActor: ({ sessionId, credential }) => authorizedSessions.has(sessionId) && credential === 'owner-auth'
        ? { principalId: 'owner-principal', role: 'owner', capability: ownerCapability } : undefined,
    };
    const bridge = new TuiBridgeService({ creativeRunCoordinator: coordinator, campaignService: service,
      hostAuthorityRegistry: bridgeAuthorities, dreamQueuePath: path.join(dir, 'bridge-dreams.json'),
      cognitiveWriter: { beginGenerationLineage: vi.fn(), writeBackGeneration: vi.fn() } as never,
      campaignPreSpendInstaller: () => undefined });
    const bridgeServer = new TuiBridgeServer(bridge, { host: '127.0.0.1', port: 0 });
    try {
      await bridgeServer.start();
      bridge.registerGovernedOwnerReviewResults(admission, manifest, reviews);
      const finalizeViaHttp = (sessionId: string, briefId: string,
        campaignId = campaignRunId, credential = 'owner-auth') =>
        fetch(bridgeServer.address + '/api/tui/session/' + encodeURIComponent(sessionId)
          + '/governed-campaign/' + encodeURIComponent(campaignId)
          + '/owner-decisions/' + encodeURIComponent(briefId), {
          method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
      const startViaHttp = (sessionId: string, briefId: string, revisionEvidenceId: string,
        campaignId = campaignRunId, credential = 'owner-auth') =>
        fetch(bridgeServer.address + '/api/tui/session/' + encodeURIComponent(sessionId)
          + '/governed-campaign/' + encodeURIComponent(campaignId)
          + '/owner-decisions/' + encodeURIComponent(briefId) + '/comparison', {
          method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
          body: JSON.stringify({ revisionEvidenceId }),
        });
      const issueActionViaHttp = (sessionId: string, action: unknown, credential = 'owner-auth') =>
        fetch(bridgeServer.address + '/api/tui/session/' + encodeURIComponent(sessionId)
          + '/artist-review/checkpoints', {
          method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
      const executeActionViaHttp = (sessionId: string, token: string) =>
        fetch(bridgeServer.address + '/api/tui/session/' + encodeURIComponent(sessionId)
          + '/artist-review', {
          method: 'POST', headers: { Authorization: 'Bearer owner-auth', 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      const issueReleaseViaHttp = (sessionId: string,
        decision: 'release-worthy' | 'not-release-worthy') =>
        fetch(bridgeServer.address + '/api/tui/session/' + encodeURIComponent(sessionId)
          + '/artist-review/release-checkpoints', {
          method: 'POST', headers: { Authorization: 'Bearer owner-auth', 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
      const revisions = await Promise.all(manifest.briefs.map((brief, index) =>
        buildTerminalRevision(brief.id, ownerRuns[index]!)));
      const providerCallsBeforeClosure = specialist.generate.mock.calls.length + holistic.generate.mock.calls.length;
      await expect(service.closeCampaignClosure(admission, manifest)).rejects.toThrow('CAMPAIGN_CLOSURE_BRIEF_NOT_TERMINAL');
      const results = [];
      let terminalReplay: { readonly sessionId: string; readonly briefId: string;
        readonly revisionEvidenceId: string; readonly ownerDecisionEvidenceId: string } | undefined;
      for (const [index, brief] of manifest.briefs.entries()) {
        const revision = revisions[index]!;
        const revisionEvidenceId = `revision-${brief.id}`;
        const ownerEvidenceId = 'owner-decision-' + createHash('sha256')
          .update(campaignRunId + '\u0000' + brief.id + '\u0000' + revisionEvidenceId).digest('hex');
        await service.sealRevisionEvidence(admission, manifest, { revisionEvidenceId, briefId: brief.id,
          plan: revision.plan, revision: revision.revision, blindPreference: revision.preference });
        const revisionAllocation = admission.fundingReservation.subject.allocations
          .find((allocation) => allocation.stageId === `revision-${brief.id}`)!;
        const debit = await funding.debit(admission.fundingReservation,
          debitRequest(revisionAllocation, `revision-${index}`));
        await funding.settle(debit, signedCompletion(hostRegistry, revisionAllocation, debit));
        const status = bridge.createSession();
        authorizedSessions.add(status.sessionId);
        if (index === 0) {
          const cliStart = await execFileAsync(process.execPath, ['bin/sinter',
            'campaign-owner-decision-start', '--bridge-url', bridgeServer.address,
            '--session', status.sessionId, '--campaign-run-id', campaignRunId, '--brief-id', brief.id,
            '--revision-evidence-id', revisionEvidenceId], {
            cwd: path.resolve(import.meta.dirname, '../../..'),
            timeout: cliTimeoutMs,
            env: { ...process.env, SINTER_OWNER_AUTHORIZATION: 'owner-auth' },
          });
          expect((JSON.parse(cliStart.stdout) as { candidates: readonly unknown[] }).candidates).toHaveLength(2);
        } else {
          const started = await startViaHttp(status.sessionId, brief.id, revisionEvidenceId);
          expect(started.status).toBe(201);
          expect((await started.json() as { candidates: readonly unknown[] }).candidates).toHaveLength(2);
        }
        if (index === 0) {
          const unauthenticated = await fetch(bridgeServer.address + '/api/tui/session/' + status.sessionId
            + '/governed-campaign/' + campaignRunId + '/owner-decisions/' + brief.id, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          expect(unauthenticated.status).toBe(401);
          const crossCampaign = await finalizeViaHttp(status.sessionId, brief.id, 'different-campaign');
          expect(crossCampaign.status).toBe(403);
          expect(await crossCampaign.json()).toMatchObject({
            error: 'GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING',
          });
          const crossSession = bridge.createSession();
          authorizedSessions.add(crossSession.sessionId);
          const wrongSession = await startViaHttp(crossSession.sessionId, brief.id, revisionEvidenceId);
          expect(wrongSession.status).toBe(403);
          expect(await wrongSession.json()).toMatchObject({
            error: 'GOVERNED_OWNER_CLOSURE_SESSION_IMMUTABLE',
          });
        }
        const incomplete = await finalizeViaHttp(status.sessionId, brief.id);
        expect(incomplete.status).toBe(403);
        expect(await incomplete.json()).toMatchObject({
          error: 'ARTIST_REVIEW_CLOSURE_DECISIONS_INCOMPLETE',
        });
        const wrongOwner = await issueActionViaHttp(status.sessionId, {
          kind: 'preference', blindIds: ['wrong-a', 'wrong-b'], outcome: 'tie',
        }, 'wrong-owner');
        expect(wrongOwner.status).toBe(403);
        const state = bridge.getArtistReviewState(status.sessionId);
        const selected = state.candidates[0]!;
        const preferenceAction = { kind: 'preference' as const,
          blindIds: state.candidates.map((candidate) => candidate.blindId) as [string, string],
          outcome: 'preferred' as const, winnerBlindId: selected.blindId };
        const preference = await issueActionViaHttp(status.sessionId, preferenceAction);
        expect(preference.status).toBe(201);
        const preferenceToken = await preference.json() as { readonly token: string };
        expect((await executeActionViaHttp(status.sessionId, preferenceToken.token)).status).toBe(200);
        if (index === 0) {
          const invalidRelease = await fetch(bridgeServer.address + '/api/tui/session/' + status.sessionId
            + '/artist-review/release-checkpoints', {
            method: 'POST', headers: { Authorization: 'Bearer owner-auth', 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'release-worthy', artifactDigest: 'client-forged' }),
          });
          expect(invalidRelease.status).toBe(400);
        }
        const release = await issueReleaseViaHttp(status.sessionId,
          index === 0 ? 'not-release-worthy' : 'release-worthy');
        expect(release.status).toBe(201);
        const releaseToken = await release.json() as { readonly token: string };
        expect((await executeActionViaHttp(status.sessionId, releaseToken.token)).status).toBe(200);
        const result = index === manifest.briefs.length - 1
          ? JSON.parse((await execFileAsync(process.execPath, ['bin/sinter',
            'campaign-owner-decision', '--bridge-url', bridgeServer.address,
            '--session', status.sessionId, '--campaign-run-id', campaignRunId, '--brief-id', brief.id], {
            cwd: path.resolve(import.meta.dirname, '../../..'),
            timeout: cliTimeoutMs,
            env: { ...process.env, SINTER_OWNER_AUTHORIZATION: 'owner-auth' },
          })).stdout) as Awaited<ReturnType<TuiBridgeService['finalizeGovernedCampaignOwnerDecision']>>
          : await (async () => {
            const finalized = await finalizeViaHttp(status.sessionId, brief.id);
            expect(finalized.status).toBe(200);
            return finalized.json() as Promise<Awaited<ReturnType<
              TuiBridgeService['finalizeGovernedCampaignOwnerDecision']>>>;
          })();
        results.push(result);
        if (index === manifest.briefs.length - 1) {
          terminalReplay = { sessionId: status.sessionId, briefId: brief.id,
            revisionEvidenceId, ownerDecisionEvidenceId: ownerEvidenceId };
        }
        const ownerEvidence = await closureAuthority.resolveOwnerDecision(ownerEvidenceId);
        expect(ownerEvidence.binding).toEqual({ campaignRunId, manifestDigest: manifest.manifestDigest });
        expect(ownerEvidence.briefId).toBe(brief.id);
        expect(ownerEvidence.planDigest).toBe(revision.plan.planDigest);
        expect(ownerEvidence.sourceBlindPacketDigest).toBe(reviews[index]!.packet.blindPacketDigest);
        expect(ownerEvidence.originalQualityPacket.packetDigest).toBe(reviews[index]!.packet.packetDigest);
        expect(ownerEvidence.originalQualityEnvelope.packetDigest).toBe(reviews[index]!.packet.packetDigest);
        expect(ownerEvidence.originalQualityPacket.candidates).toHaveLength(3);
        expect(ownerEvidence.originalQualityPacket.candidates.some((candidate) =>
          candidate.artifactDigest === revision.plan.baselineArtifact.sourceArtifactDigest)).toBe(true);
        expect(ownerEvidence.comparisonPacket.candidates).toHaveLength(2);
        expect(ownerEvidence.comparisonEnvelope.packetDigest).toBe(ownerEvidence.comparisonPacket.packetDigest);
        await expect(recordCampaignCliRevisionClosure(service, admission, manifest, {
          briefId: brief.id, revisionEvidenceId, ownerDecisionEvidenceId: ownerEvidenceId,
        })).resolves.toEqual(result.record);
      }
      expect(results.slice(0, 2).every((result) => !result.closed)).toBe(true);
      expect(results[2]!.closure?.status).toBe('durable-red');
      expect(specialist.generate.mock.calls.length + holistic.generate.mock.calls.length).toBe(providerCallsBeforeClosure);
      const replayResponse = await finalizeViaHttp(terminalReplay!.sessionId, terminalReplay!.briefId);
      expect(replayResponse.status).toBe(200);
      const replayedTerminal = await replayResponse.json() as Awaited<ReturnType<
        TuiBridgeService['finalizeGovernedCampaignOwnerDecision']>>;
      expect(replayedTerminal.record).toEqual(results[2]!.record);
      expect(replayedTerminal.closure?.closureDigest).toBe(results[2]!.closure!.closureDigest);
      expect(specialist.generate.mock.calls.length + holistic.generate.mock.calls.length).toBe(providerCallsBeforeClosure);
      const restartedAuthority = bootstrapCampaignClosureEvidenceAuthority({ persistence, captureAuthority, envelopeAuthority });
      const restarted = new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: funding,
        closureEvidenceAuthority: restartedAuthority, closurePersistence: persistence });
      const replay = await restarted.closeCampaignClosure(admission, manifest);
      expect(replay.closureDigest).toBe(results[2]!.closure!.closureDigest);
      expect(specialist.generate.mock.calls.length + holistic.generate.mock.calls.length).toBe(providerCallsBeforeClosure);
    } finally {
      await bridgeServer.stop();
    }
  }, 240_000);

  it('sends the executable CLI owner decision command to the host-bound bridge route', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ closed: false }), { status: 200,
      headers: { 'Content-Type': 'application/json' } }));
    await expect(runCampaignCliOwnerDecision({
      bridgeUrl: 'http://127.0.0.1:3200/studio', ownerCredential: 'owner-auth', sessionId: 'session/a',
      campaignRunId: 'campaign/a', briefId: 'brief/a',
    }, transport)).resolves.toEqual({ closed: false });
    expect(transport).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3200/studio/api/tui/session/session%2Fa/governed-campaign/campaign%2Fa/owner-decisions/brief%2Fa'),
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({
        Authorization: 'Bearer owner-auth', 'Content-Type': 'application/json',
      }), body: JSON.stringify({}) }),
    );
    const help = spawnSync(process.execPath, ['bin/sinter', '--help'], {
      cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('campaign-owner-decision-start');
    expect(help.stdout).toContain('campaign-owner-decision');
  });

  it('leaves the terminal ledger unclosed when any frozen brief lacks an owner decision', async () => {
    const service = new CampaignService(new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
    }));
    const close = vi.spyOn(service, 'closeCampaignClosure');
    await expect(service.finalizeGovernedOwnerDecisionClosures({} as never,
      { briefs: [{ id: 'brief-a' }, { id: 'brief-b' }, { id: 'brief-c' }] } as never,
      [{ briefId: 'brief-a' }] as never)).rejects.toThrow('CAMPAIGN_CLOSURE_DECISION_COVERAGE_INCOMPLETE');
    expect(close).not.toHaveBeenCalled();
  });

  it('governed Studio rejects missing owner review before campaign admission or provider access', async () => {
    const startCampaign = vi.fn(async () => { throw new Error('must not start'); });
    const provider = vi.fn();
    const bridge = new TuiBridgeService({
      creativeRunCoordinator: new CreativeRunCoordinator({ reserveProvider: provider }),
      campaignService: { startCampaign } as unknown as CampaignService,
      dreamQueuePath: path.join(dir, 'missing-owner-dreams.json'),
      cognitiveWriter: { beginGenerationLineage: vi.fn(), writeBackGeneration: vi.fn() } as never,
      campaignPreSpendInstaller: () => undefined,
    });
    try {
      await expect(bridge.composeStudioLayers({ layers: [{ domain: 'html', prompt: 'x' }] }, {
        governedCampaign: { manifest: {} as never, plan: {} as never },
      })).rejects.toThrow(/GOVERNED_STUDIO_OWNER_REVIEW_REQUIRED/);
      expect(startCampaign).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      bridge.destroy();
    }
  });

  it('Studio funds each node transport and rejects unfrozen shapes before provider calls', async () => {
    const base = manifestInput();
    const sourceBrief = base.briefs[1]!;
    const brief = { ...sourceBrief, candidateSlots: [sourceBrief.candidateSlots[1]!] };
    const input = { ...base, briefs: [brief], requiredReviewStageIds: [
      `specialist-review-${brief.id}-${brief.candidateSlots[0]!.id}`,
      `holistic-review-${brief.id}-${brief.candidateSlots[0]!.id}`,
    ] };
    const manifest = createCampaignManifest(input);
    const graphs = buildGraphs(manifest);
    const graph = graphs.find(item => item.graph.nodes.length === 2)!.graph;
    graph.creativeThesis = buildCrossModalArtifact({ brief: 'Studio batch transport',
      artifactId: 'studio-batch-thesis' }).thesis;
    for (const node of graph.nodes) {
      node.layer.domain = 'p5';
      node.layer.prompt = `${node.layer.prompt} stage-node ${node.id}`;
    }
    graph.retry = { maxAttempts: 2, retryable: ['unknown'] };
    graph.budgets.maxProviderCalls = 3;
    const fullFreeze = routeFreeze();
    const freeze = { ...fullFreeze,
      routes: fullFreeze.routes.map((route, index) => index === 0
        ? { ...route, provider: 'google' as const, model: 'gemini-3.1-pro-low' } : route),
      candidateDiversity: fullFreeze.candidateDiversity.filter((item) =>
        item.briefId === brief.id && item.candidateSlotId === brief.candidateSlots[0]!.id)
        .map((item) => ({ ...item,
          thesisDigest: campaignCreativeThesisDigest(graph.creativeThesis!) })) };
    const plan = buildCampaignExecutionPlan(manifest, graphs, freeze);
    const registry = buildRegistry();
    const campaignFunding = fundingAuthority(dir, 128, registry);
    const debit = vi.spyOn(campaignFunding, 'debit');
    const settle = vi.spyOn(campaignFunding, 'settle');
    const { privateKey } = generateKeyPairSync('ed25519');
    const reserve = vi.fn(async () => ({ id: 'studio-provider', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve,
      campaignAuthority: createCampaignAuthority({ keyId: 'studio-host',
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        admissionStore: new InMemoryCampaignAdmissionStore() }),
      campaignPreflight: async () => ({ releaseHead: 'a'.repeat(40), sourceFingerprint: D('b'),
        schemaDigest: D('c'), implementationDigest: D('d'), wave8ReleaseRootDigest: D('e') }),
    });
    const campaignService = new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: campaignFunding,
      executorAuthorityFactory: testExecutorFactory() });
    vi.spyOn(campaignService, 'preflightOwnerReview').mockImplementation(() => undefined);
    vi.spyOn(campaignService, 'assertOwnerReviewCoverage').mockImplementation(() => undefined);
    const ownerReview = vi.spyOn(campaignService, 'runOwnerReview')
      .mockResolvedValue({ surface: 'studio', packet: { packetDigest: 'a'.repeat(64) },
        bundle: { reviewDigest: 'b'.repeat(64) } } as never);
    const admission = await campaignService.startCampaign(
      { entryPoint: 'studio-layers', requestKey: manifest.campaignRunId }, manifest, plan,
    );
    const providers = plan.stages
      .filter(stage => stage.kind === 'generation' || stage.kind === 'recovery')
      .map((stage, index) => ({ nodeId: stage.nodeId,
        client: providerClient(admission.fundingReservation.subject.allocations.find(item =>
          item.stageId === stage.id)!, registry, `${dir}/studio-generator-${index}`,
        index === 0) }));
    const remainingProviders = [...providers];
    await registerAllGenerators();
    const p5 = generatorRegistry.getAll().find(entry => entry.name === 'p5')!;
    const generateLayer = vi.spyOn(p5, 'generate').mockImplementation(async prompt => {
      const providerIndex = remainingProviders.findIndex(item =>
        prompt.includes(`stage-node ${item.nodeId}`));
      if (providerIndex < 0) throw new Error('studio generator could not identify its node stage');
      const [provider] = remainingProviders.splice(providerIndex, 1);
      return (await provider!.client.client.generate('studio-generator', prompt)).code;
    });
    const bridge = new TuiBridgeService({ creativeRunCoordinator: coordinator, campaignService,
      dreamQueuePath: path.join(dir, 'dreams.json'), cognitiveWriter: {
        beginGenerationLineage: vi.fn(), writeBackGeneration: vi.fn(),
      } as never, campaignPreSpendInstaller: () => undefined });
    const governed = (candidateGraph: CompositionGraph, campaignPlan = plan) => ({
      manifest, plan: campaignPlan,
      input: { schema: 'sinter.campaign-execution-input' as const, schemaVersion: 1 as const,
        slotGraphs: [{ briefId: brief.id, candidateSlotId: brief.candidateSlots[0]!.id,
          graph: candidateGraph }] },
      ownerReviewBriefIds: [brief.id],
      ownerReviews: () => [{ briefId: brief.id } as never],
    });
    try {
      const result = await bridge.composeStudioLayers(graph,
        { requestKey: manifest.campaignRunId, governedCampaign: governed(graph) });
      expect(ownerReview).toHaveBeenCalledWith('studio', expect.anything(), expect.anything());
      expect(result.campaignEvidenceCheckpoint?.campaignFundingReservationDigest)
        .toMatch(/^[a-f0-9]{64}$/);
      expect(providers.reduce((calls, provider) => calls + provider.client.generate.mock.calls.length, 0))
        .toBe(3);
      expect(generateLayer).toHaveBeenCalledTimes(3);
      expect(debit).toHaveBeenCalledTimes(3);
      expect(settle).toHaveBeenCalledTimes(3);
      expect(new Set(debit.mock.calls.map(call => call[1].stageId))).toHaveLength(3);
      expect(reserve).toHaveBeenCalledOnce();
      await expect(bridge.composeStudioLayers({
        layers: [{ domain: 'html', prompt: 'legacy', code: '<p>legacy</p>' }],
      }, { requestKey: manifest.campaignRunId, governedCampaign: governed({
        layers: [{ domain: 'html', prompt: 'legacy', code: '<p>legacy</p>' }],
      } as never) })).rejects.toThrow(/V2 graph/);
      const missing = { ...graph, nodes: graph.nodes.map((node, index) =>
        index === 0 ? { ...node, id: 'not-frozen' } : node) };
      await expect(bridge.composeStudioLayers(missing, { requestKey: manifest.campaignRunId,
        governedCampaign: governed(missing) })).rejects.toThrow(/topology/);
      const matchingStage = plan.stages.find(stage => stage.nodeId === graph.nodes[0]!.id)!;
      const ambiguousPlan = { ...plan,
        stages: [...plan.stages, { ...matchingStage, id: `${matchingStage.id}-duplicate` }] };
      await expect(bridge.composeStudioLayers(graph, { requestKey: manifest.campaignRunId,
        governedCampaign: governed(graph, ambiguousPlan) })).rejects.toThrow(/MAPPING_AMBIGUOUS/);
      expect(providers.reduce((calls, provider) => calls + provider.client.generate.mock.calls.length, 0))
        .toBe(3);
      expect(reserve).toHaveBeenCalledOnce();
    } finally {
      generateLayer.mockRestore();
      bridge.destroy();
    }
  }, 30_000);
});

// This suite renders offline assets and settles exact fake-provider debits for each candidate.
describe('W8C-06 shared Studio/CLI owner-review lifecycle parity', { timeout: 90_000 }, () => {
  it('spawned shipped CLI rejects missing owner package before campaign or generation access', () => {
    const specPath = path.join(dir, 'spawn-spec.json');
    writeFileSync(specPath, JSON.stringify({ schema: 'sinter.composition-graph', schemaVersion: '2.0',
      status: 'ready', id: 'spawn-owner-preflight', title: 'Owner preflight',
      budgets: { maxNodes: 1, maxEdges: 0, maxProviderCalls: 0 },
      nodes: [{ id: 'node-0', type: 'layer', layer: { domain: 'p5', prompt: 'still',
        code: 'function setup(){createCanvas(8,8);}' } }], edges: [] }));
    const output = path.join(dir, 'spawn-output');
    const run = spawnSync(process.execPath, ['bin/sinter', 'compose', '--spec', specPath,
      '--campaign-manifest', path.join(dir, 'must-not-be-read.json'), '--output', output], {
      cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: dir },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Governed campaign requires --owner-review-package');
    expect(() => readFileSync(path.join(output, 'composition.html'))).toThrow();
  });

  // Keep one 60s test budget: its child has a 45s deadline,
  // with the remainder for signed fixture setup, assertions and cleanup.
  const realBrowser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  it.each([{ mode: 'no browser', browser: undefined },
    ...(realBrowser ? [{ mode: 'real browser', browser: realBrowser }] : [])])(
    'spawned shipped CLI completes a signed v3 batch through owner evidence checkpoint only ($mode)', async ({ browser }) => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const campaignRunId = 'spawned-v3-batch';
    const requiredEvidenceClasses = ['source', 'visual', 'temporal', 'audio',
      'interaction', 'runtime', 'clock', 'accessibility'] as const;
    const evidenceScheduleDigest = createHash('sha256').update(stableString(requiredEvidenceClasses)).digest('hex');
    const slots = ['brief-a', 'brief-b', 'brief-c'].flatMap((briefId) =>
      [1, 2, 3].map((ordinal) => {
        const id = `${briefId}-candidate-${ordinal}`;
        const nodeId = `${id}-node`;
        const body = { campaignRunId, briefId, candidateId: id, nodeId,
          audioRequirement: 'required' as const, requiredEvidenceClasses, evidenceScheduleDigest };
        return { briefId, id, nodeId, ownerEvidence: { ...body,
          slotDigest: createHash('sha256').update(stableString(body)).digest('hex') } };
      }));
    const manifest = createCampaignManifest({
      campaignRunId, owner: { authorityId: 'spawn-owner', selectionMethod: 'owner-signed-fixture' },
      briefs: ['brief-a', 'brief-b', 'brief-c'].map((briefId, index) => ({
        id: briefId, sealedBriefDigest: D(String(index + 1)), unseenAt: '2026-08-02T00:00:00.000Z',
        exampleFree: true, candidateSlots: slots.filter((slot) => slot.briefId === briefId).map((slot) => ({
          id: slot.id, graphNodeIds: [slot.nodeId], ownerEvidence: slot.ownerEvidence,
        })),
      })),
      transfer: { mode: 'sealed-brief', sealedBriefDigest: D('4'), unseenAt: '2026-08-02T00:00:00.000Z',
        treatmentControlAllocation: 'fixture-treatment-first', routeDigest: D('5'), randomSourceDigest: D('6'),
        evidenceScheduleDigest: D('7'), nonOverlapDigest: D('8') },
      rolesDigest: D('9'), executorRequirementsDigest: D('a'), evidenceModalitiesDigest: D('b'),
      ownerCheckpointsDigest: D('c'), qualityRubricVersion: 'fixture-v3', randomSourceDigest: D('d'),
      evidenceScheduleDigest: D('e'), requiredReviewStageIds: slots.flatMap((slot) => [
        `specialist-review-${slot.briefId}-${slot.id}`,
        `holistic-review-${slot.briefId}-${slot.id}`,
      ]), stopStates: ['checkpoint-pending-origin'],
      // gen/recovery stage profiles are 12 activeMinutes each; multi-node fixtures exceed 720.
    ceilings: { providerCalls: 128, inputTokens: 6_000_000, outputTokens: 2_000_000, activeMinutes: 2_400 },
    });
    const slotGraphs: CampaignSlotGraph[] = slots.map((slot) => {
      const creativeThesis = compileCreativeThesis(
        `A distinct frozen music rhythm and sound pulse for ${slot.id}.`,
      );
      return { briefId: slot.briefId, candidateSlotId: slot.id,
      graph: { schema: 'sinter.composition-graph', schemaVersion: '2.0', status: 'ready', renderGate: false,
        id: `graph-${slot.id}`, title: `Fixture ${slot.id}`,
        budgets: { maxNodes: 1, maxEdges: 0, maxProviderCalls: 1 },
        creativeThesis,
        nodes: [{ id: slot.nodeId, type: 'layer', layer: { domain: 'p5', prompt: `sealed ${slot.id}`,
        blendMode: 'normal', opacity: 1 } }], edges: [] } };
    });
    const freeze: CampaignRouteFreeze = {
      routes: [
        { role: 'generator', seatId: 'gen-seat', provider: 'google', model: 'gemini-3.6-flash-high', seed: D('f'), retryBudget: 1 },
        { role: 'harness', seatId: 'dream-seat', provider: 'openai', model: 'gpt-5.6-sol', seed: D('g'), retryBudget: 1 },
        { role: 'evaluator', seatId: 'specialist-review', provider: 'kimi', model: 'kimi-k3', seed: D('h'), retryBudget: 1 },
        { role: 'evaluator', seatId: 'holistic-review', provider: 'openai', model: 'gpt-5.6-terra', seed: D('i'), retryBudget: 1 },
      ],
      transportBudgets: { review: { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' } },
      transferTargetDigest: D('f'), diversityDimensions: [
        { id: 'conceptual', description: 'distinct concept' },
        { id: 'structural', description: 'distinct structure' },
        { id: 'temporal', description: 'distinct time' },
      ], candidateDiversity: slots.map((slot, index) => ({ briefId: slot.briefId,
        candidateSlotId: slot.id, thesisDigest: campaignCreativeThesisDigest(slotGraphs
          .find((graph) => graph.briefId === slot.briefId && graph.candidateSlotId === slot.id)!
          .graph.creativeThesis!),
        dimensions: { conceptual: `concept-${index % 3}`, structural: `structure-${index % 3}`,
          temporal: `temporal-${index % 3}` } })),
    };
    const plan = buildCampaignExecutionPlan(manifest, slotGraphs, freeze);
    const generator = await startGoogleGenerationTransport(8317);
    const specialist = await startOwnerReviewTransport();
    const holistic = await startOwnerReviewTransport(8318);
    const declaredSlots = [
      { id: 'sol-approval', purpose: 'sol-review-bootstrap', provider: 'openai', model: 'kimi-k3',
        role: 'harness', identityId: 'harness-kimi', pipe: 'kimi-k3', effort: 'high',
        seatId: 'dream-seat', subscriptionTransport: 'campaign-host',
        minCalls: 1, maxCalls: 1, maxInputTokens: 4_000, maxOutputTokens: 2_000, minActiveMinutes: 1 },
      ...plan.stages.filter((stage) => stage.kind === 'generation'
        || (stage.kind === 'recovery' && stage.candidateSlotId?.endsWith('candidate-1'))).map((stage) => ({
        id: stage.id, purpose: 'product' as const, provider: 'google', model: 'gemini-3.6-flash-high', role: 'generator' as const,
        identityId: 'gen-seat', pipe: 'google-direct', effort: 'medium',
        seatId: stage.seatId, subscriptionTransport: 'campaign-host' as const,
        minCalls: 1, maxCalls: stage.providerCalls, maxInputTokens: stage.inputTokens, maxOutputTokens: stage.outputTokens,
        minActiveMinutes: stage.activeMinutes })),
      ...plan.stages.filter((stage) => stage.kind === 'review').map((stage) => ({
        id: stage.id, purpose: 'product' as const,
        // Wire format is OpenAI-compatible; signed identity remains logical.
        provider: stage.id.startsWith('specialist-review-') ? 'kimi' : 'openai',
        model: stage.id.startsWith('specialist-review-') ? 'kimi-k3' : 'gpt-5.6-terra', role: 'critic' as const,
        identityId: stage.id.startsWith('specialist-review-') ? 'specialist-review' : 'holistic-review',
        pipe: stage.id.startsWith('specialist-review-') ? 'kimi-cliproxy' : 'terra-high',
        effort: stage.id.startsWith('specialist-review-') ? 'low' : 'high',
        seatId: stage.seatId, subscriptionTransport: 'campaign-host' as const,
        minCalls: 1, maxCalls: stage.providerCalls, maxInputTokens: stage.inputTokens, maxOutputTokens: stage.outputTokens,
        minActiveMinutes: stage.activeMinutes })),
    ];
    const campaignKeys = generateKeyPairSync('ed25519');
    const captureKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const envelopeKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const campaignKeyPath = path.join(dir, 'campaign-key.pem');
    const captureKeyPath = path.join(dir, 'capture-key.pem');
    const envelopeKeyPath = path.join(dir, 'envelope-key.pem');
    writeFileSync(campaignKeyPath, campaignKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    writeFileSync(captureKeyPath, captureKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    writeFileSync(envelopeKeyPath, envelopeKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    const reviewDir = path.join(dir, 'owner-reviews');
    const reviewPackage = { schema: 'sinter.owner-review-package', schemaVersion: 2, plan,
      reviews: manifest.briefs.map((brief) => ({ briefId: brief.id,
        assignments: brief.candidateSlots.map((slot) => ({
          candidateId: slot.id, requiredModalities: ['visual', 'audio', 'motion', 'interaction'],
          creativeThesis: slotGraphs.find((graph) => graph.briefId === brief.id
            && graph.candidateSlotId === slot.id)!.graph.creativeThesis! })),
        rendererFilePath: path.join(reviewDir, `${brief.id}.html`),
      })), captureKey: { keyId: 'capture-key', privateKeyPath: captureKeyPath },
      envelopeKey: { keyId: 'envelope-key', privateKeyPath: envelopeKeyPath }, storeDirectory: path.join(reviewDir, 'packets') };
    const executionInput = { schema: 'sinter.campaign-execution-input', schemaVersion: 1, slotGraphs };
    const live = createWave8LiveProtocolFixture({ repoRoot, declaredSlots,
      fundingMode: 'subscription-seat', campaignArtifactContents: {
        manifest: JSON.stringify(manifest), execution: JSON.stringify(executionInput),
        ownerReviewPackage: JSON.stringify(reviewPackage),
        subscriptionRouteAttestation: JSON.stringify({
          schema: 'sinter.wave8-subscription-route-attestation', schemaVersion: 1,
          campaignRunId, fundingMode: 'subscription-seat', meteredApiSpendAuthorizedUsd: 0,
          failClosed: true, fallbacks: [], routes: [
            { roles: ['generator'], models: ['gemini-3.6-flash-high'], baseUrl: generator.baseUrl },
            { roles: ['evaluator'], models: ['gpt-5.6-terra'], baseUrl: holistic.baseUrl },
            { roles: ['evaluator'], models: ['kimi-k3'], baseUrl: specialist.baseUrl.replace('/v1', '/kimi/v1') },
          ],
        }),
        phaseOneEnforcement: 'owner review checkpoint is the phase-one stop\n',
      } });
    const packagePath = live.campaignArtifacts.ownerReviewPackage;
    const legacyPackage = { ...reviewPackage, schemaVersion: 1,
      reviews: manifest.briefs.map((brief) => ({ briefId: brief.id,
        assignments: brief.candidateSlots.map((slot) => ({ candidateId: slot.id,
          requiredModalities: ['visual'] })),
        evidence: brief.candidateSlots.map((slot) => ({
          timeSamples: [{ ref: `${slot.id}.frame`, mimeType: 'text/plain', payload: 'frame-0' }],
          interactionTrace: { ref: `${slot.id}.interaction`, mimeType: 'text/plain', payload: 'click' },
          runtimeState: { ref: `${slot.id}.runtime`, mimeType: 'application/json', payload: '{"ready":true}' },
          clockEvents: { ref: `${slot.id}.clock`, mimeType: 'text/plain', payload: '0,1' },
          accessibility: { ref: `${slot.id}.a11y`, mimeType: 'text/plain', payload: 'contrast:pass' },
          knownFailures: [], hardFloorFailures: [] })),
        evidenceJudgments: brief.candidateSlots.map((_slot, index) => ({
          blindId: `candidate-${String(index + 1).padStart(3, '0')}`, outcome: 'pass', claims: [] })),
        rendererFilePath: path.join(reviewDir, `legacy-${brief.id}.html`),
      })) };
    const manifestPath = live.campaignArtifacts.manifest;
    const executionPath = live.campaignArtifacts.execution;
    const output = path.join(dir, 'output');
    const gallery = path.join(dir, 'gallery');
    mkdirSync(gallery);
    const legacyPackagePath = path.join(dir, 'owner-review-package-v1.json');
    writeFileSync(legacyPackagePath, JSON.stringify(legacyPackage));
    expect(() => loadProductionOwnerReviewPackage(legacyPackagePath).assertManifestCoverage(manifest))
      .not.toThrow();
    const forgedLegacy = JSON.parse(JSON.stringify(legacyPackage)) as {
      reviews: { assignments: Record<string, unknown>[]; evidence: Record<string, unknown>[] }[] };
    forgedLegacy.reviews[0]!.assignments[0]!.generationIdentity = { provider: 'forged' };
    writeFileSync(legacyPackagePath, JSON.stringify(forgedLegacy));
    expect(() => loadProductionOwnerReviewPackage(legacyPackagePath))
      .toThrow(/OWNER_REVIEW_GENERATION_IDENTITY_CALLER_FORBIDDEN/);
    delete forgedLegacy.reviews[0]!.assignments[0]!.generationIdentity;
    forgedLegacy.reviews[0]!.evidence[0]!.source = {
      ref: 'predicted.source', mimeType: 'text/plain', payload: 'predicted' };
    writeFileSync(legacyPackagePath, JSON.stringify(forgedLegacy));
    expect(() => loadProductionOwnerReviewPackage(legacyPackagePath))
      .toThrow(/OWNER_REVIEW_GENERATED_SOURCE_CALLER_FORBIDDEN/);
    const forgedPackage = JSON.parse(JSON.stringify(reviewPackage)) as {
      reviews: { assignments: Record<string, unknown>[] }[];
    };
    forgedPackage.reviews[0]!.assignments[0]!.generationIdentity = {
      provider: 'forged', model: 'forged', role: 'generator', pipe: 'forged',
      effort: 'forged', contributionLineage: 'forged', assignment: 'forged',
    };
    const forgedPackagePath = path.join(dir, 'owner-review-package-forged.json');
    writeFileSync(forgedPackagePath, JSON.stringify(forgedPackage));
    expect(() => loadProductionOwnerReviewPackage(forgedPackagePath))
      .toThrow(/OWNER_REVIEW_GENERATION_IDENTITY_CALLER_FORBIDDEN/);
    const predictedPackage = JSON.parse(JSON.stringify(reviewPackage)) as {
      reviews: { assignments: Record<string, unknown>[]; evidence?: Record<string, unknown>[] }[];
    };
    predictedPackage.reviews[0]!.assignments[0]!.sourceCandidateArtifactDigest = D('f');
    const predictedPackagePath = path.join(dir, 'owner-review-package-predicted.json');
    writeFileSync(predictedPackagePath, JSON.stringify(predictedPackage));
    expect(() => loadProductionOwnerReviewPackage(predictedPackagePath))
      .toThrow(/OWNER_REVIEW_GENERATED_BINDING_CALLER_FORBIDDEN/);
    delete predictedPackage.reviews[0]!.assignments[0]!.sourceCandidateArtifactDigest;
    predictedPackage.reviews[0]!.assignments[0]!.crossModalArtifact = {
      callerAuthored: true,
    };
    writeFileSync(predictedPackagePath, JSON.stringify(predictedPackage));
    expect(() => loadProductionOwnerReviewPackage(predictedPackagePath))
      .toThrow(/OWNER_REVIEW_CROSS_MODAL_ARTIFACT_CALLER_FORBIDDEN/);
    delete predictedPackage.reviews[0]!.assignments[0]!.crossModalArtifact;
    predictedPackage.reviews[0]!.evidence = [];
    writeFileSync(predictedPackagePath, JSON.stringify(predictedPackage));
    expect(() => loadProductionOwnerReviewPackage(predictedPackagePath))
      .toThrow(/OWNER_REVIEW_PACKAGE_SHAPE_INVALID/);
    const missingAudioPackage = JSON.parse(JSON.stringify(reviewPackage)) as {
      reviews: { assignments: { requiredModalities: string[] }[] }[] };
    missingAudioPackage.reviews[0]!.assignments[0]!.requiredModalities = ['visual', 'motion', 'interaction'];
    writeFileSync(predictedPackagePath, JSON.stringify(missingAudioPackage));
    expect(() => loadProductionOwnerReviewPackage(predictedPackagePath).assertManifestCoverage(manifest))
      .toThrow(/OWNER_REVIEW_REQUIRED_AUDIO_MODALITY_MISSING/);
    expect(specialist.requestCount()).toBe(0);
    expect(holistic.requestCount()).toBe(0);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(executionPath, JSON.stringify(executionInput));
    writeFileSync(packagePath, JSON.stringify(reviewPackage));
    const generatorKey = 'spawn-generator-seat-key';
    const specialistKey = 'spawn-specialist-seat-key';
    const holisticKey = 'spawn-holistic-seat-key';
    const subscribed = (seatId: string, key: string, model: string) => ({
      seat: { seatId, seatDigest: sha256Hex(key), surface: 'openai-direct' },
      identity: { provider: 'openai', model, effort: 'high' }, surface: 'openai-direct',
      endpointDigest: digestCampaignProviderEndpoint('https://api.openai.com/v1'),
      funding: { mode: 'subscription-seat', quotaSurface: 'subscription-seat', seatDigest: sha256Hex(key),
        resourceBudgetDigest: D('1'),
        quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 } },
      remaining: { providerCalls: 128, inputTokens: 5_000_000, outputTokens: 2_000_000, activeSeconds: 43_200 } });
    const capacities = {
      'gen-seat': {
        seat: { seatId: 'gen-seat', seatDigest: sha256Hex(generatorKey), surface: 'cliproxy-seat' },
        identity: { provider: 'google', model: 'gemini-3.6-flash-high', effort: 'medium' },
        surface: 'cliproxy-seat', endpointDigest: digestCampaignProviderEndpoint(generator.baseUrl),
        funding: { mode: 'subscription-seat', quotaSurface: 'cliproxy-seat', seatDigest: sha256Hex(generatorKey),
          resourceBudgetDigest: D('1'),
          quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 } },
        remaining: { providerCalls: 128, inputTokens: 5_000_000, outputTokens: 2_000_000, activeSeconds: 43_200 } },
      'dream-seat': subscribed('dream-seat', 'unused-dream-key', 'gpt-5.6-sol'),
      'holistic-review': {
        seat: { seatId: 'holistic-review', seatDigest: sha256Hex(holisticKey), surface: 'cliproxy-seat' },
        identity: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'high' },
        surface: 'cliproxy-seat',
        endpointDigest: digestCampaignProviderEndpoint(holistic.baseUrl),
        funding: { mode: 'subscription-seat', quotaSurface: 'cliproxy-seat', seatDigest: sha256Hex(holisticKey),
          resourceBudgetDigest: D('1'),
          quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 } },
        remaining: { providerCalls: 128, inputTokens: 5_000_000, outputTokens: 2_000_000, activeSeconds: 43_200 } },
      'specialist-review': { seat: { seatId: 'specialist-review', seatDigest: sha256Hex(specialistKey), surface: 'kimi-cliproxy' },
        identity: { provider: 'kimi', model: 'kimi-k3', effort: 'low' }, surface: 'kimi-cliproxy',
        endpointDigest: digestCampaignProviderEndpoint(specialist.baseUrl.replace('/v1', '/kimi/v1')),
        funding: { mode: 'subscription-seat', quotaSurface: 'cliproxy-seat', seatDigest: sha256Hex(specialistKey),
          resourceBudgetDigest: D('1'), quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 } },
        remaining: { providerCalls: 128, inputTokens: 5_000_000, outputTokens: 2_000_000, activeSeconds: 43_200 } },
    };
    const pinnedRoot = path.join(dir, '.sinter');
    const pinnedTrustDir = path.join(pinnedRoot, 'wave8-authority');
    mkdirSync(pinnedTrustDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(pinnedTrustDir, 'trust.json'), readFileSync(live.trustStorePath), { mode: 0o600 });
    bootstrapHostAuthority({ rootDir: path.join(pinnedRoot, 'executor-authority') });
    try {
      const run = await execFileAsync(process.execPath, ['bin/sinter', 'compose', '--campaign-manifest', manifestPath,
        '--campaign-execution', executionPath, '--owner-review-package', packagePath,
        '--gallery', gallery, '--output', output], {
        cwd: repoRoot, timeout: 150_000, maxBuffer: 2_000_000,
        env: { ...process.env, NODE_ENV: 'production', HOME: dir, SINTER_PROJECT_ROOT: dir, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: browser ?? path.join(dir, 'no-chromium'),
          LIMINAL_ALLOW_LOCALHOST_LLM: 'true',
          SINTER_LLM_THINKING_EFFORT: 'medium',
          SINTER_LLM_BASE_URL: generator.baseUrl, SINTER_LLM_MODEL: 'gemini-3.6-flash-high',
          SINTER_LLM_API_KEY: generatorKey,
          SINTER_WAVE8_LIVE_EXECUTION_CONFIG: live.configPath,
          SINTER_WAVE8_LIVE_TRUST_STORE: path.join(pinnedTrustDir, 'trust.json'),
          SINTER_EXECUTOR_AUTHORITY_ROOT: path.join(dir, 'authority'), SINTER_CAMPAIGN_SIGNING_KEY: campaignKeyPath,
          SINTER_CAMPAIGN_KEY_ID: 'campaign-key', SINTER_CAMPAIGN_ADMISSION_LEDGER: path.join(dir, 'campaign-ledger'),
          SINTER_CAMPAIGN_CAPACITY_JSON: JSON.stringify(capacities), SINTER_METERED_PRICE_RECEIPT_DIGEST: D('f'),
          SINTER_METERED_APPROVED_USD_CEILING: '10', SINTER_CAMPAIGN_SEAT_KEY_SPECIALIST_REVIEW: specialistKey,
          // The path keeps Kimi's provider identity while the wire adapter remains OpenAI-compatible.
          SINTER_CAMPAIGN_SEAT_BASE_URL_SPECIALIST_REVIEW: specialist.baseUrl.replace('/v1', '/kimi/v1'),
          SINTER_CAMPAIGN_SEAT_KEY_HOLISTIC_REVIEW: holisticKey,
          SINTER_CAMPAIGN_SEAT_BASE_URL_HOLISTIC_REVIEW: holistic.baseUrl } });
      const browserDiagnostic = /^(\[browser-preflight\]|\[HeadlessRenderer\]|\s+at |\s+\[cause\]: Error: \[browser-preflight\]|\}$)/;
      const sandboxDiagnostic = process.env.LIMINAL_DISABLE_SANDBOX === 'true'
        ? /^\[SandboxConfig\] Chrome sandbox is disabled\./
        : /^\[SandboxConfig\] Chromium has no usable OS sandbox on this host, so it runs unsandboxed\./;
      expect(run.stderr.split('\n')
        .filter((line) => line.trim() && !browserDiagnostic.test(line) && !sandboxDiagnostic.test(line))).toEqual([]);
      expect(run.stderr.match(/\[HeadlessRenderer\] Failed to initialize browser/g)?.length ?? 0).toBe(browser ? 0 : 1);
      expect(run.stdout).toContain('Owner review: file:');
      const candidates = path.join(output, 'campaign-candidates');
      expect(['brief-a', 'brief-b', 'brief-c'].flatMap((brief) => [1, 2, 3].map((ordinal) =>
        path.join(candidates, `${brief}--${brief}-candidate-${ordinal}.html`))).every(existsSync)).toBe(true);
      expect(['brief-a', 'brief-b', 'brief-c'].every((brief) => existsSync(path.join(candidates, `${brief}.manifest.json`)))).toBe(true);
      const handles = JSON.parse(readFileSync(path.join(output, 'campaign-owner-review-handles.json'), 'utf8')) as unknown[];
      expect(handles).toHaveLength(3);
      const actual = JSON.parse(readFileSync(path.join(candidates, 'brief-a.manifest.json'), 'utf8')) as
        CampaignActualCandidateManifest;
      const published = JSON.parse(readFileSync(path.join(reviewDir, 'packets', `${sha256Hex('brief-a')}.json`),
        'utf8')) as { packet: OwnerReviewPacket };
      const firstActual = actual.candidates[0]!;
      const firstPacket = published.packet.candidates[0]!;
      const source = firstPacket.evidence.find((item) => item.evidenceClass === 'source')!;
      expect(source.artifactDigest).toBe(firstActual.artifact.artifactDigest);
      expect(Buffer.from(source.payloadUri.split(',')[1]!, 'base64').toString())
        .toBe(campaignActualSource(firstActual.artifact.layers));
      const runtimeClasses = ['temporal', 'interaction', 'runtime', 'clock', 'accessibility'] as const;
      const sealedClasses = [...new Set(firstPacket.evidence.map((item) => item.evidenceClass))];
      expect(sealedClasses).toEqual(expect.arrayContaining(['source', 'visual', 'audio', ...(browser ? ['runtime'] : [])]));
      expect(sealedClasses.length > 3).toBe(Boolean(browser));
      expect(firstPacket.evidence.find((item) => item.evidenceClass === 'audio')?.mimeType)
        .toBe('audio/wav');
      expect(firstPacket.evidence.every((item) => item.artifactDigest === firstActual.artifact.artifactDigest))
        .toBe(true);
      expect(firstPacket.inconclusiveReasons).toContain('model-review-audio-payload-withheld');
      expect(firstPacket.inconclusiveReasons.join(' ')).not.toMatch(/planned-from-brief|static-text-scan/);
      expect(firstPacket.inconclusiveReasons.includes('render-infrastructure-unavailable')).toBe(!browser);
      for (const evidenceClass of runtimeClasses) {
        const sealed = firstPacket.evidence.filter((item) => item.evidenceClass === evidenceClass);
        for (const item of sealed) expect(item.ref).toMatch(/\.capture\./);
        expect(firstPacket.prohibitedClaims.includes(evidenceClass)).toBe(sealed.length === 0);
        expect(firstPacket.inconclusiveReasons.includes(`${evidenceClass}-not-captured-from-candidate`))
          .toBe(sealed.length === 0);
      }
      expect(specialist.requestCount()).toBe(9);
      expect(holistic.requestCount()).toBe(9);
      expect(specialist.audioPayloadRequestCount()).toBe(0);
      expect(holistic.audioPayloadRequestCount()).toBe(0);
      expect(Math.max(specialist.maxRequestBytes(), holistic.maxRequestBytes())).toBeLessThan(200_000);
      expect(generator.requestCount()).toBe(9);
      expect(existsSync(path.join(dir, 'authority', 'trust-key.json'))).toBe(false);
      expect(['brief-a', 'brief-b', 'brief-c'].every((brief) => existsSync(path.join(reviewDir, `${brief}.html`)))).toBe(true);
      const checkpoint = JSON.parse(readFileSync(path.join(output, 'campaign-evidence-checkpoint.json'), 'utf8')) as {
        originPending: boolean; receipts: unknown[] };
      expect(checkpoint.originPending).toBe(true);
      expect(checkpoint.receipts).toHaveLength(24);
      expect(existsSync(path.join(output, 'campaign-release-root.json'))).toBe(false);
    } catch (error) {
      throw new Error(`spawned campaign failed after ${generator.requestCount()} generator requests`, { cause: error });
    } finally {
      await Promise.all([generator.close(), specialist.close(), holistic.close()]);
      live.cleanup();
    }
  }, 180_000);

  it('production bootstrap installs the sole active host without the test seam', () => {
    expect(() => bootstrapProductionOwnerReviewHost()).not.toThrow();
    expect(() => bootstrapProductionOwnerReviewHost()).not.toThrow();
  });

  it('production reviewer clients execute Kimi and OpenAI routes with exact signed settlement', async () => {
    const specialistKey = 'production-kimi-seat-key';
    const holisticKey = 'production-openai-seat-key';
    const specialistSeat = 'specialist-review';
    const holisticSeat = 'holistic-review';
    const envNames = {
      receipt: 'SINTER_METERED_PRICE_RECEIPT_DIGEST',
      ceiling: 'SINTER_METERED_APPROVED_USD_CEILING',
      localhost: 'LIMINAL_ALLOW_LOCALHOST_LLM',
      specialistKey: `SINTER_CAMPAIGN_SEAT_KEY_${specialistSeat.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
      specialistUrl: `SINTER_CAMPAIGN_SEAT_BASE_URL_${specialistSeat.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
      holisticKey: `SINTER_CAMPAIGN_SEAT_KEY_${holisticSeat.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
      holisticUrl: `SINTER_CAMPAIGN_SEAT_BASE_URL_${holisticSeat.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
    } as const;
    const previous = Object.fromEntries(Object.values(envNames).map(name => [name, process.env[name]]));
    process.env[envNames.receipt] = D('f');
    process.env[envNames.ceiling] = '1';
    process.env[envNames.localhost] = 'true';
    process.env[envNames.specialistKey] = specialistKey;
    process.env[envNames.specialistUrl] = 'http://127.0.0.1:18431/v1';
    process.env[envNames.holisticKey] = holisticKey;
    process.env[envNames.holisticUrl] = 'https://api.openai.com/v1';
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string;
        messages: readonly { role: string; content: string }[] };
      const user = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as {
        evidencePacket: { candidates: OwnerReviewPacket['candidates'] }; blindId: string };
      const candidate = user.evidencePacket.candidates.find(item => item.blindId === user.blindId)!;
      const anchor = candidate.evidence[0]!.digest;
      const content = JSON.stringify({ verdict: 'pass',
        scores: (['coherence', 'specificity', 'surprise', 'emotionalTemporalArc',
          'crossModalCausality', 'intentionality', 'revisitDesire'] as const).map(dimension =>
          ({ dimension, score: 4, evidenceDigests: [anchor] })),
        finding: { text: 'Production client verified evidence', evidenceDigests: [anchor] },
        criticalFlaws: [], disagreement: [] });
      return new Response(JSON.stringify({ model: body.model,
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 4 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    });
    dnsFixture.enabled = true;
    vi.stubGlobal('fetch', transport);
    bootstrapProductionOwnerReviewHost(testExecutorFactory(dir));
    try {
      const fixture = await buildParityFixture(dir, 'campaign-production-clients',
        'Production client settlement.', {
          specialist: { provider: 'kimi', model: 'kimi-k3' },
          holistic: { provider: 'openai', model: 'gpt-5.4' },
        }, { specialistKey, holisticKey });
      const result = fixture.reviewResult;
      expect(result.bundle.candidates.every(candidate => candidate.reviews.length === 2)).toBe(true);
      const completionCalls = transport.mock.calls.filter(([, init]) => Boolean(init?.body));
      expect(completionCalls).toHaveLength(result.bundle.candidates.length * 2);
    } finally {
      vi.unstubAllGlobals();
      dnsFixture.enabled = false;
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  // Build a complete owner-review fixture: candidate manifest, matching campaign
  // manifest (artifact digests aligned), blind-review session, evidence, and
  // provider-bound independent specialist+holistic reviewers. Both CLI and
  // Studio surfaces consume the same fixture through the shared lifecycle.
  async function buildParityFixture(root: string, campaignRunId: string, intent: string,
    reviewRoutes: { specialist: { provider: 'google' | 'kimi' | 'openai'; model: string };
      holistic: { provider: 'anthropic' | 'openai'; model: string } } = {
      specialist: { provider: 'google', model: 'gemini-3.1-pro-low' },
      holistic: { provider: 'anthropic', model: 'claude-review' },
    }, production?: { readonly specialistKey: string; readonly holisticKey: string },
    behavior: { readonly surface?: 'cli' | 'studio'; readonly swapCandidateSet?: boolean;
      readonly unawaitedLifecycle?: boolean; readonly unawaitedLifecycleRejects?: boolean;
      readonly asyncOwnerReviews?: boolean } = {}) {
    const candidateManifest = await buildCandidateManifest(intent, {});
    const candidates = candidateManifest.candidates;
    const briefId = 'brief-parity';
    const requiredEvidenceClasses = ['source', 'visual', 'temporal', 'interaction', 'runtime', 'clock', 'accessibility'] as const;
    const evidenceScheduleDigest = createHash('sha256').update(stableString(requiredEvidenceClasses)).digest('hex');
    // The v3 slot freezes capture policy only; actual output bytes are bound below.
    const { privateKey: campaignPrivateKey } = generateKeyPairSync('ed25519');
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: async () => ({ id: `res-${campaignRunId}`, status: 'reserved' as const }),
      campaignAuthority: createCampaignAuthority({ keyId: `parity-host-${campaignRunId}`,
        privateKeyPem: campaignPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        admissionStore: new InMemoryCampaignAdmissionStore() }),
      campaignPreflight: async () => ({ releaseHead: 'a'.repeat(40), sourceFingerprint: D('b'),
        schemaDigest: D('c'), implementationDigest: D('d'), wave8ReleaseRootDigest: D('e') }),
    });
    // Build campaign manifest with artifact+source digests aligned to the session.
    const slots = candidates.map((src, index) => {
      const candidateId = src.id;
      const body = { campaignRunId, briefId, candidateId, nodeId: `node-${index}`,
        audioRequirement: 'not-applicable' as const,
        requiredEvidenceClasses, evidenceScheduleDigest };
      return { id: candidateId, graphNodeIds: [`node-${index}`],
        ownerEvidence: { ...body, slotDigest: createHash('sha256').update(stableString(body)).digest('hex') } };
    });
    const campaignManifest = createCampaignManifest({
      campaignRunId, owner: { authorityId: 'owner-parity', selectionMethod: 'host-sealed' },
      briefs: [{ id: briefId, sealedBriefDigest: createHash('sha256').update(intent).digest('hex'),
        unseenAt: '2026-08-01T00:00:00.000Z', exampleFree: true,
        candidateSlots: [...slots].reverse() }],
      transfer: { mode: 'sealed-brief', sealedBriefDigest: D('4'),
        unseenAt: '2026-08-01T00:00:00.000Z', treatmentControlAllocation: 'treatment-first',
        routeDigest: D('5'), randomSourceDigest: D('6'), evidenceScheduleDigest: D('7'),
        nonOverlapDigest: D('b') },
      rolesDigest: D('8'), executorRequirementsDigest: D('c'),
      evidenceModalitiesDigest: D('d'), ownerCheckpointsDigest: D('e'),
      qualityRubricVersion: 'v1', randomSourceDigest: D('9'),
      evidenceScheduleDigest: D('a'), requiredReviewStageIds: slots.flatMap((slot) => [
        `specialist-review-${briefId}-${slot.id}`, `holistic-review-${briefId}-${slot.id}`,
      ]),
      stopStates: ['complete'], ceilings: { providerCalls: 128, inputTokens: 6_000_000,
        outputTokens: 2_000_000, activeMinutes: 2_400 },
    });
    // Build plan with matching route freeze.
    const sg: CampaignSlotGraph[] = campaignManifest.briefs.flatMap((b) =>
      b.candidateSlots.map((s, candidateIndex) => {
        const graph = slotGraph(s.id, [...s.graphNodeIds], {
          creativeThesis: compileCreativeThesis(`${intent} candidate ${candidateIndex + 1}`),
          renderGate: false,
        });
        for (const node of graph.nodes) {
          node.layer = { domain: 'p5',
            prompt: `${intent} candidate-slot ${s.id} stage-node ${node.id}` };
        }
        return { briefId: b.id, candidateSlotId: s.id, graph };
      }));
    const specialistSeat = 'specialist-review';
    const holisticSeat = 'holistic-review';
    const rf: CampaignRouteFreeze = {
      routes: [
        { role: 'generator', seatId: 'gen-seat', provider: 'openai', model: 'kimi-k3', seed: D('g1'), retryBudget: 1 },
        { role: 'harness', seatId: 'dream-seat', provider: 'openai', model: 'kimi-k3', seed: D('d1'), retryBudget: 1 },
        { role: 'evaluator', seatId: specialistSeat, ...reviewRoutes.specialist, seed: D('r1'), retryBudget: 1 },
        { role: 'evaluator', seatId: holisticSeat, ...reviewRoutes.holistic, seed: D('r2'), retryBudget: 1 },
      ],
      transportBudgets: {
        recovery: { retries: 1, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' },
        revision: { retries: 0, fallbacks: 0, toolTurns: 1, primaryMode: 'generate' },
        'transfer-treatment': { retries: 0, fallbacks: 1, toolTurns: 0, primaryMode: 'generate' },
        review: { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' },
      },
      transferTargetDigest: D('c'),
      diversityDimensions: [
        { id: 'conceptual', description: 'distinct governing concept' },
        { id: 'structural', description: 'distinct graph topology' },
        { id: 'temporal', description: 'distinct clock/phase behavior' },
      ],
      candidateDiversity: campaignManifest.briefs[0]!.candidateSlots.map((s, ci) => ({
        briefId, candidateSlotId: s.id,
        thesisDigest: campaignCreativeThesisDigest(
          sg.find((item) => item.candidateSlotId === s.id)!.graph.creativeThesis!,
        ),
        dimensions: { conceptual: `${briefId}-concept-${ci}`,
          structural: `${briefId}-structure-${ci}`, temporal: `${briefId}-time-${ci}` },
      })),
    };
    const plan = buildCampaignExecutionPlan(campaignManifest, sg, rf);
    // Funding and admission.
    const fundingAuthorityInstance = bootstrappedFundingAuthority(root, rf, 128, production ? {
      [specialistSeat]: production.specialistKey, [holisticSeat]: production.holisticKey,
    } : {});
    const reviewContent = ({ userPrompt }: { readonly userPrompt: string }) => {
      const request = JSON.parse(userPrompt) as {
        readonly evidencePacket: { readonly candidates: OwnerReviewPacket['candidates'] };
        readonly blindId: string };
      const candidate = request.evidencePacket.candidates.find((item) => item.blindId === request.blindId)!;
      const anchor = candidate.evidence[0]!.digest;
      return JSON.stringify({ verdict: 'pass',
        scores: (['coherence', 'specificity', 'surprise', 'emotionalTemporalArc',
          'crossModalCausality', 'intentionality', 'revisitDesire'] as const).map((dimension) =>
          ({ dimension, score: 4, evidenceDigests: [anchor] })),
        finding: { text: 'Verified exact evidence', evidenceDigests: [anchor] },
        criticalFlaws: [], disagreement: [] });
    };
    const service = new CampaignService(coordinator, { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: fundingAuthorityInstance,
      executorAuthorityFactory: testExecutorFactory(root) });
    const campaignAdmission = await service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: campaignRunId }, campaignManifest, plan,
    );
    const registry = bootstrapHostAuthority({ rootDir: root }).registry;
    const executorAuthorityRoot = process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
    delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
    let generators: Array<{ candidateSlotId: string; nodeId: string;
      client: ReturnType<typeof providerClient> }>;
    try {
      generators = plan.stages.filter((item) => item.kind === 'generation').map((stage, index) => {
        const allocation = campaignAdmission.fundingReservation.subject.allocations
          .find((item) => item.stageId === stage.id)!;
        return { candidateSlotId: stage.candidateSlotId, nodeId: stage.nodeId,
          client: providerClient(allocation, registry,
            `${root}/${campaignRunId}/generator-${index}`) };
      });
    } finally {
      if (executorAuthorityRoot === undefined) delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
      else process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = executorAuthorityRoot;
    }
    await registerAllGenerators();
    const p5 = generatorRegistry.getAll().find((entry) => entry.name === 'p5')!;
    vi.spyOn(p5, 'generate').mockImplementation(async (prompt) => {
      const generator = generators.find((item) =>
        prompt.includes(`candidate-slot ${item.candidateSlotId}`)
          && prompt.includes(`stage-node ${item.nodeId}`));
      if (!generator) throw new Error('parity generator could not identify its node stage');
      return (await generator.client.client.generate('parity-generator', prompt)).code;
    });
    const specialist = production ? undefined : providerClient(campaignAdmission.fundingReservation.subject.allocations
      .find((item) => item.stageId.startsWith('specialist-review-'))!, registry,
    `${root}/${campaignRunId}/specialist`, false, 'evaluator', reviewContent);
    const holistic = production ? undefined : providerClient(campaignAdmission.fundingReservation.subject.allocations
      .find((item) => item.stageId.startsWith('holistic-review-'))!, registry,
    `${root}/${campaignRunId}/holistic`, false, 'evaluator', reviewContent);
    if (specialist && holistic) bootstrapTestOwnerReviewHost(specialist.client, holistic.client);
    let actualManifest: CampaignActualCandidateManifest | undefined;
    let ownerAdmission: ReturnType<CampaignService['admitOwnerReview']> | undefined;
    let session: BlindReviewSession | undefined;
    let evidence: OwnerCaptureInputs[] | undefined;
    let evidenceJudgments: BlindReviewJudgment[] | undefined;
    let reviewResult: OwnerReviewLifecycleResult | undefined;
    const captureKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const envelopeKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const captureAuthority = createCaptureAuthority({ keyId: 'capture-parity',
      privateKeyPem: captureKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const envelopeAuthority = createEnvelopeAuthority({ keyId: 'envelope-parity',
      privateKeyPem: envelopeKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const store: OwnerReviewPacketStore = {
      putIfAbsent: vi.fn(async (pkt: OwnerReviewPacket) => ({ packet: pkt, created: true })),
      compareAndSwap: vi.fn(),
    };
    const renderer = new ManagedOwnerReviewRenderer({ readyTimeoutMs: 10_000 });
    const reviewRenderer: OwnerReviewPacketRenderer = behavior.unawaitedLifecycle
      ? { render: async (packet) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (behavior.unawaitedLifecycleRejects) throw new Error('DELAYED_OWNER_RENDER_FAILED');
        return renderer.render(packet);
      }, close: () => renderer.close() }
      : renderer;
    let productAdmission = campaignAdmission;
    try {
      const governed = {
        input: { schema: 'sinter.campaign-execution-input' as const,
          schemaVersion: 1 as const, slotGraphs: sg },
        ownerReviewBriefIds: [briefId],
        ownerReviews: (activeAdmission: CampaignRunAdmission,
          manifests: readonly CampaignActualCandidateManifest[]) => {
        actualManifest = manifests[0];
        ownerAdmission = service.admitOwnerReview(activeAdmission, campaignManifest, manifests);
        const reviewManifest = behavior.swapCandidateSet ? { ...actualManifest,
          candidates: actualManifest.candidates.map((candidate, index) => index === 0
            ? (() => { const html = `${candidate.artifact.html}<!-- swapped -->`; return { ...candidate,
              artifact: { ...candidate.artifact, html,
                artifactDigest: createHash('sha256').update(html).digest('hex') } }; })()
            : candidate) } : actualManifest;
        const sourceByCandidate = new Map(reviewManifest.candidates.map((candidate) =>
          [candidate.id, campaignActualSource(candidate.artifact.layers)] as const));
        const assignments = reviewManifest.candidates.map((candidate, index) => ({
          candidateId: candidate.id, sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
          requiredModalities: ['visual'] as const, generationIdentity: {
            role: 'generator' as const, provider: `gen-provider-${index}`,
            model: `gen-model-${index}`, pipe: `gen-pipe-${index}`,
            effort: `gen-effort-${index}`, contributionLineage: `gen-lineage-${index}`,
            assignment: `gen-assignment-${index}` },
        }));
        session = createBlindReviewSession(reviewManifest, assignments);
        evidence = session.packet.candidates.map((candidate, index) => ({
          source: { ref: `${candidate.blindId}.source`, mimeType: 'text/plain',
            payload: sourceByCandidate.get(reviewManifest.candidates[index]!.id)! },
          timeSamples: [{ ref: `${candidate.blindId}.t0`, mimeType: 'text/plain', payload: 'frame-0' }],
          interactionTrace: { ref: `${candidate.blindId}.ia`, mimeType: 'text/plain', payload: 'click' },
          runtimeState: { ref: `${candidate.blindId}.rt`, mimeType: 'application/json', payload: '{"ready":true}' },
          clockEvents: { ref: `${candidate.blindId}.clk`, mimeType: 'text/plain', payload: '0,1' },
          accessibility: { ref: `${candidate.blindId}.a11y`, mimeType: 'text/plain', payload: 'contrast:pass' },
          knownFailures: [] as readonly string[], hardFloorFailures: [] as readonly string[],
        }));
        evidenceJudgments = session.packet.candidates.map((candidate) => ({
          blindId: candidate.blindId, outcome: 'pass' as const, claims: [],
        }));
        return [{
          campaign: { manifest: campaignManifest,
            fundingReservation: activeAdmission.fundingReservation },
          admission: ownerAdmission, briefId, session, evidence, evidenceJudgments,
          captureAuthority, envelopeAuthority, store, renderer: reviewRenderer,
        }];
      } };
      const request = { entryPoint: behavior.surface === 'studio'
        ? 'studio-layers' as const : 'cli-compose' as const, requestKey: campaignRunId };
      if (behavior.unawaitedLifecycle) {
        let escaped: Promise<OwnerReviewLifecycleResult> | undefined;
        await service.runGovernedCampaign(campaignAdmission, campaignManifest, governed.input,
          { ...request, entryPoint: 'cli-compose' }, async (manifests) => {
            const [input] = governed.ownerReviews(campaignAdmission, manifests);
            escaped = service.runOwnerReview('cli', campaignAdmission, input!);
            return [{ briefId,
              packetDigest: createHash('sha256').update('unawaited-packet').digest('hex'),
              reviewBundleDigest: createHash('sha256').update('unawaited-bundle').digest('hex') }];
          });
        if (!escaped) throw new Error('unawaited lifecycle was not started');
        reviewResult = await escaped;
      } else {
        const journeyGoverned = behavior.asyncOwnerReviews ? { ...governed,
          ownerReviews: async (activeAdmission: CampaignRunAdmission,
            manifests: readonly CampaignActualCandidateManifest[]) => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return governed.ownerReviews(activeAdmission, manifests);
          } } : governed;
        const journey = behavior.surface === 'studio'
          ? await runGovernedCampaignStudioJourney(service, request, campaignManifest, plan, journeyGoverned,
            () => undefined)
          : await runCampaignCliJourney(service, request, campaignManifest, plan, journeyGoverned,
            () => undefined);
        productAdmission = journey.admission;
        reviewResult = journey.ownerReviews[0];
      }
    } finally {
      await renderer.close();
    }
    if (!actualManifest || !ownerAdmission || !session || !evidence || !evidenceJudgments || !reviewResult) {
      throw new Error('parity campaign did not produce owner evidence');
    }
    return { service, campaignAdmission: productAdmission, campaignManifest, ownerAdmission, actualManifest, briefId,
      session, evidence, evidenceJudgments, captureAuthority, envelopeAuthority,
      store, reviewResult, reviewTransports: specialist && holistic
        ? [specialist.generate, holistic.generate] as const : [] as const };
  }

  it('both surfaces reach the shared owner-review lifecycle and return a live handle (non-mock)', async () => {
    // Each surface needs its own session (seal consumes the blind-review
    // submission). Both fixtures use the same intent and shape.
    const cliFixture = await buildParityFixture(dir, 'campaign-parity-cli',
      'A luminous field whose motion follows a musical pulse and one accessible control.');
    const studioFixture = await buildParityFixture(dir, 'campaign-parity-studio',
      'A luminous field whose motion follows a musical pulse and one accessible control.', undefined,
      undefined, { surface: 'studio' });
    const cliResult = cliFixture.reviewResult;
    const studioResult = studioFixture.reviewResult;
      // Both surfaces reach the lifecycle: surface tag, sealed bundle, live handle.
      expect(cliResult.surface).toBe('cli');
      expect(studioResult.surface).toBe('studio');
      expect(cliResult.bundle.signatureBase64).not.toBe('');
      expect(studioResult.bundle.signatureBase64).not.toBe('');
      // Live handles: the managed renderer spawned a real HTTP server on loopback.
      expect(cliResult.handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(studioResult.handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(() => assertOwnerReviewAdmission(cliFixture.ownerAdmission))
        .toThrow('OWNER_REVIEW_ADMISSION_NOT_HOST_ISSUED');
      expect(() => assertOwnerReviewAdmission(studioFixture.ownerAdmission))
        .toThrow('OWNER_REVIEW_ADMISSION_NOT_HOST_ISSUED');
      // Identity independence: provider is distinct between specialist and holistic.
      const specialistProvider = cliResult.bundle.candidates[0]?.reviews[0]?.attestation.provider;
      const holisticProvider = cliResult.bundle.candidates[0]?.reviews[1]?.attestation.provider;
      expect(specialistProvider).not.toBe(holisticProvider);
      // Claim coverage: every score cites at least one evidence digest.
      for (const candidate of cliResult.bundle.candidates) {
        for (const review of candidate.reviews) {
          for (const score of review.scores) {
            expect(score.evidenceDigests.length).toBeGreaterThan(0);
          }
        }
      }
  });

  it('keeps legacy owner evidence inconclusive for withheld audio and keeps limitations the capturer reported', async () => {
    const manifest = createCampaignManifest(manifestInput('campaign-parity-v1-audio'));
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const admission = generationOnlyAdmission(plan);
    const actuals = manifest.briefs.map((brief): CampaignActualCandidateManifest => ({
      schema: 'sinter.campaign-actual-candidate-manifest', schemaVersion: 1,
      campaignRunId: manifest.campaignRunId, manifestDigest: manifest.manifestDigest, briefId: brief.id,
      candidates: brief.candidateSlots.map((slot) => ({ id: slot.id, briefId: brief.id,
        slotDigest: slot.ownerEvidence.slotDigest, graphDigest: D('e'), graphNodeIds: slot.graphNodeIds,
        thesisDigest: D('f'), diversity: {}, artifact: { html: '<main>candidate</main>',
          artifactDigest: campaignActualArtifactDigest('<main>candidate</main>'),
          sourceDigest: campaignActualSourceDigest([]), layers: [], successCount: 0, layerCount: 0 } })),
    }));
    const capture = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const envelope = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const capturePath = path.join(dir, 'v1-capture.pem');
    const envelopePath = path.join(dir, 'v1-envelope.pem');
    writeFileSync(capturePath, capture.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    writeFileSync(envelopePath, envelope.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const legacyEvidence = (id: string) => ({
      timeSamples: [{ ref: `${id}.frame`, mimeType: 'text/plain', payload: 'frame-0' }],
      interactionTrace: { ref: `${id}.interaction`, mimeType: 'text/plain', payload: 'click' },
      runtimeState: { ref: `${id}.runtime`, mimeType: 'application/json', payload: '{"ready":true}' },
      clockEvents: { ref: `${id}.clock`, mimeType: 'text/plain', payload: '0,1' },
      accessibility: { ref: `${id}.a11y`, mimeType: 'text/plain', payload: 'contrast:pass' },
      knownFailures: [], hardFloorFailures: [], reviewLimitations: ['capture-stopped-after-two-seconds'],
    });
    const packagePath = path.join(dir, 'v1-owner-package.json');
    writeFileSync(packagePath, JSON.stringify({ schema: 'sinter.owner-review-package', schemaVersion: 1,
      plan, reviews: manifest.briefs.map((brief) => ({ briefId: brief.id,
        assignments: brief.candidateSlots.map((slot) => ({ candidateId: slot.id,
          requiredModalities: ['visual'] })),
        evidence: brief.candidateSlots.map((slot) => legacyEvidence(slot.id)),
        evidenceJudgments: brief.candidateSlots.map((_slot, index) => ({
          blindId: `candidate-${String(index + 1).padStart(3, '0')}`, outcome: 'pass', claims: [] })),
        rendererFilePath: path.join(dir, `${brief.id}-v1-owner-review.html`) })),
      captureKey: { keyId: 'v1-capture', privateKeyPath: capturePath },
      envelopeKey: { keyId: 'v1-envelope', privateKeyPath: envelopePath },
      storeDirectory: path.join(dir, 'v1-packets') }));
    const service = { admitOwnerReview: () => ({}) } as CampaignService;
    const inputs = loadProductionOwnerReviewPackage(packagePath).buildInputs(
      service, admission, manifest, actuals);
    for (const item of inputs.flatMap((input) => input.evidence)) {
      expect(item.reviewLimitations).toEqual(
        ['capture-stopped-after-two-seconds', 'model-review-audio-payload-withheld']);
    }
    const malformed = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      reviews: { evidence: { reviewLimitations: unknown }[] }[] };
    for (const [limitations, error] of [
      ['capture-stopped', 'OWNER_REVIEW_LIMITATIONS_INVALID'],
      [['stopped\u001b[2J'], 'OWNER_REVIEW_LIMITATIONS_INVALID'],
      [['x'.repeat(201)], 'OWNER_REVIEW_LIMITATIONS_INVALID'],
      [Array.from({ length: 65 }, (_, index) => `limit-${index}`), 'OWNER_REVIEW_LIMITATIONS_INVALID'],
    ] as const) {
      malformed.reviews[0]!.evidence[0]!.reviewLimitations = limitations;
      writeFileSync(packagePath, JSON.stringify(malformed));
      expect(() => loadProductionOwnerReviewPackage(packagePath)).toThrow(error);
    }
    (malformed.reviews[0] as { evidence: unknown }).evidence = [null];
    writeFileSync(packagePath, JSON.stringify(malformed));
    expect(() => loadProductionOwnerReviewPackage(packagePath)).toThrow('OWNER_REVIEW_EVIDENCE_INVALID');
  });

  it('seals nothing for a candidate that was never rendered, and names each class it did not observe', async () => {
    const manifest = createCampaignManifest(manifestInput('campaign-derived-evidence'));
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const admission = generationOnlyAdmission(plan);
    const thesis = compileCreativeThesis('a slow tide of light');
    const html = '<main><canvas></canvas></main>';
    const actuals = manifest.briefs.map((brief): CampaignActualCandidateManifest => ({
      schema: 'sinter.campaign-actual-candidate-manifest', schemaVersion: 1,
      campaignRunId: manifest.campaignRunId, manifestDigest: manifest.manifestDigest, briefId: brief.id,
      candidates: brief.candidateSlots.map((slot) => ({ id: slot.id, briefId: brief.id,
        slotDigest: slot.ownerEvidence.slotDigest, graphDigest: D('e'), graphNodeIds: slot.graphNodeIds,
        thesisDigest: campaignCreativeThesisDigest(thesis), diversity: {}, artifact: { html,
          artifactDigest: campaignActualArtifactDigest(html),
          sourceDigest: campaignActualSourceDigest([]), layers: [], successCount: 0, layerCount: 0 } })),
    }));
    const capture = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const envelope = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const capturePath = path.join(dir, 'derived-capture.pem');
    const envelopePath = path.join(dir, 'derived-envelope.pem');
    writeFileSync(capturePath, capture.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    writeFileSync(envelopePath, envelope.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const packagePath = path.join(dir, 'derived-owner-package.json');
    writeFileSync(packagePath, JSON.stringify({ schema: 'sinter.owner-review-package', schemaVersion: 2,
      plan, reviews: manifest.briefs.map((brief) => ({ briefId: brief.id,
        assignments: brief.candidateSlots.map((slot) => ({ candidateId: slot.id,
          requiredModalities: ['visual', 'audio'], creativeThesis: thesis })),
        rendererFilePath: path.join(dir, `${brief.id}-derived-owner-review.html`) })),
      captureKey: { keyId: 'derived-capture', privateKeyPath: capturePath },
      envelopeKey: { keyId: 'derived-envelope', privateKeyPath: envelopePath },
      storeDirectory: path.join(dir, 'derived-packets') }));
    const service = { admitOwnerReview: () => ({}) } as CampaignService;
    const evidence = loadProductionOwnerReviewPackage(packagePath).buildInputs(
      service, admission, manifest, actuals).flatMap((input) => input.evidence);
    expect(evidence.length).toBeGreaterThan(0);
    for (const item of evidence) {
      expect(item.reviewLimitations).toEqual(expect.arrayContaining([
        'model-review-audio-payload-withheld', 'render-infrastructure-unavailable', 'accessibility-not-measured',
      ]));
      expect(item.timeSamples).toBeUndefined();
      expect(item.interactionTrace).toBeUndefined();
      expect(item.runtimeState).toBeUndefined();
      expect(item.clockEvents).toBeUndefined();
      expect(item.accessibility).toBeUndefined();
    }
  });

  it('rejects an unbound owner-review admission before any mismatched campaign can use it', async () => {
    const manifest = createCampaignManifest(manifestInput('campaign-parity-mismatch'));
    const plan = buildCampaignExecutionPlan(manifest, buildGraphs(manifest), routeFreeze());
    const campaignFunding = bootstrappedFundingAuthority(dir, routeFreeze(), 256);
    const service = new CampaignService(new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: async () => ({ id: 'res-parity-mismatch', status: 'reserved' as const }),
    }), { authorityBoundary: unitTestCampaignAuthorityBoundary, fundingAuthority: campaignFunding });
    const admission = await service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: manifest.campaignRunId }, manifest, plan,
    );
    // Build a second campaign with a different reservation using the same authority.
    const otherManifest = createCampaignManifest(manifestInput('campaign-parity-other'));
    const otherPlan = buildCampaignExecutionPlan(otherManifest, buildGraphs(otherManifest), routeFreeze());
    const otherAdmissionCampaign = await service.startCampaign(
      { entryPoint: 'cli-compose', requestKey: otherManifest.campaignRunId },
      otherManifest, otherPlan,
    );
    // Admit owner-review for the OTHER campaign (validly signed, different manifest).
    await campaignFunding.runOwnerReviewScope(async (mint) => {
      const otherOwnerAdmission = mint({
        reservation: otherAdmissionCampaign.fundingReservation, manifest: otherManifest,
        briefIds: otherManifest.briefs.map((b) => b.id),
        candidateSetDigests: otherManifest.briefs.map((brief) => ({
          briefId: brief.id, digest: sha256Hex(brief.id),
        })),
      });
      // Now try to run owner-review for the FIRST campaign admission using the
      // SECOND campaign's owner-review admission. The binding must fail because
      // the owner-review admission's manifest/reservation differ from the first
      // campaign admission's reservation.
      await expect(runCampaignCliOwnerReview(service, admission, {
        campaign: { manifest, fundingReservation: admission.fundingReservation },
        admission: otherOwnerAdmission, briefId: manifest.briefs[0]!.id,
        session: {} as never, evidence: [], evidenceJudgments: [],
        captureAuthority: {} as never, envelopeAuthority: {} as never, store: {} as never,
        renderer: {} as never,
      })).rejects.toThrow(/OWNER_REVIEW_ADMISSION_CANDIDATES_UNSETTLED/);
      await expect(runOwnerReviewLifecycle('studio', service, admission, {
        campaign: { manifest, fundingReservation: admission.fundingReservation },
        admission: otherOwnerAdmission, briefId: manifest.briefs[0]!.id,
        session: {} as never, evidence: [], evidenceJudgments: [],
        captureAuthority: {} as never, envelopeAuthority: {} as never, store: {} as never,
        renderer: {} as never,
      }, undefined as never)).rejects.toThrow(/OWNER_REVIEW_SCOPE_LEASE_NOT_SERVICE_ISSUED/);
    });
  });

  it('rejects a blind session that swaps the settled candidate set', async () => {
    await expect(buildParityFixture(dir, 'campaign-parity-candidate-swap',
      'Candidate bytes stay bound through owner review.', undefined, undefined,
      { swapCandidateSet: true })).rejects.toThrow('OWNER_REVIEW_CANDIDATE_SET_MISMATCH');
  });

  it.each(['cli', 'studio'] as const)('%s journey admits owner review after async evidence capture', async (surface) => {
    const fixture = await buildParityFixture(dir, `campaign-parity-async-capture-${surface}`,
      'Owner evidence is captured from the candidate before review admission.', undefined, undefined,
      { surface, asyncOwnerReviews: true });
    expect(fixture.reviewResult.surface).toBe(surface);
    expect(fixture.reviewResult.packet.briefId).toBe(fixture.briefId);
  });

  it('finishes an unawaited real lifecycle before revoking its service lease', async () => {
    const fixture = await buildParityFixture(dir, 'campaign-parity-unawaited-lifecycle',
      'Owner-review work remains valid until its delayed renderer settles.', undefined, undefined,
      { unawaitedLifecycle: true });
    expect(fixture.reviewResult.packet.briefId).toBe(fixture.briefId);
    expect(() => assertOwnerReviewAdmission(fixture.ownerAdmission))
      .toThrow('OWNER_REVIEW_ADMISSION_NOT_HOST_ISSUED');
  });

  it('fails closed when an unawaited real lifecycle rejects after the callback returns', async () => {
    await expect(buildParityFixture(dir, 'campaign-parity-unawaited-rejection',
      'A delayed owner-review failure must abort campaign completion.', undefined, undefined,
      { unawaitedLifecycle: true, unawaitedLifecycleRejects: true }))
      .rejects.toThrow('DELAYED_OWNER_RENDER_FAILED');
  });

  it('preserves arbitrary-N: lifecycle handles every candidate produced by the candidate manifest', async () => {
    // The candidate manifest produces a natural N candidates. The lifecycle
    // must handle every one with specialist+holistic reviews — no hard-coded N.
    const fixture = await buildParityFixture(dir, 'campaign-parity-arbn',
      'Five distinct generative fields with diverse temporal behavior and accessible controls.');
    const candidateCount = fixture.session.packet.candidates.length;
    expect(candidateCount).toBeGreaterThan(1); // at least 2 candidates
    const result = fixture.reviewResult;
    expect(result.bundle.candidates).toHaveLength(candidateCount);
    expect(result.bundle.candidates.every((c) => c.reviews.length === 2)).toBe(true);
    expect(result.handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('allows a funded Luna evaluator and settles its exact signed completion', async () => {
    const fixture = await buildParityFixture(dir, 'campaign-parity-luna', 'Luna may review.', {
      specialist: { provider: 'openai', model: 'gpt-5.6-luna' },
      holistic: { provider: 'anthropic', model: 'claude-review' },
    });
    expect(fixture.reviewResult.bundle.candidates.every(candidate => candidate.reviews.length === 2)).toBe(true);
    expect(fixture.reviewTransports[0]).toHaveBeenCalledTimes(3);
  });

  it('maps a kimi-cliproxy reviewer consistently and settles exact signed completions', async () => {
    const fixture = await buildParityFixture(dir, 'campaign-parity-kimi', 'Kimi route settlement.', {
      specialist: { provider: 'kimi', model: 'kimi-k3' },
      holistic: { provider: 'anthropic', model: 'claude-review' },
    });
    expect(fixture.reviewResult.bundle.candidates.every(candidate => candidate.reviews.length === 2)).toBe(true);
    expect(fixture.reviewTransports[0]).toHaveBeenCalledTimes(3);
  });
});
