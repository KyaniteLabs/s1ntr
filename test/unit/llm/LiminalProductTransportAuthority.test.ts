import { describe, expect, it } from 'vitest';
import { assertRoleBoundProviderAttempt, withLiminalProductTransportAuthority } from
  '../../../src/llm/LLMClient.js';
import { createTestCreativeAdmissionSigner } from
  '../../../src/runtime-core/CreativeAdmissionAuthority.js';

describe('Liminal product transport authority', () => {
  it('fails production transport closed when role or product authority is missing', async () => {
    expect(() => assertRoleBoundProviderAttempt(undefined, 'production'))
      .toThrow('Roleless provider transport is forbidden');
    expect(() => assertRoleBoundProviderAttempt('generator', 'production'))
      .toThrow('Provider transport requires Liminal product command authority');
    const authority = createTestCreativeAdmissionSigner('transport-authority-test');
    const scope = { schema: 'sinter.product-transport-scope' as const, schemaVersion: 1 as const,
      operationId: 'operation:1', effectId: 'effect:1', reservationDigest: 'a'.repeat(64),
      purpose: 'generation' as const, role: 'generator' as const };
    const grant = { scope, proof: authority.sealAdmission(scope) };
    await expect(withLiminalProductTransportAuthority(grant, async () => {
      assertRoleBoundProviderAttempt('generator', 'production');
    })).resolves.toBeUndefined();
    await expect(withLiminalProductTransportAuthority(grant, async () => {
      assertRoleBoundProviderAttempt('evaluator', 'production');
    })).rejects.toThrow('Provider transport requires Liminal product command authority');
    const studioScope = { ...scope, purpose: 'studio' as const, role: 'studio' as const,
      operationId: 'operation:studio', effectId: 'effect:studio' };
    const studioGrant = { scope: studioScope, proof: authority.sealAdmission(studioScope) };
    await expect(withLiminalProductTransportAuthority(studioGrant, async () => {
      assertRoleBoundProviderAttempt('studio', 'production');
    })).resolves.toBeUndefined();
    const harnessScope = { ...scope, purpose: 'harness' as const, role: 'harness' as const,
      operationId: 'operation:harness', effectId: 'effect:harness' };
    const harnessGrant = { scope: harnessScope, proof: authority.sealAdmission(harnessScope) };
    await expect(withLiminalProductTransportAuthority(harnessGrant, async () => {
      assertRoleBoundProviderAttempt('harness', 'production');
    })).resolves.toBeUndefined();
    expect(() => assertRoleBoundProviderAttempt('studio', 'production'))
      .toThrow('Provider transport requires Liminal product command authority');
    await expect(withLiminalProductTransportAuthority({ ...grant,
      scope: { ...scope, operationId: 'operation:replayed' } }, async () => {
      assertRoleBoundProviderAttempt('generator', 'production');
    })).rejects.toThrow('Provider transport requires Liminal product command authority');
    await expect(withLiminalProductTransportAuthority({ ...grant,
      scope: { ...scope, reservationDigest: 'b'.repeat(64) } }, async () => {
      assertRoleBoundProviderAttempt('generator', 'production');
    })).rejects.toThrow('Provider transport requires Liminal product command authority');
    await expect(withLiminalProductTransportAuthority({ ...grant,
      scope: { ...scope, purpose: 'evaluation' } }, async () => {
      assertRoleBoundProviderAttempt('generator', 'production');
    })).rejects.toThrow('Provider transport requires Liminal product command authority');
  });

  it('rejects a forged production transport capability', async () => {
    const forged = { scope: { schema: 'sinter.product-transport-scope' as const,
      schemaVersion: 1 as const, operationId: 'forged', effectId: 'forged',
      reservationDigest: 'a'.repeat(64), purpose: 'generation' as const,
      role: 'generator' as const }, proof: { authorityTier: 'production' as const,
      authorityKeyDigest: 'a'.repeat(64), signature: 'b'.repeat(64) } };
    await expect(withLiminalProductTransportAuthority(forged, async () => {
      assertRoleBoundProviderAttempt('generator', 'production');
    })).rejects.toThrow('Provider transport requires Liminal product command authority');
  });
});
