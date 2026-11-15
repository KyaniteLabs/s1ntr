/**
 * ExecutorReservationV1 for W8C-03 (#716).
 *
 * The harness transport requires an atomically consumed host-signed
 * reservation before any network access. The reservation binds the request
 * and transport route to one actual provider/model/effort and sets
 * `substitutionAllowed: false`. The transport consumes the reservation
 * atomically and cannot rewrite its executor.
 *
 * Spec: W8C-03 product change — "Harness transport additionally requires a
 * host-signed `ExecutorReservation v1` before network access."
 */

import type { HostAdapterRegistry } from './hostAdapterRegistry.js';
import { closeSync, mkdirSync, openSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { type ExecutorIdentity, type FundingTruth, type ProviderSurface, type SeatBinding } from './types.js';

/**
 * Reservation subject. The signed payload binds exactly these fields; any
 * downstream mismatch is a typed failure.
 */
export interface ExecutorReservationSubjectV1 {
  readonly schemaVersion: 'executor-reservation.v1';
  readonly reservationId: string;
  readonly runDigest: string;
  readonly requestDigest: string;
  readonly routeDigest: string;
  readonly identity: ExecutorIdentity;
  readonly seat: SeatBinding;
  readonly funding: FundingTruth;
  readonly substitutionAllowed: false;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly adapterId: string;
  readonly surface: ProviderSurface;
}

/**
 * Signed reservation envelope. The {@link subject} is canonical JSON; the
 * {@link signature} is HMAC-SHA256 over that canonical JSON.
 */
export interface ExecutorReservationV1 {
  readonly subject: ExecutorReservationSubjectV1;
  readonly signature: string;
}

/**
 * Build the canonical subject object. Field order is stable so signatures are
 * reproducible.
 */
function buildSubject(input: {
  reservationId: string;
  runDigest: string;
  requestDigest: string;
  routeDigest: string;
  identity: ExecutorIdentity;
  seat: SeatBinding;
  funding: FundingTruth;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
  adapterId: string;
  surface: ProviderSurface;
}): ExecutorReservationSubjectV1 {
  return {
    schemaVersion: 'executor-reservation.v1',
    reservationId: input.reservationId,
    runDigest: input.runDigest,
    requestDigest: input.requestDigest,
    routeDigest: input.routeDigest,
    identity: input.identity,
    seat: input.seat,
    funding: input.funding,
    substitutionAllowed: false,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    keyId: input.keyId,
    adapterId: input.adapterId,
    surface: input.surface,
  };
}

/**
 * Reservation issue options. Defaults: 60-second expiry.
 */
export interface IssueReservationOptions {
  readonly reservationId: string;
  readonly runDigest: string;
  readonly requestDigest: string;
  readonly routeDigest: string;
  readonly identity: ExecutorIdentity;
  readonly seat: SeatBinding;
  readonly funding: FundingTruth;
  readonly surface: ProviderSurface;
  readonly issuedAt: string;
  readonly ttlMs?: number;
  readonly nonce: string;
}

/**
 * Typed reservation verification failures.
 */
export type ReservationVerificationFailure =
  | 'signature-invalid'
  | 'schema-version-mismatch'
  | 'expired'
  | 'wrong-trust-key'
  | 'adapter-cannot-enforce-no-substitution'
  | 'substitution-allowed';

/**
 * Issue a host-signed reservation. Only callable on the registry itself so the
 * trust key never leaves it.
 */
export function issueExecutorReservation(
  registry: HostAdapterRegistry,
  options: IssueReservationOptions,
): ExecutorReservationV1 {
  const adapter = registry.adapterForSurface(options.surface);
  if (!adapter) {
    throw new Error(`RESERVATION_ADAPTER_UNKNOWN: surface ${options.surface}`);
  }
  if (!adapter.canEnforceNoSubstitution) {
    throw new Error(`RESERVATION_ADAPTER_CANNOT_ENFORCE: surface ${options.surface} cannot guarantee no substitution`);
  }
  const expiresAtMs = Date.parse(options.issuedAt) + (options.ttlMs ?? 60_000);
  const expiresAt = new Date(expiresAtMs).toISOString();
  const subject = buildSubject({
    reservationId: options.reservationId,
    runDigest: options.runDigest,
    requestDigest: options.requestDigest,
    routeDigest: options.routeDigest,
    identity: options.identity,
    seat: options.seat,
    funding: options.funding,
    issuedAt: options.issuedAt,
    expiresAt,
    nonce: options.nonce,
    keyId: registry.keyId,
    adapterId: adapter.adapterId,
    surface: options.surface,
  });
  const signature = registry.issueReservationSignature(subject);
  return Object.freeze({ subject, signature });
}

/**
 * Verify a reservation against a registry. Does *not* consume the reservation;
 * {@link consumeExecutorReservation} does the atomic consume.
 */
export function verifyExecutorReservation(
  registry: HostAdapterRegistry,
  reservation: ExecutorReservationV1,
  now: string,
): { ok: true } | { ok: false; reason: ReservationVerificationFailure; detail: string } {
  if (reservation.subject.schemaVersion !== 'executor-reservation.v1') {
    return { ok: false, reason: 'schema-version-mismatch', detail: `unexpected schema ${reservation.subject.schemaVersion}` };
  }
  if (reservation.subject.substitutionAllowed !== false) {
    return { ok: false, reason: 'substitution-allowed', detail: 'reservation must forbid substitution' };
  }
  if (reservation.subject.keyId !== registry.keyId) {
    return { ok: false, reason: 'wrong-trust-key', detail: `key ${reservation.subject.keyId} != ${registry.keyId}` };
  }
  if (!registry.verify(reservation.subject, reservation.signature)) {
    return { ok: false, reason: 'signature-invalid', detail: 'signature does not verify under trust key' };
  }
  if (Date.parse(now) >= Date.parse(reservation.subject.expiresAt)) {
    return { ok: false, reason: 'expired', detail: `reservation expired at ${reservation.subject.expiresAt}` };
  }
  const adapter = registry.adapterForSurface(reservation.subject.surface);
  if (!adapter || !adapter.canEnforceNoSubstitution) {
    return { ok: false, reason: 'adapter-cannot-enforce-no-substitution', detail: `surface ${reservation.subject.surface} cannot enforce no substitution` };
  }
  return { ok: true };
}

/**
 * Atomic consume. A reservation can be consumed at most once; subsequent
 * attempts return `already-consumed`. The tracker is intentionally in-memory
 * for process-local reservations; durable ledgers persist the burn separately.
 */
export class ReservationTracker {
  readonly #consumed = new Map<string, { consumedAt: string }>();
  readonly #directory: string | undefined;

  constructor(directory?: string) {
    this.#directory = directory;
    if (directory) mkdirSync(directory, { recursive: true });
  }

  get durable(): boolean { return this.#directory !== undefined; }

  #path(reservationId: string): string {
    return join(this.#directory!, createHash('sha256').update(reservationId).digest('hex'));
  }

  consume(reservation: ExecutorReservationV1, now: string): { ok: true } | { ok: false; reason: 'already-consumed' } {
    if (this.#directory) {
      let fd: number | undefined;
      try {
        fd = openSync(this.#path(reservation.subject.reservationId), 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ consumedAt: now, reservationId: reservation.subject.reservationId }));
        closeSync(fd);
        return { ok: true };
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already-consumed' };
        throw error;
      }
    }
    if (this.#consumed.has(reservation.subject.reservationId)) {
      return { ok: false, reason: 'already-consumed' };
    }
    this.#consumed.set(reservation.subject.reservationId, { consumedAt: now });
    return { ok: true };
  }

  isConsumed(reservationId: string): boolean {
    if (this.#directory) return existsSync(this.#path(reservationId));
    return this.#consumed.has(reservationId);
  }

  clear(): void {
    this.#consumed.clear();
  }
}
