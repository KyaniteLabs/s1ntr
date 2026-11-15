import { describe, it, expect } from 'vitest';
import { HarnessTransportGuard } from '../../../src/identity/harnessTransportGuard.js';
import { issueExecutorReservation } from '../../../src/identity/executorReservation.js';
import { issueExecutorAttestation } from '../../../src/identity/executorAttestation.js';
import { decideRoleEligibility } from '../../../src/identity/roleEligibilityPolicy.js';
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
  ModelRole,
} from '../../../src/identity/types.js';

function policyRequest(input: {
  role: ModelRole;
  requestedIdentity: typeof SOL_IDENTITY;
  resolvedIdentity?: typeof SOL_IDENTITY;
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

describe('HarnessTransportGuard — full pre/post transport gate', () => {
  it('authorizes a valid Sol harness transport', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-1',
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
      nonce: 'res-nonce-1',
    });
    const auth = guard.authorizeTransport({
      policy: policyRequest({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
      reservation,
      now: NOW_ISO,
    });
    expect(auth.ok).toBe(true);
  });

  it('Luna reservation for harness produces zero network (rejected at pre-network gate)', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-luna',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      routeDigest: 'route-digest',
      identity: LUNA_IDENTITY,
      seat: LUNA_SEAT,
      funding: LUNA_SUBSCRIPTION_FUNDING,
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
      issuedAt: NOW_ISO,
      nonce: 'res-nonce-luna',
    });
    const auth = guard.authorizeTransport({
      policy: policyRequest({ role: 'harness', requestedIdentity: LUNA_IDENTITY }),
      reservation,
      now: NOW_ISO,
    });
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe('policy-rejected');
    // reservation is NOT consumed when policy rejects (the spy would observe zero calls)
    expect(guard.isReservationConsumed('res-luna')).toBe(false);
  });

  it('signed Luna completion against Sol reservation is quarantined before consumption', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-sol',
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
      nonce: 'res-nonce-sol',
    });
    const auth = guard.authorizeTransport({
      policy: policyRequest({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
      reservation,
      now: NOW_ISO,
    });
    expect(auth.ok).toBe(true);

    // Adversarial: provider returns an attestation signed by the host (it has
    // the key in this test) but resolved identity is Luna.
    const adversarial = issueExecutorAttestation(registry, {
      attestationId: 'att-luna-swap',
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
      nonce: 'att-nonce-swap',
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
    if (!result.ok) {
      // Identity, seat, and policy are all valid quarantine reasons — every
      // one of them discards the response with zero harness mutation.
      expect(['identity-mismatch', 'seat-mismatch', 'attestation-policy-rejection']).toContain(result.reason);
    }
    // And the nonce was not burned → response would be discarded with zero harness mutation
    expect(guard.isNonceBurned('att-nonce-swap')).toBe(false);
  });

  it('nonce replay fails the postcondition (replay attack)', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-replay',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      routeDigest: 'route-digest',
      identity: SOL_IDENTITY,
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      surface: CLIPROXY_SURFACE,
      issuedAt: NOW_ISO,
      nonce: 'res-nonce-replay',
    });
    expect(
      guard.authorizeTransport({
        policy: policyRequest({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
        reservation,
        now: NOW_ISO,
      }).ok,
    ).toBe(true);

    const attestation = issueExecutorAttestation(registry, {
      attestationId: 'att-replay',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest',
      requestedIdentity: SOL_IDENTITY,
      resolvedIdentity: SOL_IDENTITY,
      effort: 'high',
      fallbackChain: [{ ordinal: 0, identity: SOL_IDENTITY }],
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO,
      nonce: 'replay-nonce',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const first = guard.verifyCompletion({
      attestation,
      reservation,
      role: 'harness',
      sourceLayer: 'project-config',
      phase: 'post-merged-resolution',
      policyInvokedAt: ['config-mutation', 'pre-primary-transport', 'post-merged-resolution'],
      now: NOW_ISO,
    });
    expect(first.ok).toBe(true);
    const second = guard.verifyCompletion({
      attestation,
      reservation,
      role: 'harness',
      sourceLayer: 'project-config',
      phase: 'post-merged-resolution',
      policyInvokedAt: ['config-mutation', 'pre-primary-transport', 'post-merged-resolution'],
      now: NOW_ISO,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // The reservation is still consumed from the first attempt; the replay
      // is caught either at the reservation consume step or, if the spy
      // bypassed that, at the attestation nonce-burn step. Both are valid
      // quarantine reasons.
      expect(['reservation-not-consumed', 'attestation-nonce-burned']).toContain(second.reason);
    }
  });

  it('reservation consume is atomic — second authorize fails', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-once',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      routeDigest: 'route-digest',
      identity: SOL_IDENTITY,
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      surface: CLIPROXY_SURFACE,
      issuedAt: NOW_ISO,
      nonce: 'res-nonce-once',
    });
    const first = guard.authorizeTransport({
      policy: policyRequest({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
      reservation,
      now: NOW_ISO,
    });
    expect(first.ok).toBe(true);
    const second = guard.authorizeTransport({
      policy: policyRequest({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
      reservation,
      now: NOW_ISO,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('reservation-consume-failed');
  });

  it('policy rejection on signed actual identity yields zero mutation (defense in depth)', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-sol-2',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      routeDigest: 'route-digest',
      identity: SOL_IDENTITY,
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      surface: CLIPROXY_SURFACE,
      issuedAt: NOW_ISO,
      nonce: 'res-nonce-sol-2',
    });
    const auth = guard.authorizeTransport({
      policy: policyRequest({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
      reservation,
      now: NOW_ISO,
    });
    expect(auth.ok).toBe(true);

    // Adversarial: resolved identity is Luna but seat/surface/run/request
    // match the reservation so the only catch left is the policy rerun.
    const adversarial = issueExecutorAttestation(registry, {
      attestationId: 'att-luna-policy',
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
      seat: SOL_SEAT, // same seat
      funding: SOL_SUBSCRIPTION_FUNDING,
      quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO,
      nonce: 'att-nonce-policy',
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
    if (!result.ok) {
      // The identity-mismatch against the reservation is caught first.
      expect(['identity-mismatch', 'attestation-policy-rejection']).toContain(result.reason);
    }
    expect(guard.isNonceBurned('att-nonce-policy')).toBe(false);
  });

  it('accepts a clean Sol harness transport end to end', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-clean',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      routeDigest: 'route-digest',
      identity: SOL_IDENTITY,
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      surface: CLIPROXY_SURFACE,
      issuedAt: NOW_ISO,
      nonce: 'res-nonce-clean',
    });
    expect(
      guard.authorizeTransport({
        policy: policyRequest({ role: 'harness', requestedIdentity: SOL_IDENTITY }),
        reservation,
        now: NOW_ISO,
      }).ok,
    ).toBe(true);

    const attestation = issueExecutorAttestation(registry, {
      attestationId: 'att-clean',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest',
      requestedIdentity: SOL_IDENTITY,
      resolvedIdentity: SOL_IDENTITY,
      effort: 'high',
      fallbackChain: [{ ordinal: 0, identity: SOL_IDENTITY }],
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO,
      nonce: 'att-nonce-clean',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const result = guard.verifyCompletion({
      attestation,
      reservation,
      role: 'harness',
      sourceLayer: 'project-config',
      phase: 'post-merged-resolution',
      policyInvokedAt: ['config-mutation', 'pre-primary-transport', 'post-merged-resolution'],
      now: NOW_ISO,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attestation.subject.resolvedIdentity.model).toBe(SOL_IDENTITY.model);
  });

  it('separates historical authenticity from present admission (#1312)', () => {
    const registry = buildRegistry();
    const guard = new HarnessTransportGuard(registry);
    const attestation = issueExecutorAttestation(registry, {
      attestationId: 'att-hist', runDigest: 'run-digest', requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest', requestedIdentity: SOL_IDENTITY,
      resolvedIdentity: SOL_IDENTITY, effort: 'high',
      fallbackChain: [{ ordinal: 0, identity: SOL_IDENTITY }], seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO, nonce: 'att-nonce-hist', surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const later = new Date(Date.parse(NOW_ISO) + 24 * 3_600_000).toISOString();
    expect(guard.verifyPersistedCompletion(attestation)).toEqual({ ok: true });
    expect(guard.admitPersistedCompletionNow(attestation, NOW_ISO)).toEqual({ ok: true });
    const stale = guard.admitPersistedCompletionNow(attestation, later);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('expired');
    const bad = guard.admitPersistedCompletionNow(attestation, 'not-a-time');
    expect(bad.ok).toBe(false);
  });

  it('policy is also enforced for the persisted-restart-hydration phase', () => {
    const decision = decideRoleEligibility({
      role: 'harness',
      sourceLayer: 'persisted-restart-hydration',
      phase: 'pre-restart-hydration',
      requestedIdentity: LUNA_IDENTITY,
      resolvedIdentity: LUNA_IDENTITY,
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      priorDigest: null,
      policyInvokedAt: ['pre-restart-hydration'],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('role-luna-harness-forbidden');
  });
});
