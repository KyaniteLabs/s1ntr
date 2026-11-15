/**
 * Shared helpers for W8C-03 identity tests. Builds a deterministic registry,
 * identities, funding truth, and seat binding so each test stays terse.
 */

import { HostAdapterRegistry, type HostAdapterDescriptor, type HostTrustKey } from '../../../src/identity/hostAdapterRegistry.js';
import { computeSeatDigest, subscriptionFunding } from '../../../src/identity/fundingTruth.js';
import type {
  ExecutorIdentity,
  FundingTruth,
  ProviderSurface,
  SeatBinding,
} from '../../../src/identity/types.js';
import { LUNA_MODEL_ID } from '../../../src/identity/canonicalAlias.js';

export const SOL_IDENTITY: ExecutorIdentity = { provider: 'anthropic', model: 'claude-opus-4-1', effort: 'high' };
export const LUNA_IDENTITY: ExecutorIdentity = { provider: 'openai', model: LUNA_MODEL_ID, effort: 'max' };
export const GEMINI_IDENTITY: ExecutorIdentity = { provider: 'google', model: 'gemini-3.1-pro-low', effort: 'low' };

export const CLIPROXY_SURFACE: ProviderSurface = 'cliproxy-seat';

export const SOL_SEAT: SeatBinding = {
  seatId: 'cliproxy-sol-seat',
  seatDigest: computeSeatDigest('sol-seat-secret'),
  surface: CLIPROXY_SURFACE,
};

export const LUNA_SEAT: SeatBinding = {
  seatId: 'cliproxy-luna-seat',
  seatDigest: computeSeatDigest('luna-seat-secret'),
  surface: CLIPROXY_SURFACE,
};

export const SOL_SUBSCRIPTION_FUNDING: FundingTruth = subscriptionFunding({
  seatDigest: SOL_SEAT.seatDigest,
  quotaCounters: { calls: 1, inputTokens: 100, outputTokens: 50, activeSeconds: 5 },
  quotaSurface: 'cliproxy-seat',
});

export const LUNA_SUBSCRIPTION_FUNDING: FundingTruth = subscriptionFunding({
  seatDigest: LUNA_SEAT.seatDigest,
  quotaCounters: { calls: 1, inputTokens: 100, outputTokens: 50, activeSeconds: 5 },
  quotaSurface: 'cliproxy-seat',
});

/**
 * Deterministic trust key. Tests need the same key across calls so an
 * attestation issued by one registry verifies under another built from this
 * helper. The secret is a fixed UTF-8 buffer; it never leaves the test
 * boundary.
 */
const STABLE_TRUST_KEY: HostTrustKey = {
  keyId: 'test-key',
  secret: Buffer.from('w8c-03-test-trust-key-secret', 'utf8'),
};

export function buildRegistry(): HostAdapterRegistry {
  const adapters: HostAdapterDescriptor[] = [
    {
      adapterId: 'cliproxy-strict',
      surface: CLIPROXY_SURFACE,
      provider: 'openai',
      canEnforceNoSubstitution: true,
    },
    {
      adapterId: 'open-proxy-lenient',
      surface: 'openai-direct',
      provider: 'openai',
      canEnforceNoSubstitution: false,
    },
    {
      adapterId: 'kilo-gateway-strict',
      surface: 'kilo-gateway-entitlement',
      provider: 'kilo',
      canEnforceNoSubstitution: true,
    },
  ];
  return new HostAdapterRegistry(STABLE_TRUST_KEY, adapters);
}

/**
 * Build a registry with a *different* stable trust key — for negative tests
 * that need to prove a second trust key cannot verify first-key signatures.
 */
export function buildForeignRegistry(): HostAdapterRegistry {
  const adapters: HostAdapterDescriptor[] = [
    {
      adapterId: 'cliproxy-strict',
      surface: CLIPROXY_SURFACE,
      provider: 'openai',
      canEnforceNoSubstitution: true,
    },
  ];
  return new HostAdapterRegistry(
    { keyId: 'foreign-key', secret: Buffer.from('w8c-03-foreign-trust-key-secret', 'utf8') },
    adapters,
  );
}

export const NOW_ISO = '2026-08-01T12:00:00.000Z';
export const LATER_ISO = '2026-08-01T13:00:00.000Z';
