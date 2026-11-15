/**
 * W8C-04 (#717) public-seam attestation-binding tests.
 *
 * Drives the real LLMClient → GenerationAttemptLedger path with a deterministic
 * HarnessTransportAuthority so the per-actual-provider signed completion refs
 * are exercised end to end. Mirrors the W8C-03 acceptance pattern: real client,
 * spy provider, durable ledger. No internals are mocked beyond the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ok, err } from 'neverthrow';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import * as LLMClientModule from '../../../src/llm/LLMClient.js';
import {
  CampaignFundingReservationAuthority,
  digestCampaignProviderEndpoint,
} from '../../../src/creative-run/CampaignExecutionAuthority.js';
import type { CampaignExecutionPlan, CampaignTransportTemplate } from '../../../src/creative-run/CampaignManifest.js';
import { LLMError } from '../../../src/llm/errors.js';
import {
  FileGenerationAttemptPersistence,
  GenerationAttemptLedger,
  MemoryGenerationAttemptPersistence,
} from '../../../src/runtime-core/generationAttemptSink.js';
import { HarnessTransportGuard, type HarnessTransportAuthority } from '../../../src/identity/harnessTransportGuard.js';
import { issueExecutorReservation } from '../../../src/identity/executorReservation.js';
import { ReservationTracker } from '../../../src/identity/executorReservation.js';
import { issueExecutorAttestation, NonceLedger } from '../../../src/identity/executorAttestation.js';
import { subscriptionFunding } from '../../../src/identity/fundingTruth.js';
import {
  buildRegistry,
  CLIPROXY_SURFACE,
  LUNA_MODEL_ID,
  SOL_IDENTITY,
  SOL_SEAT,
  SOL_SUBSCRIPTION_FUNDING,
} from '../identity/helpers.js';
import type { HarnessAttemptContext } from '../../../src/identity/harnessTransportGuard.js';
import type { ProviderRequest, ProviderResponse, StreamEvent } from '../../../src/llm/ProviderTypes.js';
import type { ToolDefinition, ToolResultMessage } from '../../../src/llm/ProviderTypes.js';

/**
 * Build a deterministic authority + LLMClient pair. Every successful transport
 * through this client produces a signed ExecutorAttestationV1 bound to Sol,
 * which the LLMClient surfaces as an ExecutorAttestationRef on results.
 *
 * Quota counters advance on every attestation so the signed delta is non-zero
 * (mirrors the production `bootstrapExecutorAuthority` counter behavior).
 */
function buildAttestingClient(options: {
  reservationsRoot: string;
  generate: (req: ProviderRequest) => Promise<{ ok: true; value: ProviderResponse } | { ok: false; error: LLMError }>;
  fallbackGenerate?: (req: ProviderRequest, model: string) => Promise<{ ok: true; value: ProviderResponse } | { ok: false; error: LLMError }>;
  stream?: (req: ProviderRequest) => AsyncGenerator<StreamEvent>;
  identity?: typeof SOL_IDENTITY;
  role?: 'harness' | 'generator';
  baseUrl?: () => string;
  countAttestations?: { value: number };
}): { client: LLMClient; authority: HarnessTransportAuthority; generateSpy: ReturnType<typeof vi.fn> } {
  const registry = buildRegistry();
  const guard = new HarnessTransportGuard(registry, {
    reservations: new ReservationTracker(join(options.reservationsRoot, 'reservations')),
    nonces: new NonceLedger(join(options.reservationsRoot, 'nonces')),
  });
  let ordinal = 0;
  // Mutable counters — every attestation advances these so signed deltas are
  // non-zero (matches the production counter behavior in executorAuthorityBootstrap).
  let counters = { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 };
  const identity = options.identity ?? SOL_IDENTITY;
  const countAttestations = options.countAttestations ?? { value: 0 };
  const generateSpy = vi.fn(async (req: ProviderRequest) => options.generate(req));
  const fundingFor = () => subscriptionFunding({
    seatDigest: SOL_SEAT.seatDigest, quotaCounters: { ...counters }, quotaSurface: 'cliproxy-seat',
  });
  const authority: HarnessTransportAuthority = {
    guard,
    reserveAttempt: (context: HarnessAttemptContext) => issueExecutorReservation(registry, {
      reservationId: `reservation-${ordinal}`,
      runDigest: 'run', requestDigest: context.requestDigest, routeDigest: context.routeDigest,
      identity: context.resolvedIdentity, seat: SOL_SEAT, funding: fundingFor(),
      surface: CLIPROXY_SURFACE, issuedAt: new Date().toISOString(), nonce: `reservation-nonce-${ordinal++}`,
    }),
    attestCompletion: ({ context, reservation, response }: Parameters<HarnessTransportAuthority['attestCompletion']>[0]) => {
      // Advance the counters on every successful post-transport attestation.
      counters = {
        calls: counters.calls + 1,
        inputTokens: counters.inputTokens + (response.usage?.inputTokens ?? 0),
        outputTokens: counters.outputTokens + (response.usage?.outputTokens ?? 0),
        activeSeconds: counters.activeSeconds + (response.durationMs / 1_000),
      };
      ordinal += 1;
      countAttestations.value += 1;
      return issueExecutorAttestation(registry, {
        attestationId: `attestation-${ordinal}`, runDigest: reservation?.subject.runDigest ?? 'run',
        requestDigest: context.requestDigest, attemptDigest: `attempt-${ordinal}`,
        routeDigest: context.routeDigest, attemptOrdinal: context.attemptOrdinal,
        fallbackOrdinal: context.fallbackOrdinal, retryOrdinal: context.retryOrdinal,
        priorTraceDigest: context.priorTraceDigest, policyTraceDigest: context.policyTraceDigest,
        requestedIdentity: context.requestedIdentity, resolvedIdentity: context.resolvedIdentity,
        effort: context.resolvedIdentity.effort, fallbackChain: context.fallbackChain,
        seat: SOL_SEAT, funding: fundingFor(), quotaSurface: 'cliproxy-seat',
        issuedAt: new Date().toISOString(), nonce: `attestation-nonce-${ordinal}`, surface: CLIPROXY_SURFACE,
        durationMs: response.durationMs, terminalReason: response.terminalReason,
        success: response.success,
        quotaCounterDelta: {
          calls: 1,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          activeSeconds: response.durationMs / 1_000,
        },
      });
    },
  };
  const client = new LLMClient({
    role: options.role ?? 'harness',
    baseUrl: options.baseUrl?.() ?? 'http://localhost:8317/v1',
    provider: identity.provider,
    model: identity.model,
    apiKey: 'sol-seat-secret',
    harnessTransportAuthority: authority,
  });
  vi.spyOn(client as never, 'resolveModel' as never).mockResolvedValue(identity.model as never);
  const transportReservations = new WeakSet<object>();
  const provider = {
    name: 'anthropic',
    getModel: () => identity.model,
    getConfig: () => ({ baseUrl: options.baseUrl?.() ?? 'http://localhost:8317/v1',
      apiKey: 'sol-seat-secret', model: identity.model }),
    reserveTransport: () => {
      const capability = Object.freeze({});
      transportReservations.add(capability);
      return Object.freeze({ capability, provider: identity.provider, model: identity.model,
        baseUrl: options.baseUrl?.() ?? 'http://localhost:8317/v1',
        credentialDigest: createHash('sha256').update('sol-seat-secret').digest('hex') });
    },
    cancelReservedTransport: (reservation: { capability: object }) => {
      transportReservations.delete(reservation.capability);
    },
    generate: generateSpy,
    stream: options.stream,
    supportsToolUse: () => true,
    capabilities: {
      thinking: false, streaming: false, jsonMode: false, toolUse: true,
      maxContextTokens: 4096, thinkingStyle: 'none' as const, streamingStyle: 'sse' as const,
    },
  };
  vi.spyOn(client as never, 'getProvider' as never).mockResolvedValue(provider as never);
  return { client, authority, generateSpy };
}

const SUBMIT_CODE_TOOL: ToolDefinition = {
  name: 'submit_code', description: 'submit code', parameters: { type: 'object', properties: { code: { type: 'string' } } },
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function frozenCampaign(root: string, transports: readonly CampaignTransportTemplate[]) {
  const registry = buildRegistry();
  const funding = subscriptionFunding({ seatDigest: SOL_SEAT.seatDigest,
    quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    quotaSurface: 'cliproxy-seat' });
  const authority = new CampaignFundingReservationAuthority(registry, { resolve: () => ({
    seat: SOL_SEAT, identity: SOL_IDENTITY, funding, surface: CLIPROXY_SURFACE,
    endpointDigest: digestCampaignProviderEndpoint('http://localhost:8317/v1'),
    remaining: { providerCalls: 20, inputTokens: 2_000_000, outputTokens: 2_000_000, activeSeconds: 2_000 },
  }) }, join(root, 'campaign'));
  const routeFreeze = { routes: [{ role: 'generator' as const, seatId: SOL_SEAT.seatId,
    provider: SOL_IDENTITY.provider, model: SOL_IDENTITY.model, seed: 'a'.repeat(64), retryBudget: 4 }],
    transportBudgets: {}, transferTargetDigest: 'b'.repeat(64), diversityDimensions: [], candidateDiversity: [] };
  const body = { schema: 'sinter.campaign-execution-plan' as const, schemaVersion: 1 as const,
    campaignRunId: 'run', manifestDigest: 'c'.repeat(64), routeFreeze,
    routeFreezeDigest: 'd'.repeat(64), slotGraphDigests: [],
    stages: [{ id: 'stage', kind: 'generation' as const, seatId: SOL_SEAT.seatId, transports,
      providerCalls: transports.length, inputTokens: 1_000_000, outputTokens: 1_000_000, activeMinutes: 10 }] };
  const plan: CampaignExecutionPlan = { ...body,
    planDigest: createHash('sha256').update(stable(body)).digest('hex') };
  const reservation = await authority.reserve({ campaignRunId: 'run', plan,
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return { authority, reservation, debit: vi.spyOn(authority, 'debit'), settle: vi.spyOn(authority, 'settle') };
}

describe('W8C-05 campaign funding at the real LLM network boundary', () => {
  it('does not expose the old caller-forgeable campaign context installer', () => {
    expect((LLMClientModule as Record<string, unknown>).withCampaignFundingReservation).toBeUndefined();
  });

  it('accepts the exact Gemini response alias only on cliproxy', async () => {
    const identity = { provider: 'openai', model: 'gemini-3.6-flash-high', effort: 'high' } as const;
    for (const [baseUrl, expectedSuccess] of [
      ['http://localhost:8317/v1', true],
      ['http://localhost:9/v1', false],
      ['https://evil.example/localhost:8317/v1', false],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), 'w8-gemini-alias-'));
      try {
        const { client } = buildAttestingClient({
          reservationsRoot: root,
          role: 'generator',
          identity,
          baseUrl: () => baseUrl,
          generate: async () => ok({
            content: 'generated', model: 'gemini-3.6-flash', success: true,
            usage: { inputTokens: 3, outputTokens: 4 },
          }),
        });
        if (expectedSuccess) {
          await expect(client.generate('system', 'user')).resolves.toMatchObject({ success: true });
          expect(client.getHarnessExecutorProjection().status).toBe('verified');
        } else {
          await expect(client.generate('system', 'user')).rejects.toThrow(/identity-mismatch/);
          expect(client.getHarnessExecutorProjection().status).toBe('blocked');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects reverse and unknown Gemini response aliases at cliproxy', async () => {
    for (const [requestedModel, responseModel] of [
      ['gemini-3.6-flash', 'gemini-3.6-flash-high'],
      ['gemini-3.6-flash-high', 'gemini-3-flash'],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), 'w8-gemini-alias-reject-'));
      try {
        const { client } = buildAttestingClient({
          reservationsRoot: root,
          role: 'generator',
          identity: { provider: 'openai', model: requestedModel, effort: 'high' },
          generate: async () => ok({ content: 'generated', model: responseModel, success: true }),
        });
        await expect(client.generate('system', 'user')).rejects.toThrow(/identity-mismatch/);
        expect(client.getHarnessExecutorProjection().status).toBe('blocked');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('debits and settles public generate and stream paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c05-boundary-'));
    try {
      const streamSpy = vi.fn();
      const { client, generateSpy } = buildAttestingClient({
        reservationsRoot: root, role: 'generator',
        generate: async () => ok({ content: 'generated', model: SOL_IDENTITY.model, success: true,
          usage: { inputTokens: 3, outputTokens: 4 } }),
        stream: async function* () {
          streamSpy();
          yield { type: 'content' as const, content: 'streamed' };
          yield { type: 'done' as const, usage: { inputTokens: 2, outputTokens: 1 } };
        },
      });
      const funded = await frozenCampaign(root, [
        { ordinal: 0, purpose: 'primary', phase: 'pre-primary-transport', mode: 'generate' },
        { ordinal: 1, purpose: 'stream', phase: 'pre-primary-transport', mode: 'stream' },
      ]);
      const generated = await funded.authority.runStage(
        funded.reservation, 'stage', () => client.generate('system', 'user'),
      );
      expect(generated.success).toBe(true);
      expect(generateSpy).toHaveBeenCalledOnce();
      const chunks: string[] = [];
      await funded.authority.runStage(funded.reservation, 'stage', async () => {
        for await (const chunk of client.stream('system', 'user-2')) chunks.push(chunk);
      });
      expect(chunks).toEqual(['streamed']);
      expect(streamSpy).toHaveBeenCalledOnce();
      expect(funded.debit).toHaveBeenCalledTimes(2);
      expect(funded.settle).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes zero provider calls when the pre-network debit refuses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c05-refuse-'));
    try {
      const { client, generateSpy } = buildAttestingClient({
        reservationsRoot: root, role: 'generator',
        generate: async () => ok({ content: 'must-not-run', model: SOL_IDENTITY.model, success: true }),
      });
      const funded = await frozenCampaign(root, [
        { ordinal: 0, purpose: 'stream', phase: 'pre-primary-transport', mode: 'stream' },
      ]);
      await expect(funded.authority.runStage(
        funded.reservation, 'stage', () => client.generate('system', 'user'),
      )).rejects.toThrow(/TRANSPORT_PROFILE_UNAVAILABLE/);
      expect(generateSpy).not.toHaveBeenCalled();
      expect(funded.debit).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects transport drift before durable debit and preserves the allocation for correction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c05-preflight-'));
    const endpoint = { value: 'http://localhost:8317/redirected' };
    try {
      const { client, generateSpy } = buildAttestingClient({
        reservationsRoot: root, role: 'generator', baseUrl: () => endpoint.value,
        generate: async () => ok({ content: 'corrected', model: SOL_IDENTITY.model, success: true }),
      });
      const funded = await frozenCampaign(root, [
        { ordinal: 0, purpose: 'primary', phase: 'pre-primary-transport', mode: 'generate' },
      ]);
      await expect(funded.authority.runStage(
        funded.reservation, 'stage', () => client.generate('system', 'user'),
      )).rejects.toThrow(/TRANSPORT_BINDING_MISMATCH/);
      expect(generateSpy).not.toHaveBeenCalled();
      expect(funded.debit).not.toHaveBeenCalled();

      endpoint.value = 'http://localhost:8317/v1';
      const corrected = await funded.authority.runStage(
        funded.reservation, 'stage', () => client.generate('system', 'user'),
      );
      expect(corrected.success).toBe(true);
      expect(generateSpy).toHaveBeenCalledOnce();
      expect(funded.debit).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes a distinct sealed retry allocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c05-permitted-retry-'));
    try {
      let calls = 0;
      const { client, generateSpy } = buildAttestingClient({ reservationsRoot: root, role: 'generator',
        generate: async () => ++calls === 1
          ? err(new LLMError('retryable', 'anthropic', 500, true))
          : ok({ content: 'retry-ok', model: SOL_IDENTITY.model, success: true }),
      });
      const funded = await frozenCampaign(root, [
        { ordinal: 0, purpose: 'primary', phase: 'pre-primary-transport', mode: 'generate' },
        { ordinal: 1, purpose: 'retry', phase: 'pre-retry-transport', mode: 'generate' },
      ]);
      const result = await funded.authority.runStage(
        funded.reservation, 'stage', () => client.generate('system', 'user'),
      );
      expect(result.success).toBe(true);
      expect(generateSpy).toHaveBeenCalledTimes(2);
      expect(funded.debit).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes a distinct sealed fallback allocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c05-retry-'));
    try {
      const { client, generateSpy } = buildAttestingClient({
        reservationsRoot: root, role: 'generator',
        generate: async () => { throw new Error('ECONNREFUSED'); },
      });
      const fallbackGenerate = vi.fn(async () => ok({
        content: 'fallback-ok', model: SOL_IDENTITY.model, success: true,
      }));
      vi.spyOn(client as never, 'getFallbackProviders' as never).mockReturnValue([{
        name: 'anthropic', getModel: () => SOL_IDENTITY.model,
        getConfig: () => ({ baseUrl: 'http://localhost:8317/v1', apiKey: 'sol-seat-secret', model: SOL_IDENTITY.model }),
        reserveTransport: () => Object.freeze({ capability: Object.freeze({}),
          provider: SOL_IDENTITY.provider, model: SOL_IDENTITY.model,
          baseUrl: 'http://localhost:8317/v1',
          credentialDigest: createHash('sha256').update('sol-seat-secret').digest('hex') }),
        cancelReservedTransport: () => undefined,
        generate: fallbackGenerate, supportsToolUse: () => true,
        capabilities: { thinking: false, streaming: false, jsonMode: false, toolUse: true,
          maxContextTokens: 4096, thinkingStyle: 'none' as const, streamingStyle: 'sse' as const },
      }] as never);
      const funded = await frozenCampaign(root, [
        { ordinal: 0, purpose: 'primary', phase: 'pre-primary-transport', mode: 'generate' },
        { ordinal: 1, purpose: 'fallback', phase: 'pre-fallback-transport', mode: 'generate' },
      ]);
      const result = await funded.authority.runStage(funded.reservation, 'stage',
        () => client.complete({ systemPrompt: 'system', prompt: 'user' }));
      expect(result.success).toBe(true);
      expect(generateSpy).toHaveBeenCalledOnce();
      expect(fallbackGenerate).toHaveBeenCalledOnce();
      expect(funded.debit).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a second tool-loop transport when it has no frozen allocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c05-tool-loop-'));
    try {
      const { client, generateSpy } = buildAttestingClient({
        reservationsRoot: root, role: 'generator',
        generate: async () => ok({ content: '', model: SOL_IDENTITY.model, success: true,
          finishReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'validate_syntax', arguments: '{}' }] }),
      });
      const funded = await frozenCampaign(root, [
        { ordinal: 0, purpose: 'primary', phase: 'pre-primary-transport', mode: 'generate' },
        { ordinal: 1, purpose: 'tool-turn', phase: 'pre-primary-transport', mode: 'generate' },
      ]);
      const result = await funded.authority.runStage(funded.reservation, 'stage',
        () => client.generateWithToolLoop({ systemPrompt: 'system', userPrompt: 'user',
          tools: [{ name: 'validate_syntax', description: 'validate', parameters: { type: 'object', properties: {} } }],
          toolExecutor: async () => '{}', maxIterations: 3 }));
      expect(result.success).toBe(false);
      expect(generateSpy).toHaveBeenCalledTimes(2);
      expect(funded.debit).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('W8C-04 attestation binding (#717) — public LLMClient + ledger seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exact signed attestation digest persists on the ledger and the result ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-bind-'));
    try {
      const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate', domain: 'p5' });
      const { client } = buildAttestingClient({
        reservationsRoot: root,
        generate: async () => ok({ content: 'function setup(){createCanvas(10,10);}', model: SOL_IDENTITY.model, success: true }),
      });
      const result = await client.generateWithToolLoop({
        systemPrompt: 'system', userPrompt: 'user', tools: [],
        toolExecutor: async () => 'ok', maxIterations: 1,
        attemptTelemetry: attempt,
      });
      expect(result.executorAttestations?.length).toBe(1);
      const ref = result.executorAttestations![0];
      const snapshot = await ledger.snapshot('run', 'candidate');
      expect(snapshot!.events.find((event) => event.stage === 'request')?.attestationDigest).toBeUndefined();
      const payload = snapshot!.events.find((event) => event.stage === 'assistant_payload');
      expect(payload?.attestationDigest).toBe(ref.attestationDigest);
      expect(payload?.attemptDigest).toBe(ref.attemptDigest);
      expect(payload?.requestDigest).toBe(ref.requestDigest);
      expect(payload?.routeDigest).toBe(ref.routeDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provider throw terminal path still binds its signed completion ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-throw-'));
    try {
      const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate' });
      const { client, generateSpy } = buildAttestingClient({
        reservationsRoot: root,
        generate: async () => { throw new Error('provider transport exploded'); },
      });
      const result = await client.generateWithToolLoop({
        systemPrompt: 'system', userPrompt: 'user', tools: [],
        toolExecutor: async () => 'ok', maxIterations: 1,
        attemptTelemetry: attempt,
      });
      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      // The throw terminal path still produced and surfaced a signed ref.
      expect(result.executorAttestations?.length).toBe(1);
      const snapshot = await ledger.snapshot('run', 'candidate');
      const failureEvent = snapshot!.events.find((e) => e.stage === 'failure_class');
      expect(failureEvent?.attestationDigest).toBe(result.executorAttestations![0].attestationDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provider Err terminal path still binds its signed completion ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-err-'));
    try {
      const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate' });
      const { client } = buildAttestingClient({
        reservationsRoot: root,
        generate: async () => err(new LLMError('provider denied', 'anthropic', 403, false, { model: SOL_IDENTITY.model })),
      });
      const result = await client.generateWithToolLoop({
        systemPrompt: 'system', userPrompt: 'user', tools: [],
        toolExecutor: async () => 'ok', maxIterations: 1,
        attemptTelemetry: attempt,
      });
      expect(result.success).toBe(false);
      expect(result.executorAttestations?.length).toBe(1);
      const snapshot = await ledger.snapshot('run', 'candidate');
      expect(snapshot!.events.some((e) => e.attestationDigest === result.executorAttestations![0].attestationDigest)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('two tool-loop turns produce two ordered signed refs bound to the attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-two-turns-'));
    try {
      const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate' });
      let call = 0;
      const { client } = buildAttestingClient({
        reservationsRoot: root,
        generate: async () => {
          call += 1;
          if (call === 1) {
            // First turn: return a non-submit_code tool call so the loop continues.
            return ok({
              content: '', model: SOL_IDENTITY.model, success: true, finishReason: 'tool_calls' as const,
              toolCalls: [{ id: 'call-1', name: 'validate_syntax', arguments: '{}' }],
            });
          }
          // Second turn: final artifact content, no tool calls.
          return ok({ content: 'function setup(){createCanvas(20,20);}', model: SOL_IDENTITY.model, success: true });
        },
      });
      const result = await client.generateWithToolLoop({
        systemPrompt: 'system', userPrompt: 'user',
        tools: [{ name: 'validate_syntax', description: 'validate', parameters: { type: 'object', properties: { code: { type: 'string' } } } }],
        toolExecutor: async () => '{"valid":true}', maxIterations: 3,
        attemptTelemetry: attempt,
      });
      expect(result.executorAttestations?.length).toBe(2);
      const [first, second] = result.executorAttestations!;
      expect(first.attestationId).not.toBe(second.attestationId);
      expect(first.attestationDigest).not.toBe(second.attestationDigest);
      const snapshot = await ledger.snapshot('run', 'candidate');
      // Both refs are persisted in order in the durable binding list.
      const bound = snapshot!.attemptBindings?.[attempt.attemptId] ?? [];
      expect(bound.length).toBe(2);
      expect(bound[0].attestationDigest).toBe(first.attestationDigest);
      expect(bound[1].attestationDigest).toBe(second.attestationDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Luna/harness policy block makes zero provider calls and binds no ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-luna-'));
    try {
      const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate' });
      const registry = buildRegistry();
      const guard = new HarnessTransportGuard(registry, {
        reservations: new ReservationTracker(join(root, 'reservations')),
        nonces: new NonceLedger(join(root, 'nonces')),
      });
      const authority: HarnessTransportAuthority = {
        guard,
        reserveAttempt: () => { throw new Error('reservation must not be called for blocked Luna attempt'); },
        attestCompletion: () => { throw new Error('attestation must not be issued for blocked Luna attempt'); },
      };
      const client = new LLMClient({
        role: 'harness', baseUrl: 'http://localhost:9/v1',
        model: LUNA_MODEL_ID, apiKey: 'test-only', harnessTransportAuthority: authority,
      });
      vi.spyOn(client as never, 'resolveModel' as never).mockResolvedValue(LUNA_MODEL_ID as never);
      const generateSpy = vi.fn();
      vi.spyOn(client as never, 'getProvider' as never).mockResolvedValue({
        name: 'openai', getModel: () => LUNA_MODEL_ID,
        getConfig: () => ({ baseUrl: 'http://localhost:9/v1' }), generate: generateSpy,
        supportsToolUse: () => true,
        capabilities: { thinking: false, streaming: false, jsonMode: false, toolUse: true, maxContextTokens: 4096, thinkingStyle: 'none' as const, streamingStyle: 'sse' as const },
      } as never);
      const result = await client.generateWithToolLoop({
        systemPrompt: 'system', userPrompt: 'user', tools: [],
        toolExecutor: async () => 'ok', maxIterations: 1,
        attemptTelemetry: attempt,
      });
      expect(generateSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.executorAttestations ?? []).toHaveLength(0);
      const snapshot = await ledger.snapshot('run', 'candidate');
      // No durable binding was created; events remain explicitly unattested.
      expect(snapshot?.attemptBindings?.[attempt.attemptId]).toBeUndefined();
      for (const event of snapshot!.events) {
        expect(event.attestationDigest).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counters include every retry/fallback attempt via signed deltas', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-fallback-'));
    try {
      // Force a fallback path: primary throws a fallbackable error; one
      // fallback provider succeeds. Both primary-throw and fallback-success
      // produce signed refs via executeProviderAttempt's collector.
      let call = 0;
      const { client } = buildAttestingClient({
        reservationsRoot: root,
        generate: async () => {
          call += 1;
          if (call === 1) {
            throw new Error('ECONNREFUSED');
          }
          return ok({ content: 'recovered-via-fallback', model: SOL_IDENTITY.model, success: true });
        },
      });
      const fallbackProvider = {
        name: 'fallback-anthropic',
        getModel: () => SOL_IDENTITY.model,
        getConfig: () => ({ baseUrl: 'http://localhost:9/v1', apiKey: 'fallback-key', model: SOL_IDENTITY.model }),
        generate: async () => ok({
          content: 'fallback-content', model: SOL_IDENTITY.model, success: true,
        }),
        supportsToolUse: () => true,
        capabilities: { thinking: false, streaming: false, jsonMode: false, toolUse: true, maxContextTokens: 4096, thinkingStyle: 'none' as const, streamingStyle: 'sse' as const },
      };
      vi.spyOn(client as never, 'getFallbackProviders' as never).mockReturnValue([fallbackProvider] as never);
      const completeResult = await client.complete({ systemPrompt: 'system', prompt: 'user' });
      // primary throw + fallback success → 2 signed refs across the complete() call.
      expect(completeResult.success).toBe(true);
      expect((completeResult.executorAttestations ?? []).length).toBe(2);
      // Each ref's signed delta records exactly one provider call.
      const calls = (completeResult.executorAttestations ?? [])
        .reduce((sum, ref) => sum + ref.quotaCounterDelta.calls, 0);
      expect(calls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restart preserves immutable pre/post transport attribution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-restart-'));
    try {
      const persistence = new FileGenerationAttemptPersistence(root);
      const first = new GenerationAttemptLedger(persistence);
      const attempt = await first.beginPrimary({ runId: 'run', candidateId: 'candidate' });
      // Emit a pre-transport event with no ref yet — it must remain unattested
      // unless a receipt is later bound.
      await attempt.emit({
        schemaVersion: 1, runId: 'run', candidateId: 'candidate', attemptId: attempt.attemptId,
        attemptOrdinal: 1, lineageId: `run/candidate/${attempt.attemptId}`, stage: 'request', timestamp: new Date().toISOString(),
      });
      const ref = {
        attestationId: 'att-1', attestationDigest: 'a'.repeat(64), attemptDigest: 'b'.repeat(64),
        requestDigest: 'c'.repeat(64), routeDigest: 'd'.repeat(64),
        attemptOrdinal: 1, fallbackOrdinal: 0, retryOrdinal: 0, durationMs: 7,
        quotaCounterDelta: { calls: 1, inputTokens: 2, outputTokens: 3, activeSeconds: 0 },
      };
      await attempt.emit({
        schemaVersion: 1, runId: 'run', candidateId: 'candidate', attemptId: attempt.attemptId,
        attemptOrdinal: 1, lineageId: `run/candidate/${attempt.attemptId}`, stage: 'assistant_payload', timestamp: new Date().toISOString(),
      }, { providerCalls: 1, inputTokens: 2, outputTokens: 3, activeTimeMs: 7, quotaUnits: 1 }, [ref]);

      // Simulate process restart: re-open the same file persistence.
      const restarted = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(root));
      const snapshot = await restarted.snapshot('run', 'candidate');
      expect(snapshot?.attemptBindings?.[attempt.attemptId]).toHaveLength(1);
      expect(snapshot!.events[0].attestationDigest).toBeUndefined();
      expect(snapshot!.events[1].attestationDigest).toBe(ref.attestationDigest);
      expect(snapshot!.events[1].attemptDigest).toBe(ref.attemptDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no-receipt attempts remain explicitly unattested; never fabricated', async () => {
    const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
    const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate' });
    await attempt.emit({
      schemaVersion: 1, runId: 'run', candidateId: 'candidate', attemptId: attempt.attemptId,
      attemptOrdinal: 1, lineageId: `run/candidate/${attempt.attemptId}`, stage: 'request', timestamp: new Date().toISOString(),
    });
    const snapshot = await ledger.snapshot('run', 'candidate');
    expect(snapshot?.attemptBindings).toBeUndefined();
    for (const event of snapshot!.events) {
      expect(event.attestationDigest).toBeUndefined();
      expect(event.attemptDigest).toBeUndefined();
    }
  });

  it('stream() persists its primary completion ref across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-stream-primary-'));
    try {
      const ledger = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(join(root, 'ledger')));
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'stream-primary' });
      const { client } = buildAttestingClient({
        reservationsRoot: join(root, 'authority'),
        generate: async () => ok({ content: '', model: SOL_IDENTITY.model, success: true }),
        stream: async function* () {
          yield { type: 'content', content: 'hello' };
          yield { type: 'done', usage: { inputTokens: 4, outputTokens: 2 } };
        },
      });
      const chunks: string[] = [];
      for await (const chunk of client.stream('system', 'user', undefined, attempt)) chunks.push(chunk);
      expect(chunks).toEqual(['hello']);
      const snapshot = await new GenerationAttemptLedger(
        new FileGenerationAttemptPersistence(join(root, 'ledger')),
      ).snapshot('run', 'stream-primary');
      expect(snapshot?.attemptBindings?.[attempt.attemptId]).toHaveLength(1);
      expect(snapshot?.counters).toMatchObject({ providerCalls: 1, inputTokens: 4, outputTokens: 2 });
      expect(snapshot?.events.find((event) => event.stage === 'assistant_payload')?.attestationDigest)
        .toBe(snapshot?.attemptBindings?.[attempt.attemptId][0].attestationDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streamWithThinking() keeps primary error A and fallback payload B attributed after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-stream-fallback-'));
    try {
      const ledgerRoot = join(root, 'ledger');
      const ledger = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(ledgerRoot));
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'stream-fallback' });
      const { client } = buildAttestingClient({
        reservationsRoot: join(root, 'authority'),
        generate: async () => ok({ content: '', model: SOL_IDENTITY.model, success: true }),
        stream: async function* () { yield { type: 'error', error: 'ECONNREFUSED' }; },
      });
      const fallback = {
        name: 'fallback-anthropic', getModel: () => SOL_IDENTITY.model,
        getConfig: () => ({ baseUrl: 'http://localhost:9/v1', model: SOL_IDENTITY.model }),
        stream: async function* () {
          yield { type: 'thinking' as const, content: 'private reasoning' };
          yield { type: 'content' as const, content: 'fallback payload' };
          yield { type: 'done' as const, usage: { inputTokens: 6, outputTokens: 3 } };
        },
      };
      vi.spyOn(client as never, 'getFallbackProviders' as never).mockReturnValue([fallback] as never);
      const output = [];
      for await (const event of client.streamWithThinking('system', 'user', undefined, undefined, attempt)) {
        output.push(event);
      }
      expect(output.at(-1)).toEqual({ type: 'content', content: 'fallback payload' });
      const snapshot = await new GenerationAttemptLedger(
        new FileGenerationAttemptPersistence(ledgerRoot),
      ).snapshot('run', 'stream-fallback');
      const refs = snapshot?.attemptBindings?.[attempt.attemptId] ?? [];
      expect(refs).toHaveLength(2);
      expect(refs.map((ref) => ref.fallbackOrdinal)).toEqual([0, 1]);
      const failure = snapshot?.events.find((event) => event.stage === 'failure_class');
      const payload = snapshot?.events.find((event) => event.stage === 'assistant_payload');
      expect(failure?.attestationDigest).toBe(refs[0].attestationDigest);
      expect(payload?.attestationDigest).toBe(refs[1].attestationDigest);
      expect(failure?.attestationDigest).not.toBe(payload?.attestationDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stream() binds a terminal provider error ref after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-stream-error-'));
    try {
      const ledgerRoot = join(root, 'ledger');
      const ledger = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(ledgerRoot));
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'stream-error' });
      const { client } = buildAttestingClient({
        reservationsRoot: join(root, 'authority'),
        generate: async () => ok({ content: '', model: SOL_IDENTITY.model, success: true }),
        stream: async function* () { yield { type: 'error', error: 'malformed response' }; },
      });
      await expect(async () => {
        for await (const chunk of client.stream('system', 'user', undefined, attempt)) void chunk;
      }).rejects.toThrow('malformed response');
      const snapshot = await new GenerationAttemptLedger(
        new FileGenerationAttemptPersistence(ledgerRoot),
      ).snapshot('run', 'stream-error');
      const ref = snapshot?.attemptBindings?.[attempt.attemptId][0];
      const failure = snapshot?.events.find((event) => event.stage === 'failure_class');
      expect(failure?.attestationDigest).toBe(ref?.attestationDigest);
      expect(snapshot?.events.some((event) => event.failureReason === 'consumer_abort')).toBe(false);
      expect(snapshot?.counters.providerCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streamWithThinking() binds consumer-abort to the completed provider ref after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-stream-abort-'));
    try {
      const ledgerRoot = join(root, 'ledger');
      const ledger = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(ledgerRoot));
      const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'stream-abort' });
      const { client } = buildAttestingClient({
        reservationsRoot: join(root, 'authority'),
        generate: async () => ok({ content: '', model: SOL_IDENTITY.model, success: true }),
        stream: async function* () {
          yield { type: 'content', content: 'first' };
          yield { type: 'content', content: 'second' };
          yield { type: 'done', usage: { inputTokens: 3, outputTokens: 2 } };
        },
      });
      for await (const event of client.streamWithThinking('system', 'user', undefined, undefined, attempt)) {
        expect(event.content).toBe('first');
        break;
      }
      const snapshot = await new GenerationAttemptLedger(
        new FileGenerationAttemptPersistence(ledgerRoot),
      ).snapshot('run', 'stream-abort');
      const ref = snapshot?.attemptBindings?.[attempt.attemptId][0];
      const abortEvent = snapshot?.events.find((event) => event.failureReason === 'consumer_abort');
      expect(abortEvent?.attestationDigest).toBe(ref?.attestationDigest);
      expect(snapshot?.counters).toMatchObject({ providerCalls: 1, inputTokens: 3, outputTokens: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('overlapping primary and fallback transports charge exact signed per-call totals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c04-overlap-'));
    const oldRetries = process.env.SINTER_LLM_MAX_RETRIES;
    process.env.SINTER_LLM_MAX_RETRIES = '0';
    try {
      let arrivals = 0;
      let release!: () => void;
      const bothStarted = new Promise<void>((resolve) => { release = resolve; });
      const { client } = buildAttestingClient({
        reservationsRoot: root,
        generate: async (req) => {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothStarted;
          if (req.userPrompt === 'needs-fallback') {
            throw new LLMError('ECONNREFUSED', 'anthropic', undefined, true);
          }
          return ok({
            content: 'primary', model: SOL_IDENTITY.model, success: true,
            usage: { inputTokens: 7, outputTokens: 3 },
          });
        },
      });
      const fallback = {
        name: 'fallback-anthropic', getModel: () => SOL_IDENTITY.model,
        getConfig: () => ({ baseUrl: 'http://localhost:9/v1', model: SOL_IDENTITY.model }),
        generate: async () => ok({
          content: 'fallback', model: SOL_IDENTITY.model, success: true,
          usage: { inputTokens: 11, outputTokens: 5 },
        }),
      };
      vi.spyOn(client as never, 'getFallbackProviders' as never).mockReturnValue([fallback] as never);
      const [fallbackResult, primaryResult] = await Promise.all([
        client.complete({ prompt: 'needs-fallback' }),
        client.complete({ prompt: 'primary' }),
      ]);
      const refs = [...(fallbackResult.executorAttestations ?? []), ...(primaryResult.executorAttestations ?? [])];
      expect(refs).toHaveLength(3);
      expect(refs.reduce((sum, ref) => sum + ref.quotaCounterDelta.calls, 0)).toBe(3);
      expect(refs.reduce((sum, ref) => sum + ref.quotaCounterDelta.inputTokens, 0)).toBe(18);
      expect(refs.reduce((sum, ref) => sum + ref.quotaCounterDelta.outputTokens, 0)).toBe(8);
    } finally {
      if (oldRetries === undefined) delete process.env.SINTER_LLM_MAX_RETRIES;
      else process.env.SINTER_LLM_MAX_RETRIES = oldRetries;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('concurrent candidates do not cross-bind signed refs', async () => {
    const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
    const attemptA = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate-A' });
    const attemptB = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate-B' });
    const refA = {
      attestationId: 'att-A', attestationDigest: '1'.repeat(64), attemptDigest: '2'.repeat(64),
      requestDigest: '3'.repeat(64), routeDigest: '4'.repeat(64),
      attemptOrdinal: 1, fallbackOrdinal: 0, retryOrdinal: 0, durationMs: 5,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    };
    const refB = {
      attestationId: 'att-B', attestationDigest: '5'.repeat(64), attemptDigest: '6'.repeat(64),
      requestDigest: '7'.repeat(64), routeDigest: '8'.repeat(64),
      attemptOrdinal: 1, fallbackOrdinal: 0, retryOrdinal: 0, durationMs: 6,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    };
    await attemptA.emit({
      schemaVersion: 1, runId: 'run', candidateId: 'candidate-A', attemptId: attemptA.attemptId,
      attemptOrdinal: 1, lineageId: `run/candidate-A/${attemptA.attemptId}`, stage: 'request', timestamp: new Date().toISOString(),
    }, undefined, [refA]);
    await attemptB.emit({
      schemaVersion: 1, runId: 'run', candidateId: 'candidate-B', attemptId: attemptB.attemptId,
      attemptOrdinal: 1, lineageId: `run/candidate-B/${attemptB.attemptId}`, stage: 'request', timestamp: new Date().toISOString(),
    }, undefined, [refB]);

    const snapA = await ledger.snapshot('run', 'candidate-A');
    const snapB = await ledger.snapshot('run', 'candidate-B');
    expect(snapA?.events[0].attestationDigest).toBe(refA.attestationDigest);
    expect(snapB?.events[0].attestationDigest).toBe(refB.attestationDigest);
    // Cross-binding safety: A's digest must not appear in B's record.
    expect(snapB?.events.some((e) => e.attestationDigest === refA.attestationDigest)).toBe(false);
    expect(snapA?.events.some((e) => e.attestationDigest === refB.attestationDigest)).toBe(false);
    void (attemptA as unknown as { emit: unknown });
    void (attemptB as unknown as { emit: unknown });
    void ({} as ToolResultMessage);
  });
});
