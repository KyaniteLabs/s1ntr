import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionLiminalRuntime,
  type ProductionLiminalRuntime } from '../runtime-core/ProductionLiminalRuntime.js';
import { runProductionCliProviderEffect } from './LiminalProductionProviderEffect.js';
import { withBoundLoopJournal, LoopOutcomeUnknown, LoopReplayIntegrityError, type LoopReplayOptions } from './LiminalProductionLoops.js';
import type { CoordinatedCompositionResult, ComposeRevision }
  from '../creative-run/CreativeRunCoordinatorBase.js';
import { LLMClient, withProviderAttemptLimit } from '../llm/LLMClient.js';
import { hybridEnabled, type ExplicitLayerRequest } from '../composition/hybrid/HybridPlan.js';
import { enforceProductionAuthorityEntrypoints }
  from '../runtime-core/ProductionAuthorityRegistry.js';
import { scanProductionEntrypointAuthorityLocators }
  from '../runtime-core/ProductionAuthorityScanner.js';

export interface ProductionCliComposeInput extends LoopReplayOptions {
  readonly prompt: string;
  readonly outputRoot: string;
  /** Optional operator-fixed hybrid layer list (SINTER_HYBRID_LAYERS=1). */
  readonly hybridLayers?: ExplicitLayerRequest[];
  /** Improvement loops: distinguishes loop k's governed compose from loop k+1's (same idea, different attempt). */
  readonly attemptId?: string;
  readonly loopDirectory?: string;
  /** Improvement loops: loop k's layers, verdicts and critique. */
  readonly revision?: ComposeRevision;
  readonly maxProviderCalls?: number;
  readonly referenceProvenanceSha256?: string;
}

export interface ProductionCliComposeResult {
  readonly result: CoordinatedCompositionResult;
  readonly providerCallsUsed?: number;
  readonly replayedLoop?: boolean;
  readonly ownerRetry?: string;
}

type RuntimeFactory = (options: { root?: string }) => Promise<ProductionLiminalRuntime>;

/**
 * Delegate that performs the actual compose work (decomposition + layer
 * generation). The production path calls this inside the transport-authority
 * grant scope so every LLM transport it triggers is properly authorised.
 *
 * Mirrors CreativeRunCoordinator.composeFromPrompt's signature; bin/sinter
 * passes its coordinator instance directly.
 */
export interface ProductionComposeDelegate {
  composeFromPrompt(prompt: string, llm: LLMClient | undefined,
    options: { entryPoint: 'cli-compose'; hybrid?: { layers?: ExplicitLayerRequest[] }; revision?: ComposeRevision }): Promise<CoordinatedCompositionResult>;
}

async function assertProductionEntrypointAuthority(): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  enforceProductionAuthorityEntrypoints(await scanProductionEntrypointAuthorityLocators(
    packageRoot, ['src/cli/LiminalProductionCompose.ts']));
}

/**
 * Production compose path: mirrors runProductionCliGenerate by bootstrapping
 * ProductionLiminalRuntime, then wrapping the compose LLM calls in a legitimate
 * product transport authority grant via the port's runResearchProviderEffect.
 * The grant satisfies assertRoleBoundProviderAttempt for all generator-role
 * transports inside delegate.composeFromPrompt (decomposition + layers).
 */
export async function runProductionCliCompose(
  input: ProductionCliComposeInput,
  delegate: ProductionComposeDelegate,
  runtimeFactory: RuntimeFactory = createProductionLiminalRuntime,
): Promise<ProductionCliComposeResult> {
  if (!path.isAbsolute(input.outputRoot)) {
    throw new Error('GOVERNED_COMPOSE_OUTPUT_ROOT_NOT_ABSOLUTE');
  }
  await assertProductionEntrypointAuthority();
  const scope = {
    hybrid: hybridEnabled(),
    ...(input.hybridLayers ? { hybridLayers: input.hybridLayers } : {}),
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.maxProviderCalls === undefined ? {} : { maxProviderCalls: input.maxProviderCalls }),
    ...(input.referenceProvenanceSha256 ? { referenceProvenanceSha256: input.referenceProvenanceSha256 } : {}),
  };
  const keyFor = (attemptId?: string) => createHash('sha256')
    .update(input.prompt + (attemptId ? `\u0000${attemptId}` : ''))
    .update('\u0000').update(JSON.stringify(scope)).digest('hex');
  const submit = async (ownerRetry: string | undefined, replayOnly: boolean) => {
    const attemptId = ownerRetry ? `${input.attemptId}-owner-retry-${ownerRetry}` : input.attemptId;
    const result = await runProductionCliProviderEffect({
      idempotencyKey: `production-compose:${keyFor(attemptId)}`,
      binding: { prompt: input.prompt, surface: 'cli-compose', ...scope, ...(attemptId ? { attemptId } : {}) },
      outputRoot: input.outputRoot, replayOnly,
      effect: async () => {
        // Pass a generator-role LLMClient so decomposePrompt inherits the
        // transport grant's 'generation'/'generator' scope. A studio-role
        // client would have no expectedPurpose and always fail the assertion.
        const generatorClient = new LLMClient({ role: 'generator' });
        const compose = () => delegate.composeFromPrompt(input.prompt, generatorClient,
          { entryPoint: 'cli-compose',
            ...(input.hybridLayers ? { hybrid: { layers: input.hybridLayers } } : {}),
            ...(input.revision ? { revision: input.revision } : {}) });
        if (input.maxProviderCalls === undefined) return compose();
        return withProviderAttemptLimit(input.maxProviderCalls, compose);
      },
    }, runtimeFactory).catch(error => {
      if (!replayOnly) throw error;
      if (error instanceof Error && error.message === 'LOOP_REPLAY_EFFECT_MISSING') throw new LoopOutcomeUnknown(error);
      throw new LoopReplayIntegrityError(error);
    });
    const composed = 'providerCallsUsed' in result ? result : { result };
    return Object.freeze({ ...composed, ...(ownerRetry ? { ownerRetry } : {}), ...(replayOnly ? { replayedLoop: true } : {}) });
  };
  return input.loopDirectory && input.attemptId
    ? withBoundLoopJournal(input.loopDirectory, input.attemptId, `production-compose:${keyFor(input.attemptId)}`,
      input.outputRoot, input, submit)
    : submit(undefined, false);
}
