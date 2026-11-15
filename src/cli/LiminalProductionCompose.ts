import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionLiminalRuntime,
  type ProductionLiminalRuntime } from '../runtime-core/ProductionLiminalRuntime.js';
import { runProductionCliProviderEffect } from './LiminalProductionProviderEffect.js';
import type { CoordinatedCompositionResult }
  from '../creative-run/CreativeRunCoordinatorBase.js';
import { LLMClient } from '../llm/LLMClient.js';
import { enforceProductionAuthorityEntrypoints }
  from '../runtime-core/ProductionAuthorityRegistry.js';
import { scanProductionEntrypointAuthorityLocators }
  from '../runtime-core/ProductionAuthorityScanner.js';

export interface ProductionCliComposeInput {
  readonly prompt: string;
  readonly outputRoot: string;
}

export interface ProductionCliComposeResult {
  readonly result: CoordinatedCompositionResult;
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
    options: { entryPoint: 'cli-compose' }): Promise<CoordinatedCompositionResult>;
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
  const idempotencyKey = `production-compose:${createHash('sha256')
    .update(input.prompt).digest('hex')}`;
  const result = await runProductionCliProviderEffect({
    idempotencyKey,
    binding: { prompt: input.prompt, surface: 'cli-compose' },
    outputRoot: input.outputRoot,
    effect: async () => {
      // Pass a generator-role LLMClient so decomposePrompt inherits the
      // transport grant's 'generation'/'generator' scope. A studio-role
      // client would have no expectedPurpose and always fail the assertion.
      const generatorClient = new LLMClient({ role: 'generator' });
      return delegate.composeFromPrompt(input.prompt, generatorClient,
        { entryPoint: 'cli-compose' });
    },
  }, runtimeFactory);
  return Object.freeze({ result });
}
