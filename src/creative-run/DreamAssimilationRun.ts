import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareComposition, type CompositionRequest } from '../composition/CompositionGraph.js';
import {
  compileCreativeThesis,
  validateCreativeThesis,
  type CreativeThesis,
} from '../creative-intelligence/CreativeIntelligence.js';
import { resolveSinterProjectRoot } from '../fs/projectRoot.js';
import {
  DomainIncubatorStore,
  parseDomainIncubationRecommendation,
  recommendDomainIncubation,
  type DomainIncubationRecommendation,
} from '../runtime-core/DomainIncubator.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { HeadlessRenderer } from '../render/HeadlessRenderer.js';
import type { RenderEvidence } from '../core/types/GenerationEvaluation.js';
import {
  validateCreativeJudgmentProfile,
  type CreativeJudgmentProfile,
} from '../learning/CreativeJudgmentCalibration.js';
import type { CausalIdentity } from './AttributableRevision.js';
import type {
  BlindReviewJudgment,
  BlindReviewCandidateView,
  BlindReviewPacket,
  BlindReviewRecord,
  CandidateEvidenceAssignment,
  GenerationIdentity,
  ReviewModality,
  UnmaskedReview,
} from './BlindReviewEvidence.js';
import type {
  CoordinatedCompositionResult,
  CreativeRunHandle,
} from './CreativeRunCoordinatorBase.js';

export const DREAM_ASSIMILATION_SCHEMA = 'sinter.dream-assimilate-run' as const;
export const DREAM_ASSIMILATION_VERSION = 2 as const;
export const DREAM_ASSIMILATION_CHECKPOINT_SCHEMA = 'sinter.dream-assimilate-checkpoint' as const;
export const DREAM_ASSIMILATION_CHECKPOINT_VERSION = 3 as const;
export const DREAM_EVALUATOR_SCHEMA = 'sinter.dream-evaluator-manifest' as const;
export const DREAM_EVALUATOR_VERSION = 1 as const;
export const DREAM_PRODUCTION_ARTIFACT_SCHEMA = 'sinter.dream-production-artifact' as const;
export const DREAM_PRODUCTION_ARTIFACT_VERSION = 1 as const;
export const DREAM_JUDGMENT_ASSIMILATION_SCHEMA = 'sinter.dream-judgment-assimilation' as const;
export const DREAM_JUDGMENT_ASSIMILATION_VERSION = 1 as const;

const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 25;

export interface DreamAssimilationIdentities {
  readonly generator: CausalIdentity & { readonly role: 'generator' };
  readonly specialist: CausalIdentity & { readonly role: 'specialist' };
  readonly holistic: CausalIdentity & { readonly role: 'holistic' };
}

export interface DreamAssimilationBudget {
  readonly candidateCount: number;
  readonly candidateBudget: number;
  readonly maxProviderCalls: 0 | 1;
  readonly maxRecommendations: 1;
}

export interface DreamCampaignOriginIdentity {
  readonly rootRunId: string;
  readonly fundingReservationDigest: string;
  readonly feasibilityDigest: string;
  readonly routeFreezeDigest: string;
}

export interface DreamCampaignBinding {
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly stageId: 'dream';
  readonly origin: DreamCampaignOriginIdentity;
}

export interface DreamCampaignProductionSeam {
  readonly binding: DreamCampaignBinding;
  composeFunded(request: CompositionRequest, options: {
    readonly entryPoint: 'studio-layers';
    readonly requestKey: string;
    readonly creativeThesis: CreativeThesis;
    readonly candidateCount: number;
    readonly candidateBudget: number;
    readonly binding: DreamCampaignBinding;
  }): Promise<CoordinatedCompositionResult>;
}

const campaignProductionCapabilities = new WeakSet<object>();

export function sealDreamCampaignProductionSeam(input: {
  readonly binding: DreamCampaignBinding;
  assertActive(): void;
  readonly composeFunded: DreamCampaignProductionSeam['composeFunded'];
}): DreamCampaignProductionSeam {
  const binding = freeze(structuredClone(parseCampaignBinding(input.binding)));
  const bindingDigest = digest(binding);
  const composeFunded: DreamCampaignProductionSeam['composeFunded'] = (request, options) => {
    input.assertActive();
    if (digest(parseCampaignBinding(options.binding)) !== bindingDigest) {
      throw new Error('DREAM_CAMPAIGN_PRODUCTION_BINDING_INVALID');
    }
    return input.composeFunded(request, { ...options, binding });
  };
  const seam = Object.freeze({ binding,
    composeFunded }) satisfies DreamCampaignProductionSeam;
  campaignProductionCapabilities.add(seam);
  return seam;
}

export interface DreamEvaluatorCriterion {
  readonly id: string;
  readonly description: string;
  readonly requiredModalities: readonly ReviewModality[];
}

export interface SealedDreamEvaluatorManifest {
  readonly schema: typeof DREAM_EVALUATOR_SCHEMA;
  readonly schemaVersion: typeof DREAM_EVALUATOR_VERSION;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly identity: CausalIdentity;
  readonly criteria: readonly DreamEvaluatorCriterion[];
  readonly criteriaDigest: string;
  readonly manifestDigest: string;
}

export interface DreamEvaluatorCriterionResult {
  readonly criterionId: string;
  readonly passed: boolean;
  readonly evidenceRefs: readonly string[];
  readonly explanation: string;
}

export interface DreamEvaluatorDecision {
  readonly identity: CausalIdentity;
  readonly manifestDigest: string;
  readonly packetDigest: string;
  readonly verdict: 'approve' | 'veto';
  readonly judgments: readonly BlindReviewJudgment[];
  readonly criteriaResults: readonly DreamEvaluatorCriterionResult[];
  readonly disagreement: readonly string[];
}

export interface DreamEvaluatorContext {
  /** Stable provider idempotency key; evaluators must deduplicate this key. */
  readonly reviewKey: string;
  readonly packet: BlindReviewPacket;
  /** Immutable, playable evidence for the exact composed production output. */
  readonly productionArtifact: DreamProductionArtifactEvidence;
  readonly manifest: SealedDreamEvaluatorManifest;
  readonly signal: AbortSignal;
}

export interface DreamAssimilationEvaluator {
  readonly manifest: SealedDreamEvaluatorManifest;
  evaluate(context: DreamEvaluatorContext): Promise<DreamEvaluatorDecision>;
}

export interface DreamAssimilationEvaluators {
  readonly specialist: DreamAssimilationEvaluator;
  readonly holistic: DreamAssimilationEvaluator;
}

export interface SealedDreamReviewReceipt {
  readonly role: 'specialist' | 'holistic';
  readonly identity: CausalIdentity;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly manifestDigest: string;
  readonly packetDigest: string;
  readonly productionArtifactEvidenceDigest: string;
  readonly verdict: 'approve' | 'veto';
  readonly record: BlindReviewRecord;
  readonly unmasked: UnmaskedReview;
  readonly criteriaResults: readonly DreamEvaluatorCriterionResult[];
  readonly disagreement: readonly string[];
  readonly receiptDigest: string;
}

export interface DreamAssimilationReviewBundle {
  readonly specialist: SealedDreamReviewReceipt;
  readonly holistic: SealedDreamReviewReceipt;
  readonly outcome: 'approve' | 'veto';
  readonly disagreement: readonly string[];
  readonly reviewDigest: string;
}

export interface DreamProductionEvidence {
  readonly run: CreativeRunHandle;
  readonly generatorIdentity: GenerationIdentity;
  readonly graphDigest: string;
  readonly sourceFingerprint: string;
  readonly compositionDigest: string;
  readonly generatedArtifactDigest: string;
  readonly productionArtifact: DreamProductionArtifactEvidence;
  readonly candidates: BlindReviewCandidateView;
  readonly candidateEvidenceBindings: readonly {
    readonly candidateId: string;
    readonly generatedArtifactDigest: string;
    readonly reviewedArtifactDigest: string;
  }[];
  readonly blindReviewPacket: BlindReviewPacket;
  readonly productionMode: 'ambient-no-spend' | 'campaign-funded';
  readonly campaignBinding?: DreamCampaignBinding;
  readonly productionDigest: string;
}

export interface DreamRenderedFrame {
  readonly mimeType: 'image/png';
  readonly dataBase64: string;
  readonly width?: number;
  readonly height?: number;
  readonly digest: string;
}

export interface DreamRenderedEvidence {
  readonly rendererIdentity: string;
  readonly earlyFrame: DreamRenderedFrame;
  readonly lateFrame: DreamRenderedFrame;
  readonly runtimeErrors: readonly string[];
  readonly audio?: RenderEvidence['audio'];
  readonly timingMs: number;
  readonly evidenceDigest: string;
}

export interface DreamProductionArtifactEvidence {
  readonly schema: typeof DREAM_PRODUCTION_ARTIFACT_SCHEMA;
  readonly schemaVersion: typeof DREAM_PRODUCTION_ARTIFACT_VERSION;
  readonly artifactDigest: string;
  readonly compositionDigest: string;
  readonly sourceFingerprint: string;
  readonly playableMedia: {
    readonly modality: 'visual';
    readonly mimeType: 'text/html';
    readonly uri: string;
    readonly digest: string;
  };
  readonly renderedEvidence: DreamRenderedEvidence;
  readonly evidenceDigest: string;
}

export interface DreamArtifactRenderer {
  readonly identity: string;
  renderWithEvidence(html: string): Promise<RenderEvidence>;
}

export interface DreamRecommendationStore {
  getOrCreate(record: DomainIncubationRecommendation): Promise<{
    record: DomainIncubationRecommendation;
    created: boolean;
  }>;
}

export interface DreamSourceArtifactReference {
  readonly id: string;
  readonly domain: string;
  readonly prompt: string;
  readonly code: string;
  readonly codeDigest: string;
}

export interface DreamAssimilationRequest {
  readonly requestKey: string;
  readonly prompt: string;
  /** Human creative brief only; machine learning blocks stay in prompt. */
  readonly creativeBrief?: string;
  /** Exact parents used as research references, never as visible composition layers. */
  readonly sourceArtifacts?: readonly DreamSourceArtifactReference[];
  readonly graph: CompositionRequest;
  readonly identities: DreamAssimilationIdentities;
  readonly evaluators: DreamAssimilationEvaluators;
  readonly budget?: Partial<Omit<DreamAssimilationBudget, 'maxProviderCalls' | 'maxRecommendations'>>;
  readonly store?: DreamAssimilationRunStore;
  readonly recommendationStore?: DreamRecommendationStore;
  readonly signal?: AbortSignal;
  /** Live host seam; only its serializable binding is persisted or fingerprinted. */
  readonly campaignProduction?: DreamCampaignProductionSeam;
  /** Exact learned judgment snapshot consumed by this production request. */
  readonly creativeJudgmentProfile?: CreativeJudgmentProfile;
  /** Injectable for tests; production defaults to HeadlessRenderer. */
  readonly renderer?: DreamArtifactRenderer;
}

export type DreamCheckpointPhase =
  | 'started'
  | 'produced'
  | 'specialist-reviewed'
  | 'reviewed'
  | 'completed';

export interface DreamAssimilationCheckpoint {
  readonly schema: typeof DREAM_ASSIMILATION_CHECKPOINT_SCHEMA;
  readonly schemaVersion: typeof DREAM_ASSIMILATION_CHECKPOINT_VERSION;
  readonly status: 'running' | 'completed';
  readonly phase: DreamCheckpointPhase;
  readonly requestKey: string;
  readonly runId: string;
  readonly lineageId: string;
  readonly requestDigest: string;
  readonly sourceFingerprint: string;
  readonly campaignBinding?: DreamCampaignBinding;
  readonly production?: DreamProductionEvidence;
  readonly specialistReview?: SealedDreamReviewReceipt;
  readonly review?: DreamAssimilationReviewBundle;
  readonly result?: DreamAssimilationResult;
  readonly checkpointDigest: string;
}

export interface DreamAssimilationRecommendation {
  readonly schema: typeof DREAM_ASSIMILATION_SCHEMA;
  readonly schemaVersion: typeof DREAM_ASSIMILATION_VERSION;
  readonly kind: 'composition-primitive';
  readonly status: 'ready-for-owner-review';
  readonly allowedAction: 'request-owner-domain-review';
  readonly promotion: 'forbidden';
  readonly candidateId: string;
  readonly sourceFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly runFingerprint: string;
  readonly campaignBinding?: DreamCampaignBinding;
  readonly recommendation: DomainIncubationRecommendation;
  readonly recommendationDigest: string;
}

export interface DreamJudgmentAssimilationReceipt {
  readonly schema: typeof DREAM_JUDGMENT_ASSIMILATION_SCHEMA;
  readonly schemaVersion: typeof DREAM_JUDGMENT_ASSIMILATION_VERSION;
  readonly status: 'assimilated';
  readonly profileDigest: string;
  readonly requestDigest: string;
  readonly productionDigest: string;
  readonly reviewDigest: string;
  readonly receiptDigest: string;
}

export interface DreamAssimilationResult {
  readonly schema: typeof DREAM_ASSIMILATION_SCHEMA;
  readonly schemaVersion: typeof DREAM_ASSIMILATION_VERSION;
  readonly requestDigest: string;
  readonly runId: string;
  readonly lineageId: string;
  readonly budget: DreamAssimilationBudget;
  readonly identities: DreamAssimilationIdentities;
  readonly production: DreamProductionEvidence;
  readonly review: DreamAssimilationReviewBundle;
  readonly sourceFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly runFingerprint: string;
  readonly campaignBinding?: DreamCampaignBinding;
  readonly authorityBoundary: {
    readonly status: 'owner-action-required';
    readonly ownerPreferenceClaimed: false;
    readonly ownerReleaseClaimed: false;
    readonly learningAuthorized: false;
    readonly transferOpened: false;
    readonly promotionAttempted: false;
  };
  readonly creativeJudgmentAssimilation?: DreamJudgmentAssimilationReceipt;
  readonly recommendation: DreamAssimilationRecommendation;
}

export interface DreamAssimilationRunStore {
  read(requestKey: string): Promise<DreamAssimilationCheckpoint | null>;
  write(checkpoint: DreamAssimilationCheckpoint): Promise<void>;
  claim?<T>(requestKey: string, operation: () => Promise<T>): Promise<T>;
}

export interface DreamAssimilationCoordinator {
  composeNoSpend(request: CompositionRequest, options: {
    readonly entryPoint: 'studio-layers' | 'cli-compose';
    readonly requestKey: string;
    readonly creativeThesis: CreativeThesis;
    readonly candidateCount: number;
    readonly candidateBudget: number;
  }): Promise<CoordinatedCompositionResult>;
  createBlindReviewSession(
    manifest: BlindReviewCandidateView,
    assignments: readonly CandidateEvidenceAssignment[],
  ): import('./BlindReviewEvidence.js').BlindReviewSession;
}

export class DreamAssimilationReviewVeto extends Error {
  constructor(readonly review: DreamAssimilationReviewBundle) {
    super(`DREAM_ASSIMILATION_REVIEW_VETO:${review.disagreement.join('|') || 'adverse-criteria'}`);
    this.name = 'DreamAssimilationReviewVeto';
  }
}

export class MemoryDreamAssimilationRunStore implements DreamAssimilationRunStore {
  readonly #records = new Map<string, DreamAssimilationCheckpoint>();
  readonly #writes: DreamCheckpointPhase[] = [];
  readonly #claims = new Map<string, Promise<unknown>>();

  get writes(): readonly DreamCheckpointPhase[] { return this.#writes; }

  read(requestKey: string): Promise<DreamAssimilationCheckpoint | null> {
    return Promise.resolve(this.#records.get(requestKey) ?? null);
  }

  write(checkpoint: DreamAssimilationCheckpoint): Promise<void> {
    this.#records.set(checkpoint.requestKey, structuredClone(checkpoint));
    this.#writes.push(checkpoint.phase);
    return Promise.resolve();
  }

  async claim<T>(requestKey: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.#claims.get(requestKey) as Promise<T> | undefined;
    if (pending) return pending;
    const current = operation();
    this.#claims.set(requestKey, current);
    try { return await current; } finally { this.#claims.delete(requestKey); }
  }
}

export class FileDreamAssimilationRunStore implements DreamAssimilationRunStore {
  readonly #root: string;
  readonly #claims = new Map<string, Promise<unknown>>();

  constructor(root = path.join(resolveSinterProjectRoot(), '.sinter', 'dream-assimilate-runs')) {
    if (!path.isAbsolute(root)) throw new Error('DREAM_ASSIMILATION_ROOT_NOT_ABSOLUTE');
    this.#root = path.resolve(root);
  }

  async read(requestKey: string): Promise<DreamAssimilationCheckpoint | null> {
    try {
      return parseDreamAssimilationCheckpoint(JSON.parse(await readFile(this.#path(requestKey), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(checkpoint: DreamAssimilationCheckpoint): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await writeFileAtomic(this.#path(checkpoint.requestKey), `${JSON.stringify(checkpoint)}\n`);
  }

  async claim<T>(requestKey: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.#claims.get(requestKey) as Promise<T> | undefined;
    if (pending) return pending;
    const current = this.#claimFile(requestKey, operation);
    this.#claims.set(requestKey, current);
    try { return await current; } finally { this.#claims.delete(requestKey); }
  }

  #path(requestKey: string): string { return path.join(this.#root, `${digest(requestKey)}.json`); }

  async #claimFile<T>(requestKey: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#root, { recursive: true });
    const lockPath = path.join(this.#root, `${digest(requestKey)}.lock`);
    for (;;) {
      try {
        await mkdir(lockPath);
        await writeFileAtomic(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };
          let alive = typeof owner.pid === 'number' && owner.pid > 0;
          if (alive) try { process.kill(owner.pid as number, 0); } catch { alive = false; }
          if (!alive) await rm(lockPath, { recursive: true, force: true });
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code !== 'ENOENT') throw ownerError;
          try {
            if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS) {
              await rm(lockPath, { recursive: true, force: true });
            }
          } catch (lockError) {
            if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    try { return await operation(); } finally { await rm(lockPath, { recursive: true, force: true }); }
  }
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function bytesDigest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function bufferDigest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const SHA256 = /^[a-f0-9]{64}$/;

function parseCampaignBinding(value: unknown): DreamCampaignBinding {
  if (!isRecord(value) || !isRecord(value.origin) || value.stageId !== 'dream') {
    throw new Error('DREAM_CAMPAIGN_BINDING_INVALID');
  }
  const binding = value as unknown as DreamCampaignBinding;
  requireText(binding.campaignRunId, 'DREAM_CAMPAIGN_RUN_ID_REQUIRED');
  requireText(binding.origin.rootRunId, 'DREAM_CAMPAIGN_ORIGIN_REQUIRED');
  for (const candidate of [binding.manifestDigest, binding.planDigest,
    binding.origin.fundingReservationDigest, binding.origin.feasibilityDigest,
    binding.origin.routeFreezeDigest]) {
    if (!SHA256.test(candidate)) throw new Error('DREAM_CAMPAIGN_BINDING_INVALID');
  }
  return binding;
}

function campaignBindingOf(request: DreamAssimilationRequest): DreamCampaignBinding | undefined {
  if (!request.campaignProduction) return undefined;
  if (!campaignProductionCapabilities.has(request.campaignProduction)) {
    throw new Error('DREAM_CAMPAIGN_PRODUCTION_AUTHORITY_INVALID');
  }
  return freeze(structuredClone(parseCampaignBinding(request.campaignProduction.binding)));
}

function persistenceKeyFor(
  requestKey: string,
  campaignBinding?: DreamCampaignBinding,
): string {
  return campaignBinding
    ? `campaign-dream:${digest(campaignBinding)}:${requestKey}`
    : requestKey;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

const INDEPENDENT_IDENTITY_FIELDS = [
  'provider', 'model', 'pipe', 'effort', 'contributionLineage', 'assignment',
] as const satisfies readonly (keyof CausalIdentity)[];

function identitiesAreIndependent(identities: readonly CausalIdentity[]): boolean {
  return INDEPENDENT_IDENTITY_FIELDS.every((field) =>
    new Set(identities.map((identity) => identity[field].trim().toLowerCase())).size
      === identities.length);
}

function parseIdentity(value: unknown, role: CausalIdentity['role']): CausalIdentity {
  if (!isRecord(value) || value.role !== role) throw new Error(`DREAM_ASSIMILATION_IDENTITY_ROLE:${role}`);
  for (const field of ['provider', 'model', 'pipe', 'effort', 'contributionLineage', 'assignment']) {
    requireText(value[field], `DREAM_ASSIMILATION_IDENTITY_INCOMPLETE:${role}:${field}`);
  }
  return value as unknown as CausalIdentity;
}

function freezeIdentities(request: DreamAssimilationRequest): DreamAssimilationIdentities {
  const generator = parseIdentity(request.identities.generator, 'generator');
  const specialist = parseIdentity(request.identities.specialist, 'specialist');
  const holistic = parseIdentity(request.identities.holistic, 'holistic');
  const identities = [generator, specialist, holistic];
  if (!identitiesAreIndependent(identities)) {
    throw new Error('DREAM_ASSIMILATION_IDENTITY_OVERLAP');
  }
  return freeze(structuredClone({ generator, specialist, holistic })) as DreamAssimilationIdentities;
}

export function sealDreamEvaluatorManifest(input: {
  evaluatorId: string;
  evaluatorVersion: string;
  identity: CausalIdentity;
  criteria: readonly DreamEvaluatorCriterion[];
}): SealedDreamEvaluatorManifest {
  requireText(input.evaluatorId, 'DREAM_EVALUATOR_ID_REQUIRED');
  requireText(input.evaluatorVersion, 'DREAM_EVALUATOR_VERSION_REQUIRED');
  if (!['specialist', 'holistic'].includes(input.identity.role)) throw new Error('DREAM_EVALUATOR_ROLE_INVALID');
  if (input.criteria.length === 0 || new Set(input.criteria.map((item) => item.id)).size !== input.criteria.length) {
    throw new Error('DREAM_EVALUATOR_CRITERIA_INVALID');
  }
  for (const criterion of input.criteria) {
    requireText(criterion.id, 'DREAM_EVALUATOR_CRITERION_ID_REQUIRED');
    requireText(criterion.description, 'DREAM_EVALUATOR_CRITERION_DESCRIPTION_REQUIRED');
    if (criterion.requiredModalities.length === 0) throw new Error('DREAM_EVALUATOR_CRITERION_MODALITY_REQUIRED');
  }
  const criteria = structuredClone(input.criteria);
  const criteriaDigest = digest(criteria);
  const body = {
    schema: DREAM_EVALUATOR_SCHEMA,
    schemaVersion: DREAM_EVALUATOR_VERSION,
    evaluatorId: input.evaluatorId,
    evaluatorVersion: input.evaluatorVersion,
    identity: structuredClone(input.identity),
    criteria,
    criteriaDigest,
  };
  return freeze({ ...body, manifestDigest: digest(body) });
}

function parseEvaluatorManifest(value: unknown, role: 'specialist' | 'holistic'): SealedDreamEvaluatorManifest {
  if (!isRecord(value) || value.schema !== DREAM_EVALUATOR_SCHEMA
    || value.schemaVersion !== DREAM_EVALUATOR_VERSION || !Array.isArray(value.criteria)) {
    throw new Error('DREAM_EVALUATOR_MANIFEST_INVALID');
  }
  const manifest = value as unknown as SealedDreamEvaluatorManifest;
  const expected = sealDreamEvaluatorManifest({
    evaluatorId: manifest.evaluatorId,
    evaluatorVersion: manifest.evaluatorVersion,
    identity: parseIdentity(manifest.identity, role),
    criteria: manifest.criteria,
  });
  if (canonical(expected) !== canonical(manifest)) throw new Error('DREAM_EVALUATOR_SEAL_DRIFT');
  return manifest;
}

function freezeBudget(request: DreamAssimilationRequest): DreamAssimilationBudget {
  const candidateCount = request.budget?.candidateCount ?? 3;
  const candidateBudget = request.budget?.candidateBudget ?? candidateCount;
  if (!Number.isInteger(candidateCount) || candidateCount < 3
    || !Number.isInteger(candidateBudget) || candidateBudget < candidateCount) {
    throw new Error('DREAM_ASSIMILATION_BUDGET_INVALID');
  }
  return freeze({ candidateCount, candidateBudget,
    maxProviderCalls: request.campaignProduction ? 1 as const : 0 as const,
    maxRecommendations: 1 as const });
}

function sourceArtifactManifest(request: DreamAssimilationRequest) {
  return (request.sourceArtifacts ?? []).map((source) => {
    requireText(source.id, 'DREAM_SOURCE_ID_REQUIRED');
    requireText(source.domain, 'DREAM_SOURCE_DOMAIN_REQUIRED');
    requireText(source.prompt, 'DREAM_SOURCE_PROMPT_REQUIRED');
    requireText(source.code, 'DREAM_SOURCE_CODE_REQUIRED');
    const codeDigest = bytesDigest(source.code);
    if (source.codeDigest !== codeDigest
      || !request.prompt.includes(`source_digest=${codeDigest}`)) {
      throw new Error('DREAM_SOURCE_ARTIFACT_BINDING_INVALID');
    }
    return { id: source.id, domain: source.domain, prompt: source.prompt, codeDigest };
  });
}

function sourceFingerprints(request: DreamAssimilationRequest, budget: DreamAssimilationBudget) {
  const prepared = prepareComposition(request.graph);
  const creativeBrief = request.creativeBrief ?? request.prompt;
  requireText(creativeBrief, 'DREAM_ASSIMILATION_CREATIVE_BRIEF_REQUIRED');
  const thesis = validateCreativeThesis(prepared.creativeThesis ?? compileCreativeThesis(creativeBrief));
  if (thesis.disposition !== 'supported') throw new Error('DREAM_ASSIMILATION_THESIS_UNSUPPORTED');
  const creativeJudgmentProfile = request.creativeJudgmentProfile
    ? validateCreativeJudgmentProfile(request.creativeJudgmentProfile)
    : undefined;
  if (creativeJudgmentProfile
    && (!request.prompt.includes(`profile_digest=${creativeJudgmentProfile.profileDigest}`)
      || !request.prompt.includes(`weights=${JSON.stringify(creativeJudgmentProfile.weights)}`)
      || creativeJudgmentProfile.guidance.some((guidance) =>
        !request.prompt.includes(`guidance=${guidance}`)))) {
    throw new Error('DREAM_JUDGMENT_PROFILE_NOT_CONSUMED');
  }
  const graphDigest = digest({ ...prepared, creativeThesis: thesis });
  const evaluatorDigests = {
    specialist: request.evaluators.specialist.manifest.manifestDigest,
    holistic: request.evaluators.holistic.manifest.manifestDigest,
  };
  const rendererIdentity = (request.renderer ?? productionRenderer).identity;
  requireText(rendererIdentity, 'DREAM_RENDERER_IDENTITY_REQUIRED');
  const campaignBinding = campaignBindingOf(request);
  const sourceArtifacts = sourceArtifactManifest(request);
  const requestDigest = digest({ requestKey: request.requestKey, prompt: request.prompt, creativeBrief,
    graph: request.graph, budget, identities: request.identities, evaluatorDigests,
    campaignBinding, creativeJudgmentProfile, rendererIdentity, sourceArtifacts });
  return { thesis, graphDigest, requestDigest,
    sourceFingerprint: digest({ graphDigest, requestDigest, thesis, evaluatorDigests,
      campaignBinding, creativeJudgmentProfile, rendererIdentity, sourceArtifacts }), campaignBinding,
    creativeJudgmentProfile, rendererIdentity, sourceArtifacts };
}

function judgmentAssimilationReceipt(
  profile: CreativeJudgmentProfile,
  requestDigest: string,
  productionDigestValue: string,
  reviewDigest: string,
): DreamJudgmentAssimilationReceipt {
  const body = { schema: DREAM_JUDGMENT_ASSIMILATION_SCHEMA,
    schemaVersion: DREAM_JUDGMENT_ASSIMILATION_VERSION, status: 'assimilated' as const,
    profileDigest: profile.profileDigest, requestDigest,
    productionDigest: productionDigestValue, reviewDigest };
  return freeze({ ...body, receiptDigest: digest(body) });
}

function checkpointBody(checkpoint: Omit<DreamAssimilationCheckpoint, 'checkpointDigest'>): DreamAssimilationCheckpoint {
  return freeze({ ...checkpoint, checkpointDigest: digest(checkpoint) });
}

function nextCheckpoint(
  previous: DreamAssimilationCheckpoint,
  phase: DreamCheckpointPhase,
  additions: Partial<Pick<DreamAssimilationCheckpoint,
  'production' | 'specialistReview' | 'review' | 'result'>>,
): DreamAssimilationCheckpoint {
  return checkpointBody({
    schema: previous.schema, schemaVersion: previous.schemaVersion,
    status: phase === 'completed' ? 'completed' : 'running', phase,
    requestKey: previous.requestKey, runId: previous.runId, lineageId: previous.lineageId,
    requestDigest: previous.requestDigest, sourceFingerprint: previous.sourceFingerprint,
    ...(previous.campaignBinding ? { campaignBinding: previous.campaignBinding } : {}),
    ...additions,
  });
}

function verifyPacketDigest(packet: BlindReviewPacket): void {
  const body = { schema: packet.schema, version: packet.version,
    candidateSetDigest: packet.candidateSetDigest, candidates: packet.candidates,
    contactSheetHtml: packet.contactSheetHtml, playableMedia: packet.playableMedia };
  if (bytesDigest(JSON.stringify(body)) !== packet.packetDigest) {
    throw new Error('DREAM_ASSIMILATION_EVIDENCE_DIGEST_MISMATCH');
  }
}

function reviewReceiptDigest(receipt: Omit<SealedDreamReviewReceipt, 'receiptDigest'>): string {
  return digest(receipt);
}

function parseReviewBundle(value: unknown): DreamAssimilationReviewBundle {
  if (!isRecord(value) || !isRecord(value.specialist) || !isRecord(value.holistic)
    || !Array.isArray(value.disagreement)) throw new Error('DREAM_ASSIMILATION_REVIEW_INVALID');
  const review = value as unknown as DreamAssimilationReviewBundle;
  for (const [role, receipt] of [['specialist', review.specialist], ['holistic', review.holistic]] as const) {
    if (receipt.role !== role || !isRecord(receipt.record) || !isRecord(receipt.unmasked)
      || !Array.isArray(receipt.criteriaResults) || !Array.isArray(receipt.disagreement)) {
      throw new Error('DREAM_ASSIMILATION_REVIEW_INVALID');
    }
    const { receiptDigest, ...body } = receipt;
    parseIdentity(receipt.identity, role);
    requireText(receipt.evaluatorId, 'DREAM_EVALUATOR_ID_REQUIRED');
    requireText(receipt.evaluatorVersion, 'DREAM_EVALUATOR_VERSION_REQUIRED');
    requireText(receipt.manifestDigest, 'DREAM_EVALUATOR_MANIFEST_DIGEST_REQUIRED');
    requireText(receipt.productionArtifactEvidenceDigest,
      'DREAM_PRODUCTION_ARTIFACT_EVIDENCE_DIGEST_REQUIRED');
    if (reviewReceiptDigest(body) !== receiptDigest) throw new Error('DREAM_ASSIMILATION_REVIEW_DIGEST_MISMATCH');
    if (receipt.record.packetDigest !== receipt.packetDigest
      || receipt.unmasked.packetDigest !== receipt.packetDigest
      || receipt.unmasked.reviewDigest !== receipt.record.reviewDigest
      || bytesDigest(JSON.stringify({ packetDigest: receipt.record.packetDigest,
        judgments: receipt.record.judgments })) !== receipt.record.reviewDigest
      || bytesDigest(JSON.stringify({ boundary: receipt.unmasked.boundary,
        packetDigest: receipt.unmasked.packetDigest,
        reviewDigest: receipt.unmasked.reviewDigest,
        mappings: receipt.unmasked.mappings })) !== receipt.unmasked.auditDigest) {
      throw new Error('DREAM_ASSIMILATION_REVIEW_EVIDENCE_MISMATCH');
    }
  }
  const expectedOutcome = review.specialist.verdict === 'approve' && review.holistic.verdict === 'approve'
    ? 'approve' : 'veto';
  if (review.outcome !== expectedOutcome || digest({ specialist: review.specialist.receiptDigest,
    holistic: review.holistic.receiptDigest, outcome: review.outcome,
    disagreement: review.disagreement }) !== review.reviewDigest) {
    throw new Error('DREAM_ASSIMILATION_REVIEW_DIGEST_MISMATCH');
  }
  return review;
}

function verifyProduction(production: DreamProductionEvidence): void {
  if (!isRecord(production.run) || !Array.isArray(production.candidates?.candidates)
    || !isRecord(production.productionArtifact)
    || !Array.isArray(production.candidateEvidenceBindings)) {
    throw new Error('DREAM_ASSIMILATION_PRODUCTION_INVALID');
  }
  verifyProductionArtifact(production.productionArtifact);
  const { productionDigest: recorded, ...body } = production;
  const productionMode = production.productionMode ?? 'ambient-no-spend';
  if (!['ambient-no-spend', 'campaign-funded'].includes(productionMode)) {
    throw new Error('DREAM_ASSIMILATION_PRODUCTION_INVALID');
  }
  const campaign = productionMode === 'campaign-funded';
  if (campaign) parseCampaignBinding(production.campaignBinding);
  if (productionDigest(body) !== recorded
    || production.run.record.status !== 'completed'
    || production.run.readiness.source !== (campaign ? 'injected-provider' : 'synthetic-no-spend')
    || production.run.providerReservation.source !== (campaign ? 'injected-provider' : 'synthetic-no-spend')
    || (campaign
      ? production.run.rootRunId !== production.campaignBinding?.origin.rootRunId
      : production.campaignBinding !== undefined)
    || production.candidateEvidenceBindings.length !== production.candidates.candidates.length) {
    throw new Error('DREAM_ASSIMILATION_PRODUCTION_INVALID');
  }
  verifyPacketDigest(production.blindReviewPacket);
  if (production.generatedArtifactDigest !== production.productionArtifact.artifactDigest
    || production.compositionDigest !== production.productionArtifact.compositionDigest
    || production.sourceFingerprint !== production.productionArtifact.sourceFingerprint) {
    throw new Error('DREAM_ASSIMILATION_PRODUCTION_ARTIFACT_INVALID');
  }
  for (const [index, binding] of production.candidateEvidenceBindings.entries()) {
    const candidate = production.candidates.candidates[index];
    if (!candidate || binding.candidateId !== candidate.id
      || binding.generatedArtifactDigest !== candidate.artifact.artifactDigest
      || binding.reviewedArtifactDigest !== candidate.artifact.artifactDigest) {
      throw new Error('DREAM_ASSIMILATION_PRODUCTION_INVALID');
    }
  }
}

export function parseDreamAssimilationCheckpoint(value: unknown): DreamAssimilationCheckpoint {
  if (!isRecord(value)) throw new Error('DREAM_ASSIMILATION_STALE_SCHEMA');
  const record = value as unknown as DreamAssimilationCheckpoint;
  if (record.schema !== DREAM_ASSIMILATION_CHECKPOINT_SCHEMA
    || record.schemaVersion !== DREAM_ASSIMILATION_CHECKPOINT_VERSION
    || !['started', 'produced', 'specialist-reviewed', 'reviewed', 'completed'].includes(record.phase)
    || record.status !== (record.phase === 'completed' ? 'completed' : 'running')) {
    throw new Error('DREAM_ASSIMILATION_STALE_SCHEMA');
  }
  for (const field of ['requestKey', 'runId', 'lineageId', 'requestDigest',
    'sourceFingerprint', 'checkpointDigest'] as const) {
    requireText(record[field], `DREAM_ASSIMILATION_CHECKPOINT_FIELD:${field}`);
  }
  const { checkpointDigest, ...body } = record;
  if (digest(body) !== checkpointDigest) throw new Error('DREAM_ASSIMILATION_CHECKPOINT_DIGEST_MISMATCH');
  if (record.campaignBinding) parseCampaignBinding(record.campaignBinding);
  if (['produced', 'specialist-reviewed', 'reviewed', 'completed'].includes(record.phase)
    && !record.production) {
    throw new Error('DREAM_ASSIMILATION_PARTIAL_CHECKPOINT');
  }
  if (['specialist-reviewed', 'reviewed', 'completed'].includes(record.phase)
    && !record.specialistReview) {
    throw new Error('DREAM_ASSIMILATION_PARTIAL_CHECKPOINT');
  }
  if (record.production) verifyProduction(record.production);
  if (record.production
    && canonical(record.production.campaignBinding) !== canonical(record.campaignBinding)) {
    throw new Error('DREAM_ASSIMILATION_CAMPAIGN_BINDING_MISMATCH');
  }
  if (['reviewed', 'completed'].includes(record.phase) && !record.review) {
    throw new Error('DREAM_ASSIMILATION_PARTIAL_CHECKPOINT');
  }
  if (record.specialistReview) {
    const { receiptDigest, ...body } = record.specialistReview;
    if (record.specialistReview.role !== 'specialist'
      || !isRecord(record.specialistReview.record)
      || !isRecord(record.specialistReview.unmasked)
      || !Array.isArray(record.specialistReview.criteriaResults)
      || !Array.isArray(record.specialistReview.disagreement)
      || reviewReceiptDigest(body) !== receiptDigest
      || record.specialistReview.record.packetDigest !== record.specialistReview.packetDigest
      || record.specialistReview.unmasked.packetDigest !== record.specialistReview.packetDigest
      || record.specialistReview.unmasked.reviewDigest
        !== record.specialistReview.record.reviewDigest
      || record.specialistReview.productionArtifactEvidenceDigest
        !== record.production?.productionArtifact.evidenceDigest) {
      throw new Error('DREAM_ASSIMILATION_REVIEW_DIGEST_MISMATCH');
    }
  }
  if (record.review) {
    parseReviewBundle(record.review);
    if (!record.specialistReview
      || canonical(record.review.specialist) !== canonical(record.specialistReview)) {
      throw new Error('DREAM_ASSIMILATION_REVIEW_EVIDENCE_MISMATCH');
    }
  }
  if (record.phase === 'completed') {
    const result = parseDreamAssimilationResult(record.result);
    if (result.runId !== record.runId || result.lineageId !== record.lineageId
      || result.requestDigest !== record.requestDigest
      || result.sourceFingerprint !== record.sourceFingerprint
      || canonical(result.campaignBinding) !== canonical(record.campaignBinding)) {
      throw new Error('DREAM_ASSIMILATION_CROSS_RUN_EVIDENCE');
    }
  }
  return record;
}

function evidenceFingerprintOf(result: DreamAssimilationResult): string {
  return digest({ sourceFingerprint: result.sourceFingerprint,
    productionDigest: result.production.productionDigest,
    reviewDigest: result.review.reviewDigest,
    authorityBoundary: result.authorityBoundary,
    creativeJudgmentAssimilationDigest:
      result.creativeJudgmentAssimilation?.receiptDigest,
    recommendationReceiptDigest: result.recommendation.recommendation.receiptDigest });
}

function runFingerprintOf(result: DreamAssimilationResult): string {
  return digest({ runId: result.runId, lineageId: result.lineageId,
    evidenceFingerprint: result.evidenceFingerprint,
    executionRootRunId: result.production.run.rootRunId,
    executionLineageId: result.production.run.lineageId });
}

function verifyJudgmentAssimilation(result: DreamAssimilationResult): void {
  const receipt = result.creativeJudgmentAssimilation;
  if (!receipt) return;
  const { receiptDigest, ...body } = receipt;
  if (receipt.schema !== DREAM_JUDGMENT_ASSIMILATION_SCHEMA
    || receipt.schemaVersion !== DREAM_JUDGMENT_ASSIMILATION_VERSION
    || receipt.status !== 'assimilated'
    || receipt.requestDigest !== result.requestDigest
    || receipt.productionDigest !== result.production.productionDigest
    || receipt.reviewDigest !== result.review.reviewDigest
    || !/^[a-f0-9]{64}$/.test(receipt.profileDigest)
    || digest(body) !== receiptDigest) {
    throw new Error('DREAM_JUDGMENT_ASSIMILATION_INVALID');
  }
}

export function parseDreamAssimilationResult(value: unknown): DreamAssimilationResult {
  if (!isRecord(value)) throw new Error('DREAM_ASSIMILATION_FABRICATED_RESULT');
  const result = value as unknown as DreamAssimilationResult;
  const campaign = result.production?.productionMode === 'campaign-funded';
  if (result.schema !== DREAM_ASSIMILATION_SCHEMA || result.schemaVersion !== DREAM_ASSIMILATION_VERSION
    || !isRecord(result.production) || !isRecord(result.review) || !isRecord(result.recommendation)
    || !isRecord(result.authorityBoundary) || result.review.outcome !== 'approve'
    || result.authorityBoundary.status !== 'owner-action-required'
    || result.authorityBoundary.ownerPreferenceClaimed !== false
    || result.authorityBoundary.ownerReleaseClaimed !== false
    || result.authorityBoundary.learningAuthorized !== false
    || result.authorityBoundary.transferOpened !== false
    || result.authorityBoundary.promotionAttempted !== false
    || result.recommendation.status !== 'ready-for-owner-review'
    || result.recommendation.promotion !== 'forbidden') {
    throw new Error('DREAM_ASSIMILATION_FABRICATED_RESULT');
  }
  const identities = [parseIdentity(result.identities.generator, 'generator'),
    parseIdentity(result.identities.specialist, 'specialist'),
    parseIdentity(result.identities.holistic, 'holistic')];
  if (!identitiesAreIndependent(identities)
    || result.budget.maxProviderCalls !== (campaign ? 1 : 0)
    || result.budget.maxRecommendations !== 1
    || result.budget.candidateCount < 3
    || result.budget.candidateBudget < result.budget.candidateCount) {
    throw new Error('DREAM_ASSIMILATION_FABRICATED_RESULT');
  }
  verifyPacketDigest(result.production.blindReviewPacket);
  verifyProduction(result.production);
  parseReviewBundle(result.review);
  verifyJudgmentAssimilation(result);
  parseDomainIncubationRecommendation(result.recommendation.recommendation);
  if (campaign) parseCampaignBinding(result.campaignBinding);
  const { recommendationDigest, ...recommendationBody } = result.recommendation;
  if (digest(recommendationBody) !== recommendationDigest
    || evidenceFingerprintOf(result) !== result.evidenceFingerprint
    || runFingerprintOf(result) !== result.runFingerprint
    || result.recommendation.evidenceFingerprint !== result.evidenceFingerprint
    || result.recommendation.runFingerprint !== result.runFingerprint
    || result.recommendation.sourceFingerprint !== result.sourceFingerprint
    || result.production.sourceFingerprint !== result.sourceFingerprint
    || canonical(result.production.campaignBinding) !== canonical(result.campaignBinding)
    || canonical(result.recommendation.campaignBinding) !== canonical(result.campaignBinding)
    || result.recommendation.candidateId !== result.recommendation.recommendation.candidateId
    || result.review.specialist.packetDigest !== result.production.blindReviewPacket.packetDigest
    || result.review.holistic.packetDigest !== result.production.blindReviewPacket.packetDigest
    || result.review.specialist.productionArtifactEvidenceDigest
      !== result.production.productionArtifact.evidenceDigest
    || result.review.holistic.productionArtifactEvidenceDigest
      !== result.production.productionArtifact.evidenceDigest) {
    throw new Error('DREAM_ASSIMILATION_CROSS_RUN_EVIDENCE');
  }
  return result;
}

function assignments(manifest: BlindReviewCandidateView, identity: GenerationIdentity): CandidateEvidenceAssignment[] {
  return manifest.candidates.map((candidate) => ({
    candidateId: candidate.id,
    sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: ['visual'] as const,
    generationIdentity: identity,
  }));
}

function productionDigest(evidence: Omit<DreamProductionEvidence, 'productionDigest'>): string {
  return digest(evidence);
}

const productionRenderer: DreamArtifactRenderer = {
  identity: 'HeadlessRenderer/PlaywrightChromium',
  renderWithEvidence: (html) => HeadlessRenderer.getInstance().renderWithEvidence(html, {
    domain: 'html', lateCaptureDelay: 3000,
  }),
};

function sealRenderedEvidence(identity: string, evidence: RenderEvidence): DreamRenderedEvidence {
  if (!identity.trim() || evidence.infraUnavailable || evidence.candidateFailure
    || !evidence.screenshot || !evidence.lateScreenshot
    || (evidence.errors?.length ?? 0) > 0
    || evidence.screenshot.mimeType !== 'image/png'
    || evidence.lateScreenshot.mimeType !== 'image/png') {
    throw new Error('DREAM_RENDERED_EVIDENCE_REQUIRED');
  }
  const frame = (value: NonNullable<RenderEvidence['screenshot']>): DreamRenderedFrame => ({
    mimeType: 'image/png', dataBase64: value.dataBase64,
    ...(value.width ? { width: value.width } : {}),
    ...(value.height ? { height: value.height } : {}),
    digest: bufferDigest(Buffer.from(value.dataBase64, 'base64')),
  });
  const body = { rendererIdentity: identity, earlyFrame: frame(evidence.screenshot),
    lateFrame: frame(evidence.lateScreenshot), runtimeErrors: [...(evidence.errors ?? [])],
    ...(evidence.audio ? { audio: evidence.audio } : {}), timingMs: evidence.timingMs };
  return freeze({ ...body, evidenceDigest: digest(body) });
}

function productionArtifactEvidence(input: {
  html: string;
  compositionDigest: string;
  sourceFingerprint: string;
  renderedEvidence: DreamRenderedEvidence;
}): DreamProductionArtifactEvidence {
  const artifactDigest = bytesDigest(input.html);
  const body = {
    schema: DREAM_PRODUCTION_ARTIFACT_SCHEMA,
    schemaVersion: DREAM_PRODUCTION_ARTIFACT_VERSION,
    artifactDigest,
    compositionDigest: input.compositionDigest,
    sourceFingerprint: input.sourceFingerprint,
    playableMedia: {
      modality: 'visual' as const,
      mimeType: 'text/html' as const,
      uri: `data:text/html;base64,${Buffer.from(input.html).toString('base64')}`,
      digest: artifactDigest,
    },
    renderedEvidence: input.renderedEvidence,
  };
  return freeze({ ...body, evidenceDigest: digest(body) });
}

function verifyRenderedEvidence(evidence: DreamRenderedEvidence): void {
  const { evidenceDigest, ...body } = evidence;
  const frames = [evidence.earlyFrame, evidence.lateFrame];
  if (!evidence.rendererIdentity?.trim() || !Array.isArray(evidence.runtimeErrors)
    || evidence.runtimeErrors.length > 0 || !Number.isFinite(evidence.timingMs)
    || frames.some((frame) => !frame || frame.mimeType !== 'image/png'
      || !frame.dataBase64 || bufferDigest(Buffer.from(frame.dataBase64, 'base64'))
        !== frame.digest)
    || digest(body) !== evidenceDigest) {
    throw new Error('DREAM_RENDERED_EVIDENCE_INVALID');
  }
}

function verifyProductionArtifact(evidence: DreamProductionArtifactEvidence): void {
  if (!isRecord(evidence) || !isRecord(evidence.playableMedia)
    || !isRecord(evidence.renderedEvidence)) {
    throw new Error('DREAM_ASSIMILATION_PRODUCTION_ARTIFACT_INVALID');
  }
  const { evidenceDigest, ...body } = evidence;
  verifyRenderedEvidence(evidence.renderedEvidence);
  const prefix = 'data:text/html;base64,';
  if (evidence.schema !== DREAM_PRODUCTION_ARTIFACT_SCHEMA
    || evidence.schemaVersion !== DREAM_PRODUCTION_ARTIFACT_VERSION
    || evidence.playableMedia.modality !== 'visual'
    || evidence.playableMedia.mimeType !== 'text/html'
    || !evidence.playableMedia.uri.startsWith(prefix)
    || evidence.playableMedia.digest !== evidence.artifactDigest
    || bytesDigest(Buffer.from(evidence.playableMedia.uri.slice(prefix.length), 'base64').toString())
      !== evidence.artifactDigest
    || digest(body) !== evidenceDigest) {
    throw new Error('DREAM_ASSIMILATION_PRODUCTION_ARTIFACT_INVALID');
  }
}

function assertGenerativeSynthesis(
  request: DreamAssimilationRequest,
  composition: CoordinatedCompositionResult,
): void {
  if (!request.sourceArtifacts?.length) return;
  const prepared = prepareComposition(request.graph);
  if (prepared.layers.length !== 1 || prepared.layers.some((layer) => layer.code)
    || composition.layers.length !== 1 || composition.successCount !== 1
    || !composition.layers[0]?.generated) {
    throw new Error('DREAM_GENERATIVE_SYNTHESIS_REQUIRED');
  }
  for (const source of request.sourceArtifacts) {
    const encoded = Buffer.from(source.code).toString('base64');
    if (composition.html.includes(source.code) || composition.html.includes(encoded)) {
      throw new Error('DREAM_SOURCE_ARTIFACT_REPLAYED');
    }
  }
}

function actualCandidateView(
  composition: CoordinatedCompositionResult,
  artifactDigest: string,
  thesis: CreativeThesis,
): BlindReviewCandidateView {
  return freeze({ creativeThesis: thesis, candidates: [{
    id: `dream-actual-${artifactDigest.slice(0, 16)}`,
    artifact: { html: composition.html, artifactDigest,
      successCount: composition.successCount, layerCount: composition.layers.length },
  }] });
}

async function produce(
  coordinator: DreamAssimilationCoordinator,
  request: DreamAssimilationRequest,
  budget: DreamAssimilationBudget,
  source: ReturnType<typeof sourceFingerprints>,
): Promise<DreamProductionEvidence> {
  const options = {
    entryPoint: 'studio-layers', requestKey: `dream-assimilate:${source.requestDigest}`,
    creativeThesis: source.thesis, candidateCount: budget.candidateCount,
    candidateBudget: budget.candidateBudget,
  } as const;
  const campaignBinding = source.campaignBinding;
  if (request.campaignProduction
    && canonical(parseCampaignBinding(request.campaignProduction.binding))
      !== canonical(campaignBinding)) {
    throw new Error('DREAM_CAMPAIGN_BINDING_DRIFT');
  }
  const composition = request.campaignProduction
    ? await request.campaignProduction.composeFunded(request.graph, {
      ...options, binding: campaignBinding!,
    })
    : await coordinator.composeNoSpend(request.graph, options);
  const expectedSource = campaignBinding ? 'injected-provider' : 'synthetic-no-spend';
  if (composition.creativeRun.readiness.source !== expectedSource
    || composition.creativeRun.providerReservation.source !== expectedSource
    || (campaignBinding
      && composition.creativeRun.rootRunId !== campaignBinding.origin.rootRunId)) {
    throw new Error(campaignBinding
      ? 'DREAM_CAMPAIGN_FUNDED_PRODUCTION_INVALID'
      : 'DREAM_ASSIMILATION_PROVIDER_SPEND_FORBIDDEN');
  }
  assertGenerativeSynthesis(request, composition);
  const generatedArtifactDigest = bytesDigest(composition.html);
  const candidates = actualCandidateView(composition, generatedArtifactDigest, source.thesis);
  const generationAssignments = assignments(candidates, request.identities.generator);
  const packet = coordinator.createBlindReviewSession(candidates, generationAssignments).packet;
  const compositionDigest = digest({ generatedArtifactDigest, title: composition.title,
    background: composition.background, layers: composition.layers,
    successCount: composition.successCount });
  const renderer = request.renderer ?? productionRenderer;
  if (renderer.identity !== source.rendererIdentity) {
    throw new Error('DREAM_RENDERER_IDENTITY_DRIFT');
  }
  const renderedEvidence = sealRenderedEvidence(renderer.identity,
    await renderer.renderWithEvidence(composition.html));
  const exactArtifact = productionArtifactEvidence({ html: composition.html,
    compositionDigest, sourceFingerprint: source.sourceFingerprint, renderedEvidence });
  const body = {
    run: composition.creativeRun, generatorIdentity: structuredClone(request.identities.generator),
    graphDigest: source.graphDigest, sourceFingerprint: source.sourceFingerprint,
    compositionDigest,
    generatedArtifactDigest, productionArtifact: exactArtifact,
    candidates,
    candidateEvidenceBindings: candidates.candidates.map((candidate) => ({
      candidateId: candidate.id,
      generatedArtifactDigest: candidate.artifact.artifactDigest,
      reviewedArtifactDigest: candidate.artifact.artifactDigest,
    })),
    blindReviewPacket: packet,
    productionMode: campaignBinding ? 'campaign-funded' as const : 'ambient-no-spend' as const,
    ...(campaignBinding ? { campaignBinding } : {}),
  };
  return freeze({ ...body, productionDigest: productionDigest(body) });
}

function validateCriterionResults(
  manifest: SealedDreamEvaluatorManifest,
  decision: DreamEvaluatorDecision,
  packet: BlindReviewPacket,
  productionArtifact: DreamProductionArtifactEvidence,
): boolean {
  if (decision.criteriaResults.length !== manifest.criteria.length
    || new Set(decision.criteriaResults.map((item) => item.criterionId)).size !== decision.criteriaResults.length) {
    throw new Error('DREAM_EVALUATOR_CRITERIA_RESULT_INCOMPLETE');
  }
  const evidence = new Set(packet.candidates.flatMap((candidate) => candidate.media.map((media) => media.digest)));
  evidence.add(productionArtifact.artifactDigest);
  evidence.add(productionArtifact.renderedEvidence.earlyFrame.digest);
  evidence.add(productionArtifact.renderedEvidence.lateFrame.digest);
  for (const criterion of manifest.criteria) {
    const result = decision.criteriaResults.find((item) => item.criterionId === criterion.id);
    if (!result || !result.explanation.trim()
      || !result.evidenceRefs.includes(productionArtifact.artifactDigest)
      || (criterion.requiredModalities.includes('visual')
        && (!result.evidenceRefs.includes(productionArtifact.renderedEvidence.earlyFrame.digest)
          || !result.evidenceRefs.includes(productionArtifact.renderedEvidence.lateFrame.digest)))
      || result.evidenceRefs.some((ref) => !evidence.has(ref))) {
      throw new Error('DREAM_EVALUATOR_CRITERIA_EVIDENCE_INVALID');
    }
    for (const candidate of packet.candidates) {
      for (const modality of criterion.requiredModalities) {
        const media = candidate.media.find((item) => item.modality === modality);
        if (!media || !result.evidenceRefs.includes(media.digest)) {
          throw new Error('DREAM_EVALUATOR_CRITERIA_EVIDENCE_INVALID');
        }
      }
    }
  }
  return decision.criteriaResults.every((item) => item.passed);
}

async function executeReview(
  role: 'specialist' | 'holistic',
  evaluator: DreamAssimilationEvaluator,
  expectedIdentity: CausalIdentity,
  coordinator: DreamAssimilationCoordinator,
  production: DreamProductionEvidence,
  signal: AbortSignal,
): Promise<SealedDreamReviewReceipt> {
  const before = parseEvaluatorManifest(evaluator.manifest, role);
  if (canonical(before.identity) !== canonical(expectedIdentity)) throw new Error('DREAM_EVALUATOR_IDENTITY_MISMATCH');
  const session = coordinator.createBlindReviewSession(
    production.candidates, assignments(production.candidates, production.generatorIdentity),
  );
  if (session.packet.packetDigest !== production.blindReviewPacket.packetDigest) {
    throw new Error('DREAM_ASSIMILATION_EVIDENCE_DIGEST_MISMATCH');
  }
  const reviewKey = digest({ rootRunId: production.run.rootRunId, role,
    packetDigest: production.blindReviewPacket.packetDigest,
    manifestDigest: before.manifestDigest });
  const decision = await evaluator.evaluate({ reviewKey,
    packet: production.blindReviewPacket,
    productionArtifact: production.productionArtifact, manifest: before, signal });
  const after = parseEvaluatorManifest(evaluator.manifest, role);
  if (before.manifestDigest !== after.manifestDigest || decision.manifestDigest !== before.manifestDigest) {
    throw new Error('DREAM_EVALUATOR_SEAL_DRIFT');
  }
  if (canonical(decision.identity) !== canonical(before.identity)
    || decision.packetDigest !== production.blindReviewPacket.packetDigest) {
    throw new Error('DREAM_EVALUATOR_IDENTITY_OR_PACKET_MISMATCH');
  }
  const record = session.submitReview(production.blindReviewPacket, decision.judgments);
  const unmasked = session.unmask();
  const criteriaPass = validateCriterionResults(before, decision, production.blindReviewPacket,
    production.productionArtifact);
  const evidencePass = record.judgments.every((judgment) => judgment.outcome === 'pass');
  const expectedVerdict = criteriaPass && evidencePass ? 'approve' : 'veto';
  if (decision.verdict !== expectedVerdict) throw new Error('DREAM_EVALUATOR_VERDICT_INCONSISTENT');
  const body = {
    role, identity: structuredClone(before.identity), evaluatorId: before.evaluatorId,
    evaluatorVersion: before.evaluatorVersion, manifestDigest: before.manifestDigest,
    packetDigest: production.blindReviewPacket.packetDigest,
    productionArtifactEvidenceDigest: production.productionArtifact.evidenceDigest,
    verdict: decision.verdict,
    record, unmasked, criteriaResults: structuredClone(decision.criteriaResults),
    disagreement: [...decision.disagreement],
  };
  return freeze({ ...body, receiptDigest: reviewReceiptDigest(body) });
}

function combineReviews(
  specialist: SealedDreamReviewReceipt,
  holistic: SealedDreamReviewReceipt,
): DreamAssimilationReviewBundle {
  const disagreement = [...specialist.disagreement, ...holistic.disagreement];
  if (specialist.verdict !== holistic.verdict) {
    disagreement.push(`verdict:${specialist.verdict}:${holistic.verdict}`);
  }
  const outcome: DreamAssimilationReviewBundle['outcome'] =
    specialist.verdict === 'approve' && holistic.verdict === 'approve' ? 'approve' : 'veto';
  const body = { specialist, holistic, outcome, disagreement };
  return freeze({ ...body, reviewDigest: digest({ specialist: specialist.receiptDigest,
    holistic: holistic.receiptDigest, outcome, disagreement }) });
}

function recommendationFor(
  request: DreamAssimilationRequest,
  source: ReturnType<typeof sourceFingerprints>,
  production: DreamProductionEvidence,
  review: DreamAssimilationReviewBundle,
): DomainIncubationRecommendation {
  const slug = `composition-${source.sourceFingerprint.slice(0, 12)}`;
  return recommendDomainIncubation({
    slug, displayName: 'Dream arbitrary-N composition layering', kind: 'composition-primitive',
    rationale: 'Two sealed independent critics reviewed a bounded production-graph exploration. Owner action remains required.',
    ownerConfirmed: false,
    signals: [
      { id: 'creative-generation', kind: 'creative', capabilityKey: slug,
        claim: 'The production composition graph emitted a bounded candidate set.',
        evidenceRef: `production:${production.productionDigest}`, lineageId: production.run.lineageId },
      { id: 'sealed-evaluation', kind: 'evaluation', capabilityKey: slug,
        claim: 'Independent specialist and holistic evaluators approved exact sealed evidence.',
        evidenceRef: `review:${review.reviewDigest}`, lineageId: production.run.lineageId },
      { id: 'contract-consolidation', kind: 'consolidation', capabilityKey: slug,
        claim: 'The thesis, graph, budgets, identities, and evaluator seals are fingerprinted.',
        evidenceRef: `graph:${source.graphDigest}`, lineageId: production.run.lineageId },
      { id: 'owner-boundary', kind: 'causal', capabilityKey: slug,
        claim: 'No preference, release, learning, transfer, or promotion decision was made.',
        evidenceRef: `authority:${digest({ requestKey: request.requestKey, action: 'recommend-only' })}`,
        lineageId: production.run.lineageId },
    ],
    specification: {
      routing: ['isolated composition-primitive incubator only'],
      generation: ['reuse the canonical arbitrary-N production composition graph'],
      evaluation: ['retain both sealed specialist and holistic evidence receipts'],
      persistence: ['atomic immutable get-or-create recommendation'],
      documentation: ['bind source, production, review, and run fingerprints'],
      rejectionTests: ['reject evaluator seal or identity drift', 'reject adverse artistic criteria'],
    },
  });
}

function assertCheckpointMatches(
  checkpoint: DreamAssimilationCheckpoint,
  request: DreamAssimilationRequest,
  source: ReturnType<typeof sourceFingerprints>,
  persistenceKey: string,
): void {
  if (checkpoint.requestKey !== persistenceKey
    || checkpoint.requestDigest !== source.requestDigest
    || checkpoint.sourceFingerprint !== source.sourceFingerprint
    || canonical(checkpoint.campaignBinding) !== canonical(source.campaignBinding)) {
    throw new Error('DREAM_ASSIMILATION_FINGERPRINT_MISMATCH');
  }
  if (checkpoint.review
    && (checkpoint.review.specialist.manifestDigest
      !== request.evaluators.specialist.manifest.manifestDigest
      || checkpoint.review.holistic.manifestDigest
      !== request.evaluators.holistic.manifest.manifestDigest
      || canonical(checkpoint.review.specialist.identity) !== canonical(request.identities.specialist)
      || canonical(checkpoint.review.holistic.identity) !== canonical(request.identities.holistic))) {
    throw new Error('DREAM_EVALUATOR_IDENTITY_OR_SEAL_MISMATCH');
  }
  if (checkpoint.specialistReview
    && (checkpoint.specialistReview.manifestDigest
      !== request.evaluators.specialist.manifest.manifestDigest
      || canonical(checkpoint.specialistReview.identity)
      !== canonical(request.identities.specialist))) {
    throw new Error('DREAM_EVALUATOR_IDENTITY_OR_SEAL_MISMATCH');
  }
}

export async function runDreamAndAssimilate(
  coordinator: DreamAssimilationCoordinator,
  request: DreamAssimilationRequest,
): Promise<DreamAssimilationResult> {
  requireText(request.requestKey, 'DREAM_ASSIMILATION_REQUEST_KEY_REQUIRED');
  requireText(request.prompt, 'DREAM_ASSIMILATION_PROMPT_REQUIRED');
  const budget = freezeBudget(request);
  const identities = freezeIdentities(request);
  parseEvaluatorManifest(request.evaluators.specialist?.manifest, 'specialist');
  parseEvaluatorManifest(request.evaluators.holistic?.manifest, 'holistic');
  const source = sourceFingerprints(request, budget);
  const store = request.store ?? new FileDreamAssimilationRunStore();
  const runId = `dream-assimilate-${source.sourceFingerprint.slice(0, 24)}`;
  const persistenceKey = persistenceKeyFor(request.requestKey, source.campaignBinding);

  const execute = async (): Promise<DreamAssimilationResult> => {
    let checkpoint = await store.read(persistenceKey);
    if (checkpoint) {
      checkpoint = parseDreamAssimilationCheckpoint(checkpoint);
      assertCheckpointMatches(checkpoint, request, source, persistenceKey);
      if (checkpoint.phase === 'completed') return parseDreamAssimilationResult(checkpoint.result);
    } else {
      checkpoint = checkpointBody({ schema: DREAM_ASSIMILATION_CHECKPOINT_SCHEMA,
        schemaVersion: DREAM_ASSIMILATION_CHECKPOINT_VERSION, status: 'running', phase: 'started',
        requestKey: persistenceKey, runId, lineageId: runId,
        requestDigest: source.requestDigest, sourceFingerprint: source.sourceFingerprint,
        ...(source.campaignBinding ? { campaignBinding: source.campaignBinding } : {}) });
      await store.write(checkpoint);
    }

    let production = checkpoint.production;
    if (!production) {
      production = await produce(coordinator, { ...request, identities }, budget, source);
      checkpoint = nextCheckpoint(checkpoint, 'produced', { production });
      await store.write(checkpoint);
    }

    const signal = request.signal ?? new AbortController().signal;
    let specialistReview = checkpoint.specialistReview;
    if (!specialistReview) {
      specialistReview = await executeReview('specialist', request.evaluators.specialist,
        identities.specialist, coordinator, production, signal);
      checkpoint = nextCheckpoint(checkpoint, 'specialist-reviewed', {
        production, specialistReview,
      });
      await store.write(checkpoint);
    }

    let review = checkpoint.review;
    if (!review) {
      const holisticReview = await executeReview('holistic', request.evaluators.holistic,
        identities.holistic, coordinator, production, signal);
      review = combineReviews(specialistReview, holisticReview);
      checkpoint = nextCheckpoint(checkpoint, 'reviewed', {
        production, specialistReview, review,
      });
      await store.write(checkpoint);
    }
    if (review.outcome !== 'approve') throw new DreamAssimilationReviewVeto(review);

    const recommendationStore = request.recommendationStore
      ?? new DomainIncubatorStore(path.join(resolveSinterProjectRoot(), '.sinter',
        'dream-assimilate-recommendations'));
    const persisted = (await recommendationStore.getOrCreate(
      recommendationFor(request, source, production, review),
    )).record;
    const authorityBoundary = freeze({ status: 'owner-action-required' as const,
      ownerPreferenceClaimed: false as const, ownerReleaseClaimed: false as const,
      learningAuthorized: false as const, transferOpened: false as const,
      promotionAttempted: false as const });
    const creativeJudgmentAssimilation = source.creativeJudgmentProfile
      ? judgmentAssimilationReceipt(source.creativeJudgmentProfile, source.requestDigest,
        production.productionDigest, review.reviewDigest)
      : undefined;
    const evidenceFingerprint = digest({ sourceFingerprint: source.sourceFingerprint,
      productionDigest: production.productionDigest, reviewDigest: review.reviewDigest,
      authorityBoundary,
      creativeJudgmentAssimilationDigest: creativeJudgmentAssimilation?.receiptDigest,
      recommendationReceiptDigest: persisted.receiptDigest });
    const runFingerprint = digest({ runId, lineageId: runId, evidenceFingerprint,
      executionRootRunId: production.run.rootRunId, executionLineageId: production.run.lineageId });
    const recommendationBody = { schema: DREAM_ASSIMILATION_SCHEMA,
      schemaVersion: DREAM_ASSIMILATION_VERSION, kind: 'composition-primitive' as const,
      status: 'ready-for-owner-review' as const,
      allowedAction: 'request-owner-domain-review' as const, promotion: 'forbidden' as const,
      candidateId: persisted.candidateId, sourceFingerprint: source.sourceFingerprint,
      evidenceFingerprint, runFingerprint, recommendation: persisted,
      ...(source.campaignBinding ? { campaignBinding: source.campaignBinding } : {}) };
    const recommendation = freeze({ ...recommendationBody,
      recommendationDigest: digest(recommendationBody) });
    const result = freeze({ schema: DREAM_ASSIMILATION_SCHEMA,
      schemaVersion: DREAM_ASSIMILATION_VERSION, requestDigest: source.requestDigest,
      runId, lineageId: runId, budget, identities, production, review,
      sourceFingerprint: source.sourceFingerprint, evidenceFingerprint, runFingerprint,
      authorityBoundary, recommendation,
      ...(creativeJudgmentAssimilation ? { creativeJudgmentAssimilation } : {}),
      ...(source.campaignBinding ? { campaignBinding: source.campaignBinding } : {}) });
    parseDreamAssimilationResult(result);
    await store.write(nextCheckpoint(checkpoint, 'completed', {
      production, specialistReview, review, result,
    }));
    return result;
  };
  return store.claim ? store.claim(persistenceKey, execute) : execute();
}
