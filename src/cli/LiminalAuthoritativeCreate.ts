import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Seat credentials for spine clients: the authority projection redacts keys, so
 *  clients read the live role config (key + seat flags) from the config file. */
function spineRoleCredentials(roleName: 'generator' | 'evaluator'): { apiKey?: string; glmCodingPlanSeat?: boolean } {
  try {
    const cfgPath = join(homedir(), '.sinter', 'config.json');
    if (!existsSync(cfgPath)) return {};
    const role = (JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      roles?: Record<string, { apiKey?: string; glmCodingPlanSeat?: boolean }> }).roles?.[roleName];
    return { apiKey: role?.apiKey, glmCodingPlanSeat: role?.glmCodingPlanSeat };
  } catch { return {}; }
}
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLMClient } from '../llm/LLMClient.js';
import { HeadlessRenderer } from '../render/HeadlessRenderer.js';
import {
  LiminalCommandService,
  bootstrapProductionReceiptAuthority,
  type LiminalCommandResult,
  type LiminalCreativeCommand,
} from '../runtime-core/LiminalCommandService.js';
import {
  FileLiminalArtifactStore,
  FileLiminalOperationJournal,
} from '../runtime-core/LiminalCommandFilePersistence.js';
import { createLiminalProductionEffects } from '../runtime-core/LiminalProductionEffects.js';
import { enforceProductionAuthorityEntrypoints }
  from '../runtime-core/ProductionAuthorityRegistry.js';
import { scanProductionEntrypointAuthorityLocators }
  from '../runtime-core/ProductionAuthorityScanner.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { runLiminalCommandJourney } from './LiminalCommandCli.js';

interface FrozenProvider {
  readonly executor: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface Wave8C0AuthorityPackage {
  readonly schema: 'sinter.wave8-c0-authority';
  readonly schemaVersion: 1;
  readonly canonicalMainSha: string;
  readonly sourceHeadSha: string;
  readonly mainFrozen: true;
  readonly activeBlocker: 'one-rendered-c0';
  readonly prompt: string;
  readonly domains: readonly ['p5'];
  readonly layers: readonly string[];
  readonly maxTransportAttempts: 2;
  readonly evalMode: 'strict-browser';
  readonly renderer: {
    readonly identity: string;
    readonly authorization: 'isolated-playwright';
  };
  readonly roles: {
    readonly generator: FrozenProvider;
    readonly evaluator: FrozenProvider;
    readonly harness: string;
    readonly studio: string;
  };
  readonly outputRoot: string;
}

export interface AuthoritativeCreateResult {
  readonly authorityPackageDigest: string;
  readonly command: LiminalCreativeCommand;
  readonly result: LiminalCommandResult;
  readonly reviewPath: string;
  readonly playablePath: string;
  readonly earlyFramePath: string;
  readonly lateFramePath: string;
}

interface StoredAuthoritativeCreateResult extends AuthoritativeCreateResult {
  readonly command: LiminalCreativeCommand;
  readonly result: LiminalCommandResult;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateAuthority(value: unknown): Wave8C0AuthorityPackage {
  const authority = value as Partial<Wave8C0AuthorityPackage>;
  if (authority.schema !== 'sinter.wave8-c0-authority' || authority.schemaVersion !== 1
    || authority.mainFrozen !== true || authority.activeBlocker !== 'one-rendered-c0'
    || !/^[0-9a-f]{40}$/.test(authority.canonicalMainSha ?? '')
    || !/^[0-9a-f]{40}$/.test(authority.sourceHeadSha ?? '')
    || authority.evalMode !== 'strict-browser'
    || authority.renderer?.authorization !== 'isolated-playwright'
    || authority.maxTransportAttempts !== 2
    || authority.domains?.length !== 1 || authority.domains[0] !== 'p5'
    || !authority.layers?.length || !authority.prompt?.trim()
    || !authority.roles?.generator || !authority.roles.evaluator
    || !authority.outputRoot || !path.isAbsolute(authority.outputRoot)) {
    throw new Error('Invalid or incomplete Wave 8 C0 authority package');
  }
  return authority as Wave8C0AuthorityPackage;
}

function providerIdentity(provider: FrozenProvider): string {
  return `${provider.provider}/${provider.model}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function authoritativeEvidencePaths(outputRoot: string, operationId: string) {
  const directory = path.join(outputRoot, 'artifacts', sha256(operationId));
  return Object.freeze({ earlyFramePath: path.join(directory, 'early-frame.png'),
    lateFramePath: path.join(directory, 'late-frame.png') });
}

export function buildAuthoritativeReviewHtml(authority: Wave8C0AuthorityPackage,
  playablePath: string, earlyFramePath: string, lateFramePath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Wave 8 C0 review</title></head>
<body><h1>Wave 8 C0</h1><p><strong>Prompt:</strong> ${escapeHtml(authority.prompt)}</p>
<p><strong>Domains:</strong> p5 &nbsp; <strong>Layers (${authority.layers.length}):</strong> ${authority.layers.map(escapeHtml).join(', ')}</p>
<p><a href="${path.relative(authority.outputRoot, playablePath)}">Open playable artwork</a></p>
<figure><img src="${path.relative(authority.outputRoot, earlyFramePath)}" alt="Early rendered frame"><figcaption>Early frame</figcaption></figure>
<figure><img src="${path.relative(authority.outputRoot, lateFramePath)}" alt="Late rendered frame"><figcaption>Late frame</figcaption></figure></body></html>`;
}

/** Keep live evaluator actions bounded while allowing observed visual-evaluation latency. */
export function validateEvaluatorTimeoutMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 120_000 || (value as number) > 600_000) {
    throw new Error('EVALUATOR_TIMEOUT_OUT_OF_BOUNDS');
  }
  return value as number;
}

export function resolveReevaluationEvidenceRoot(
  authorityPath: string, configuredOutputRoot: string,
): string {
  const root = path.dirname(authorityPath);
  if (path.basename(root) !== path.basename(configuredOutputRoot)) {
    throw new Error('REEVALUATION_EVIDENCE_ROOT_IDENTITY_MISMATCH');
  }
  return root;
}

async function assertLiveProductionAuthorityCensus(): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  enforceProductionAuthorityEntrypoints(await scanProductionEntrypointAuthorityLocators(
    packageRoot, ['src/cli/LiminalAuthoritativeCreate.ts']));
}

/** Execute one production C0 through the same Liminal command used by product adapters. */
export async function runAuthoritativeC0(authorityPath: string): Promise<AuthoritativeCreateResult> {
  await assertLiveProductionAuthorityCensus();
  if (!path.isAbsolute(authorityPath)) throw new Error('Authority package path must be absolute');
  const authorityBytes = await readFile(authorityPath, 'utf8');
  const authority = validateAuthority(JSON.parse(authorityBytes));
  const authorityPackageDigest = sha256(authorityBytes);
  const generatorIdentity = providerIdentity(authority.roles.generator);
  const evaluatorIdentity = providerIdentity(authority.roles.evaluator);
  const command: LiminalCreativeCommand = Object.freeze({
    schema: 'sinter.liminal-command', schemaVersion: 1, kind: 'generate-candidate',
    idempotencyKey: `wave8-c0:${authority.sourceHeadSha}:${authorityPackageDigest}`,
    prompt: authority.prompt, domain: 'p5', layers: authority.layers,
    canonicalMainSha: authority.canonicalMainSha, authorityPackageDigest,
    maxTransportAttempts: authority.maxTransportAttempts,
    evalMode: authority.evalMode, safeMode: 'c0-no-empirical-teaching',
    rendererIdentity: authority.renderer.identity,
    renderAuthorization: authority.renderer.authorization,
    roles: { generator: generatorIdentity, evaluator: evaluatorIdentity,
      harness: authority.roles.harness, studio: authority.roles.studio },
  });
  const renderer = HeadlessRenderer.getInstance();
  const generatorConfig = authority.roles.generator;
  const evaluatorConfig = authority.roles.evaluator;
  const service = new LiminalCommandService({
    effects: createLiminalProductionEffects({
      generator: new LLMClient({ provider: generatorConfig.provider,
        baseUrl: generatorConfig.baseUrl, model: generatorConfig.model, role: 'generator',
        // Seat identity must ride the client, not just the role: without the key and
        // coding-plan flag the transport classifies glm-direct/unknown and the
        // funding gate fail-closes (server deployment blocker, 2026-08-27).
        apiKey: spineRoleCredentials('generator').apiKey,
        glmCodingPlanSeat: spineRoleCredentials('generator').glmCodingPlanSeat === true,
        thinking: { enabled: false } }),
      escalationGenerator: (() => {
        try {
          const cfgPath = join(homedir(), '.sinter', 'config.json');
          if (!existsSync(cfgPath)) return undefined;
          const harness = JSON.parse(readFileSync(cfgPath, 'utf8')).roles?.harness;
          if (!harness?.baseUrl || !harness?.model) return undefined;
          return new LLMClient({ provider: harness.provider, baseUrl: harness.baseUrl,
            model: harness.model, apiKey: harness.apiKey,
            glmCodingPlanSeat: harness.glmCodingPlanSeat === true, role: 'generator' });
        } catch { return undefined; }
      })(),
      evaluator: new LLMClient({ provider: evaluatorConfig.provider,
        baseUrl: evaluatorConfig.baseUrl, model: evaluatorConfig.model, role: 'evaluator' }),
      renderer, generatorIdentity, evaluatorIdentity,
      rendererIdentity: authority.renderer.identity,
    }),
    artifacts: new FileLiminalArtifactStore(path.join(authority.outputRoot, 'artifacts')),
    journal: new FileLiminalOperationJournal(path.join(authority.outputRoot, 'operation-journal.json')),
    authority: await bootstrapProductionReceiptAuthority(
      path.join(os.homedir(), '.sinter', 'authority', 'liminal-command-receipt.key')),
  });
  try {
  const result = await runLiminalCommandJourney(service, command);
  const operationDirectory = sha256(result.operationId);
  const playablePath = path.join(authority.outputRoot, 'artifacts', operationDirectory, 'playable.html');
  const reviewPath = path.join(authority.outputRoot, 'review.html');
  const { earlyFramePath, lateFramePath } = authoritativeEvidencePaths(
    authority.outputRoot, result.operationId);
  const review = buildAuthoritativeReviewHtml(
    authority, playablePath, earlyFramePath, lateFramePath);
  await writeFileAtomic(reviewPath, review);
  await writeFileAtomic(path.join(authority.outputRoot, 'result.json'), `${JSON.stringify({
    authorityPackageDigest, command, result, reviewPath, playablePath, earlyFramePath, lateFramePath,
  }, null, 2)}\n`);
  return Object.freeze({ authorityPackageDigest, command, result,
    reviewPath, playablePath, earlyFramePath, lateFramePath });
  } finally {
    // This entry point owns the singleton it borrowed; the effects port no
    // longer closes per render.
    await renderer.close();
  }
}

/** Retry only rendered evaluation for the exact persisted C0; never regenerate. */
export async function reevaluateAuthoritativeC0(
  authorityPath: string,
  reevaluationAuthorityPath: string,
): Promise<AuthoritativeCreateResult> {
  await assertLiveProductionAuthorityCensus();
  if (!path.isAbsolute(authorityPath)) throw new Error('Authority package path must be absolute');
  if (!path.isAbsolute(reevaluationAuthorityPath)) {
    throw new Error('Re-evaluation authority package path must be absolute');
  }
  const authorityBytes = await readFile(authorityPath, 'utf8');
  const authority = validateAuthority(JSON.parse(authorityBytes));
  const authorityPackageDigest = sha256(authorityBytes);
  const evidenceRoot = resolveReevaluationEvidenceRoot(authorityPath, authority.outputRoot);
  const reevaluationAuthorityBytes = await readFile(reevaluationAuthorityPath, 'utf8');
  const reevaluationAuthority = JSON.parse(reevaluationAuthorityBytes) as {
    schema?: string; sourceHeadSha?: string; parentAuthorityDigest?: string;
    maxTransportAttempts?: number; candidateCount?: number; evaluatorTimeoutMs?: number;
  };
  const reevaluationAuthorityDigest = sha256(reevaluationAuthorityBytes);
  if (reevaluationAuthority.schema !== 'sinter.wave8-c0-reevaluation-authority'
    || !/^[0-9a-f]{40}$/.test(reevaluationAuthority.sourceHeadSha ?? '')
    || reevaluationAuthority.parentAuthorityDigest !== authorityPackageDigest
    || reevaluationAuthority.maxTransportAttempts !== 1
    || reevaluationAuthority.candidateCount !== 0) {
    throw new Error('Invalid C0 re-evaluation authority package');
  }
  const evaluatorTimeoutMs = validateEvaluatorTimeoutMs(reevaluationAuthority.evaluatorTimeoutMs);
  const stored = JSON.parse(
    await readFile(path.join(evidenceRoot, 'result.json'), 'utf8'),
  ) as StoredAuthoritativeCreateResult;
  if (stored.authorityPackageDigest !== authorityPackageDigest
    || stored.command.authorityPackageDigest !== authorityPackageDigest) {
    throw new Error('REEVALUATION_AUTHORITY_PACKAGE_MISMATCH');
  }
  const journal = new FileLiminalOperationJournal(
    path.join(evidenceRoot, 'operation-journal.json'));
  const sourceResult = await journal.findByIdempotencyKey(stored.command.idempotencyKey);
  if (!sourceResult) throw new Error('REEVALUATION_SOURCE_RESULT_MISSING');
  let { earlyFramePath, lateFramePath } = authoritativeEvidencePaths(
    evidenceRoot, stored.result.operationId);
  let earlyFrame: Buffer;
  let lateFrame: Buffer;
  try {
    [earlyFrame, lateFrame] = await Promise.all([
      readFile(earlyFramePath), readFile(lateFramePath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    earlyFramePath = path.join(evidenceRoot, 'rendered-evidence', 'early.png');
    lateFramePath = path.join(evidenceRoot, 'rendered-evidence', 'late.png');
    [earlyFrame, lateFrame] = await Promise.all([
      readFile(earlyFramePath), readFile(lateFramePath)]);
  }
  const digestBuffer = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
  if (digestBuffer(earlyFrame) !== stored.result.evidence.earlyFrameDigest
    || digestBuffer(lateFrame) !== stored.result.evidence.lateFrameDigest) {
    throw new Error('REEVALUATION_FRAME_DIGEST_MISMATCH');
  }
  const { default: sharp } = await import('sharp');
  const [earlyMeta, lateMeta] = await Promise.all([sharp(earlyFrame).metadata(), sharp(lateFrame).metadata()]);
  if (!earlyMeta.width || !earlyMeta.height || !lateMeta.width || !lateMeta.height) {
    throw new Error('REEVALUATION_FRAME_DIMENSIONS_MISSING');
  }
  const generatorConfig = authority.roles.generator;
  const evaluatorConfig = authority.roles.evaluator;
  const renderer = HeadlessRenderer.getInstance();
  const service = new LiminalCommandService({
    effects: createLiminalProductionEffects({
      generator: new LLMClient({ provider: generatorConfig.provider,
        baseUrl: generatorConfig.baseUrl, model: generatorConfig.model, role: 'generator',
        // Seat identity must ride the client, not just the role: without the key and
        // coding-plan flag the transport classifies glm-direct/unknown and the
        // funding gate fail-closes (server deployment blocker, 2026-08-27).
        apiKey: spineRoleCredentials('generator').apiKey,
        glmCodingPlanSeat: spineRoleCredentials('generator').glmCodingPlanSeat === true,
        thinking: { enabled: false } }),
      escalationGenerator: (() => {
        try {
          const cfgPath = join(homedir(), '.sinter', 'config.json');
          if (!existsSync(cfgPath)) return undefined;
          const harness = JSON.parse(readFileSync(cfgPath, 'utf8')).roles?.harness;
          if (!harness?.baseUrl || !harness?.model) return undefined;
          return new LLMClient({ provider: harness.provider, baseUrl: harness.baseUrl,
            model: harness.model, apiKey: harness.apiKey,
            glmCodingPlanSeat: harness.glmCodingPlanSeat === true, role: 'generator' });
        } catch { return undefined; }
      })(),
      evaluator: new LLMClient({ provider: evaluatorConfig.provider,
        baseUrl: evaluatorConfig.baseUrl, model: evaluatorConfig.model,
        timeout: evaluatorTimeoutMs, role: 'evaluator' }),
      renderer, generatorIdentity: providerIdentity(generatorConfig),
      evaluatorIdentity: providerIdentity(evaluatorConfig),
      rendererIdentity: authority.renderer.identity, evaluatorTimeoutMs,
    }),
    artifacts: new FileLiminalArtifactStore(path.join(evidenceRoot, 'artifacts')),
    journal,
    authority: await bootstrapProductionReceiptAuthority(
      path.join(os.homedir(), '.sinter', 'authority', 'liminal-command-receipt.key')),
    verifyActionAuthority: input => input.action === 'reevaluate'
      && input.digest === reevaluationAuthorityDigest
      && input.parent.signature === sourceResult.receipt.signature
      && input.evidenceDigest === stored.result.evidence.evidenceDigest
      && input.maxTransportAttempts === reevaluationAuthority.maxTransportAttempts,
  });
  try {
  const priorEvidence = stored.result.evidence;
  const result = await service.reevaluate(stored.command, sourceResult, {
    status: 'rendered', rendererIdentity: priorEvidence.rendererIdentity,
    earlyFrame, lateFrame,
    earlyFrameSize: { width: earlyMeta.width, height: earlyMeta.height },
    lateFrameSize: { width: lateMeta.width, height: lateMeta.height },
    runtimeErrors: priorEvidence.runtimeErrors, timingMs: priorEvidence.timingMs,
    rendererEnvironmentDigest: priorEvidence.rendererEnvironmentDigest,
    containment: priorEvidence.containment, playback: priorEvidence.playback,
    interaction: priorEvidence.interaction, audio: priorEvidence.audio,
  }, { idempotencyKey: `${stored.command.idempotencyKey}:evaluation:${reevaluationAuthorityDigest}`,
    maxTransportAttempts: 1, actionAuthorityDigest: reevaluationAuthorityDigest }, stored.result);
  const completed = Object.freeze({ ...stored, result });
  await writeFileAtomic(path.join(evidenceRoot, 'result.json'), `${JSON.stringify(completed, null, 2)}\n`);
  await writeFileAtomic(path.join(evidenceRoot, 'evaluation-repair-result.json'),
    `${JSON.stringify(completed, null, 2)}\n`);
  return completed;
  } finally {
    await renderer.close();
  }
}
