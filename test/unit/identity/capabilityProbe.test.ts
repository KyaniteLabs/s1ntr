import { describe, it, expect } from 'vitest';
import {
  buildCapabilitySnapshot,
  isSurfaceAttestedAvailable,
  isSurfaceAvailable,
  isSurfaceDenied,
  kiloGatewayDenied,
  probeResult,
  quotaSurfaceFor,
} from '../../../src/identity/capabilityProbe.js';

describe('CapabilityProbe', () => {
  it('Kilo gateway denial preserves unknown status for other Kilo surfaces', () => {
    const snapshot = kiloGatewayDenied({
      gatewayExhaustionClass: 'subscription-quota-exhausted',
      resetTime: '2026-09-01T00:00:00Z',
      webBalanceState: 'capability-unknown',
      cliState: 'available',
    });
    expect(isSurfaceDenied(snapshot, 'kilo-gateway-entitlement')).toBe(true);
    expect(isSurfaceAvailable(snapshot, 'kilo-cli-entitlement')).toBe(true);
    expect(probeResult(snapshot, 'kilo-web-balance')?.state).toBe('capability-unknown');
    // The denial does not demote unrelated surfaces
    expect(isSurfaceDenied(snapshot, 'kilo-web-balance')).toBe(false);
  });

  it('quotaSurfaceFor maps each Kilo surface to a distinct quota surface', () => {
    expect(quotaSurfaceFor('kilo-gateway-entitlement')).toBe('kilo-gateway-entitlement');
    expect(quotaSurfaceFor('kilo-cli-entitlement')).toBe('kilo-cli-entitlement');
    expect(quotaSurfaceFor('kilo-web-balance')).toBe('kilo-web-balance');
    expect(quotaSurfaceFor('cliproxy-seat')).toBe('cliproxy-seat');
  });

  it('buildCapabilitySnapshot rejects duplicate surface entries', () => {
    expect(() =>
      buildCapabilitySnapshot([
        { surface: 'cliproxy-seat', state: 'available' },
        { surface: 'cliproxy-seat', state: 'denied' },
      ]),
    ).toThrow(/DUPLICATE/);
  });

  it('gateway denied snapshot reports exhaustion class and reset time', () => {
    const snapshot = kiloGatewayDenied({
      gatewayExhaustionClass: 'rate-limited',
      resetTime: '2026-08-02T00:00:00Z',
    });
    const gateway = probeResult(snapshot, 'kilo-gateway-entitlement');
    expect(gateway?.exhaustionClass).toBe('rate-limited');
    expect(gateway?.resetTime).toBe('2026-08-02T00:00:00Z');
  });

  describe('isSurfaceAttestedAvailable (#1296)', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const maxAgeMs = 5 * 60_000;
    const attested = (evidence?: { probeClass: string; probedAt: string }, state: 'available' | 'denied' = 'available') =>
      buildCapabilitySnapshot([{ surface: 'cliproxy-seat', state, evidence }]);

    it('an available state with no probe evidence is reported but not attested', () => {
      const snapshot = attested(undefined);
      expect(isSurfaceAvailable(snapshot, 'cliproxy-seat')).toBe(true);
      expect(isSurfaceAttestedAvailable(snapshot, 'cliproxy-seat', { now, maxAgeMs })).toBe(false);
    });

    it('fresh evidence from a named probe class attests availability', () => {
      const snapshot = attested({ probeClass: 'http-health', probedAt: '2026-11-09T11:58:00Z' });
      expect(isSurfaceAttestedAvailable(snapshot, 'cliproxy-seat', { now, maxAgeMs })).toBe(true);
    });

    it('rejects stale, future, unparseable, and empty-class evidence', () => {
      const cases = [
        { probeClass: 'http-health', probedAt: '2026-11-09T11:50:00Z' }, // 10 min old
        { probeClass: 'http-health', probedAt: '2026-11-09T12:01:00Z' }, // future
        { probeClass: 'http-health', probedAt: 'yesterday-ish' },
        { probeClass: '  ', probedAt: '2026-11-09T11:59:00Z' },
      ];
      const verdicts = cases.map((e) => isSurfaceAttestedAvailable(attested(e), 'cliproxy-seat', { now, maxAgeMs }));
      expect(verdicts).toEqual([false, false, false, false]);
    });

    it('evidence cannot make a denied or missing surface available, and bad bounds fail closed', () => {
      const evidence = { probeClass: 'http-health', probedAt: '2026-11-09T11:59:00Z' };
      expect(isSurfaceAttestedAvailable(attested(evidence, 'denied'), 'cliproxy-seat', { now, maxAgeMs })).toBe(false);
      expect(isSurfaceAttestedAvailable(attested(evidence), 'kilo-cli-entitlement', { now, maxAgeMs })).toBe(false);
      expect(isSurfaceAttestedAvailable(attested(evidence), 'cliproxy-seat', { now, maxAgeMs: Number.NaN })).toBe(false);
      expect(isSurfaceAttestedAvailable(attested(evidence), 'cliproxy-seat', { now, maxAgeMs: -1 })).toBe(false);
    });
  });
});
