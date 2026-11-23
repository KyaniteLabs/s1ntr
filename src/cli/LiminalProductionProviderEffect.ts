import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withEvaluatorScope } from '../core/EvaluatorScope.js';
import { createProductionLiminalRuntime,
  type ProductionLiminalRuntime } from '../runtime-core/ProductionLiminalRuntime.js';

export interface ProductionProviderEffectInput<T> {
  /** Journal key. Same key replays the stored result instead of re-running the effect. */
  readonly idempotencyKey: string;
  /** Digest-bound description of what this grant is for (surface, prompt, target). */
  readonly binding: unknown;
  /** Absolute runtime root. Omit to use SINTER_LIMINAL_RUNTIME_ROOT or ~/.sinter. */
  readonly outputRoot?: string;
  /** If supplied, reserve each actual request against this ceiling before transport. */
  readonly maxGeneratorAttempts?: number;
  readonly replayOnly?: boolean;
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
  input: ProductionProviderEffectInput<T> & { readonly role?: 'generator' | 'evaluator' },
  runtimeFactory: RuntimeFactory = createProductionLiminalRuntime,
): Promise<T> {
  if (input.outputRoot !== undefined && !path.isAbsolute(input.outputRoot)) {
    throw new Error('GOVERNED_PROVIDER_EFFECT_ROOT_NOT_ABSOLUTE');
  }
  const runtime = await runtimeFactory(
    input.outputRoot === undefined ? {} : { root: input.outputRoot });
  try {
    const surface = (input.binding as { surface?: string } | null | undefined)?.surface;
    const maxGeneratorAttempts = input.maxGeneratorAttempts
      ?? (surface === 'gui-live-music' || surface === 'gui-live-visuals' ? 1 : undefined);
    const role = input.role ?? 'generator';
    return await runtime.port.runResearchProviderEffect({
      idempotencyKey: input.idempotencyKey,
      binding: input.binding,
      identity: runtime.identities[role],
      role,
      maxTransportAttempts: role === 'evaluator' ? 1 : maxGeneratorAttempts ?? 1,
      countActualAttempts: role === 'evaluator' || maxGeneratorAttempts !== undefined,
      ...(input.replayOnly ? { replayOnly: true } : {}),
      effect: input.effect,
    });
  } finally {
    await runtime.close();
  }
}

/**
 * A cycle records each transport attempt under its authorized role before sending.
 * Each evaluator call gets a separate grant and one attempt.
 */
export async function runProductionCliCycleEffect<T>(
  input: ProductionProviderEffectInput<T> & { readonly maxGeneratorAttempts: number },
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
      maxTransportAttempts: input.maxGeneratorAttempts,
      countActualAttempts: true,
      effect: () => withEvaluatorScope(call => runtime.port.runResearchProviderEffect({
        idempotencyKey: `${input.idempotencyKey}:evaluate:${randomUUID()}`,
        binding: { parent: input.binding, phase: 'evaluate' },
        identity: runtime.identities.evaluator,
        role: 'evaluator',
        maxTransportAttempts: 1,
        countActualAttempts: true,
        effect: call,
      }), input.effect),
    });
  } finally {
    await runtime.close();
  }
}
