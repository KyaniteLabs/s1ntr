import path from 'node:path';
import { createProductionLiminalRuntime,
  type ProductionLiminalRuntime } from '../runtime-core/ProductionLiminalRuntime.js';

export interface ProductionProviderEffectInput<T> {
  /** Journal key. Same key replays the stored result instead of re-running the effect. */
  readonly idempotencyKey: string;
  /** Digest-bound description of what this grant is for (surface, prompt, target). */
  readonly binding: unknown;
  /** Absolute runtime root. Omit to use SINTER_LIMINAL_RUNTIME_ROOT or ~/.sinter. */
  readonly outputRoot?: string;
  /** Provider calls made here run under one journal-reserved generator grant. */
  readonly effect: () => Promise<T>;
}

type RuntimeFactory = (options: { root?: string }) => Promise<ProductionLiminalRuntime>;

/**
 * Run provider calls under a journal-reserved, generator-role transport grant.
 *
 * Lifecycle: reserve (journal.reserveEffect + reserveTransportAttempt) -> use
 * (effect runs inside withLiminalProductTransportAuthority) -> settle
 * (completeEffect on success, failTransportAttempt + finishEffect on throw).
 * The runtime is closed on both paths. Shared by compose, live-music and fix.
 */
export async function runProductionCliProviderEffect<T>(
  input: ProductionProviderEffectInput<T>,
  runtimeFactory: RuntimeFactory = createProductionLiminalRuntime,
): Promise<T> {
  if (input.outputRoot !== undefined && !path.isAbsolute(input.outputRoot)) {
    throw new Error('GOVERNED_PROVIDER_EFFECT_ROOT_NOT_ABSOLUTE');
  }
  const runtime = await runtimeFactory(
    input.outputRoot === undefined ? {} : { root: input.outputRoot });
  try {
    return await runtime.port.runResearchProviderEffect({
      idempotencyKey: input.idempotencyKey,
      binding: input.binding,
      identity: runtime.identities.generator,
      role: 'generator',
      maxTransportAttempts: 1,
      effect: input.effect,
    });
  } finally {
    await runtime.close();
  }
}
