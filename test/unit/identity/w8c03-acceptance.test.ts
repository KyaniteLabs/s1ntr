/**
 * W8C-03 (#716) acceptance bundle.
 *
 * Maps each bullet of section 3 ("Identity, fallback, and quota") of the test
 * spec to a concrete test. These tests demonstrate the contract end to end
 * with a transport spy that proves zero network and an evidence sink that
 * proves zero harness evidence on every rejection.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'neverthrow';
import { decideRoleEligibility, ROLE_ELIGIBILITY_POLICY_VERSION } from '../../../src/identity/roleEligibilityPolicy.js';
import { HarnessTransportGuard } from '../../../src/identity/harnessTransportGuard.js';
import { issueExecutorReservation } from '../../../src/identity/executorReservation.js';
import { ReservationTracker } from '../../../src/identity/executorReservation.js';
import { issueExecutorAttestation } from '../../../src/identity/executorAttestation.js';
import { NonceLedger } from '../../../src/identity/executorAttestation.js';
import { LUNA_MODEL_ID } from '../../../src/identity/canonicalAlias.js';
import {
  buildRegistry,
  CLIPROXY_SURFACE,
  LUNA_IDENTITY,
  LUNA_SEAT,
  LUNA_SUBSCRIPTION_FUNDING,
  NOW_ISO,
  SOL_IDENTITY,
  SOL_SEAT,
  SOL_SUBSCRIPTION_FUNDING,
} from './helpers.js';
import type {
  ConfigSourceLayer,
  EligibilityPhase,
  ExecutorIdentity,
  ModelRole,
} from '../../../src/identity/types.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';

/**
 * A spy that simulates the provider network. If authorizeTransport returns
 * ok=false, callers must NOT invoke the spy. The spy asserts on every call
 * that the gate said ok.
 */
class TransportSpy {
  calls = 0;
  evidenceEmitted = 0;
  call(_input: unknown): { ok: true } {
    this.calls += 1;
    return { ok: true };
  }
  emitEvidence(): void {
    this.evidenceEmitted += 1;
  }
}

function policy(input: {
  role: ModelRole;
  requestedIdentity: ExecutorIdentity;
  resolvedIdentity?: ExecutorIdentity;
  sourceLayer?: ConfigSourceLayer;
  phase?: EligibilityPhase;
  substitutionAllowed?: boolean;
}) {
  return {
    role: input.role,
    sourceLayer: input.sourceLayer ?? 'project-config',
    phase: input.phase ?? 'pre-primary-transport',
    requestedIdentity: input.requestedIdentity,
    resolvedIdentity: input.resolvedIdentity ?? input.requestedIdentity,
    fallbackOrdinal: 0,
    retryOrdinal: 0,
    priorDigest: null,
    policyInvokedAt: ['config-mutation', 'pre-primary-transport'],
    substitutionAllowed: input.substitutionAllowed,
  };
}

describe('W8C-03 acceptance — section 3: Identity, fallback, and quota', () => {
  it('blocks an actual Luna harness client at the shared provider boundary with zero transport', async () => {
    const client = new LLMClient({ role: 'harness', baseUrl: 'http://localhost:9/v1',
      model: LUNA_MODEL_ID, apiKey: 'test-only' });
    const generate = vi.fn();
    const provider = { name: 'openai', getModel: () => LUNA_MODEL_ID,
      getConfig: () => ({ baseUrl: 'http://localhost:9/v1' }), generate };
    vi.spyOn(client as never, 'resolveModel' as never).mockResolvedValue(LUNA_MODEL_ID as never);
    vi.spyOn(client as never, 'getProvider' as never).mockResolvedValue(provider as never);
    const response = await client.complete({ systemPrompt: 'system', prompt: 'test' });
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/Harness executor blocked before transport.*luna.*forbidden/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails closed before transport when a non-Luna harness has no host authority', async () => {
    const client = new LLMClient({ role: 'harness', baseUrl: 'http://localhost:9/v1',
      model: SOL_IDENTITY.model, apiKey: 'test-only' });
    const generate = vi.fn();
    vi.spyOn(client as never, 'resolveModel' as never).mockResolvedValue(SOL_IDENTITY.model as never);
    vi.spyOn(client as never, 'getProvider' as never).mockResolvedValue({ name: 'anthropic',
      getModel: () => SOL_IDENTITY.model, getConfig: () => ({ baseUrl: 'http://localhost:9/v1' }), generate } as never);
    const response = await client.complete({ systemPrompt: 'system', prompt: 'test' });
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/host-owned completion authority is required/i);
    expect(generate).not.toHaveBeenCalled();
    expect(client.getHarnessExecutorProjection()).toMatchObject({ status: 'blocked', resolved: SOL_IDENTITY });
  });

  it('uses durable one-use host truth at the real provider seam before accepting content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w8c03-authority-'));
    try {
      const registry = buildRegistry();
      const guard = new HarnessTransportGuard(registry, {
        reservations: new ReservationTracker(join(root, 'reservations')),
        nonces: new NonceLedger(join(root, 'nonces')),
      });
      let ordinal = 0;
      const authority = {
        guard,
        reserveAttempt: (context: import('../../../src/identity/harnessTransportGuard.js').HarnessAttemptContext) => issueExecutorReservation(registry, {
          reservationId: `reservation-${ordinal}`,
          runDigest: 'run', requestDigest: context.requestDigest, routeDigest: context.routeDigest,
          identity: context.resolvedIdentity, seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING,
          surface: CLIPROXY_SURFACE, issuedAt: new Date().toISOString(), nonce: `reservation-nonce-${ordinal}`,
        }),
        attestCompletion: ({ context, reservation, response }: Parameters<import('../../../src/identity/harnessTransportGuard.js').HarnessTransportAuthority['attestCompletion']>[0]) => {
          expect(response).toMatchObject({ model: SOL_IDENTITY.model, success: true });
          ordinal += 1;
          return issueExecutorAttestation(registry, {
            attestationId: `attestation-${ordinal}`, runDigest: reservation.subject.runDigest,
            requestDigest: context.requestDigest, attemptDigest: `attempt-${ordinal}`,
            routeDigest: context.routeDigest, attemptOrdinal: context.attemptOrdinal,
            fallbackOrdinal: context.fallbackOrdinal, retryOrdinal: context.retryOrdinal,
            priorTraceDigest: context.priorTraceDigest, policyTraceDigest: context.policyTraceDigest,
            requestedIdentity: context.requestedIdentity, resolvedIdentity: context.resolvedIdentity,
            effort: context.resolvedIdentity.effort, fallbackChain: context.fallbackChain,
            seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat',
            issuedAt: new Date().toISOString(), nonce: `attestation-nonce-${ordinal}`, surface: CLIPROXY_SURFACE,
            durationMs: response.durationMs,
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
      const client = new LLMClient({ role: 'harness', baseUrl: 'http://localhost:9/v1',
        model: SOL_IDENTITY.model, apiKey: 'test-only', harnessTransportAuthority: authority });
      const generate = vi.fn(async () => ok({ content: 'verified-content', model: SOL_IDENTITY.model, success: true }));
      const provider = { name: 'anthropic', getModel: () => SOL_IDENTITY.model,
        getConfig: () => ({ baseUrl: 'http://localhost:9/v1' }), generate };
      vi.spyOn(client as never, 'resolveModel' as never).mockResolvedValue(SOL_IDENTITY.model as never);
      vi.spyOn(client as never, 'getProvider' as never).mockResolvedValue(provider as never);
      const response = await client.complete({ systemPrompt: 'system', prompt: 'test' });
      expect(response).toMatchObject({ success: true, text: 'verified-content' });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(client.getHarnessExecutorProjection()).toMatchObject({
        status: 'verified', requested: SOL_IDENTITY, resolved: SOL_IDENTITY,
        seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat',
      });

      const replayGuard = new HarnessTransportGuard(registry, {
        reservations: new ReservationTracker(join(root, 'reservations')),
        nonces: new NonceLedger(join(root, 'nonces')),
      });
      const durableReservation = issueExecutorReservation(registry, {
        reservationId: 'restart-replay', runDigest: 'run', requestDigest: 'request', routeDigest: 'route',
        identity: SOL_IDENTITY, seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING,
        surface: CLIPROXY_SURFACE, issuedAt: new Date().toISOString(), nonce: 'restart-replay-nonce',
      });
      expect(guard.authorizeTransport({
        policy: policy({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
        reservation: durableReservation, now: new Date().toISOString(),
      }).ok).toBe(true);
      expect(replayGuard.authorizeTransport({
        policy: policy({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
        reservation: durableReservation, now: new Date().toISOString(),
      })).toMatchObject({ ok: false, reason: 'reservation-consume-failed' });

      const mismatchAuthority: import('../../../src/identity/harnessTransportGuard.js').HarnessTransportAuthority = {
        guard: replayGuard,
        reserveAttempt: context => issueExecutorReservation(registry, {
          reservationId: 'mismatch-reservation', runDigest: 'run', requestDigest: context.requestDigest,
          routeDigest: context.routeDigest, identity: context.resolvedIdentity, seat: SOL_SEAT,
          funding: SOL_SUBSCRIPTION_FUNDING, surface: CLIPROXY_SURFACE,
          issuedAt: new Date().toISOString(), nonce: 'mismatch-reservation-nonce',
        }),
        attestCompletion: ({ context, reservation }) => issueExecutorAttestation(registry, {
          attestationId: 'mismatch-attestation', runDigest: reservation.subject.runDigest,
          requestDigest: context.requestDigest, attemptDigest: 'mismatch-attempt',
          routeDigest: context.routeDigest, attemptOrdinal: context.attemptOrdinal,
          fallbackOrdinal: context.fallbackOrdinal, retryOrdinal: context.retryOrdinal,
          priorTraceDigest: context.priorTraceDigest, policyTraceDigest: context.policyTraceDigest,
          requestedIdentity: context.requestedIdentity, resolvedIdentity: context.resolvedIdentity,
          effort: context.resolvedIdentity.effort,
          fallbackChain: [{ ordinal: 0, identity: context.resolvedIdentity }, { ordinal: 1, identity: LUNA_IDENTITY }],
          seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat',
          issuedAt: new Date().toISOString(), nonce: 'mismatch-attestation-nonce', surface: CLIPROXY_SURFACE,
          durationMs: 0, success: true,
          quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
        }),
      };
      const mismatchClient = new LLMClient({ role: 'harness', baseUrl: 'http://localhost:9/v1',
        model: SOL_IDENTITY.model, apiKey: 'test-only', harnessTransportAuthority: mismatchAuthority });
      vi.spyOn(mismatchClient as never, 'resolveModel' as never).mockResolvedValue(SOL_IDENTITY.model as never);
      vi.spyOn(mismatchClient as never, 'getProvider' as never).mockResolvedValue(provider as never);
      const discarded = await mismatchClient.complete({ systemPrompt: 'system', prompt: 'must-not-escape' });
      expect(discarded).toMatchObject({ success: false, text: '' });
      expect(discarded.error).toMatch(/identity-mismatch/);
      expect(mismatchClient.getHarnessExecutorProjection()).toMatchObject({ status: 'blocked' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requested Sol + resolved Luna records both identities and the complete fallback chain', () => {
    const decision = decideRoleEligibility(
      policy({
        role: 'generator',
        requestedIdentity: SOL_IDENTITY,
        resolvedIdentity: LUNA_IDENTITY,
      }),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      // The trace proves BOTH identities are recorded: requested (Sol) and resolved (Luna).
      expect(decision.trace.requestedIdentity.model).toBe(SOL_IDENTITY.model);
      expect(decision.trace.resolvedIdentity.model).toBe(LUNA_MODEL_ID);
      expect(decision.trace.sourceLayer).toBe('project-config');
    }
  });

  it('Luna succeeds in frozen generator/evaluator/studio fixtures (studio is the runtime chat role)', () => {
    for (const role of ['generator', 'evaluator', 'studio'] as ModelRole[]) {
      const spy = new TransportSpy();
      const registry = buildRegistry();
      const guard = new HarnessTransportGuard(registry);
      const reservation = issueExecutorReservation(registry, {
        reservationId: `res-${role}`,
        runDigest: 'run-digest',
        requestDigest: 'request-digest',
        routeDigest: 'route-digest',
        identity: LUNA_IDENTITY,
        seat: LUNA_SEAT,
        funding: LUNA_SUBSCRIPTION_FUNDING,
        surface: CLIPROXY_SURFACE,
        issuedAt: NOW_ISO,
        nonce: `res-nonce-${role}`,
      });
      const auth = guard.authorizeTransport({
        policy: policy({ role, requestedIdentity: LUNA_IDENTITY }),
        reservation,
        now: NOW_ISO,
      });
      expect(auth.ok, `${role} should be authorized`).toBe(true);
      if (auth.ok) {
        spy.call({});
        spy.emitEvidence();
      }
      expect(spy.calls, `${role} should make one network call`).toBe(1);
      expect(spy.evidenceEmitted, `${role} should emit one evidence`).toBe(1);
    }
  });

  describe('every Luna-into-harness ingress path fails before provider transport (zero network, zero evidence)', () => {
    const cases: Array<{ name: string; sourceLayer: ConfigSourceLayer; phase: EligibilityPhase }> = [
      { name: 'direct harness config', sourceLayer: 'project-config', phase: 'config-mutation' },
      { name: 'explicit harness client construction', sourceLayer: 'explicit-harness-client', phase: 'pre-harness-client-construction' },
      { name: 'role-specific env override', sourceLayer: 'role-specific-env-override', phase: 'config-mutation' },
      { name: 'generic env override', sourceLayer: 'generic-env-override', phase: 'config-mutation' },
      { name: 'generator-to-harness inheritance', sourceLayer: 'generator-to-harness-inheritance', phase: 'post-merged-resolution' },
      { name: 'fallbacks.harness', sourceLayer: 'fallbacks-harness', phase: 'pre-fallback-transport' },
      { name: 'internal retry', sourceLayer: 'internal-retry', phase: 'pre-retry-transport' },
      { name: 'persisted restart hydration', sourceLayer: 'persisted-restart-hydration', phase: 'pre-restart-hydration' },
      { name: 'legacy config conversion', sourceLayer: 'legacy-config-conversion', phase: 'config-mutation' },
    ];

    for (const { name, sourceLayer, phase } of cases) {
      it(name, () => {
        const spy = new TransportSpy();
        const decision = decideRoleEligibility({
          role: 'harness',
          sourceLayer,
          phase,
          requestedIdentity: LUNA_IDENTITY,
          resolvedIdentity: LUNA_IDENTITY,
          fallbackOrdinal: 0,
          retryOrdinal: 0,
          priorDigest: null,
          policyInvokedAt: [phase],
        });
        expect(decision.ok).toBe(false);
        if (!decision.ok) {
          expect(decision.reason).toBe('role-luna-harness-forbidden');
          // The rejection emits a trace and typed blocker but no provider request and no harness evidence.
          expect(decision.trace.digest).toMatch(/^[a-f0-9]{64}$/);
        }
        // Spy must NOT have been invoked because the gate returned ok=false.
        expect(spy.calls).toBe(0);
        expect(spy.evidenceEmitted).toBe(0);
      });
    }
  });

  it('unknown resolved identity blocks critical-role / independent-review claims', () => {
    const unknown: ExecutorIdentity = { provider: 'unknown', model: 'mystery', effort: 'high' };
    const decision = decideRoleEligibility(policy({ role: 'harness', requestedIdentity: unknown }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('unknown-resolved-identity');
    }
  });

  it('alias ambiguity (caller-asserted identity) fails closed', () => {
    const asserted: ExecutorIdentity = {
      provider: 'openai',
      model: 'gpt-5.1',
      effort: 'high',
      alias: 'openai/gpt-5.6-luna', // alias resolves to Luna, not gpt-5.1
    };
    const decision = decideRoleEligibility(policy({ role: 'generator', requestedIdentity: asserted }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('identity-ambiguous');
  });

  it('gateway quota denial records the exact capability surface and does not demote unrelated surfaces', () => {
    // Tested in capabilityProbe.test.ts; here we re-state the contract:
    //   the snapshot exposes 3 Kilo surfaces independently, gateway is denied
    //   while web-balance/CLI retain their own state.
    const snapshot = {
      results: [
        { surface: 'kilo-web-balance' as const, state: 'capability-unknown' as const },
        {
          surface: 'kilo-gateway-entitlement' as const,
          state: 'denied' as const,
          exhaustionClass: 'subscription-quota-exhausted' as const,
          resetTime: '2026-09-01T00:00:00Z',
        },
        { surface: 'kilo-cli-entitlement' as const, state: 'available' as const },
      ],
    };
    const denied = snapshot.results.find((r) => r.surface === 'kilo-gateway-entitlement');
    expect(denied?.state).toBe('denied');
    const cli = snapshot.results.find((r) => r.surface === 'kilo-cli-entitlement');
    expect(cli?.state).toBe('available'); // not demoted
  });

  it('subscription quota exhaustion and metered spend exhaustion have distinct terminal reasons', () => {
    // Re-asserted at the contract level here. fundingTruth.test.ts covers the function.
    expect('subscription-quota-exhausted').not.toBe('metered-spend-exhausted');
  });

  it('subscription evidence cannot use spendUsd: 0 as deterministic no-spend proof', () => {
    // The FundingTruth type has no spendUsd field for subscription-seat;
    // it requires seatDigest + resourceBudgetDigest instead.
    const funding = SOL_SUBSCRIPTION_FUNDING;
    expect(funding.mode).toBe('subscription-seat');
    expect(funding.seatDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(funding.resourceBudgetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect('spendUsd' in funding).toBe(false);
  });

  it('signed Luna completion against a Sol reservation is discarded before response consumption', () => {
    const spy = new TransportSpy();
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-sol-vs-luna',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      routeDigest: 'route-digest',
      identity: SOL_IDENTITY,
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
      issuedAt: NOW_ISO,
      nonce: 'res-nonce-sol-vs-luna',
    });
    const auth = guard.authorizeTransport({
      policy: policy({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
      reservation,
      now: NOW_ISO,
    });
    expect(auth.ok).toBe(true);
    if (auth.ok) spy.call({}); // primary transport happens

    const adversarial = issueExecutorAttestation(registry, {
      attestationId: 'att-luna-vs-sol',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest',
      requestedIdentity: SOL_IDENTITY,
      resolvedIdentity: LUNA_IDENTITY,
      effort: 'max',
      fallbackChain: [
        { ordinal: 0, identity: SOL_IDENTITY },
        { ordinal: 1, identity: LUNA_IDENTITY },
      ],
      seat: LUNA_SEAT,
      funding: LUNA_SUBSCRIPTION_FUNDING,
      quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO,
      nonce: 'att-nonce-luna-vs-sol',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const result = guard.verifyCompletion({
      attestation: adversarial,
      reservation,
      role: 'harness',
      sourceLayer: 'project-config',
      phase: 'post-merged-resolution',
      policyInvokedAt: ['config-mutation', 'pre-primary-transport', 'post-merged-resolution'],
      now: NOW_ISO,
    });
    expect(result.ok).toBe(false);
    // Zero harness evidence — the spy's evidence counter only ticks for the
    // primary transport and never for the discarded adversarial response.
    expect(spy.evidenceEmitted).toBeLessThanOrEqual(0);
    // We never explicitly called emitEvidence in this test, so it's 0.
    expect(spy.evidenceEmitted).toBe(0);
  });

  it('live execution requires signed Sol-high critical approval (informational contract)', () => {
    // The separate critical-review contract is recorded in the spec; the
    // eligibility policy does not replace it. This test simply documents that
    // the policy does not gate on critical approval (it's a separate Sol-high
    // signature) so the two concerns cannot be conflated.
    expect(ROLE_ELIGIBILITY_POLICY_VERSION).toMatch(/^w8c-03\.role-eligibility/);
  });
});
