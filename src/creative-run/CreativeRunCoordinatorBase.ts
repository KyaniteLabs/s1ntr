import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, writeFileAtomicSync } from '../utils/atomicWrite.js';
import { resolveSinterProjectRoot } from '../fs/projectRoot.js';
import {
  CompositionOrchestrator,
  type CompositionGenerationContext,
  type CompositionResult,
} from '../composition/CompositionOrchestrator.js';
import {
  CompositionGraphRollbackController,
  type CompositionRequest,
} from '../composition/CompositionGraph.js';
import { withHarnessTransportAuthority, type LLMClient } from '../llm/LLMClient.js';
import { resolveRuntimeExecutorAuthority } from '../identity/executorAuthorityBootstrap.js';
import type { HarnessTransportAuthority } from '../identity/harnessTransportGuard.js';
import { compileMusicCreativeThesis } from '../music/generateMusic.js';
import {
  compileCreativeThesis,
  validateCreativeThesis,
  type CreativeThesis,
} from '../creative-intelligence/CreativeIntelligence.js';
import type {
  BuildInteractiveArtifactOptions,
  InteractiveArtifactTrace,
} from '../creative-intelligence/InteractiveArtifact.js';
import type { TemporalArtifact, TemporalArtifactOptions } from '../creative-intelligence/temporal/TemporalArtifact.js';
import {
  TemporalArtifactGenerator,
  type TemporalArtifactGenerationSeam,
} from '../generators/temporal/TemporalArtifactGenerator.js';
import {
  buildCampaignActualCandidateManifest,
  buildCandidateManifest,
  type BuildCandidateManifestOptions,
  type CampaignActualCandidateManifest,
  type CandidateManifest,
} from './CandidateHypothesisProduction.js';
import {
  buildCrossModalArtifact,
  type CrossModalArtifact,
  type CrossModalArtifactOptions,
} from '../creative-intelligence/CrossModalArtifact.js';
import {
  createBlindReviewSession,
  type BlindReviewCandidateManifest,
  type BlindReviewJudgment,
  type BlindReviewSession,
  type CandidateEvidenceAssignment,
} from './BlindReviewEvidence.js';
import {
  createOwnerReviewPacket as buildOwnerReviewPacket,
  publishOwnerReviewPacket as persistOwnerReviewPacket,
  renderOwnerReviewPacket as displayOwnerReviewPacket,
  sealOwnerQualityReview as finalizeOwnerQualityReview,
  type CaptureAuthority,
  type CreativeQualityReviewInput,
  type EnvelopeAuthority,
  type OwnerCaptureInputs,
  type OwnerPacketEnvelope,
  type OwnerQualityReviewBundle,
  type OwnerReviewPacket,
  type OwnerReviewPacketRenderer,
  type OwnerReviewPacketStore,
  type SealedOwnerCampaignRef,
  type ReviewerAttestationVerifier,
} from './OwnerQualityReview.js';
import {
  createAttributableRevisionSession,
  createIndependentBlindTreatmentPreference,
  type BlindTreatmentPreferenceOutcome,
  type CanonicalCreativeArtifactEnvelope,
  type CausalIdentity,
  type ExperimentPlan,
  type IndependentBlindTreatmentPreference,
  type AttributableRevisionSession,
  type CompileExperimentPlanOptions,
} from './AttributableRevision.js';
import type { OwnerAuthorityBootstrapConfig } from './OwnerLearningAuthority.js';
import {
  type CampaignEvidenceReceipt,
  type CampaignManifestBinding,
  type CampaignOriginAuthority,
  type CampaignOriginCapability,
} from '../runtime-core/CampaignOrigin.js';
import {
  FileGenerationAttemptPersistence,
  GenerationAttemptLedger,
} from '../runtime-core/generationAttemptSink.js';
import {
  assertHostCampaignFundingAdmission,
  assertHostCampaignSuccessfulStageGroups,
  type CampaignFundingReservationV1,
  type CampaignSuccessfulStageGroup,
  type HostCampaignFundingAdmission,
  type OwnerReviewAdmission,
} from './CampaignExecutionAuthority.js';
import {
  CampaignCandidateLedger,
  createCampaignManifest,
  preflightCampaignBudget,
  type CampaignBudgetFeasibility,
  type CampaignCapacity,
  type CampaignCandidateDiversityFreeze,
  type CampaignExecutionStage,
  type CampaignExecutionPlan,
  type CampaignManifest,
  type CampaignManifestInput,
  type CampaignSlotGraph,
  type CampaignSlotGraphProof,
} from './CampaignManifest.js';

export type CreativeRunEntryPoint = 'studio-session' | 'studio-layers' | 'cli-compose';
const GOVERNED_CAMPAIGN = Symbol('governed-campaign');
type CampaignCanonicalBinding = Omit<CampaignManifestBinding, 'campaignRunId' | 'rootRunId' | 'manifestDigest'>;
export type CampaignRequestBinding = Pick<CampaignManifestBinding,
  'campaignRunId' | 'manifestDigest' | 'campaignFundingReservationDigest'
  | 'campaignPlanDigest' | 'campaignRouteFreezeDigest'>;

export interface CreativeRunRequest {
  entryPoint: CreativeRunEntryPoint;
  requestKey?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  creativeThesis?: CreativeThesis;
  /** Module-owned governed-campaign binding. Never persisted or accepted from artifact data. */
  [GOVERNED_CAMPAIGN]?: CampaignRequestBinding;
}

export interface ProviderReservation {
  id: string;
  status: 'reserved';
  source?: 'injected-provider' | 'synthetic-no-spend';
}

export interface CreativeRunReadiness {
  wave: 8;
  ready: boolean;
  source: 'injected-provider' | 'synthetic-no-spend';
  reason: string;
}

export interface CreativeRunRecord {
  schemaVersion: 1 | 2;
  rootRunId: string;
  lineageId: string;
  requestKey: string;
  entryPoint: CreativeRunEntryPoint;
  releaseRoot: string;
  status: 'reserved' | 'completed' | 'failed';
  provider?: string;
  model?: string;
  providerReservation: ProviderReservation;
  readiness: CreativeRunReadiness;
  createdAt: string;
  updatedAt: string;
  interactionRevisionsApplied?: number;
  creativeThesis?: CreativeThesis;
  /**
   * Atomically persisted with the run when started through the sealed-plan
   * campaign seam. Binds the run to its manifest, plan, host-signed funding
   * reservation, route freeze, and feasibility digests.
   */
  campaignOrigin?: CampaignOriginRecord;
}

/** Frozen campaign provenance persisted atomically with a creative run. */
export interface CampaignOriginRecord {
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly campaignFundingReservationDigest: string;
  readonly feasibilityDigest: string;
  readonly routeFreezeDigest: string;
}

export interface CreativeRunHandle {
  rootRunId: string;
  lineageId: string;
  requestKey: string;
  providerReservation: ProviderReservation;
  readiness: CreativeRunReadiness;
  record: CreativeRunRecord;
  creativeThesis?: CreativeThesis;
}

/** Frozen preflight evidence paired with the only reservation it authorizes. */
export interface CampaignRunAdmission {
  readonly creativeRun: CreativeRunHandle;
  readonly manifestDigest: string;
  readonly planDigest?: string;
  readonly plan: CampaignExecutionPlan;
  readonly feasibility: CampaignBudgetFeasibility;
  readonly fundingReservation: CampaignFundingReservationV1;
}

export type CampaignProviderStageRunner = NonNullable<CompositionGenerationContext['runProviderStage']>;

export interface CoordinatedCompositionResult extends CompositionResult {
  creativeRun: CreativeRunHandle;
  candidateManifest: CandidateManifest;
  temporalArtifact?: TemporalArtifact;
}

export interface VerifiedCampaignSlotExecution {
  readonly binding: CampaignSlotGraph;
  readonly proof: CampaignSlotGraphProof;
  readonly diversity: CampaignCandidateDiversityFreeze;
}

export interface CoordinatedCampaignSlotResult {
  readonly briefId: string;
  readonly candidateSlotId: string;
  readonly graphDigest: string;
  readonly composition: CoordinatedCompositionResult;
}

export interface CampaignOwnerReviewEvidence {
  readonly briefId: string;
  readonly packetDigest: string;
  readonly reviewBundleDigest: string;
}

export interface CampaignEvidenceCheckpoint extends CampaignRequestBinding {
  readonly schema: 'sinter.campaign-evidence-checkpoint';
  readonly schemaVersion: 1;
  readonly originPending: true;
  readonly rootRunId: string;
  readonly receipts: readonly CampaignEvidenceReceipt[];
  readonly checkpointDigest: string;
}

export interface CoordinatedCampaignResult {
  readonly schema: 'sinter.coordinated-campaign-result';
  readonly schemaVersion: 1;
  readonly creativeRun: CreativeRunHandle;
  readonly executions: readonly CoordinatedCampaignSlotResult[];
  readonly candidateManifests: readonly CampaignActualCandidateManifest[];
  readonly campaignEvidenceCheckpoint: CampaignEvidenceCheckpoint;
}

export interface CoordinatedInteractiveArtifactResult {
  readonly html: string;
  readonly trace: InteractiveArtifactTrace;
  readonly creativeRun: CreativeRunHandle;
}

export interface CoordinatedCrossModalArtifactResult {
  readonly html: string;
  readonly crossModalArtifact: CrossModalArtifact;
  readonly creativeRun: CreativeRunHandle;
}

export interface CreativeRunPersistence {
  read(requestKey: string): Promise<CreativeRunRecord | null>;
  write(record: CreativeRunRecord): Promise<void>;
  claim?<T>(requestKey: string, operation: () => Promise<T>): Promise<T>;
  readSync?(requestKey: string): CreativeRunRecord | null;
  writeSync?(record: CreativeRunRecord): void;
  claimSync?<T>(requestKey: string, operation: () => T): T;
}

const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 25;
const VALID_ENTRY_POINTS: ReadonlySet<CreativeRunEntryPoint> = new Set([
  'studio-session',
  'studio-layers',
  'cli-compose',
]);
const VALID_RECORD_STATUSES: ReadonlySet<CreativeRunRecord['status']> = new Set([
  'reserved',
  'completed',
  'failed',
]);
const VALID_RESERVATION_STATUSES: ReadonlySet<ProviderReservation['status']> = new Set([
  'reserved',
]);
const VALID_READINESS_SOURCES: ReadonlySet<CreativeRunReadiness['source']> = new Set([
  'injected-provider',
  'synthetic-no-spend',
]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestCheckpoint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
const VALID_RESERVATION_SOURCES: ReadonlySet<NonNullable<ProviderReservation['source']>> = new Set([
  'injected-provider',
  'synthetic-no-spend',
]);
const VALID_SCHEMA_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2]);
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Persisted creative-run record has invalid ${field}: expected non-empty string`);
  }
  if (value.length === 0) {
    throw new Error(`Persisted creative-run record has invalid ${field}: expected non-empty string`);
  }
  return value;
}

function ensureOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Persisted creative-run record has invalid ${field}: expected string or undefined`);
  }
  return value;
}

function ensureInteractionRevisionsApplied(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1) {
    throw new Error('Persisted creative-run record has invalid interactionRevisionsApplied: expected 0 | 1');
  }
  return value as number;
}

function ensureEnum<T extends string | number>(
  value: unknown,
  allowed: ReadonlySet<T>,
  field: string,
  label: string,
): T {
  const valueType = typeof value;
  if (valueType !== 'string' && valueType !== 'number') {
    throw new Error(
      `Persisted creative-run record has invalid ${field}: expected one of ${label}`,
    );
  }
  if (!allowed.has(value as T)) {
    throw new Error(
      `Persisted creative-run record has invalid ${field}: expected one of ${label}`,
    );
  }
  return value as T;
}

function ensureProviderReservation(value: unknown): ProviderReservation {
  if (!isPlainObject(value)) {
    throw new Error('Persisted creative-run record has invalid providerReservation: expected object');
  }
  const id = ensureString(value.id, 'providerReservation.id');
  const status = ensureEnum(
    value.status,
    VALID_RESERVATION_STATUSES,
    'providerReservation.status',
    "'reserved'",
  );
  const sourceValue = value.source;
  let source: ProviderReservation['source'];
  if (sourceValue === undefined) {
    source = undefined;
  } else {
    source = ensureEnum(
      sourceValue,
      VALID_RESERVATION_SOURCES,
      'providerReservation.source',
      "'injected-provider' | 'synthetic-no-spend'",
    );
  }
  return source === undefined ? { id, status } : { id, status, source };
}

function ensureReadiness(value: unknown): CreativeRunReadiness {
  if (!isPlainObject(value)) {
    throw new Error('Persisted creative-run record has invalid readiness: expected object');
  }
  const wave = value.wave;
  if (wave !== 8) {
    throw new Error("Persisted creative-run record has invalid readiness.wave: expected 8");
  }
  const ready = value.ready;
  if (typeof ready !== 'boolean') {
    throw new Error('Persisted creative-run record has invalid readiness.ready: expected boolean');
  }
  if (value.source === 'CreativeRunCoordinator' && value.reason === undefined) {
    return { ...SYNTHETIC_READINESS };
  }
  const source = ensureEnum(
    value.source,
    VALID_READINESS_SOURCES,
    'readiness.source',
    "'injected-provider' | 'synthetic-no-spend'",
  );
  const reason = ensureString(value.reason, 'readiness.reason');
  return { wave: 8, ready, source, reason };
}

export function validateCreativeRunRecord(value: unknown): CreativeRunRecord {
  if (!isPlainObject(value)) {
    throw new Error(
      `Persisted creative-run record is corrupted: expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
    );
  }
  const schemaVersion = ensureEnum(
    value.schemaVersion,
    VALID_SCHEMA_VERSIONS,
    'schemaVersion',
    '1 | 2',
  );
  const rootRunId = ensureString(value.rootRunId, 'rootRunId');
  const lineageId = ensureString(value.lineageId, 'lineageId');
  const requestKey = ensureString(value.requestKey, 'requestKey');
  const entryPoint = ensureEnum(
    value.entryPoint,
    VALID_ENTRY_POINTS,
    'entryPoint',
    "'studio-session' | 'studio-layers' | 'cli-compose'",
  );
  const releaseRoot = ensureString(value.releaseRoot, 'releaseRoot');
  const status = ensureEnum(
    value.status,
    VALID_RECORD_STATUSES,
    'status',
    "'reserved' | 'completed' | 'failed'",
  );
  const provider = ensureOptionalString(value.provider, 'provider');
  const model = ensureOptionalString(value.model, 'model');
  const providerReservation = ensureProviderReservation(value.providerReservation);
  const readiness = ensureReadiness(value.readiness);
  const createdAt = ensureString(value.createdAt, 'createdAt');
  const updatedAt = ensureString(value.updatedAt, 'updatedAt');
  const interactionRevisionsApplied = ensureInteractionRevisionsApplied(
    value.interactionRevisionsApplied,
  );
  const creativeThesis = value.creativeThesis === undefined
    ? undefined
    : validateCreativeThesis(value.creativeThesis);
  const campaignOrigin = validateCampaignOrigin(value.campaignOrigin);
  return {
    schemaVersion: schemaVersion as 1 | 2,
    rootRunId,
    lineageId,
    requestKey,
    entryPoint,
    releaseRoot,
    status,
    provider,
    model,
    providerReservation,
    readiness,
    createdAt,
    updatedAt,
    interactionRevisionsApplied,
    ...(creativeThesis ? { creativeThesis } : {}),
    ...(campaignOrigin ? { campaignOrigin } : {}),
  };
}

function validateCampaignOrigin(value: unknown): CampaignOriginRecord | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error('Persisted creative-run record has invalid campaignOrigin: expected object');
  }
  const manifestDigest = ensureString(value.manifestDigest, 'campaignOrigin.manifestDigest');
  const planDigest = ensureString(value.planDigest, 'campaignOrigin.planDigest');
  const campaignFundingReservationDigest = ensureString(
    value.campaignFundingReservationDigest, 'campaignOrigin.campaignFundingReservationDigest',
  );
  const feasibilityDigest = ensureString(value.feasibilityDigest, 'campaignOrigin.feasibilityDigest');
  const routeFreezeDigest = ensureString(value.routeFreezeDigest, 'campaignOrigin.routeFreezeDigest');
  return { manifestDigest, planDigest, campaignFundingReservationDigest, feasibilityDigest, routeFreezeDigest };
}
const SYNTHETIC_READINESS: CreativeRunReadiness = {
  wave: 8,
  ready: false,
  source: 'synthetic-no-spend',
  reason: 'No provider reservation was injected; this is a deterministic no-spend reservation.',
};

function thesisFor(request: CreativeRunRequest): CreativeThesis {
  const thesis = request.creativeThesis ?? compileCreativeThesis(request.prompt ?? 'A creative work with a clear focal relationship.');
  validateCreativeThesis(thesis);
  if (thesis.disposition !== 'supported') throw new Error('Creative Thesis is unsupported; provider reservation was not attempted');
  return thesis;
}

function executionThesis(handle: CreativeRunHandle): CreativeThesis {
  if (handle.record.schemaVersion !== 2 || !handle.creativeThesis) {
    throw new Error('Legacy creative run is read-only and has no validated Creative Thesis');
  }
  return validateCreativeThesis(handle.creativeThesis);
}
const INJECTED_READINESS: CreativeRunReadiness = {
  wave: 8,
  ready: true,
  source: 'injected-provider',
  reason: 'Provider reservation was injected by the caller.',
};

function readinessFor(record: CreativeRunRecord): CreativeRunReadiness {
  return record.schemaVersion === 2
    && record.providerReservation.source === 'injected-provider'
    && record.readiness.source === 'injected-provider'
    && record.readiness.ready === true
    && record.creativeThesis?.disposition === 'supported'
    ? { ...INJECTED_READINESS }
    : { ...SYNTHETIC_READINESS };
}

export class MemoryCreativeRunPersistence implements CreativeRunPersistence {
  private readonly records = new Map<string, CreativeRunRecord>();
  private readonly claims = new Map<string, Promise<void>>();

  read(requestKey: string): Promise<CreativeRunRecord | null> {
    return Promise.resolve(this.records.get(requestKey) ?? null);
  }

  write(record: CreativeRunRecord): Promise<void> {
    this.records.set(record.requestKey, { ...record });
    return Promise.resolve();
  }

  async claim<T>(requestKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.claims.get(requestKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.claims.set(requestKey, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.claims.get(requestKey) === current) this.claims.delete(requestKey);
    }
  }

  readSync(requestKey: string): CreativeRunRecord | null {
    return this.records.get(requestKey) ?? null;
  }

  writeSync(record: CreativeRunRecord): void {
    this.records.set(record.requestKey, { ...record });
  }
}

export class FileCreativeRunPersistence implements CreativeRunPersistence {
  constructor(readonly releaseRoot: string) {}

  private filePath(requestKey: string): string {
    const digest = createHash('sha256').update(requestKey).digest('hex');
    return path.join(this.releaseRoot, `${digest}.json`);
  }

  private lockPath(requestKey: string): string {
    return `${this.filePath(requestKey)}.lock`;
  }

  private async acquireLock(requestKey: string): Promise<() => Promise<void>> {
    await mkdir(this.releaseRoot, { recursive: true });
    const lockPath = this.lockPath(requestKey);
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const lock = await stat(lockPath);
          if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { recursive: true, force: true });
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    const heartbeat = setInterval(() => {
      void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
    }, Math.floor(LOCK_STALE_MS / 3));
    return async () => {
      clearInterval(heartbeat);
      await rm(lockPath, { recursive: true, force: true });
    };
  }

  async claim<T>(requestKey: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(requestKey);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async read(requestKey: string): Promise<CreativeRunRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(requestKey), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const record = validateCreativeRunRecord(JSON.parse(raw));
    if (record.requestKey !== requestKey) {
      throw new Error('Persisted creative-run record requestKey does not match its storage key');
    }
    return record;
  }

  async write(record: CreativeRunRecord): Promise<void> {
    await mkdir(this.releaseRoot, { recursive: true });
    await writeFileAtomic(this.filePath(record.requestKey), `${JSON.stringify(record, null, 2)}\n`);
  }

  readSync(requestKey: string): CreativeRunRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath(requestKey), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const record = validateCreativeRunRecord(JSON.parse(raw));
    if (record.requestKey !== requestKey) {
      throw new Error('Persisted creative-run record requestKey does not match its storage key');
    }
    return record;
  }

  writeSync(record: CreativeRunRecord): void {
    mkdirSync(this.releaseRoot, { recursive: true });
    writeFileAtomicSync(this.filePath(record.requestKey), `${JSON.stringify(record, null, 2)}\n`);
  }

  claimSync<T>(requestKey: string, operation: () => T): T {
    mkdirSync(this.releaseRoot, { recursive: true });
    const lockPath = this.lockPath(requestKey);
    for (;;) {
      try {
        mkdirSync(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, LOCK_POLL_MS);
      }
    }
    try {
      return operation();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

export type ProviderReservationFn = (request: CreativeRunRequest) => Promise<ProviderReservation>;
export type SyncProviderReservationFn = (request: CreativeRunRequest) => ProviderReservation;

export interface CreativeRunCoordinatorOptions {
  releaseRoot?: string;
  persistence?: CreativeRunPersistence;
  reserveProvider?: ProviderReservationFn;
  reserveProviderSync?: SyncProviderReservationFn;
  idFactory?: () => string;
  now?: () => string;
  graphPolicy?: CompositionGraphRollbackController;
  temporalGenerator?: TemporalArtifactGenerationSeam;
  ownerAuthority?: OwnerAuthorityBootstrapConfig;
  campaignAuthority?: CampaignOriginAuthority;
  campaignPreflight?: () => Promise<CampaignCanonicalBinding>;
  executorAuthority?: HarnessTransportAuthority;
  generationAttemptLedger?: GenerationAttemptLedger;
}

export class CreativeRunCoordinatorBase {
  private readonly persistence: CreativeRunPersistence;
  private readonly releaseRoot: string;
  private readonly reserveProvider: ProviderReservationFn;
  private readonly reserveProviderSync: SyncProviderReservationFn;
  private readonly asyncReservationIsInjected: boolean;
  private readonly syncReservationIsInjected: boolean;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly graphPolicy: CompositionGraphRollbackController;
  private readonly temporalGenerator: TemporalArtifactGenerationSeam;
  private readonly generationAttemptLedger: GenerationAttemptLedger;
  private readonly pending = new Map<string, Promise<CreativeRunHandle>>();
  private readonly campaignAuthority?: CampaignOriginAuthority;
  private readonly campaignPreflight?: () => Promise<CampaignCanonicalBinding>;
  private readonly executorAuthority?: HarnessTransportAuthority;
  private readonly campaignCapabilities = new Map<string, CampaignOriginCapability>();
  private readonly campaignAdmissions = new WeakSet<object>();
  private readonly campaignFundingAdmissions = new WeakMap<object, HostCampaignFundingAdmission>();
  private readonly settledCampaignCandidates = new WeakMap<object, CampaignRunAdmission>();

  constructor(options: CreativeRunCoordinatorOptions = {}) {
    this.releaseRoot = options.releaseRoot
      ?? path.join(resolveSinterProjectRoot(), '.sinter', 'creative-runs');
    this.persistence = options.persistence
      ?? new FileCreativeRunPersistence(this.releaseRoot);
    this.asyncReservationIsInjected = options.reserveProvider !== undefined;
    this.syncReservationIsInjected = options.reserveProviderSync !== undefined;
    this.reserveProvider = options.reserveProvider ?? ((request) => Promise.resolve({
      id: `reservation-${request.requestKey ?? randomUUID()}`,
      status: 'reserved' as const,
    }));
    this.reserveProviderSync = options.reserveProviderSync ?? ((request) => ({
      id: `reservation-${request.requestKey ?? randomUUID()}`,
      status: 'reserved',
    }));
    this.idFactory = options.idFactory ?? (() => `creative-${randomUUID()}`);
    this.now = options.now ?? (() => new Date().toISOString());
    this.graphPolicy = options.graphPolicy ?? new CompositionGraphRollbackController();
    this.temporalGenerator = options.temporalGenerator ?? new TemporalArtifactGenerator();
    this.campaignAuthority = options.campaignAuthority;
    this.campaignPreflight = options.campaignPreflight;
    this.executorAuthority = resolveRuntimeExecutorAuthority(options.executorAuthority);
    this.generationAttemptLedger = options.generationAttemptLedger
      ?? new GenerationAttemptLedger(new FileGenerationAttemptPersistence(
        path.join(this.releaseRoot, 'generation-attempts'),
      ));
  }

  /** Hook for verified, coordinator-owned learning applied to ordinary Create prompts. */
  protected prepareOrdinaryCreatePrompt(prompt: string): string {
    return prompt;
  }

  /** Freeze the finite campaign before any campaign provider reservation. */
  createCampaignManifest(input: CampaignManifestInput): CampaignManifest {
    return createCampaignManifest(input);
  }

  createCampaignCandidateLedger(manifest: CampaignManifest): CampaignCandidateLedger {
    return new CampaignCandidateLedger(manifest);
  }

  /** Legacy caller-declared feasibility is permanently fail-closed. */
  startCampaign(
    _request: CreativeRunRequest,
    manifest: CampaignManifest,
    stages: readonly CampaignExecutionStage[],
    capacity: CampaignCapacity,
  ): Promise<CampaignRunAdmission> {
    const feasibility = preflightCampaignBudget(manifest, stages, capacity);
    if (!feasibility.passed) {
      return Promise.reject(new Error(
        `Campaign provider reservation was not attempted: ${feasibility.failures.join(', ')}`,
      ));
    }
    return Promise.reject(new Error(
      'Campaign provider reservation was not attempted: caller-declared campaign admission is disabled',
    ));
  }

  /**
   * Sealed-plan campaign seam: feasibility is bound to a sealed canonical
   * execution plan and a host-signed W8C-05 funding reservation. The manifest,
   * plan, route, funding, and feasibility digests persist with the run.
   */
  async startCampaignPlan(
    request: CreativeRunRequest,
    manifest: CampaignManifest,
    plan: CampaignExecutionPlan,
    feasibility: CampaignBudgetFeasibility,
    hostAdmission: HostCampaignFundingAdmission,
  ): Promise<CampaignRunAdmission> {
    const fundingReservation = assertHostCampaignFundingAdmission(hostAdmission);
    if (!feasibility.passed) {
      throw new Error(`Campaign provider reservation was not attempted: ${feasibility.failures.join(', ')}`);
    }
    const campaignOrigin: CampaignOriginRecord = {
      manifestDigest: manifest.manifestDigest,
      planDigest: plan.planDigest,
      campaignFundingReservationDigest: fundingReservation.reservationDigest,
      feasibilityDigest: feasibility.feasibilityDigest,
      routeFreezeDigest: plan.routeFreezeDigest,
    };
    if (fundingReservation.subject.manifestDigest !== manifest.manifestDigest
      || fundingReservation.subject.planDigest !== plan.planDigest
      || fundingReservation.subject.routeFreezeDigest !== plan.routeFreezeDigest) {
      throw new Error('Campaign funding reservation does not match the sealed campaign origin');
    }
    const requestKey = request.requestKey?.trim();
    if (!requestKey || requestKey !== fundingReservation.subject.campaignRunId) {
      throw new Error('Campaign funding reservation does not match the campaign request key');
    }
    const existing = await this.persistence.read(requestKey);
    let creativeRun: CreativeRunHandle;
    if (existing && existing.campaignOrigin
      && existing.campaignOrigin.manifestDigest === campaignOrigin.manifestDigest
      && existing.campaignOrigin.planDigest === campaignOrigin.planDigest
      && existing.campaignOrigin.routeFreezeDigest === campaignOrigin.routeFreezeDigest
      && existing.status === 'reserved') {
      const renewed = { ...existing, campaignOrigin, updatedAt: this.now() } satisfies CreativeRunRecord;
      await this.persistence.write(renewed);
      creativeRun = this.toHandle(renewed);
    } else {
      creativeRun = await this.start(request, campaignOrigin);
    }
    const admission: CampaignRunAdmission = Object.freeze({
      creativeRun,
      manifestDigest: manifest.manifestDigest,
      planDigest: plan.planDigest,
      plan,
      feasibility,
      fundingReservation,
    });
    this.campaignAdmissions.add(admission);
    this.campaignFundingAdmissions.set(admission, hostAdmission);
    return admission;
  }

  async start(request: CreativeRunRequest, campaignOrigin?: CampaignOriginRecord): Promise<CreativeRunHandle> {
    const requestKey = request.requestKey?.trim() || `${request.entryPoint}:${randomUUID()}`;
    const existingPending = this.pending.get(requestKey);
    if (existingPending) {
      const existing = await existingPending;
      this.assertCampaignOrigin(existing.record, campaignOrigin);
      return existing;
    }
    const pending = this.startOnce({ ...request, requestKey }, campaignOrigin);
    this.pending.set(requestKey, pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(requestKey);
    }
  }

  startSync(request: CreativeRunRequest, campaignOrigin?: CampaignOriginRecord): CreativeRunHandle {
    if (!this.persistence.readSync || !this.persistence.writeSync) {
      throw new Error('Synchronous creative-run persistence is unavailable');
    }
    const requestKey = request.requestKey?.trim() || `${request.entryPoint}:${randomUUID()}`;
    const start = () => this.startSyncOnce({ ...request, requestKey }, campaignOrigin);
    return this.persistence.claimSync
      ? this.persistence.claimSync(requestKey, start)
      : start();
  }

  private startSyncOnce(
    request: CreativeRunRequest & { requestKey: string },
    campaignOrigin?: CampaignOriginRecord,
  ): CreativeRunHandle {
    const readSync = this.persistence.readSync;
    const writeSync = this.persistence.writeSync;
    if (!readSync || !writeSync) throw new Error('Synchronous creative-run persistence is unavailable');
    const creativeThesis = thesisFor(request);
    if (request[GOVERNED_CAMPAIGN]) {
      throw new Error('Governed campaign requires asynchronous host admission before provider reservation');
    }
    const existing = readSync.call(this.persistence, request.requestKey);
    if (existing) {
      this.assertCampaignOrigin(existing, campaignOrigin);
      return this.toHandle(existing);
    }
    const now = this.now();
    const rootRunId = this.idFactory();
    const record: CreativeRunRecord = {
      schemaVersion: 2,
      rootRunId,
      lineageId: rootRunId,
      requestKey: request.requestKey,
      entryPoint: request.entryPoint,
      releaseRoot: this.releaseRoot,
      status: 'reserved',
      provider: request.provider,
      model: request.model,
      providerReservation: {
        ...this.reserveProviderSync({ ...request, creativeThesis }),
        source: this.syncReservationIsInjected ? 'injected-provider' : 'synthetic-no-spend',
      },
      readiness: this.syncReservationIsInjected ? { ...INJECTED_READINESS } : { ...SYNTHETIC_READINESS },
      createdAt: now,
      updatedAt: now,
      interactionRevisionsApplied: 0,
      creativeThesis,
      ...(campaignOrigin ? { campaignOrigin } : {}),
    };
    writeSync.call(this.persistence, record);
    return this.toHandle(record);
  }

  private async startOnce(
    request: CreativeRunRequest & { requestKey: string },
    campaignOrigin?: CampaignOriginRecord,
  ): Promise<CreativeRunHandle> {
    const start = async (): Promise<CreativeRunHandle> => {
      const creativeThesis = thesisFor(request);
      const existing = await this.persistence.read(request.requestKey);
      if (existing) {
        this.assertCampaignOrigin(existing, campaignOrigin);
        const campaign = request[GOVERNED_CAMPAIGN];
        if (campaign && !this.campaignCapabilities.has(existing.rootRunId)) {
          const origin = existing.campaignOrigin;
          if (!origin || origin.manifestDigest !== campaign.manifestDigest
            || origin.planDigest !== campaign.campaignPlanDigest
            || origin.campaignFundingReservationDigest !== campaign.campaignFundingReservationDigest
            || origin.routeFreezeDigest !== campaign.campaignRouteFreezeDigest) {
            throw new Error('Governed campaign admission does not match persisted funding origin');
          }
          if (!this.campaignAuthority || !this.campaignPreflight) {
            throw new Error('Governed campaign blocked: host authority and preflight are required');
          }
          const canonical = await this.campaignPreflight();
          const capability = await this.ensureCampaignCapability({
            ...campaign, ...canonical, rootRunId: existing.rootRunId,
          });
          this.campaignCapabilities.set(existing.rootRunId, capability);
        }
        return this.toHandle(existing);
      }
      const now = this.now();
      const rootRunId = this.idFactory();
      const campaign = request[GOVERNED_CAMPAIGN];
      if (campaign) {
        if (!this.campaignAuthority || !this.campaignPreflight) {
          throw new Error('Governed campaign blocked: host authority and preflight are required');
        }
        const canonical = await this.campaignPreflight();
        const capability = await this.campaignAuthority.admit({ ...campaign, ...canonical, rootRunId });
        this.campaignCapabilities.set(rootRunId, capability);
      }
      const reservation = await this.reserveProvider({ ...request, creativeThesis });
      const record: CreativeRunRecord = {
        schemaVersion: 2,
        rootRunId,
        lineageId: rootRunId,
        requestKey: request.requestKey,
        entryPoint: request.entryPoint,
        releaseRoot: this.releaseRoot,
        status: 'reserved',
        provider: request.provider,
        model: request.model,
        providerReservation: {
          ...reservation,
          source: this.asyncReservationIsInjected ? 'injected-provider' : 'synthetic-no-spend',
        },
        readiness: this.asyncReservationIsInjected ? { ...INJECTED_READINESS } : { ...SYNTHETIC_READINESS },
        createdAt: now,
        updatedAt: now,
        interactionRevisionsApplied: 0,
        creativeThesis,
        ...(campaignOrigin ? { campaignOrigin } : {}),
      };
      await this.persistence.write(record);
      return this.toHandle(record);
    };
    return this.persistence.claim
      ? this.persistence.claim(request.requestKey, start)
      : start();
  }

  private toHandle(record: CreativeRunRecord): CreativeRunHandle {
    const readiness = readinessFor(record);
    const truthfulRecord = {
      ...record,
      interactionRevisionsApplied: record.interactionRevisionsApplied ?? 0,
      providerReservation: { ...record.providerReservation, source: readiness.source },
      readiness,
    } satisfies CreativeRunRecord;
    return {
      rootRunId: truthfulRecord.rootRunId,
      lineageId: truthfulRecord.lineageId,
      requestKey: truthfulRecord.requestKey,
      providerReservation: truthfulRecord.providerReservation,
      readiness: truthfulRecord.readiness,
      record: truthfulRecord,
      creativeThesis: truthfulRecord.creativeThesis,
    };
  }

  private assertCampaignOrigin(record: CreativeRunRecord, expected?: CampaignOriginRecord): void {
    if (!expected) return;
    const actual = record.campaignOrigin;
    if (!actual || actual.manifestDigest !== expected.manifestDigest
      || actual.planDigest !== expected.planDigest
      || actual.campaignFundingReservationDigest !== expected.campaignFundingReservationDigest
      || actual.feasibilityDigest !== expected.feasibilityDigest
      || actual.routeFreezeDigest !== expected.routeFreezeDigest) {
      throw new Error(`Campaign request key ${record.requestKey} is already bound to a different campaign origin`);
    }
  }

  async finish(
    handle: CreativeRunHandle,
    status: 'completed' | 'failed',
  ): Promise<CreativeRunHandle> {
    const current = await this.persistence.read(handle.requestKey);
    // Outcomes only move forward: reserved -> failed -> completed. start()
    // hands back an existing record for a reused requestKey, so a retry of a
    // failed run may complete it, but a later failure must not erase a
    // completed outcome. Callers finish('failed') inside catch blocks, so this
    // returns the stored handle instead of throwing over their original error.
    const stored = current ?? handle.record;
    if (stored.status === status || stored.status === 'completed') return this.toHandle(stored);
    const record = {
      ...this.toHandle(current ?? handle.record).record,
      status,
      updatedAt: this.now(),
    } satisfies CreativeRunRecord;
    await this.persistence.write(record);
    return this.toHandle(record);
  }

  async read(requestKey: string): Promise<CreativeRunHandle | null> {
    const record = await this.persistence.read(requestKey);
    return record ? this.toHandle(record) : null;
  }

  /**
   * Open a no-spend creative run for a time-based artifact path. The temporal
   * artifact builder uses this to guarantee the run never touches an injected
   * provider reservation: the thesis is still compiled and validated (so an
   * unsupported brief fails closed), but the reservation is the deterministic
   * synthetic-no-spend path, regardless of whether the coordinator was
   * constructed with a `reserveProvider`.
   */
  async startNoSpend(request: CreativeRunRequest): Promise<CreativeRunHandle> {
    const requestKey = request.requestKey?.trim() || `${request.entryPoint}:temporal-${randomUUID()}`;
    const start = async (): Promise<CreativeRunHandle> => {
      const creativeThesis = thesisFor(request);
      const existing = await this.persistence.read(requestKey);
      if (existing) return this.toHandle(existing);
      const now = this.now();
      const rootRunId = this.idFactory();
      const record: CreativeRunRecord = {
        schemaVersion: 2,
        rootRunId,
        lineageId: rootRunId,
        requestKey,
        entryPoint: request.entryPoint,
        releaseRoot: this.releaseRoot,
        status: 'reserved',
        provider: request.provider,
        model: request.model,
        providerReservation: {
          id: `temporal-no-spend-${rootRunId}`,
          status: 'reserved',
          source: 'synthetic-no-spend',
        },
        readiness: { ...SYNTHETIC_READINESS },
        createdAt: now,
        updatedAt: now,
        creativeThesis,
      };
      await this.persistence.write(record);
      return this.toHandle(record);
    };
    return this.persistence.claim
      ? this.persistence.claim(requestKey, start)
      : start();
  }

  /** Build provider-free candidate hypotheses from the same intent used by Create. */
  async planCandidates(
    userIntent: string,
    options: Omit<BuildCandidateManifestOptions, 'creativeThesis'> & { creativeThesis?: CreativeThesis } = {},
  ): Promise<CandidateManifest> {
    return buildCandidateManifest(userIntent, options);
  }

  createBlindReviewSession(
    manifest: BlindReviewCandidateManifest,
    assignments: readonly CandidateEvidenceAssignment[],
  ): BlindReviewSession {
    return createBlindReviewSession(manifest, assignments);
  }

  createOwnerReviewPacket(
    session: BlindReviewSession,
    captureAuthority: CaptureAuthority,
    input: {
      readonly campaign: SealedOwnerCampaignRef;
      readonly admission: OwnerReviewAdmission;
      readonly briefId: string;
      readonly evidence: readonly OwnerCaptureInputs[];
    },
  ): Promise<OwnerReviewPacket> {
    return buildOwnerReviewPacket(session, captureAuthority, input);
  }

  sealOwnerQualityReview(input: {
    readonly session: BlindReviewSession;
    readonly packet: OwnerReviewPacket;
    readonly envelope: OwnerPacketEnvelope;
    readonly envelopeAuthority: EnvelopeAuthority;
    readonly captureAuthority: CaptureAuthority;
    readonly attestationVerifier: ReviewerAttestationVerifier;
    readonly evidenceJudgments: readonly BlindReviewJudgment[];
    readonly reviews: readonly CreativeQualityReviewInput[];
  }): OwnerQualityReviewBundle {
    return finalizeOwnerQualityReview(input);
  }

  async renderOwnerReviewPacket(
    packet: OwnerReviewPacket,
    envelope: OwnerPacketEnvelope,
    envelopeAuthority: EnvelopeAuthority,
    renderer: OwnerReviewPacketRenderer,
  ) {
    return displayOwnerReviewPacket(packet, envelope, envelopeAuthority, renderer);
  }

  async publishOwnerReviewPacket(
    envelope: OwnerPacketEnvelope,
    envelopeAuthority: EnvelopeAuthority,
    packet: OwnerReviewPacket,
    store: OwnerReviewPacketStore,
  ): Promise<{ readonly packet: OwnerReviewPacket; readonly created: boolean }> {
    return persistOwnerReviewPacket(envelope, envelopeAuthority, packet, store);
  }

  createAttributableRevisionSession(
    options: CompileExperimentPlanOptions,
  ): AttributableRevisionSession {
    return createAttributableRevisionSession(options);
  }

  createIndependentBlindTreatmentPreference(
    plan: ExperimentPlan,
    treatment: CanonicalCreativeArtifactEnvelope,
    reviewer: CausalIdentity,
    outcome: BlindTreatmentPreferenceOutcome,
  ): IndependentBlindTreatmentPreference {
    return createIndependentBlindTreatmentPreference(plan, treatment, reviewer, outcome);
  }

  async compose(
    request: CompositionRequest,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt'>> & {
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
    } = {},
  ): Promise<CoordinatedCompositionResult> {
    return this.composeThroughProductionGraph(request, options, false);
  }

  /**
   * Host-only composition seam for a single preregistered campaign stage.
   * The supplied runner is responsible for the exact frozen allocation; this
   * method never falls back to ordinary provider reservation.
   */
  async composeCampaignStage(
    request: CompositionRequest,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt'>> & {
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
      candidateCount?: number;
      candidateBudget?: number;
    },
    runProviderStage: CampaignProviderStageRunner,
    existingHandle?: CreativeRunHandle,
  ): Promise<CoordinatedCompositionResult> {
    return this.composeThroughProductionGraph(
      request, options, false, runProviderStage, existingHandle, !existingHandle,
    );
  }

  /** Removed single-artifact campaign API retained only as a fail-closed boundary. */
  runGovernedCampaign(
    _request: unknown,
    _binding: unknown,
    _options?: unknown,
  ): Promise<never> {
    return Promise.reject(new Error(
      'Governed campaign requires a host-admitted funding reservation and versioned batch execution',
    ));
  }

  /** Only manifests produced after this admission's generator settlements pass this boundary. */
  assertSettledCampaignCandidateManifests(
    admission: CampaignRunAdmission,
    manifests: readonly CampaignActualCandidateManifest[],
  ): void {
    if (!this.campaignAdmissions.has(admission) || manifests.length === 0
      || manifests.some((manifest) => this.settledCampaignCandidates.get(manifest) !== admission
        || manifest.campaignRunId !== admission.creativeRun.requestKey
        || manifest.manifestDigest !== admission.manifestDigest)) {
      throw new Error('CAMPAIGN_OWNER_REVIEW_CANDIDATES_UNSETTLED');
    }
  }

  /** Execute frozen candidates and owner review while retaining terminal-origin authority. */
  async runGovernedCampaignBatch(
    manifest: CampaignManifest,
    executions: readonly VerifiedCampaignSlotExecution[],
    admission: CampaignRunAdmission,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt' | typeof GOVERNED_CAMPAIGN>> & {
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
    } = {},
    runProviderStageFor?: (binding: CampaignSlotGraph) => CampaignProviderStageRunner,
    completeOwnerReviews?: (
      manifests: readonly CampaignActualCandidateManifest[],
    ) => Promise<readonly CampaignOwnerReviewEvidence[]>,
  ): Promise<CoordinatedCampaignResult> {
    if (!this.campaignAdmissions.has(admission)) {
      throw new Error('Governed campaign requires a host-admitted funding reservation');
    }
    if (!runProviderStageFor) throw new Error('Governed campaign requires host-bound per-stage execution');
    if (!completeOwnerReviews) throw new Error('Governed campaign requires dependent owner review');
    if (manifest.manifestDigest !== admission.manifestDigest) {
      throw new Error('Governed campaign manifest does not match its admission');
    }
    const funding = admission.fundingReservation;
    const campaign: CampaignRequestBinding = {
      campaignRunId: admission.creativeRun.requestKey,
      manifestDigest: admission.manifestDigest,
      campaignFundingReservationDigest: funding.reservationDigest,
      campaignPlanDigest: funding.subject.planDigest,
      campaignRouteFreezeDigest: funding.subject.routeFreezeDigest,
    };
    if (!this.campaignCapabilities.has(admission.creativeRun.rootRunId)) {
      if (!this.campaignAuthority || !this.campaignPreflight) {
        throw new Error('Governed campaign blocked: host authority and preflight are required');
      }
      const canonical = await this.campaignPreflight();
      const capability = await this.ensureCampaignCapability({ ...campaign, ...canonical,
        rootRunId: admission.creativeRun.rootRunId });
      this.campaignCapabilities.set(admission.creativeRun.rootRunId, capability);
    }
    const execute = async (): Promise<CoordinatedCampaignSlotResult[]> => {
      const results: CoordinatedCampaignSlotResult[] = [];
      for (const item of executions) {
        const composition = await this.composeThroughProductionGraph(
          item.binding.graph, { ...options, [GOVERNED_CAMPAIGN]: campaign }, false,
          runProviderStageFor(item.binding),
          admission.creativeRun, false,
        );
        results.push({ briefId: item.binding.briefId,
          candidateSlotId: item.binding.candidateSlotId,
          graphDigest: item.proof.graphDigest, composition });
      }
      return results;
    };
    try {
      let results = this.executorAuthority
        ? await withHarnessTransportAuthority(this.executorAuthority, execute)
        : await execute();
      const hostFundingAdmission = this.campaignFundingAdmissions.get(admission);
      if (!hostFundingAdmission) throw new Error('Governed campaign requires host-bound settlement verification');
      const requiredGenerationSettlements: CampaignSuccessfulStageGroup[] = executions.flatMap((item) =>
        item.binding.graph.nodes.map((node) => ({
          nodeId: `${item.binding.briefId}:${item.binding.candidateSlotId}:${node.id}`,
          stageIds: admission.plan.stages.filter((stage) =>
            (stage.kind === 'generation' || stage.kind === 'recovery')
            && stage.briefId === item.binding.briefId
            && stage.candidateSlotId === item.binding.candidateSlotId
            && stage.nodeId === node.id).map((stage) => stage.id),
        })));
      await assertHostCampaignSuccessfulStageGroups(hostFundingAdmission, requiredGenerationSettlements);
      const capability = this.campaignCapabilities.get(admission.creativeRun.rootRunId);
      if (!capability || !this.campaignAuthority) {
        throw new Error('Governed campaign capability was not retained');
      }
      const candidateManifests = manifest.briefs.map((brief) =>
        buildCampaignActualCandidateManifest(manifest, brief,
          brief.candidateSlots.map((slot) => {
            const index = executions.findIndex((item) => item.binding.briefId === brief.id
              && item.binding.candidateSlotId === slot.id);
            if (index < 0 || !results[index]) {
              throw new Error(`CAMPAIGN_BATCH_RESULT_MISSING:${brief.id}/${slot.id}`);
            }
            const item = executions[index]!;
            return { brief, proof: item.proof, diversity: item.diversity,
              result: results[index]!.composition };
          })));
      for (const candidateManifest of candidateManifests) {
        this.settledCampaignCandidates.set(candidateManifest, admission);
      }
      let ownerEvidence: readonly CampaignOwnerReviewEvidence[];
      try {
        ownerEvidence = await completeOwnerReviews(Object.freeze(candidateManifests));
      } finally {
        for (const candidateManifest of candidateManifests) {
          this.settledCampaignCandidates.delete(candidateManifest);
        }
      }
      const expectedBriefs = manifest.briefs.map((brief) => brief.id);
      const actualBriefs = ownerEvidence.map((item) => item.briefId);
      const validDigest = /^[a-f0-9]{64}$/;
      if (actualBriefs.length !== expectedBriefs.length
        || actualBriefs.some((id, index) => id !== expectedBriefs[index])
        || ownerEvidence.some((item) => !validDigest.test(item.packetDigest)
          || !validDigest.test(item.reviewBundleDigest))) {
        throw new Error('CAMPAIGN_OWNER_REVIEW_EVIDENCE_INVALID');
      }
      const candidates = new Map(candidateManifests.flatMap((item) =>
        item.candidates.map((candidate) => [`${item.briefId}:${candidate.id}`, candidate] as const)));
      const evidence: CampaignEvidenceReceipt[] = [];
      for (const result of results) {
        const candidate = candidates.get(`${result.briefId}:${result.candidateSlotId}`);
        if (!candidate) throw new Error(`CAMPAIGN_BATCH_CANDIDATE_MISSING:${result.candidateSlotId}`);
        evidence.push({ receiptId: `${campaign.campaignRunId}:${result.briefId}:${result.candidateSlotId}:composition`,
          kind: 'composition', resultDigest: createHash('sha256')
            .update(result.composition.html).digest('hex') });
        evidence.push({ receiptId: `${campaign.campaignRunId}:${result.briefId}:${result.candidateSlotId}:candidate`,
          kind: 'actual-candidate', resultDigest: createHash('sha256')
            .update(JSON.stringify(candidate)).digest('hex') });
      }
      for (const item of ownerEvidence) {
        evidence.push(Object.freeze({ receiptId: `${campaign.campaignRunId}:${item.briefId}:owner-packet`,
          kind: 'owner-packet', resultDigest: item.packetDigest }));
        evidence.push(Object.freeze({ receiptId: `${campaign.campaignRunId}:${item.briefId}:owner-review-bundle`,
          kind: 'owner-review-bundle', resultDigest: item.reviewBundleDigest }));
      }
      const frozenEvidence = Object.freeze(evidence.map((item) => Object.freeze(item)));
      const checkpointBody = { schema: 'sinter.campaign-evidence-checkpoint' as const,
        schemaVersion: 1 as const, originPending: true as const, ...campaign,
        rootRunId: admission.creativeRun.rootRunId, receipts: frozenEvidence };
      const campaignEvidenceCheckpoint = Object.freeze({ ...checkpointBody,
        checkpointDigest: digestCheckpoint(checkpointBody) });
      const completed = await this.finish(admission.creativeRun, 'completed');
      results = results.map((item) => ({ ...item,
        composition: { ...item.composition, creativeRun: completed } }));
      return Object.freeze({ schema: 'sinter.coordinated-campaign-result', schemaVersion: 1,
        creativeRun: results.at(-1)?.composition.creativeRun ?? admission.creativeRun,
        executions: Object.freeze(results), candidateManifests: Object.freeze(candidateManifests),
        campaignEvidenceCheckpoint });
    } catch (error) {
      await this.finish(admission.creativeRun, 'failed');
      this.campaignCapabilities.delete(admission.creativeRun.rootRunId);
      throw error;
    }
  }

  /** Terminal host-origin signing is available only for the retained exact campaign capability. */
  async finalizeCampaignOrigin(
    admission: CampaignRunAdmission,
    receipts: readonly CampaignEvidenceReceipt[],
  ) {
    if (!this.campaignAdmissions.has(admission) || !this.campaignAuthority || !this.campaignPreflight) {
      throw new Error('CAMPAIGN_ORIGIN_ADMISSION_INVALID');
    }
    let capability = this.campaignCapabilities.get(admission.creativeRun.rootRunId);
    if (!capability) {
      const origin = admission.creativeRun.record.campaignOrigin;
      if (!origin || !admission.planDigest) {
        throw new Error('CAMPAIGN_ORIGIN_CAPABILITY_NOT_RETAINED');
      }
      const canonical = await this.campaignPreflight();
      capability = await this.ensureCampaignCapability({
        campaignRunId: admission.creativeRun.requestKey,
        rootRunId: admission.creativeRun.rootRunId,
        manifestDigest: admission.manifestDigest,
        campaignFundingReservationDigest: admission.fundingReservation.reservationDigest,
        campaignPlanDigest: admission.planDigest,
        campaignRouteFreezeDigest: admission.fundingReservation.subject.routeFreezeDigest,
        ...canonical,
      });
      this.campaignCapabilities.set(admission.creativeRun.rootRunId, capability);
    }
    const origin = await this.campaignAuthority.finalize(capability, receipts);
    this.campaignCapabilities.delete(admission.creativeRun.rootRunId);
    return origin;
  }

  /**
   * Execute the same graph, candidate, orchestration, and finalization path as
   * ordinary composition while reserving the explicit synthetic no-spend lane.
   * Background exploration must use this method instead of rebuilding a
   * plan-only approximation of Create.
   */
  async composeNoSpend(
    request: CompositionRequest,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt'>> & {
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
      candidateCount?: number;
      candidateBudget?: number;
    } = {},
  ): Promise<CoordinatedCompositionResult> {
    return this.composeThroughProductionGraph(request, options, true);
  }

  /** Admit once, then recover only the exact durable host admission on restart. */
  private async ensureCampaignCapability(binding: CampaignManifestBinding): Promise<CampaignOriginCapability> {
    if (!this.campaignAuthority) throw new Error('Governed campaign blocked: host authority is required');
    try {
      return await this.campaignAuthority.admit(binding);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Campaign has already been admitted') throw error;
      const persisted = await this.persistence.read(binding.campaignRunId);
      if (persisted?.rootRunId === binding.rootRunId && persisted.status === 'failed') {
        throw error;
      }
      return this.campaignAuthority.resume(binding);
    }
  }

  private async composeThroughProductionGraph(
    request: CompositionRequest,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt'>> & {
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
      candidateCount?: number;
      candidateBudget?: number;
    },
    noSpend: boolean,
    runProviderStage?: CampaignProviderStageRunner,
    existingHandle?: CreativeRunHandle,
    finishRun = true,
  ): Promise<CoordinatedCompositionResult> {
    const graph = 'schema' in request && request.schemaVersion === '2.0'
      ? this.graphPolicy.readV2(request)
      : this.graphPolicy.createV2FromLegacy(request);
    const renderedSpec = this.graphPolicy.renderV2(graph);
    const spec = 'renderGate' in request && request.renderGate === false
      ? { ...renderedSpec, renderGate: false }
      : renderedSpec;
    if (options.creativeThesis && spec.creativeThesis
      && options.creativeThesis.thesisId !== spec.creativeThesis.thesisId) {
      throw new Error('Supplied Creative Thesis is incompatible with the composition Creative Thesis; provider reservation was not attempted');
    }
    const requestedThesis = spec.creativeThesis ?? options.creativeThesis;
    for (const layer of spec.layers.filter((candidate) => ['music', 'tone', 'strudel'].includes(candidate.domain))) {
      try {
        compileMusicCreativeThesis(layer.prompt);
      } catch {
        throw new Error(`Unsupported music/sound layer prompt for ${layer.domain}; provider reservation was not attempted`);
      }
    }
    const prompt = this.prepareOrdinaryCreatePrompt(
      [spec.title, ...spec.layers.map((layer) => `${layer.domain}: ${layer.prompt}`)]
        .filter(Boolean).join('\n'),
    );
    if (/\b(?:temporal|time-based) artifact\b/i.test(prompt)) {
      const temporal = await this.composeTemporal({
        brief: prompt,
        artifactId: options.requestKey,
        requestKey: options.requestKey,
        entryPoint: options.entryPoint,
      });
      return {
        html: temporal.temporalArtifact.html,
        title: spec.title ?? 'Temporal artifact',
        background: spec.background ?? '#000000',
        layers: [{ domain: 'html', prompt, blendMode: 'normal', opacity: 1, codeLength: temporal.temporalArtifact.html.length, generated: true, artifactHtml: temporal.temporalArtifact.html }],
        successCount: 1,
        creativeThesis: temporal.temporalArtifact.thesis,
        creativeRun: temporal.creativeRun,
        candidateManifest: temporal.candidateManifest,
        temporalArtifact: temporal.temporalArtifact,
      };
    }
    const { candidateCount, candidateBudget, ...runOptions } = options;
    const start = noSpend ? this.startNoSpend.bind(this) : this.start.bind(this);
    const handle = existingHandle ?? await start({ ...runOptions,
      entryPoint: options.entryPoint ?? 'studio-layers', prompt,
      creativeThesis: requestedThesis });
    const creativeThesis = existingHandle && requestedThesis
      ? requestedThesis : executionThesis(handle);
    try {
      const candidateManifest = await this.planCandidates(prompt, {
        creativeThesis,
        layers: spec.layers,
        ...(candidateCount === undefined ? {} : { candidateCount }),
        ...(candidateBudget === undefined ? {} : { candidateBudget }),
      });
      const candidateId = candidateManifest.candidates[0]?.id ?? 'primary-candidate';
      const result = await CompositionOrchestrator.compose({
        ...spec,
        creativeThesis,
        generationContext: {
          runId: handle.rootRunId,
          candidateId,
          ledger: this.generationAttemptLedger,
          ...(runProviderStage ? { runProviderStage } : {}),
        },
      });
      const finished = finishRun ? await this.finish(handle, 'completed') : handle;
      return { ...result, creativeRun: finished, candidateManifest };
    } catch (error) {
      if (finishRun) await this.finish(handle, 'failed');
      throw error;
    }
  }

  async composeFromPrompt(
    prompt: string,
    llm?: LLMClient,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt'>> & {
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
    } = {},
  ): Promise<CoordinatedCompositionResult> {
    return this.composeFromPromptInternal(prompt, llm, options);
  }

  private async composeFromPromptInternal(
    prompt: string,
    llm: LLMClient | undefined,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt'>> & {
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
    },
  ): Promise<CoordinatedCompositionResult> {
    const ordinaryPrompt = this.prepareOrdinaryCreatePrompt(prompt);
    const requestedThesis = validateCreativeThesis(compileCreativeThesis(ordinaryPrompt));
    const handle = await this.start({
      ...options,
      entryPoint: options.entryPoint ?? 'cli-compose',
      prompt: ordinaryPrompt,
      creativeThesis: requestedThesis,
    });
    const creativeThesis = executionThesis(handle);
    try {
      const spec = await CompositionOrchestrator.decomposePrompt(ordinaryPrompt, llm);
      const candidateManifest = await this.planCandidates(ordinaryPrompt, {
        creativeThesis,
        layers: spec.layers,
      });
      const candidateId = candidateManifest.candidates[0]?.id ?? 'primary-candidate';
      const result = await CompositionOrchestrator.compose({
        ...spec,
        creativeThesis,
        generationContext: {
          runId: handle.rootRunId,
          candidateId,
          ledger: this.generationAttemptLedger,
        },
      });
      const finished = await this.finish(handle, 'completed');
      return { ...result, creativeRun: finished, candidateManifest };
    } catch (error) {
      await this.finish(handle, 'failed');
      throw error;
    }
  }

  async createInteractiveArtifact(
    prompt: string,
    artifactOptions: BuildInteractiveArtifactOptions,
    options: Partial<Omit<CreativeRunRequest, 'entryPoint' | 'prompt'>> = {},
  ): Promise<CoordinatedInteractiveArtifactResult> {
    const handle = await this.start({ ...options, entryPoint: 'studio-session', prompt });
    if (artifactOptions.revisionsApplied === 1 && !this.persistence.claim) {
      throw new Error('Interactive revision persistence does not support atomic claims');
    }
    const executionHandle = artifactOptions.revisionsApplied === 1
      ? await this.persistence.claim!(handle.requestKey, async () => {
          const current = await this.persistence.read(handle.requestKey);
          const record = this.toHandle(current ?? handle.record).record;
          if ((record.interactionRevisionsApplied ?? 0) >= 1) {
            throw new Error('Interactive artifact bounded revision has already been consumed');
          }
          const revised = {
            ...record,
            interactionRevisionsApplied: 1,
            updatedAt: this.now(),
          } satisfies CreativeRunRecord;
          await this.persistence.write(revised);
          return this.toHandle(revised);
        })
      : handle;
    try {
      const artifact = CompositionOrchestrator.composeInteractiveArtifact(
        executionThesis(executionHandle),
        artifactOptions,
      );
      return { ...artifact, creativeRun: await this.finish(executionHandle, 'completed') };
    } catch (error) {
      await this.finish(handle, 'failed');
      throw error;
    }
  }

  async composeCrossModal(
    options: CrossModalArtifactOptions & {
      requestKey?: string;
      entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'>;
    },
  ): Promise<CoordinatedCrossModalArtifactResult> {
    const crossModalArtifact = buildCrossModalArtifact(options);
    const handle = await this.startNoSpend({
      entryPoint: options.entryPoint ?? 'studio-layers',
      prompt: options.brief,
      creativeThesis: crossModalArtifact.thesis,
      requestKey: options.requestKey ?? `cross-modal-${crossModalArtifact.artifactId}`,
    });
    try {
      const finished = await this.finish(handle, 'completed');
      return { html: crossModalArtifact.html, crossModalArtifact, creativeRun: finished };
    } catch (error) {
      await this.finish(handle, 'failed');
      throw error;
    }
  }

  async composeTemporal(options: TemporalArtifactOptions & { requestKey?: string; entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'> }): Promise<CoordinatedTemporalResult> {
    return new TemporalArtifactBuilder(this, this.temporalGenerator).compose(options);
  }
}

export interface CoordinatedTemporalResult {
  readonly creativeRun: CreativeRunHandle;
  readonly temporalArtifact: TemporalArtifact;
  readonly candidateManifest: CandidateManifest;
}

export class TemporalArtifactBuilder {
  constructor(
    private readonly coordinator: CreativeRunCoordinatorBase,
    private readonly generator: TemporalArtifactGenerationSeam = new TemporalArtifactGenerator(),
  ) {}

  async compose(options: TemporalArtifactOptions & { requestKey?: string; entryPoint?: Extract<CreativeRunEntryPoint, 'studio-layers' | 'cli-compose'> }): Promise<CoordinatedTemporalResult> {
    const entryPoint = options.entryPoint ?? 'studio-layers';
    const candidateManifest = await this.coordinator.planCandidates(options.brief, {
      creativeThesis: options.thesis,
    });
    // Always use the no-spend path: the temporal artifact is contract-driven
    // and deterministic. An injected provider must never be reserved for it.
    const handle = await this.coordinator.startNoSpend({
      entryPoint,
      prompt: options.brief,
      creativeThesis: candidateManifest.creativeThesis,
      requestKey: options.requestKey ?? (options.artifactId ? `temporal-${options.artifactId}` : `temporal-${randomUUID()}`),
    });
    if (handle.record.readiness.source !== 'synthetic-no-spend' || handle.record.providerReservation.source !== 'synthetic-no-spend') {
      await this.coordinator.finish(handle, 'failed');
      throw new Error('Temporal artifact requires a no-spend readiness path; provider reservation must not occur.');
    }
    try {
      const temporalArtifact = this.generator.generate(options);
      const finished = await this.coordinator.finish(handle, 'completed');
      return { creativeRun: finished, temporalArtifact, candidateManifest };
    } catch (error) {
      await this.coordinator.finish(handle, 'failed');
      throw error;
    }
  }
}
