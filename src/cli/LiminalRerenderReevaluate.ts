import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLMClient } from '../llm/LLMClient.js';
import { HeadlessRenderer } from '../render/HeadlessRenderer.js';
import { bootstrapProductionReceiptAuthority } from '../runtime-core/LiminalCommandService.js';
import { createLiminalProductionEffects } from '../runtime-core/LiminalProductionEffects.js';
import { resolveProductionSourceRefs, spineExplicitClient } from '../runtime-core/ProductionLiminalRuntime.js';
import {
  gitMainCandidates, parseRerenderGrant, rerenderReevaluateProductRun,
  type RerenderReevaluateOutcome,
} from '../runtime-core/ProductRerenderReevaluation.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';

export interface RerenderReevaluateCliOptions {
  /** File holding the original prompt text; run roots keep only its digest. */
  readonly promptFile?: string;
  /** Repository used to resolve current and historical source bindings. */
  readonly repoRoot?: string;
}

/**
 * Re-render and re-judge one product run through the production authority path.
 * The judge is the run's own evaluator identity; the generator is never called.
 */
export async function rerenderReevaluateProductRunCli(runRoot: string, grantPath: string,
  options: RerenderReevaluateCliOptions = {}): Promise<RerenderReevaluateOutcome> {
  if (!path.isAbsolute(runRoot) || !path.isAbsolute(grantPath)) {
    throw new Error('REEVALUATION_PATH_NOT_ABSOLUTE');
  }
  const grant = parseRerenderGrant(await readFile(grantPath, 'utf8'));
  await LLMClient.loadRoles();
  const generator = spineExplicitClient('generator');
  const evaluator = spineExplicitClient('evaluator');
  const parentRoles = JSON.parse(await readFile(
    path.join(runRoot, 'product-projections.json'), 'utf8')) as Record<string,
    { kind: string; result: { roles: { generator: string; evaluator: string };
      evidence: { rendererIdentity: string } } }>;
  const parent = grant.parentCreateIdempotencyKey
    ? parentRoles[grant.parentCreateIdempotencyKey]
    : Object.values(parentRoles).find(value => value.kind === 'create');
  if (parent?.kind !== 'create') throw new Error('REEVALUATION_PARENT_NOT_FOUND');
  const repoRoot = options.repoRoot ?? fileURLToPath(new URL('../..', import.meta.url));
  let currentSourceRefs;
  try {
    currentSourceRefs = resolveProductionSourceRefs({ repoRoot });
  } catch { /* a historic run can still match an available reflog entry */ }
  const renderer = HeadlessRenderer.getInstance();
  try {
    const outcome = await rerenderReevaluateProductRun(runRoot, grantPath, {
      effects: createLiminalProductionEffects({ generator, evaluator, renderer,
        generatorIdentity: parent.result.roles.generator,
        evaluatorIdentity: parent.result.roles.evaluator,
        rendererIdentity: parent.result.evidence.rendererIdentity,
        evaluatorTimeoutMs: grant.evaluatorTimeoutMs }),
      authority: await bootstrapProductionReceiptAuthority(
        path.join(os.homedir(), '.sinter', 'authority', 'liminal-command-receipt.key')),
      promptText: options.promptFile ? (await readFile(options.promptFile, 'utf8')).trim()
        : undefined,
      currentSourceRefs,
      canonicalMainCandidates: gitMainCandidates(repoRoot),
    });
    await writeFileAtomic(path.join(runRoot, 'rerender-reevaluation.json'),
      `${JSON.stringify({ grantDigest: outcome.grantDigest, parentKey: outcome.parentKey,
        result: outcome.result }, null, 2)}\n`);
    return outcome;
  } finally {
    await renderer.close();
  }
}
