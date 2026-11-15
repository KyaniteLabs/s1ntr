import { describe, it, expect } from 'vitest';
import {
  issueExecutorAttestation,
  verifyExecutorAttestation,
  verifyAttestationAgainstReservation,
  NonceLedger,
  type ExecutorAttestationV2,
  type IssueAttestationOptions,
} from '../../../src/identity/executorAttestation.js';
import { issueExecutorReservation, type ExecutorReservationV1 } from '../../../src/identity/executorReservation.js';
import {
  buildForeignRegistry,
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

function baseReservation(): ExecutorReservationV1 {
  return issueExecutorReservation(buildRegistry(), {
    reservationId: 'res-1',
    runDigest: 'run-digest',
    requestDigest: 'request-digest',
    routeDigest: 'route-digest',
    identity: SOL_IDENTITY,
    seat: SOL_SEAT,
    funding: SOL_SUBSCRIPTION_FUNDING,
    surface: CLIPROXY_SURFACE,
    issuedAt: NOW_ISO,
    nonce: 'res-nonce-1',
  });
}

function baseAttestation(input?: {
  requestedIdentity?: typeof SOL_IDENTITY;
  resolvedIdentity?: typeof SOL_IDENTITY;
  surface?: typeof CLIPROXY_SURFACE;
  seat?: typeof SOL_SEAT;
  funding?: typeof SOL_SUBSCRIPTION_FUNDING;
  nonce?: string;
  fallbackChain?: readonly { ordinal: number; identity: typeof SOL_IDENTITY; reason?: string }[];
}) {
  return issueExecutorAttestation(buildRegistry(), {
    attestationId: 'att-1',
    runDigest: 'run-digest',
    requestDigest: 'request-digest',
    attemptDigest: 'attempt-digest',
    requestedIdentity: input?.requestedIdentity ?? SOL_IDENTITY,
    resolvedIdentity: input?.resolvedIdentity ?? SOL_IDENTITY,
    effort: (input?.resolvedIdentity ?? SOL_IDENTITY).effort,
    fallbackChain: input?.fallbackChain ?? [{ ordinal: 0, identity: SOL_IDENTITY }],
    seat: input?.seat ?? SOL_SEAT,
    funding: input?.funding ?? SOL_SUBSCRIPTION_FUNDING,
    quotaSurface: 'cliproxy-seat',
    issuedAt: NOW_ISO,
    nonce: input?.nonce ?? 'att-nonce-1',
    surface: input?.surface ?? CLIPROXY_SURFACE,
    durationMs: 0, success: true,
    quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
  });
}

describe('versioned ExecutorAttestation', () => {
  it('verify accepts a freshly issued attestation', () => {
    const registry = buildRegistry();
    const attestation = baseAttestation();
    expect(verifyExecutorAttestation(registry, attestation, NOW_ISO).ok).toBe(true);
  });

  it('verify rejects a tampered signature', () => {
    const registry = buildRegistry();
    const attestation = baseAttestation();
    const tampered: ExecutorAttestationV2 = {
      subject: attestation.subject,
      signature: attestation.signature.slice(0, -2) + 'XX',
    };
    const result = verifyExecutorAttestation(registry, tampered, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-invalid');
  });

  it('verify rejects provider-self-asserted identity (signed by a different trust key)', () => {
    const foreignRegistry = buildForeignRegistry();
    const localRegistry = buildRegistry();
    const attestation = issueExecutorAttestation(foreignRegistry, {
      attestationId: 'att-foreign',
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
      nonce: 'foreign-nonce',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const result = verifyExecutorAttestation(localRegistry, attestation, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-trust-key');
  });

  it('refuses to issue v2 without an observed exact outcome', () => {
    const options = {
      attestationId: 'att-missing-outcome', runDigest: 'run-digest', requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest', requestedIdentity: SOL_IDENTITY, resolvedIdentity: SOL_IDENTITY,
      effort: 'high', fallbackChain: [{ ordinal: 0, identity: SOL_IDENTITY }],
      seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO, nonce: 'missing-outcome-nonce', surface: CLIPROXY_SURFACE,
    } as unknown as IssueAttestationOptions;
    expect(() => issueExecutorAttestation(buildRegistry(), options))
      .toThrow('ATTESTATION_EXACT_OUTCOME_REQUIRED');
  });

  it('verify rejects an expired attestation', () => {
    const registry = buildRegistry();
    const attestation = issueExecutorAttestation(registry, {
      attestationId: 'att-old',
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
      issuedAt: '2020-01-01T00:00:00.000Z',
      ttlMs: 1,
      nonce: 'old-nonce',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const result = verifyExecutorAttestation(registry, attestation, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('verify detects effort downgrade (resolved effort < declared effort)', () => {
    const registry = buildRegistry();
    const attestation = issueExecutorAttestation(registry, {
      attestationId: 'att-effort',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest',
      requestedIdentity: SOL_IDENTITY,
      resolvedIdentity: SOL_IDENTITY,
      effort: 'medium', // Mismatch with resolvedIdentity.effort='high'
      fallbackChain: [{ ordinal: 0, identity: SOL_IDENTITY }],
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO,
      nonce: 'eff-nonce',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const result = verifyExecutorAttestation(registry, attestation, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('effort-mismatch');
  });

  it('verify detects an incomplete fallback chain', () => {
    const registry = buildRegistry();
    const attestation = issueExecutorAttestation(registry, {
      attestationId: 'att-chain',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest',
      requestedIdentity: SOL_IDENTITY,
      resolvedIdentity: SOL_IDENTITY,
      effort: 'high',
      fallbackChain: [
        { ordinal: 0, identity: SOL_IDENTITY },
        { ordinal: 2, identity: SOL_IDENTITY }, // gap
      ],
      seat: SOL_SEAT,
      funding: SOL_SUBSCRIPTION_FUNDING,
      quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO,
      nonce: 'chain-nonce',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const result = verifyExecutorAttestation(registry, attestation, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fallback-chain-incomplete');
  });

  it('verifyAttestationAgainstReservation accepts matching attestation+reservation', () => {
    const reservation = baseReservation();
    const attestation = baseAttestation();
    const result = verifyAttestationAgainstReservation(attestation, reservation);
    expect(result.ok).toBe(true);
  });

  it('verifyAttestationAgainstReservation rejects alternate seat', () => {
    const reservation = baseReservation();
    const attestation = baseAttestation({ seat: LUNA_SEAT });
    const result = verifyAttestationAgainstReservation(attestation, reservation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('seat-mismatch');
  });

  it('verifyAttestationAgainstReservation rejects signed Luna completion against Sol reservation', () => {
    const reservation = baseReservation();
    const attestation = baseAttestation({
      resolvedIdentity: LUNA_IDENTITY,
      seat: LUNA_SEAT,
      funding: LUNA_SUBSCRIPTION_FUNDING,
      requestedIdentity: SOL_IDENTITY,
      fallbackChain: [
        { ordinal: 0, identity: SOL_IDENTITY },
        { ordinal: 1, identity: LUNA_IDENTITY },
      ],
    });
    const result = verifyAttestationAgainstReservation(attestation, reservation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity-mismatch');
  });

  it('verifyAttestationAgainstReservation detects hidden fallback not present in chain', () => {
    // Construct a reservation whose identity matches the attestation's
    // resolved identity so we reach the hidden-fallback check. The fallback
    // chain omits the resolved identity even though it differs from the
    // requested identity — that is the hidden fallback.
    const gemini = { provider: 'google' as const, model: 'gemini-3.1-pro-low', effort: 'low' as const };
    const registry = buildRegistry();
    const geminiSeat = { ...SOL_SEAT, seatDigest: 'gemini-seat-digest' };
    const reservation = issueExecutorReservation(registry, {
      reservationId: 'res-gemini',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      routeDigest: 'route-digest',
      identity: gemini,
      seat: geminiSeat,
      funding: { ...SOL_SUBSCRIPTION_FUNDING, seatDigest: geminiSeat.seatDigest },
      surface: CLIPROXY_SURFACE,
      issuedAt: NOW_ISO,
      nonce: 'res-nonce-gemini',
    });
    const attestation = issueExecutorAttestation(registry, {
      attestationId: 'att-hidden',
      runDigest: 'run-digest',
      requestDigest: 'request-digest',
      attemptDigest: 'attempt-digest',
      requestedIdentity: SOL_IDENTITY,
      resolvedIdentity: gemini,
      effort: 'low',
      fallbackChain: [{ ordinal: 0, identity: SOL_IDENTITY }], // gemini is not in chain
      seat: geminiSeat,
      funding: { ...SOL_SUBSCRIPTION_FUNDING, seatDigest: geminiSeat.seatDigest },
      quotaSurface: 'cliproxy-seat',
      issuedAt: NOW_ISO,
      nonce: 'att-nonce-hidden',
      surface: CLIPROXY_SURFACE,
      durationMs: 0, success: true,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    const result = verifyAttestationAgainstReservation(attestation, reservation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hidden-fallback');
  });

  it('NonceLedger burns each nonce exactly once', () => {
    const ledger = new NonceLedger();
    expect(ledger.burn('n1', 'att-1', NOW_ISO)).toEqual({ ok: true });
    const again = ledger.burn('n1', 'att-1', NOW_ISO);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('nonce-replayed');
    expect(ledger.isBurned('n1')).toBe(true);
  });
});
