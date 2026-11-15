export interface DreamRecoveryCapability { readonly kind: 'dream-operator-recovery' }

interface RecoveryGrant { aggregateId: string; reason: string }

export interface DreamRecoveryIssuer {
  authorizeAbandon(aggregateId: string, reason: string): DreamRecoveryCapability;
}

export interface DreamRecoveryResolver {
  assertAbandon(capability: DreamRecoveryCapability,
    aggregateId: string, reason: string): void;
}

/** Explicit operator-only authority for recovery after the campaign lease is unavailable. */
export function createDreamRecoveryAuthority(): {
  issuer: DreamRecoveryIssuer; resolver: DreamRecoveryResolver } {
  const grants = new WeakMap<object, RecoveryGrant>();
  return {
    issuer: Object.freeze({ authorizeAbandon(aggregateId: string, reason: string) {
      const capability = Object.freeze({ kind: 'dream-operator-recovery' as const });
      grants.set(capability, Object.freeze({ aggregateId, reason }));
      return capability;
    } }),
    resolver: Object.freeze({ assertAbandon(capability: DreamRecoveryCapability,
      aggregateId: string, reason: string) {
      const grant = grants.get(capability);
      if (grant?.aggregateId !== aggregateId || grant.reason !== reason) {
        throw new Error('DREAM_RECOVERY_CAPABILITY_INVALID');
      }
    } }),
  };
}
