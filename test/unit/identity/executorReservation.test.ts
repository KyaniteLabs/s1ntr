import { describe, it, expect } from 'vitest';
import {
  issueExecutorReservation,
  verifyExecutorReservation,
  ReservationTracker,
  type ExecutorReservationV1,
} from '../../../src/identity/executorReservation.js';
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

function baseReservationInput() {
  return {
    reservationId: 'res-1',
    runDigest: 'run-digest',
    requestDigest: 'request-digest',
    routeDigest: 'route-digest',
    identity: SOL_IDENTITY,
    seat: SOL_SEAT,
    funding: SOL_SUBSCRIPTION_FUNDING,
    surface: CLIPROXY_SURFACE,
    issuedAt: NOW_ISO,
    nonce: 'nonce-1',
  };
}

describe('ExecutorReservation v1', () => {
  it('issue produces a signed reservation with substitution forbidden', () => {
    const registry = buildRegistry();
    const reservation = issueExecutorReservation(registry, baseReservationInput());
    expect(reservation.subject.schemaVersion).toBe('executor-reservation.v1');
    expect(reservation.subject.substitutionAllowed).toBe(false);
    expect(reservation.signature).toMatch(/\S/);
  });

  it('verify accepts a fresh reservation', () => {
    const registry = buildRegistry();
    const reservation = issueExecutorReservation(registry, baseReservationInput());
    const result = verifyExecutorReservation(registry, reservation, NOW_ISO);
    expect(result.ok).toBe(true);
  });

  it('verify rejects tampered signature', () => {
    const registry = buildRegistry();
    const reservation = issueExecutorReservation(registry, baseReservationInput());
    const tampered: ExecutorReservationV1 = {
      subject: reservation.subject,
      signature: reservation.signature.slice(0, -2) + 'XX',
    };
    const result = verifyExecutorReservation(registry, tampered, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-invalid');
  });

  it('verify rejects signature under a different trust key', () => {
    const registry = buildRegistry();
    const other = buildForeignRegistry(); // different key id
    const reservation = issueExecutorReservation(other, baseReservationInput());
    const result = verifyExecutorReservation(registry, reservation, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-trust-key');
  });

  it('verify rejects an expired reservation', () => {
    const registry = buildRegistry();
    const reservation = issueExecutorReservation(registry, {
      ...baseReservationInput(),
      ttlMs: 1,
      issuedAt: '2020-01-01T00:00:00.000Z',
    });
    const result = verifyExecutorReservation(registry, reservation, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('issue refuses on a substitution-capable surface (harness-ineligible route)', () => {
    const registry = buildRegistry();
    expect(() =>
      issueExecutorReservation(registry, {
        ...baseReservationInput(),
        surface: 'openai-direct', // adapter has canEnforceNoSubstitution=false
      }),
    ).toThrow(/CANNOT_ENFORCE/);
  });

  it('tracker consumes a reservation exactly once (atomic)', () => {
    const registry = buildRegistry();
    const reservation = issueExecutorReservation(registry, baseReservationInput());
    const tracker = new ReservationTracker();
    expect(tracker.consume(reservation, NOW_ISO)).toEqual({ ok: true });
    const second = tracker.consume(reservation, NOW_ISO);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-consumed');
    expect(tracker.isConsumed(reservation.subject.reservationId)).toBe(true);
  });

  it('Luna reservation carries the Luna identity (request Sol/execute Luna evidence base)', () => {
    const registry = buildRegistry();
    const reservation = issueExecutorReservation(registry, {
      ...baseReservationInput(),
      identity: LUNA_IDENTITY,
      seat: LUNA_SEAT,
      funding: LUNA_SUBSCRIPTION_FUNDING,
    });
    expect(reservation.subject.identity.model).toBe(LUNA_IDENTITY.model);
    expect(reservation.subject.substitutionAllowed).toBe(false);
  });

  it('rejects substitutionAllowed=true if subject is re-constructed as true (defense in depth)', () => {
    const registry = buildRegistry();
    const reservation = issueExecutorReservation(registry, baseReservationInput());
    const tampered: ExecutorReservationV1 = {
      subject: {
        ...reservation.subject,
        // @ts-expect-error deliberately breaking the type to test the verifier
        substitutionAllowed: true,
      },
      signature: reservation.signature,
    };
    const result = verifyExecutorReservation(registry, tampered, NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('substitution-allowed');
  });

  it('refuses to issue for an unknown surface', () => {
    const registry = buildRegistry();
    expect(() =>
      issueExecutorReservation(registry, {
        ...baseReservationInput(),
        // @ts-expect-error deliberately out-of-registry surface
        surface: 'unknown',
      }),
    ).toThrow(/ADAPTER_UNKNOWN/);
  });

  void SOL_IDENTITY;
});
