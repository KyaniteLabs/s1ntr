import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionLiminalRuntime,
  type ProductionLiminalRuntime } from '../runtime-core/ProductionLiminalRuntime.js';
import type { LiminalCommandResult } from '../runtime-core/LiminalCommandService.js';
import { enforceProductionAuthorityEntrypoints }
  from '../runtime-core/ProductionAuthorityRegistry.js';
import { scanProductionEntrypointAuthorityLocators }
  from '../runtime-core/ProductionAuthorityScanner.js';
import { validateSVGFragment, type SVGFragmentSpec } from '../generators/svg/SVGFragment.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { setSinterMemoryStage } from '../telemetry/SinterMemoryProfile.js';

export interface GovernedCliCompatibility {
  readonly explicitMaxIterations?: number;
  readonly stages?: string;
  readonly useSwarm?: boolean;
  readonly learn?: boolean;
  readonly intuition?: boolean;
  readonly aesthetic?: boolean;
  readonly voice?: boolean;
  readonly providerOverride?: boolean;
}

export function assertGovernedCliCompatibility(input: GovernedCliCompatibility): void {
  const incompatible = [
    input.explicitMaxIterations !== undefined && input.explicitMaxIterations !== 1
      ? '--max-iterations other than 1' : undefined,
    input.stages ? '--stages' : undefined,
    input.useSwarm ? '--use-swarm' : undefined,
    input.learn ? '--learn' : undefined,
    input.intuition ? '--intuition' : undefined,
    input.aesthetic ? '--aesthetic/--aesthetic-config' : undefined,
    input.voice ? '--voice/--voice-file' : undefined,
    input.providerOverride ? '--provider/--model/--base-url/--api-key' : undefined,
  ].filter(Boolean);
  if (incompatible.length) {
    throw new Error(`GOVERNED_GENERATE_FLAGS_UNSUPPORTED:${incompatible.join(',')}`);
  }
}

export interface ProductionCliGenerateInput {
  readonly prompt: string;
  readonly domain: string;
  readonly outputRoot: string;
  readonly maxTransportAttempts?: number;
  /** Operator accepts possible double billing after an UNKNOWN outcome (#1323). */
  readonly retryUnknownOutcome?: boolean;
  /** SVG fragment mode (#1162): also write the accepted source as fragment.svg. */
  readonly fragmentSpec?: SVGFragmentSpec | null;
}

export interface ProductionCliGenerateResult {
  readonly result: LiminalCommandResult;
  readonly sourcePath: string;
  readonly playablePath: string;
  /** Paste-ready fragment, only set in SVG fragment mode. */
  readonly fragmentPath?: string;
}

type RuntimeFactory = (options: { root: string; artifactRoot: string }) => Promise<ProductionLiminalRuntime>;

async function assertProductionEntrypointAuthority(): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  enforceProductionAuthorityEntrypoints(await scanProductionEntrypointAuthorityLocators(
    packageRoot, ['src/cli/LiminalProductionGenerate.ts']));
}

export async function runProductionCliGenerate(input: ProductionCliGenerateInput,
  runtimeFactory: RuntimeFactory = createProductionLiminalRuntime):
  Promise<ProductionCliGenerateResult> {
  if (!path.isAbsolute(input.outputRoot)) {
    throw new Error('GOVERNED_GENERATE_OUTPUT_ROOT_NOT_ABSOLUTE');
  }
  setSinterMemoryStage('cli:authority-scan');
  await assertProductionEntrypointAuthority();
  setSinterMemoryStage('cli:runtime-bootstrap');
  const defaultOutputRoot = path.join(process.env.HOME || '/tmp', '.sinter', 'output');
  const stateRoot = input.outputRoot === defaultOutputRoot
    ? process.env.SINTER_LIMINAL_RUNTIME_ROOT ?? input.outputRoot
    : input.outputRoot;
  const runtime = await runtimeFactory({
    root: stateRoot,
    artifactRoot: input.outputRoot,
  });
  try {
    setSinterMemoryStage('cli:create-command');
    const command = runtime.createCommand({ prompt: input.prompt, domain: input.domain,
      maxTransportAttempts: input.maxTransportAttempts,
      ...(input.retryUnknownOutcome ? { retryUnknownOutcome: randomUUID() } : {}) });
    setSinterMemoryStage('cli:submit-create');
    const projection = await runtime.port.submitCreate('cli', command);
    if (projection.kind !== 'create') throw new Error('LIMINAL_CREATE_PROJECTION_INVALID');
    const operationDirectory = createHash('sha256')
      .update(projection.result.operationId).digest('hex');
    const artifactDirectory = path.join(input.outputRoot, 'artifacts', operationDirectory);
    const sourcePath = path.join(artifactDirectory, 'source.txt');
    let fragmentPath: string | undefined;
    if (input.fragmentSpec) {
      // Read the accepted artifact back, never the raw first attempt.
      const accepted = await readFile(sourcePath, 'utf8');
      const check = validateSVGFragment(accepted, input.fragmentSpec);
      if (!check.valid) throw new Error(`SVG_FRAGMENT_INVALID:${check.error}`);
      fragmentPath = path.join(artifactDirectory, 'fragment.svg');
      await writeFileAtomic(fragmentPath, accepted);
    }
    return Object.freeze({ result: projection.result, sourcePath,
      playablePath: path.join(artifactDirectory, 'playable.html'),
      ...(fragmentPath ? { fragmentPath } : {}) });
  } finally {
    setSinterMemoryStage('cli:close');
    await runtime.close();
  }
}
