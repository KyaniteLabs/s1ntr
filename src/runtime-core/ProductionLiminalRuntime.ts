import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { CreativeKnowledgeConsolidator, FileActivatedKnowledgeStore, KnowledgeApplication,
  verifyActivatedKnowledgeSnapshot }
  from '../dreaming/research/DreamKnowledgeActivation.js';
import { createDreamDecisionAuthority, type DreamDecisionIssuer }
  from '../dreaming/research/DreamDecisionAuthority.js';
import type { DreamRenderedObserver }
  from '../dreaming/research/DreamRenderedExperimentExecutor.js';
import { DreamResearchController, FileDreamResearchPolicyStore,
  type DreamResearchPlan } from '../dreaming/research/DreamResearchController.js';
import { DreamResearchJournal } from '../dreaming/research/DreamResearchJournal.js';
import { DreamResearchService, type DreamLeaseAuthority }
  from '../dreaming/research/DreamResearchService.js';
import { DreamLeaseRegistry } from '../dreaming/research/DreamLeaseRegistry.js';
import { HeadlessDreamObserver } from '../dreaming/research/HeadlessDreamObserver.js';
import { createDreamRenderedEvidenceAuthority } from
  '../dreaming/research/DreamResearchEvidence.js';
import { DreamHoldoutVault, FileDreamHoldoutVault }
  from '../dreaming/research/DreamHoldoutVault.js';
import { DreamTransferRunner, type DreamTransferEvaluator, type DreamTransferProducer }
  from '../dreaming/research/DreamTransferRunner.js';
import type { DreamTransferCommitmentProtocol } from '../dreaming/research/DreamResearchEvidence.js';
import { DreamLearningGateway } from '../dreaming/research/DreamLearningGateway.js';
import { LLMClient } from '../llm/LLMClient.js';
import { HeadlessRenderer } from '../render/HeadlessRenderer.js';
import { AuthoredCreativeDoctrineStore } from './AuthoredCreativeDoctrine.js';
import { GovernedCreativeTeachingCompiler } from './GovernedCreativeTeachingCompiler.js';
import { FileLiminalArtifactStore, FileLiminalOperationJournal }
  from './LiminalCommandFilePersistence.js';
import { LiminalCommandService, bootstrapProductionReceiptAuthority,
  type LiminalCreativeCommand, type LiminalEvalMode, type LiminalReceiptAuthority }
  from './LiminalCommandService.js';
import { LiminalProductCommandPort, FileLiminalProductCommandStore,
  type LiminalOwnerReviewAuthority } from './LiminalProductCommandPort.js';
import { bootstrapProductionLiminalOwnerReviewAuthority }
  from './LiminalOwnerReviewAuthority.js';
import { FileGenerationCheckpointStore } from './GenerationCheckpoints.js';
import { createLiminalProductionEffects,
  isLiminalProductionDomain, type LiminalProductionDomain,
  type LiminalRendererPort } from './LiminalProductionEffects.js';
import { readCurrentGitCommit, readGitRef } from './ProofReceiptValidator.js';
import { readProductionAuthorityStamp } from './ProductionPackageStamp.js';
import { DreamProductCommandPort, FileDreamProductProjectionStore,
  type DreamExperimentTemplate } from './DreamProductCommandPort.js';
import { DreamActivationCommandPort, DreamTransferCommandPort, FileDreamProjectionStore,
  type DreamActivationPolicy } from './DreamTransferActivationPort.js';
import { CompoundCreateProofPort, type CompoundCreateJudge,
  type CompoundCreatePolicy, compoundCreateExecutionContextDigest,
  sealCompoundCreatePolicy } from './CompoundCreateProofPort.js';
import { sealDreamActivationPolicy } from './DreamTransferActivationPort.js';
import { sealCreativeKnowledgePolicy } from '../dreaming/research/DreamKnowledgeActivation.js';
import { sealDreamBlindComparisonPolicy, sealDreamOperatorDeclaration,
  DreamRenderedExperimentExecutor } from '../dreaming/research/DreamRenderedExperimentExecutor.js';
import { LLMDreamCompoundJudge, LLMDreamCreativeOperator, LLMDreamEvaluator,
  LLMDreamTransferProducer, assertProductionDreamAdapters, dreamClientIdentity }
  from './ProductionDreamHostAdapters.js';

export interface ProductionDreamRuntimeOptions {
  /** Digest produced by sealProductionDreamRuntimeOptions for production startup. */
  readonly authorityPackageDigest?: string;
  readonly budget: DreamResearchPlan['budget'];
  readonly template: DreamExperimentTemplate;
  readonly leaseAuthority: DreamLeaseAuthority;
  readonly leaseAuthorityIdentityDigest: string;
  readonly executorIdentityDigest: string;
  executor(decisions: DreamDecisionIssuer,
    renderedEvidence: ReturnType<typeof createDreamRenderedEvidenceAuthority>):
    DreamRenderedExperimentExecutor;
  readonly transfer?: {
    readonly producerIdentityDigest: string;
    readonly observerIdentityDigest: string;
    readonly rendererIdentityDigest: string;
    readonly holdout: { readonly custodyId: string; readonly bytes: string;
      readonly selectorDigest: string; readonly custodianDigest: string;
      readonly protocol: DreamTransferCommitmentProtocol };
    readonly producer: DreamTransferProducer;
    readonly observer: DreamRenderedObserver;
    readonly evaluators: readonly [DreamTransferEvaluator, DreamTransferEvaluator];
    readonly activationPolicy: DreamActivationPolicy;
    readonly compound?: { readonly policy: CompoundCreatePolicy;
      readonly judges: readonly [CompoundCreateJudge, CompoundCreateJudge] };
    /** Exact test seam; production derives this from the canonical receipt key. */
    readonly hostKey?: string;
  };
}

function dreamAuthorityBody(options: ProductionDreamRuntimeOptions) {
  return { budget: options.budget, template: options.template,
    leaseAuthorityIdentityDigest: options.leaseAuthorityIdentityDigest,
    executorIdentityDigest: options.executorIdentityDigest,
    transfer: options.transfer ? { holdout: { ...options.transfer.holdout,
      bytesDigest: sha256(options.transfer.holdout.bytes), bytes: undefined },
    producerIdentityDigest: options.transfer.producerIdentityDigest,
    observerIdentityDigest: options.transfer.observerIdentityDigest,
    rendererIdentityDigest: options.transfer.rendererIdentityDigest,
    evaluatorIdentities: options.transfer.evaluators.map(item => item.identity),
    activationPolicy: options.transfer.activationPolicy,
    compoundPolicy: options.transfer.compound?.policy,
    compoundJudgeIdentities: options.transfer.compound?.judges.map(item => item.identityDigest) }
      : undefined };
}

/** Seals the complete host-adapter authority required by the production Dream chain. */
export function sealProductionDreamRuntimeOptions(input: Omit<ProductionDreamRuntimeOptions,
  'authorityPackageDigest'>): ProductionDreamRuntimeOptions {
  if (!input.transfer?.compound) throw new Error('DREAM_PRODUCTION_HOST_ADAPTERS_INCOMPLETE');
  return Object.freeze({ ...input, authorityPackageDigest: sha256(dreamAuthorityBody(input)) });
}

export function assertProductionDreamRuntimeOptions(options: ProductionDreamRuntimeOptions): void {
  if (!options.transfer?.compound) throw new Error('DREAM_PRODUCTION_HOST_ADAPTERS_INCOMPLETE');
  const identities = [options.leaseAuthorityIdentityDigest, options.executorIdentityDigest,
    options.transfer.producerIdentityDigest, options.transfer.observerIdentityDigest,
    options.transfer.rendererIdentityDigest];
  if (!identities.every(value => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('DREAM_PRODUCTION_IDENTITY_INVALID');
  }
  if (options.authorityPackageDigest !== sha256(dreamAuthorityBody(options))) {
    throw new Error('DREAM_PRODUCTION_AUTHORITY_INVALID');
  }
}

export function resolveProductionDreamKeys(knowledgeSigningKey: string,
  holdoutEncryptionKey?: string) {
  if (!knowledgeSigningKey.trim()) throw new Error('KNOWLEDGE_SIGNING_KEY_REQUIRED');
  return Object.freeze({ knowledgeSigningKey,
    holdoutEncryptionKey: holdoutEncryptionKey ?? knowledgeSigningKey });
}

export interface ProductionLiminalRuntimeOptions {
  readonly root?: string;
  /** Artifact custody may be separate from the journal and product-store root. */
  readonly artifactRoot?: string;
  readonly generator?: LLMClient;
  readonly evaluator?: LLMClient;
  readonly renderer?: LiminalRendererPort;
  readonly rendererIdentity?: string;
  readonly harnessIdentity?: string;
  readonly studioIdentity?: string;
  readonly ownerReviewAuthority?: LiminalOwnerReviewAuthority;
  readonly doctrineStore?: AuthoredCreativeDoctrineStore;
  /** Test/bootstrap seam; production defaults to the canonical host authority. */
  readonly receiptAuthority?: LiminalReceiptAuthority;
  /** Required with injected receipt authority; avoids ambient HOME key coupling. */
  readonly knowledgeSigningKey?: string;
  /** Exact test seam; production resolves both refs from the live repository. */
  readonly sourceRefs?: { readonly sourceHeadSha: string; readonly canonicalMainSha: string };
  readonly repoRoot?: string;
  readonly dream?: ProductionDreamRuntimeOptions;
}

export interface ProductionLiminalCreateInput {
  readonly prompt: string;
  readonly domain: string;
  readonly layers?: readonly string[];
  readonly maxTransportAttempts?: number;
  readonly evalMode?: Exclude<LiminalEvalMode, 'legacy'>;
  readonly renderAuthorization?: LiminalCreativeCommand['renderAuthorization'];
  readonly teaching?: LiminalCreativeCommand['teaching'];
  /** Nonce that starts a new operation after an UNKNOWN effect outcome (#1323). */
  readonly retryUnknownOutcome?: string;
}

export interface ProductionLiminalRuntime {
  readonly root: string;
  readonly port: LiminalProductCommandPort;
  readonly createAuthority: LiminalCommandService;
  readonly activatedKnowledge: FileActivatedKnowledgeStore;
  readonly doctrine: AuthoredCreativeDoctrineStore;
  readonly identities: { readonly generator: string; readonly evaluator: string;
    readonly harness: string; readonly studio: string; readonly renderer: string };
  readonly sourceRefs: ProductionSourceRefs;
  readonly dream?: DreamProductCommandPort;
  readonly dreamTransfer?: DreamTransferCommandPort;
  readonly dreamActivation?: DreamActivationCommandPort;
  readonly compoundCreate?: CompoundCreateProofPort;
  createCommand(input: ProductionLiminalCreateInput): LiminalCreativeCommand;
  close(): Promise<void>;
}

export interface ProductionSourceRefs {
  readonly sourceHeadSha: string;
  readonly canonicalMainSha: string;
  readonly sourceKind: 'explicit' | 'git-origin-main' | 'forgejo-actions-pull-request'
    | 'forgejo-actions-main-push' | 'package-stamp';
  readonly sourceHeadSource: 'caller' | 'git-head' | 'forgejo-actions-github-sha'
    | 'package-stamp';
  readonly canonicalMainSource: 'caller' | 'git-origin-main'
    | 'forgejo-event-pull-request-base' | 'forgejo-event-main-push' | 'package-stamp';
  readonly eventHeadSha?: string;
}

function identity(client: LLMClient): string {
  const config = client.getConfig();
  return `${config.provider ?? 'configured'}/${config.model}`;
}

function runtimeRoot(value?: string): string {
  const root = value ?? process.env.SINTER_LIMINAL_RUNTIME_ROOT
    ?? path.join(os.homedir(), '.sinter', 'liminal-runtime');
  if (!path.isAbsolute(root)) throw new Error('LIMINAL_RUNTIME_ROOT_NOT_ABSOLUTE');
  return root;
}

function sha256(value: unknown): string {
  const stable = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(stable(value)).digest('hex');
}

function forgejoActionsSourceRefs(sourceHeadSha: string | null):
ProductionSourceRefs | null {
  if (process.env.FORGEJO_ACTIONS !== 'true') return null;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const githubSha = process.env.GITHUB_SHA?.toLowerCase();
  if (!eventPath || !path.isAbsolute(eventPath) || !/^[a-f0-9]{40}$/.test(githubSha ?? '')
    || sourceHeadSha !== githubSha) return null;
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(eventPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    event = parsed as Record<string, unknown>;
  } catch { return null; }
  if (process.env.GITHUB_EVENT_NAME === 'pull_request'
    && process.env.GITHUB_BASE_REF === 'main' && process.env.GITHUB_HEAD_REF?.trim()) {
    const pull = event.pull_request as Record<string, unknown> | undefined;
    const head = pull?.head as Record<string, unknown> | undefined;
    const base = pull?.base as Record<string, unknown> | undefined;
    const eventHeadSha = typeof head?.sha === 'string' ? head.sha.toLowerCase() : '';
    const eventHeadRef = typeof head?.ref === 'string' ? head.ref : '';
    const canonicalMainSha = typeof base?.sha === 'string' ? base.sha.toLowerCase() : '';
    const eventBaseRef = typeof base?.ref === 'string' ? base.ref : '';
    if (eventHeadSha !== githubSha || eventHeadRef !== process.env.GITHUB_HEAD_REF
      || eventBaseRef !== process.env.GITHUB_BASE_REF
      || !/^[a-f0-9]{40}$/.test(canonicalMainSha)) return null;
    return Object.freeze({ sourceHeadSha: githubSha!, canonicalMainSha,
      sourceKind: 'forgejo-actions-pull-request',
      sourceHeadSource: 'forgejo-actions-github-sha',
      canonicalMainSource: 'forgejo-event-pull-request-base', eventHeadSha });
  }
  const after = typeof event.after === 'string' ? event.after.toLowerCase() : '';
  if (process.env.GITHUB_EVENT_NAME === 'push'
    && process.env.GITHUB_REF === 'refs/heads/main' && after === githubSha) {
    return Object.freeze({ sourceHeadSha: githubSha!, canonicalMainSha: githubSha!,
      sourceKind: 'forgejo-actions-main-push',
      sourceHeadSource: 'forgejo-actions-github-sha',
      canonicalMainSource: 'forgejo-event-main-push', eventHeadSha: githubSha! });
  }
  return null;
}

export function resolveProductionSourceRefs(
  options: ProductionLiminalRuntimeOptions = {},
): ProductionSourceRefs {
  const refs = options.sourceRefs ? { ...options.sourceRefs, sourceKind: 'explicit' as const,
    sourceHeadSource: 'caller' as const, canonicalMainSource: 'caller' as const } : (() => {
    const repo = options.repoRoot ?? fileURLToPath(new URL('../..', import.meta.url));
    const sourceHeadSha = readCurrentGitCommit(repo)?.toLowerCase() ?? null;
    const canonicalMainSha = readGitRef(repo, 'refs/remotes/origin/main')?.toLowerCase() ?? null;
    if (sourceHeadSha && canonicalMainSha) return { sourceHeadSha, canonicalMainSha,
      sourceKind: 'git-origin-main' as const, sourceHeadSource: 'git-head' as const,
      canonicalMainSource: 'git-origin-main' as const };
    const event = forgejoActionsSourceRefs(sourceHeadSha);
    if (event) return event;
    // A packed install has no checkout: use the refs recorded from the tree it was packed from.
    if (sourceHeadSha || existsSync(path.join(repo, 'src'))) return null;
    const stamp = readProductionAuthorityStamp(repo);
    return stamp ? Object.freeze({ sourceHeadSha: stamp.sourceHeadSha,
      canonicalMainSha: stamp.canonicalMainSha, sourceKind: 'package-stamp' as const,
      sourceHeadSource: 'package-stamp' as const, canonicalMainSource: 'package-stamp' as const })
      : null;
  })();
  if (!refs || !/^[a-f0-9]{40}$/.test(refs.sourceHeadSha ?? '')
    || !/^[a-f0-9]{40}$/.test(refs.canonicalMainSha ?? '')) {
    throw new Error('LIMINAL_PRODUCTION_SOURCE_REFS_UNRESOLVED');
  }
  return Object.freeze(refs as ProductionSourceRefs);
}

function commandFactory(sourceRefs: ProductionLiminalRuntime['sourceRefs'],
  identities: ProductionLiminalRuntime['identities']) {
  return (input: ProductionLiminalCreateInput): LiminalCreativeCommand => {
    if (!input.prompt.trim()) throw new Error('LIMINAL_PRODUCTION_PROMPT_REQUIRED');
    if (!isLiminalProductionDomain(input.domain)) {
      throw new Error(`LIMINAL_PRODUCTION_DOMAIN_UNSUPPORTED:${input.domain}`);
    }
    const domain: LiminalProductionDomain = input.domain;
    const layers = Object.freeze([...(input.layers ?? [`${domain}-composition`])]);
    if (!layers.length || layers.some(layer => !layer.trim())) {
      throw new Error('LIMINAL_PRODUCTION_LAYERS_REQUIRED');
    }
    const settings = Object.freeze({ prompt: input.prompt, domain, layers,
      maxTransportAttempts: input.maxTransportAttempts ?? 2,
      evalMode: input.evalMode ?? 'strict-browser',
      renderAuthorization: input.renderAuthorization ?? 'isolated-playwright',
      safeMode: 'governed-production' as const, teaching: input.teaching });
    if (!Number.isSafeInteger(settings.maxTransportAttempts)
      || settings.maxTransportAttempts < 1) {
      throw new Error('LIMINAL_PRODUCTION_TRANSPORT_CAP_INVALID');
    }
    const authorityPackageDigest = sha256(input.retryUnknownOutcome
      ? { sourceRefs, identities, settings, retryUnknownOutcome: input.retryUnknownOutcome }
      : { sourceRefs, identities, settings });
    return Object.freeze({ schema: 'sinter.liminal-command', schemaVersion: 1,
      kind: 'generate-candidate',
      idempotencyKey: `production-create:${sourceRefs.sourceHeadSha}:${authorityPackageDigest}`,
      sourceHeadSha: sourceRefs.sourceHeadSha,
      canonicalMainSha: sourceRefs.canonicalMainSha,
      sourceBinding: Object.freeze({ sourceKind: sourceRefs.sourceKind,
        sourceHeadSource: sourceRefs.sourceHeadSource,
        canonicalMainSource: sourceRefs.canonicalMainSource,
        ...(sourceRefs.eventHeadSha ? { eventHeadSha: sourceRefs.eventHeadSha } : {}) }),
      authorityPackageDigest, prompt: settings.prompt, domain, layers,
      maxTransportAttempts: settings.maxTransportAttempts,
      evalMode: settings.evalMode, safeMode: settings.safeMode,
      roles: Object.freeze({ generator: identities.generator,
        evaluator: identities.evaluator, harness: identities.harness, studio: identities.studio }),
      rendererIdentity: identities.renderer,
      renderAuthorization: settings.renderAuthorization,
      ...(settings.teaching ? { teaching: settings.teaching } : {}),
    });
  };
}

/** Sole host bootstrap for production Create today and later research handlers. */

/**
 * Default spine clients carry the already-resolved role's explicit endpoint.
 * Role-only construction races async role resolution: at reservation time the
 * client still holds the localhost default and the surface classifies 'unknown',
 * fail-closing funding (fresh-bootstrap server blocker, 2026-08-27).
 */
export function spineExplicitClient(role: 'generator' | 'evaluator'): LLMClient {
  // Callers load roles first. Reopening the raw file here bypasses rotation
  // overrides and can pair a stale endpoint/key with the wrong model.
  const resolved = LLMClient.getResolvedRoleConfig(role);
  if (!resolved) return new LLMClient({ role });
  const { provider, baseUrl, apiKey, model, timeout, maxTokens,
    temperature, thinking, glmCodingPlanSeat } = resolved;
  return new LLMClient({ role, provider, baseUrl, apiKey, model, timeout,
    maxTokens, temperature, thinking, glmCodingPlanSeat });
}

export async function createProductionLiminalRuntime(
  options: ProductionLiminalRuntimeOptions = {},
): Promise<ProductionLiminalRuntime> {
  const root = runtimeRoot(options.root);
  const artifactRoot = options.artifactRoot ?? root;
  if (!path.isAbsolute(artifactRoot)) throw new Error('LIMINAL_ARTIFACT_ROOT_NOT_ABSOLUTE');
  await mkdir(root, { recursive: true });
  if (!options.generator || !options.evaluator) await LLMClient.loadRoles();
  
const generator = options.generator ?? spineExplicitClient('generator');
  const evaluator = options.evaluator ?? spineExplicitClient('evaluator');
  const renderer = options.renderer ?? HeadlessRenderer.getInstance();
  const identities = Object.freeze({ generator: identity(generator),
    evaluator: identity(evaluator),
    harness: options.harnessIdentity ?? identity(new LLMClient({ role: 'harness' })),
    studio: options.studioIdentity ?? identity(new LLMClient({ role: 'studio' })),
    renderer: options.rendererIdentity ?? 'headless-renderer/playwright' });
  const sourceRefs = resolveProductionSourceRefs(options);
  const activatedKnowledge = new FileActivatedKnowledgeStore(
    path.join(root, 'activated-knowledge.json'));
  const doctrine = options.doctrineStore ?? new AuthoredCreativeDoctrineStore();
  const authorityKey = path.join(os.homedir(), '.sinter', 'authority',
    'liminal-command-receipt.key');
  const authority = options.receiptAuthority
    ?? await bootstrapProductionReceiptAuthority(authorityKey);
  if (options.receiptAuthority && !options.knowledgeSigningKey?.trim()) {
    throw new Error('KNOWLEDGE_SIGNING_KEY_REQUIRED_WITH_INJECTED_AUTHORITY');
  }
  const knowledgeSigningKey = options.knowledgeSigningKey?.trim()
    ?? (await readFile(authorityKey, 'utf8')).trim();
  const ownerReviewAuthority = options.ownerReviewAuthority
    ?? await bootstrapProductionLiminalOwnerReviewAuthority(authorityKey);
  const artGenerationSeconds = Number(process.env.SINTER_ART_GENERATION_WALL_SECONDS);
  const createAuthority = new LiminalCommandService({
    effects: createLiminalProductionEffects({ generator, evaluator, renderer,
      generatorIdentity: identities.generator, evaluatorIdentity: identities.evaluator,
      rendererIdentity: identities.renderer,
      checkpoints: new FileGenerationCheckpointStore(path.join(root, 'generation-checkpoints')),
      ...(Number.isSafeInteger(artGenerationSeconds) && artGenerationSeconds > 0
        ? { generationWallMs: artGenerationSeconds * 1000 } : {}) }),
    artifacts: new FileLiminalArtifactStore(path.join(artifactRoot, 'artifacts')),
    journal: new FileLiminalOperationJournal(path.join(root, 'operation-journal.json')),
    authority,
  });
  const port = new LiminalProductCommandPort(createAuthority,
    ownerReviewAuthority,
    new FileLiminalProductCommandStore(path.join(root, 'product-projections.json')),
    new GovernedCreativeTeachingCompiler(
      new KnowledgeApplication(activatedKnowledge,
        snapshot => verifyActivatedKnowledgeSnapshot(snapshot, knowledgeSigningKey)), doctrine));
  let dreamJournal: DreamResearchJournal | undefined;
  let dream: DreamProductCommandPort | undefined;
  let dreamTransfer: DreamTransferCommandPort | undefined;
  let dreamActivation: DreamActivationCommandPort | undefined;
  let compoundCreate: CompoundCreateProofPort | undefined;
  if (options.dream) {
    if (process.env.NODE_ENV !== 'test') assertProductionDreamRuntimeOptions(options.dream);
    dreamJournal = new DreamResearchJournal(path.join(root, 'dream-research.sqlite'));
    const decisions = createDreamDecisionAuthority();
    const dreamRenderedEvidence = createDreamRenderedEvidenceAuthority(knowledgeSigningKey);
    const service = new DreamResearchService(dreamJournal, options.dream.leaseAuthority,
      decisions.resolver);
    const dreamStore = new FileDreamProductProjectionStore(
      path.join(root, 'dream-projections.json'));
    dream = new DreamProductCommandPort(port,
      new DreamResearchController(new FileDreamResearchPolicyStore(
        path.join(root, 'dream-policies', `${sha256(options.dream.template.campaignId)}.json`))),
      service, options.dream.executor(decisions.issuer, dreamRenderedEvidence), dreamStore,
      options.dream.budget, options.dream.template);
    if (options.dream.transfer) {
      const keys = resolveProductionDreamKeys(knowledgeSigningKey,
        options.dream.transfer.hostKey);
      const hostKey = keys.holdoutEncryptionKey;
      const vault = new FileDreamHoldoutVault(path.join(root, 'dream-holdouts.json'), hostKey);
      const holdout = vault.precommit(options.dream.transfer.holdout.custodyId,
        options.dream.transfer.holdout.bytes, options.dream.transfer.holdout);
      if (holdout.commitment.commitmentDigest
        !== options.dream.template.context.transferCommitmentDigest) {
        throw new Error('DREAM_RUNTIME_HOLDOUT_PRECOMMIT_MISMATCH');
      }
      const runner = new DreamTransferRunner(service, vault, decisions.issuer,
        options.dream.transfer.observer, dreamRenderedEvidence.resolver,
        input => port.runResearchProviderEffect({
          idempotencyKey: `dream-transfer-provider:${input.aggregateId}:${input.purpose}`,
          binding: { aggregateId: input.aggregateId, purpose: input.purpose,
            identity: input.identity }, identity: input.identity, role: input.role,
          maxTransportAttempts: 1, effect: input.effect,
        }));
      dreamTransfer = new DreamTransferCommandPort(dreamStore, service, runner,
        { holdout, producer: options.dream.transfer.producer,
          producerIdentityDigest: options.dream.transfer.producerIdentityDigest,
          observer: options.dream.transfer.observer,
          evaluators: options.dream.transfer.evaluators },
        new FileDreamProjectionStore(path.join(root, 'dream-transfer-projections.json')));
      const consolidator = new CreativeKnowledgeConsolidator(activatedKnowledge,
        keys.knowledgeSigningKey, new DreamLearningGateway(service));
      dreamActivation = new DreamActivationCommandPort(dreamTransfer, dreamStore,
        service, consolidator, options.dream.transfer.activationPolicy,
        new FileDreamProjectionStore(path.join(root, 'dream-activation-projections.json')));
      if (options.dream.transfer.compound) {
        compoundCreate = new CompoundCreateProofPort({ product: port,
          activation: dreamActivation, createCommand: commandFactory(sourceRefs, identities),
          judges: options.dream.transfer.compound.judges },
        options.dream.transfer.compound.policy,
        new FileDreamProjectionStore(path.join(root, 'compound-create-projections.json')));
      }
    }
  }
  return Object.freeze({ root, port, createAuthority, activatedKnowledge, doctrine, identities,
    sourceRefs, ...(dream ? { dream } : {}), ...(dreamTransfer ? { dreamTransfer } : {}),
    ...(dreamActivation ? { dreamActivation } : {}),
    ...(compoundCreate ? { compoundCreate } : {}),
    createCommand: commandFactory(sourceRefs, identities),
    close: async () => { dreamJournal?.close(); await renderer.close(); } });
}

async function builtInDreamOptions(input: { generator: LLMClient; evaluator: LLMClient;
  secondEvaluator: LLMClient; renderer: HeadlessRenderer;
  sourceRefs: ProductionLiminalRuntime['sourceRefs'];
  identities: ProductionLiminalRuntime['identities'] }): Promise<ProductionDreamRuntimeOptions> {
  const holdoutFile = process.env.SINTER_DREAM_HOLDOUT_FILE;
  const rendererEnvironmentDigest = process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST;
  if (!holdoutFile || !path.isAbsolute(holdoutFile)
    || !/^[a-f0-9]{64}$/.test(rendererEnvironmentDigest ?? '')) {
    throw new Error('DREAM_PRODUCTION_CONFIG_REQUIRED');
  }
  const holdoutBytes = await readFile(holdoutFile, 'utf8');
  if (!holdoutBytes.trim()) throw new Error('DREAM_PRODUCTION_HOLDOUT_EMPTY');
  const maxProviderAttempts = resolveProductionDreamProviderAttemptBudget(
    process.env.SINTER_DREAM_MAX_PROVIDER_ATTEMPTS);
  const campaignId = process.env.SINTER_DREAM_CAMPAIGN_ID ?? 'production-dream';
  const leaseAuthority = new DreamLeaseRegistry(
    path.join(runtimeRoot(), 'dream-leases.json'));
  const lease = leaseAuthority.resumeOrIssue(campaignId);
  const declaration = sealDreamOperatorDeclaration({ id: 'structural-depth-v1',
    factor: 'spatial-depth', compatibleDomains: ['html'],
    protectedInvariants: ['domain'], structuralDiffRules: ['composition.depth'] });
  const policy = sealDreamBlindComparisonPolicy({ criterionIds: ['visual-depth'],
    evaluatorOrderSeeds: [sha256('dream-order-a'), sha256('dream-order-b')],
    disagreementRule: 'inconclusive', uncertaintyThreshold: 0.35,
    criticalRegressionCriteria: ['visual-depth'] });
  const evaluators = [new LLMDreamEvaluator(input.evaluator),
    new LLMDreamEvaluator(input.secondEvaluator)] as const;
  const operator = new LLMDreamCreativeOperator(declaration, input.generator);
  const producer = new LLMDreamTransferProducer(input.generator);
  let observer: HeadlessDreamObserver | undefined;
  const observerProxy: DreamRenderedObserver = { observe: (candidate, plan) => {
    if (!observer) throw new Error('DREAM_RENDER_OBSERVER_NOT_INITIALIZED');
    return observer.observe(candidate, plan);
  } };
  assertProductionDreamAdapters({ operator, producer, evaluators,
    observer: observerProxy, leaseAuthority });
  const findingDigest = sha256({ declaration: declaration.declarationDigest,
    policy: policy.policyDigest });
  const transferContext = sha256({ campaignId, holdout: sha256(holdoutBytes) });
  const protocol = { originContextDigest: sha256({ campaignId, origin: true }),
    controlContextDigest: transferContext, treatmentContextDigest: transferContext,
    findingDigest, controlFindingDigest: null, treatmentFindingDigest: findingDigest };
  const holdout = { custodyId: `production:${sha256(holdoutBytes).slice(0, 24)}`,
    bytes: holdoutBytes, selectorDigest: sha256({ campaignId, selector: 'sealed-v1' }),
    custodianDigest: sha256({ host: input.identities.harness }), protocol };
  const transferCommitmentDigest = new DreamHoldoutVault().seal(holdoutBytes, holdout)
    .commitment.commitmentDigest;
  const activationPolicy = sealDreamActivationPolicy({
    knowledge: sealCreativeKnowledgePolicy({ minimumRepetitions: 2,
      minimumIndependentStudies: 2, allowedScopes: ['visual', 'motion'] }),
    compilerRuleVersion: 1, compilerRulePrefix: 'Validated transfer: ',
    contraindications: [] });
  const criterionDigest = sha256({ criterion: 'visual-depth' });
  const judges = [new LLMDreamCompoundJudge(input.evaluator, criterionDigest),
    new LLMDreamCompoundJudge(input.secondEvaluator, criterionDigest)] as const;
  const contextCommand = commandFactory(input.sourceRefs, input.identities)({
    prompt: 'compound context', domain: 'html', layers: ['visual-depth'],
    maxTransportAttempts: 2 });
  const compoundPolicy = sealCompoundCreatePolicy({ tasks: [
    { taskId: 'unseen-depth-a', prompt: 'Create an unseen spatial depth study',
      domain: 'html', layers: ['depth'], targetScope: 'visual', maxTransportAttempts: 2 },
    { taskId: 'unseen-depth-b', prompt: 'Create an unseen motion depth study',
      domain: 'html', layers: ['motion'], targetScope: 'motion', maxTransportAttempts: 2 },
  ], assignments: [
    { taskId: 'unseen-depth-a', firstArmId: 'opaque-a1', secondArmId: 'opaque-a2',
      treatmentPosition: 0 },
    { taskId: 'unseen-depth-b', firstArmId: 'opaque-b1', secondArmId: 'opaque-b2',
      treatmentPosition: 1 },
  ], judgeIdentityDigests: judges.map(item => item.identityDigest) as [string, string],
  criterionDigest, executionContextDigest: compoundCreateExecutionContextDigest(contextCommand),
  minimumEffectSize: 0.05, maximumJudgeDisagreement: 0.15,
  regressionVetoThreshold: 0.05, aggregation: 'mean-delta', sampleCount: 2,
  minimumTaskWins: 2 });
  const template = { campaignId, requiredModalities: ['visual', 'motion'] as const, lease,
    context: { knowledgeProfileDigest: sha256({ activationPolicy }),
      operatorDigest: declaration.declarationDigest, policyDigest: policy.policyDigest,
      rendererEnvironmentDigest: rendererEnvironmentDigest!,
      evaluatorManifestDigests: evaluators.map(item => item.identity.identityDigest),
      transferCommitmentDigest } };
  return sealProductionDreamRuntimeOptions({ budget: { maxCandidates: 1,
    maxProviderAttempts },
  template, leaseAuthority,
  leaseAuthorityIdentityDigest: sha256({ adapter: leaseAuthority.constructor.name }),
  executorIdentityDigest: sha256({ operator: declaration.declarationDigest,
    generator: dreamClientIdentity(input.generator) }),
  executor: (decisions, renderedEvidence) => {
    observer = new HeadlessDreamObserver(input.renderer,
      { timeoutMs: 30_000, maximumOutputBytes: 1_000_000 }, renderedEvidence.issuer);
    return new DreamRenderedExperimentExecutor(operator, observer, evaluators,
      decisions, policy, renderedEvidence.resolver);
  },
  transfer: { producerIdentityDigest: sha256({ adapter: producer.constructor.name,
    generator: dreamClientIdentity(input.generator) }),
  observerIdentityDigest: sha256({ adapter: HeadlessDreamObserver.name,
    rendererEnvironmentDigest }), rendererIdentityDigest: rendererEnvironmentDigest!,
  holdout, producer, observer: observerProxy, evaluators, activationPolicy,
  compound: { policy: compoundPolicy, judges } } });
}

/** Three discovery calls plus four transfer calls are required for a complete Dream study. */
export function resolveProductionDreamProviderAttemptBudget(value?: string): number {
  const maximum = Number(value ?? 7);
  if (!Number.isSafeInteger(maximum) || maximum !== 7) {
    throw new Error('DREAM_PRODUCTION_PROVIDER_CAP_INVALID');
  }
  return maximum;
}

/** Shipped entrypoint bootstrap: Dream authority must exist and validate before exposure. */
export async function bootstrapProductionLiminalRuntime(
  options: ProductionLiminalRuntimeOptions = {},
): Promise<ProductionLiminalRuntime> {
  if (options.dream) {
    assertProductionDreamRuntimeOptions(options.dream);
  }
  return createProductionLiminalRuntime(options);
}

/** Lazily composes real Dream adapters; ordinary Studio startup never needs Dream config. */
export async function bootstrapProductionDreamRuntime(
  options: ProductionLiminalRuntimeOptions = {},
): Promise<ProductionLiminalRuntime> {
  if (options.dream) return bootstrapProductionLiminalRuntime(options);
  if (process.env.SINTER_DREAM_HOST_CONFIG_MODULE) {
    return bootstrapProductionLiminalRuntime({ ...options,
      dream: await loadProductionDreamRuntimeOptions() });
  }
  await LLMClient.loadRoles();
  const generator = options.generator ?? spineExplicitClient('generator');
  const evaluator = options.evaluator ?? spineExplicitClient('evaluator');
  const studioRoute = new LLMClient({ role: 'studio' }).getConfig();
  const secondEvaluator = new LLMClient({ ...studioRoute, role: 'evaluator' });
  const harness = new LLMClient({ role: 'harness' });
  const renderer = options.renderer instanceof HeadlessRenderer
    ? options.renderer : HeadlessRenderer.getInstance();
  const identities = { generator: identity(generator), evaluator: identity(evaluator),
    harness: identity(harness), studio: identity(secondEvaluator),
    renderer: options.rendererIdentity ?? 'headless-renderer/playwright' };
  const sourceRefs = resolveProductionSourceRefs(options);
  const dream = await builtInDreamOptions({ generator, evaluator, secondEvaluator,
    renderer, identities, sourceRefs });
  return createProductionLiminalRuntime({ ...options, generator, evaluator, renderer,
    harnessIdentity: identities.harness, studioIdentity: identities.studio,
    sourceRefs, dream });
}

export async function loadProductionDreamRuntimeOptions(): Promise<ProductionDreamRuntimeOptions> {
  const modulePath = process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
  if (!modulePath || !path.isAbsolute(modulePath)) {
    throw new Error('DREAM_PRODUCTION_HOST_CONFIG_REQUIRED');
  }
  const host = await import(pathToFileURL(modulePath).href) as {
    dreamRuntimeOptions?: ProductionDreamRuntimeOptions };
  if (!host.dreamRuntimeOptions) throw new Error('DREAM_PRODUCTION_HOST_CONFIG_INVALID');
  assertProductionDreamRuntimeOptions(host.dreamRuntimeOptions);
  return host.dreamRuntimeOptions;
}
