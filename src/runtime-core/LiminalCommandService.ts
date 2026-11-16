import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { productPurposeForRole, withLiminalProductTransportAuthority, withProviderAttemptGuard,
  type LiminalProductTransportGrant, type ProductTransportPurpose } from '../llm/LLMClient.js';
import { fatalShaderEvidence } from './LiminalProductionEffects.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { classifyEffectFailure, LiminalEffectBroker } from './LiminalEffectBroker.js';
import { LiminalReceiptProjector, rebuildOperationTrace } from './LiminalReceiptProjector.js';
import { LiminalOperationKernel } from './LiminalOperationKernel.js';
import { liminalDurablePayloadDigest } from './LiminalPayloadDigest.js';
import { bootstrapProductionCreativeAdmissionSigner, createTestCreativeAdmissionSigner,
  type CreativeAdmissionProof, type CreativeAdmissionSigner } from
  './CreativeAdmissionAuthority.js';

export type LiminalEvalMode = 'legacy' | 'auto' | 'strict-browser';
export type LiminalRole = 'generator' | 'evaluator' | 'harness' | 'studio';

export interface LiminalCreativeCommand {
  readonly schema: 'sinter.liminal-command';
  readonly schemaVersion: 1;
  readonly kind: 'generate-candidate';
  readonly idempotencyKey: string;
  readonly prompt: string;
  readonly domain: string;
  readonly layers: readonly string[];
  readonly sourceHeadSha?: string;
  readonly canonicalMainSha: string;
  readonly sourceBinding?: {
    readonly sourceKind: 'explicit' | 'git-origin-main'
      | 'forgejo-actions-pull-request' | 'forgejo-actions-main-push' | 'package-stamp';
    readonly sourceHeadSource: 'caller' | 'git-head' | 'forgejo-actions-github-sha'
      | 'package-stamp';
    readonly canonicalMainSource: 'caller' | 'git-origin-main'
      | 'forgejo-event-pull-request-base' | 'forgejo-event-main-push' | 'package-stamp';
    readonly eventHeadSha?: string;
  };
  readonly authorityPackageDigest: string;
  readonly maxTransportAttempts: number;
  readonly evalMode: LiminalEvalMode;
  readonly safeMode: 'c0-no-empirical-teaching' | 'governed-production';
  readonly roles: Readonly<Record<LiminalRole, string>>;
  readonly rendererIdentity: string;
  readonly renderAuthorization: 'test-fake' | 'isolated-playwright' | 'non-chrome';
  readonly generatorOverride?: string;
  readonly teaching?: { readonly targetScope: string;
    readonly snapshotDigest?: string; readonly doctrineDigest?: string };
  readonly creativeContextDigest?: string;
}

export interface GeneratedArtifact {
  readonly source: string;
  readonly playable: string;
  readonly provenance: string;
}

export interface RenderedObservation {
  readonly status: 'rendered' | 'missing' | 'failed' | 'degraded';
  readonly rendererIdentity: string;
  readonly earlyFrame?: Buffer;
  readonly lateFrame?: Buffer;
  readonly earlyFrameSize?: { readonly width: number; readonly height: number };
  readonly lateFrameSize?: { readonly width: number; readonly height: number };
  readonly runtimeErrors: readonly string[];
  readonly timingMs?: number;
  readonly rendererEnvironmentDigest?: string;
  readonly containment?: {
    readonly networkIsolated: boolean;
    readonly permissionsDenied: boolean;
    readonly cleanupSucceeded: boolean;
    readonly assetDigests?: readonly string[];
    readonly runtimeDigest?: string;
    readonly postRunCensus?: { readonly durationMs: number;
      readonly usedHeapBytes: number | null; readonly eventListeners: number;
      readonly eventsDispatched: number; readonly timers: number;
      readonly audioContexts: number; readonly pagesBefore: number; readonly pagesAfter: number };
  };
  readonly playback?: { readonly controlsAccessible: boolean; readonly started: boolean };
  readonly interaction?: { readonly actions: number; readonly stateChanged: boolean | null;
    readonly target?: 'control' | 'canvas-pointer' | 'none' | 'error' };
  /** How far piece time got before the late frame was taken (#1637, #1647). */
  readonly arc?: { readonly horizonMs: number; readonly reachedMs: number; readonly wallMs: number };
  readonly audio: {
    readonly relevant: boolean;
    readonly state: 'audible' | 'inaudible' | 'not-applicable' | 'unavailable';
    readonly peakAmplitude?: number;
    readonly rmsAmplitude?: number;
    readonly silentShare?: number;
    readonly noisiness?: number | null;
    readonly floorFailure?: string;
  };
}

export interface EvaluatorResult {
  readonly score: number;
  readonly confidence?: number;
  readonly failureClass?: string;
  readonly reasoning?: string;
  readonly degraded: boolean;
  readonly identityValid: boolean;
  readonly evaluatorIdentity: string;
  readonly evidenceDigest: string | null;
}

export interface LiminalCommandEffects {
  generate(input: { prompt: string; identity: string; domain: string;
    startTransport(payload?: unknown): Promise<number>;
    failTransport(reason?: string): Promise<void>; }): Promise<GeneratedArtifact>;
  render(input: { playable: string; domain: string }): Promise<RenderedObservation>;
  evaluate(input: {
    observation: RenderedObservation;
    domain: string;
    /** Generated source; audio domains are judged from it plus measured audio. */
    source?: string;
    /** The user's request, so the judge scores adherence instead of guessing intent (#1638). */
    prompt?: string;
    evidenceDigest: string | null;
    identity: string;
    startTransport(payload?: unknown): Promise<number>;
    failTransport(reason?: string): Promise<void>;
  }): Promise<EvaluatorResult>;
}

export interface PersistedArtifacts {
  readonly sourceDigest: string;
  readonly playableDigest: string;
  readonly provenanceDigest: string;
}

export interface PersistedRenderedEvidence {
  readonly earlyFrameDigest: string | null;
  readonly lateFrameDigest: string | null;
}

export interface LiminalArtifactStore {
  persist(operationId: string, artifact: GeneratedArtifact): Promise<PersistedArtifacts>;
  persistRenderedEvidence(operationId: string,
    observation: RenderedObservation): Promise<PersistedRenderedEvidence>;
  read(operationId: string): Promise<GeneratedArtifact | null>;
  readRenderedEvidence?(operationId: string): Promise<PersistedRenderedEvidence | null>;
}

export type LiminalOperationEventType =
  | 'command-accepted'
  | 'domain-authorized'
  | 'effect-reserved'
  | 'effect-started'
  | 'effect-result'
  | 'transport-started'
  | 'transport-failed'
  | 'artifacts-persisted'
  | 'render-observed'
  | 'domain-decided'
  | 'domain-projection-linked'
  | 'evaluation-decided'
  | 'receipt-projected';

export type LiminalEffectKind = 'generation' | 'render' | 'evaluation' | 'judgment';

export interface LiminalEffectReservation {
  readonly operationId: string;
  readonly effectId: string;
  readonly kind: LiminalEffectKind;
  readonly capability: string;
  readonly fence: number;
}

export type LiminalEffectOutcome = 'succeeded' | 'failed' | 'ambiguous';

export interface LiminalOperationEvent {
  readonly operationId: string;
  readonly ordinal: number;
  readonly type: LiminalOperationEventType;
  readonly payloadDigest: string;
}

export interface LiminalOperationAdmission {
  readonly operationId: string;
  readonly lineageId: string;
  readonly commandDigest: string;
  readonly attemptsConsumed: number;
}

export interface LiminalOperationJournal {
  begin(key: string, proposed: LiminalOperationAdmission): Promise<LiminalOperationAdmission>;
  reserveTransportAttempt(operationId: string, maximum: number, payload: unknown): Promise<number>;
  /** Releases the attempt only when `reason` is a definite failure (#1323). */
  failTransportAttempt(operationId: string, reason?: unknown): Promise<void>;
  authorizeDomain(operationId: string, domain: string): Promise<void>;
  reserveEffect(operationId: string, kind: LiminalEffectKind,
    payload: unknown): Promise<LiminalEffectReservation>;
  startEffect(reservation: LiminalEffectReservation): Promise<void>;
  completedEffect<T>(operationId: string, kind: LiminalEffectKind): Promise<T | null>;
  completeEffect<T>(reservation: LiminalEffectReservation, result: T): Promise<void>;
  finishEffect(reservation: LiminalEffectReservation,
    outcome: LiminalEffectOutcome, payload: unknown): Promise<void>;
  linkProjection(operationId: string, domain: 'campaign' | 'dream',
    projectionDigest: string): Promise<void>;
  attemptsConsumed(operationId: string): Promise<number>;
  append(operationId: string, type: LiminalOperationEventType, payload: unknown): Promise<void>;
  eventsForOperation(operationId: string): Promise<readonly LiminalOperationEvent[]>;
  findByIdempotencyKey(key: string): Promise<LiminalCommandResult | null>;
  bindResult(key: string, result: LiminalCommandResult): Promise<void>;
}

export interface BoundRenderedEvidence {
  readonly status: RenderedObservation['status'];
  readonly rendererIdentity: string;
  readonly earlyFrameDigest: string | null;
  readonly lateFrameDigest: string | null;
  readonly earlyFrameSize?: RenderedObservation['earlyFrameSize'];
  readonly lateFrameSize?: RenderedObservation['lateFrameSize'];
  readonly runtimeErrors: readonly string[];
  readonly timingMs?: number;
  readonly rendererEnvironmentDigest?: string;
  readonly containment?: RenderedObservation['containment'];
  readonly playback?: RenderedObservation['playback'];
  readonly interaction?: RenderedObservation['interaction'];
  readonly arc?: RenderedObservation['arc'];
  readonly audio: RenderedObservation['audio'];
  readonly evidenceDigest: string | null;
}

export interface AdmissionEvaluation extends EvaluatorResult {
  readonly admissionEligible: boolean;
  readonly rejectionReasons: readonly string[];
}

export interface LiminalAuthorityReceipt {
  readonly schema: 'sinter.liminal-authority-receipt';
  readonly schemaVersion: 1;
  readonly authorityTier: 'test-proof' | 'production';
  readonly authorityKeyDigest: string;
  readonly operationId: string;
  readonly lineageId: string;
  readonly commandDigest: string;
  readonly providerInputDigest: string;
  readonly artifactDigest: string;
  readonly evidenceDigest: string | null;
  readonly actionAuthorityDigest?: string;
  readonly operationTraceDigest: string;
  readonly disabledTeachingReaders: readonly string[];
  readonly empiricalContextDigests: readonly string[];
  readonly learningEligible: boolean;
  readonly signature: string;
}

export interface LiminalReceiptAuthority {
  readonly tier: LiminalAuthorityReceipt['authorityTier'];
  project(input: Omit<LiminalAuthorityReceipt,
  'schema' | 'schemaVersion' | 'authorityTier' | 'authorityKeyDigest' | 'signature'>): LiminalAuthorityReceipt;
  verify(receipt: LiminalAuthorityReceipt): boolean;
}

const ADMISSION_SEAL = Symbol('liminal-admission-seal');
interface InternalLiminalReceiptAuthority extends LiminalReceiptAuthority {
  [ADMISSION_SEAL](value: unknown): CreativeAdmissionProof;
}

function sealInternalAdmission(authority: LiminalReceiptAuthority,
  value: unknown): CreativeAdmissionProof {
  const seal = (authority as InternalLiminalReceiptAuthority)[ADMISSION_SEAL];
  if (!seal) throw new Error('LIMINAL_INTERNAL_ADMISSION_AUTHORITY_REQUIRED');
  return seal.call(authority, value);
}

export interface LiminalCommandResult {
  readonly operationId: string;
  readonly lineageId: string;
  readonly domain: string;
  readonly roles: Readonly<Record<LiminalRole, string>>;
  readonly artifacts: PersistedArtifacts;
  readonly evidence: BoundRenderedEvidence;
  readonly evaluation: AdmissionEvaluation;
  readonly attempts: { readonly consumed: number; readonly maximum: number };
  readonly receipt: LiminalAuthorityReceipt;
}

export interface LiminalReevaluationSpec {
  readonly idempotencyKey: string;
  readonly maxTransportAttempts: 1;
  readonly actionAuthorityDigest: string;
}

const DISABLED_TEACHING_READERS = Object.freeze([
  'guidance-engine',
  'semantic-art-memory',
  'quality-archive',
  'map-elites',
  'compost-seed-bank',
  'dream-queue',
  'harness-memory',
] as const);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  const input = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonical(value);
  return createHash('sha256').update(input).digest('hex');
}

function bindEvidence(observation: RenderedObservation): BoundRenderedEvidence {
  const earlyFrameDigest = observation.earlyFrame ? digest(observation.earlyFrame) : null;
  const lateFrameDigest = observation.lateFrame ? digest(observation.lateFrame) : null;
  const base = {
    status: observation.status,
    rendererIdentity: observation.rendererIdentity,
    earlyFrameDigest,
    lateFrameDigest,
    earlyFrameSize: observation.earlyFrameSize,
    lateFrameSize: observation.lateFrameSize,
    runtimeErrors: [...observation.runtimeErrors],
    timingMs: observation.timingMs,
    rendererEnvironmentDigest: observation.rendererEnvironmentDigest,
    containment: observation.containment ? { ...observation.containment } : undefined,
    playback: observation.playback ? { ...observation.playback } : undefined,
    interaction: observation.interaction ? { ...observation.interaction } : undefined,
    // Only when present: canonical() hashes an undefined key, and renders
    // without an arc must keep their existing evidence digests.
    ...(observation.arc ? { arc: { ...observation.arc } } : {}),
    audio: { ...observation.audio },
  };
  const evidenceDigest = earlyFrameDigest && lateFrameDigest ? digest(base) : null;
  return Object.freeze({ ...base, evidenceDigest });
}

export class InMemoryLiminalArtifactStore implements LiminalArtifactStore {
  private readonly values = new Map<string, GeneratedArtifact>();
  private readonly rendered = new Map<string, { early?: Buffer; late?: Buffer }>();
  constructor(private readonly onPersist: (event: string) => void = () => undefined) {}

  persist(operationId: string, artifact: GeneratedArtifact): Promise<PersistedArtifacts> {
    this.onPersist('persist:source');
    const sourceDigest = digest(artifact.source);
    this.onPersist('persist:playable');
    const playableDigest = digest(artifact.playable);
    this.onPersist('persist:provenance');
    const provenanceDigest = digest(artifact.provenance);
    this.values.set(operationId, Object.freeze({ ...artifact }));
    return Promise.resolve(Object.freeze({ sourceDigest, playableDigest, provenanceDigest }));
  }
  read(operationId: string): Promise<GeneratedArtifact | null> {
    return Promise.resolve(this.values.get(operationId) ?? null);
  }
  readRenderedEvidence(operationId: string): Promise<PersistedRenderedEvidence | null> {
    const value = this.rendered.get(operationId);
    if (!value) return Promise.resolve(null);
    return Promise.resolve(Object.freeze({
      earlyFrameDigest: value.early ? digest(value.early) : null,
      lateFrameDigest: value.late ? digest(value.late) : null,
    }));
  }
  persistRenderedEvidence(operationId: string,
    observation: RenderedObservation): Promise<PersistedRenderedEvidence> {
    const early = observation.earlyFrame && Buffer.from(observation.earlyFrame);
    const late = observation.lateFrame && Buffer.from(observation.lateFrame);
    this.rendered.set(operationId, { early, late });
    return Promise.resolve(Object.freeze({ earlyFrameDigest: early ? digest(early) : null,
      lateFrameDigest: late ? digest(late) : null }));
  }
}

export class InMemoryLiminalOperationJournal implements LiminalOperationJournal {
  private readonly log: LiminalOperationEvent[] = [];
  private readonly results = new Map<string, LiminalCommandResult>();
  private readonly operations = new Map<string, LiminalOperationAdmission>();
  private readonly effects = new Map<string, {
    reservation: LiminalEffectReservation;
    state: 'reserved' | 'started' | LiminalEffectOutcome;
    result?: unknown;
  }>();
  private nextFence = 1;

  async begin(key: string, proposed: LiminalOperationAdmission): Promise<LiminalOperationAdmission> {
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.commandDigest !== proposed.commandDigest) throw new Error('IDEMPOTENCY_KEY_REBOUND');
      return existing;
    }
    this.operations.set(key, Object.freeze({ ...proposed, attemptsConsumed: 0 }));
    await this.append(proposed.operationId, 'command-accepted', {
      commandDigest: proposed.commandDigest, lineageId: proposed.lineageId,
    });
    return this.operations.get(key)!;
  }

  async reserveTransportAttempt(operationId: string, maximum: number, payload: unknown): Promise<number> {
    const entry = [...this.operations.entries()].find(([, value]) => value.operationId === operationId);
    if (!entry) throw new Error('UNKNOWN_LIMINAL_OPERATION');
    const [key, operation] = entry;
    if (operation.attemptsConsumed >= maximum) throw new Error('TRANSPORT_ATTEMPT_CAP_EXHAUSTED');
    const attempt = operation.attemptsConsumed + 1;
    this.operations.set(key, Object.freeze({ ...operation, attemptsConsumed: attempt }));
    await this.append(operationId, 'transport-started', { ...payload as object, attempt });
    return attempt;
  }
  async failTransportAttempt(operationId: string, reason?: unknown): Promise<void> {
    const entry = [...this.operations.entries()].find(([, value]) => value.operationId === operationId);
    if (!entry) throw new Error('UNKNOWN_LIMINAL_OPERATION');
    const [key, operation] = entry;
    if (classifyEffectFailure(reason) === 'ambiguous') {
      await this.append(operationId, 'transport-failed', { released: 0, outcome: 'ambiguous' });
      return;
    }
    if (operation.attemptsConsumed <= 0) return;
    this.operations.set(key,
      Object.freeze({ ...operation, attemptsConsumed: operation.attemptsConsumed - 1 }));
    await this.append(operationId, 'transport-failed', { released: operation.attemptsConsumed });
  }

  attemptsConsumed(operationId: string): Promise<number> {
    const operation = [...this.operations.values()].find(value => value.operationId === operationId);
    return Promise.resolve(operation?.attemptsConsumed ?? 0);
  }

  authorizeDomain(operationId: string, domain: string): Promise<void> {
    return this.append(operationId, 'domain-authorized', { domain });
  }

  async reserveEffect(operationId: string, kind: LiminalEffectKind,
    payload: unknown): Promise<LiminalEffectReservation> {
    if (![...this.operations.values()].some(value => value.operationId === operationId)) {
      throw new Error('UNKNOWN_LIMINAL_OPERATION');
    }
    const prior = [...this.effects.values()].find(effect =>
      effect.reservation.operationId === operationId && effect.reservation.kind === kind);
    if (prior) {
      if (prior.state === 'reserved') return prior.reservation;
      // A prior attempt that failed should not permanently block retries.
      // Drop the stale reservation and mint a fresh one; the audit trail
      // for the failed attempt is preserved in the events log (#865).
      if (prior.state !== 'failed') throw new Error('EFFECT_OUTCOME_UNRESOLVED');
      this.effects.delete(prior.reservation.effectId);
    }
    const reservation = Object.freeze({ operationId, kind,
      effectId: `effect:${randomUUID()}`,
      capability: randomBytes(32).toString('hex'), fence: this.nextFence++ });
    this.effects.set(reservation.effectId, { reservation, state: 'reserved' });
    await this.append(operationId, 'effect-reserved', { kind, effectId: reservation.effectId,
      fence: reservation.fence, payload });
    return reservation;
  }

  async startEffect(reservation: LiminalEffectReservation): Promise<void> {
    const effect = this.validEffect(reservation);
    if (effect.state !== 'reserved') throw new Error('EFFECT_RESERVATION_ALREADY_CLAIMED');
    effect.state = 'started';
    await this.append(reservation.operationId, 'effect-started', {
      effectId: reservation.effectId, kind: reservation.kind, fence: reservation.fence });
  }

  completedEffect<T>(operationId: string, kind: LiminalEffectKind): Promise<T | null> {
    return new Promise(resolve => {
      const effect = [...this.effects.values()].find(item =>
        item.reservation.operationId === operationId && item.reservation.kind === kind);
      resolve(effect?.state === 'succeeded' && 'result' in effect ? effect.result as T : null);
    });
  }

  async completeEffect<T>(reservation: LiminalEffectReservation, result: T): Promise<void> {
    const effect = this.validEffect(reservation);
    if (effect.state === 'succeeded' && 'result' in effect) return;
    if (effect.state !== 'started') throw new Error('EFFECT_NOT_STARTED');
    effect.result = result;
    effect.state = 'succeeded';
    await this.append(reservation.operationId, 'effect-result', {
      effectId: reservation.effectId, kind: reservation.kind, outcome: 'succeeded',
      resultDigest: digest(result),
    });
  }

  async finishEffect(reservation: LiminalEffectReservation,
    outcome: LiminalEffectOutcome, payload: unknown): Promise<void> {
    const effect = this.validEffect(reservation);
    if (effect.state !== 'started') throw new Error('EFFECT_NOT_STARTED');
    effect.state = outcome;
    await this.append(reservation.operationId, 'effect-result', {
      effectId: reservation.effectId, kind: reservation.kind, outcome, payload });
  }

  linkProjection(operationId: string, domain: 'campaign' | 'dream',
    projectionDigest: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(projectionDigest)) {
      return Promise.reject(new Error('DOMAIN_PROJECTION_DIGEST_INVALID'));
    }
    const expected = digest({ domain, projectionDigest });
    if (this.log.some(event => event.operationId === operationId
      && event.type === 'domain-projection-linked' && event.payloadDigest === expected)) {
      return Promise.resolve();
    }
    return this.append(operationId, 'domain-projection-linked', { domain, projectionDigest });
  }

  append(operationId: string, type: LiminalOperationEventType, payload: unknown): Promise<void> {
    this.log.push(Object.freeze({
      operationId,
      ordinal: this.log.length + 1,
      type,
      payloadDigest: digest(payload),
    }));
    return Promise.resolve();
  }

  findByIdempotencyKey(key: string): Promise<LiminalCommandResult | null> {
    return Promise.resolve(this.results.get(key) ?? null);
  }

  bindResult(key: string, result: LiminalCommandResult): Promise<void> {
    this.results.set(key, result);
    return Promise.resolve();
  }

  events(): readonly LiminalOperationEvent[] {
    return [...this.log];
  }

  eventsForOperation(operationId: string): Promise<readonly LiminalOperationEvent[]> {
    return Promise.resolve(this.log.filter(event => event.operationId === operationId));
  }

  private validEffect(reservation: LiminalEffectReservation) {
    const effect = this.effects.get(reservation.effectId);
    if (!effect
      || effect.reservation.capability !== reservation.capability
      || effect.reservation.operationId !== reservation.operationId
      || effect.reservation.kind !== reservation.kind
      || effect.reservation.fence !== reservation.fence) {
      throw new Error('INVALID_EFFECT_CAPABILITY');
    }
    return effect;
  }
}

function unsignedReceipt(receipt: LiminalAuthorityReceipt): Omit<LiminalAuthorityReceipt, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

class HmacReceiptAuthority implements LiminalReceiptAuthority {
  constructor(
    private readonly secret: string,
    readonly tier: LiminalAuthorityReceipt['authorityTier'],
    private readonly verificationSecrets: readonly string[] = [secret],
    private readonly revokedKeyDigests: ReadonlySet<string> = new Set(),
    private readonly admissionSigner: CreativeAdmissionSigner =
      createTestCreativeAdmissionSigner(secret),
  ) {
    if (secret.length < 8) throw new Error('Receipt authority secret is too short');
  }

  [ADMISSION_SEAL](value: unknown): CreativeAdmissionProof {
    return this.admissionSigner.sealAdmission(value);
  }

  project(input: Omit<LiminalAuthorityReceipt,
  'schema' | 'schemaVersion' | 'authorityTier' | 'authorityKeyDigest' | 'signature'>): LiminalAuthorityReceipt {
    if (this.revokedKeyDigests.has(digest(this.secret))) {
      throw new Error('RECEIPT_SIGNER_REVOKED');
    }
    const unsigned = Object.freeze({
      schema: 'sinter.liminal-authority-receipt' as const,
      schemaVersion: 1 as const,
      authorityTier: this.tier,
      authorityKeyDigest: digest(this.secret),
      ...input,
    });
    return Object.freeze({ ...unsigned, signature: this.sign(unsigned) });
  }

  verify(receipt: LiminalAuthorityReceipt): boolean {
    const verificationSecret = this.verificationSecrets.find(
      candidate => digest(candidate) === receipt.authorityKeyDigest,
    );
    if (receipt.authorityTier !== this.tier || !verificationSecret
      || this.revokedKeyDigests.has(receipt.authorityKeyDigest)) return false;
    const expected = Buffer.from(this.sign(unsignedReceipt(receipt), verificationSecret), 'hex');
    const actual = Buffer.from(receipt.signature, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private sign(value: unknown, secret = this.secret): string {
    return createHmac('sha256', secret).update(canonical(value)).digest('hex');
  }
}

/** Test authority is cryptographically bound but can never claim production tier. */
export function createTestReceiptAuthority(secret: string): LiminalReceiptAuthority {
  return new HmacReceiptAuthority(secret, 'test-proof');
}

export function createRotatingTestReceiptAuthority(input: {
  readonly currentSecret: string;
  readonly verificationSecrets: readonly string[];
  readonly revokedKeyDigests?: readonly string[];
}): LiminalReceiptAuthority {
  if (!input.verificationSecrets.includes(input.currentSecret)) {
    throw new Error('CURRENT_RECEIPT_SIGNER_NOT_IN_KEYRING');
  }
  return new HmacReceiptAuthority(input.currentSecret, 'test-proof',
    input.verificationSecrets, new Set(input.revokedKeyDigests ?? []));
}

/** Bootstrap the one host-held production authority; test helpers cannot upgrade tiers. */
export async function bootstrapProductionReceiptAuthority(
  keyFile: string,
): Promise<LiminalReceiptAuthority> {
  if (!path.isAbsolute(keyFile)) throw new Error('Production receipt key path must be absolute');
  const canonicalKeyFile = path.join(os.homedir(), '.sinter', 'authority',
    'liminal-command-receipt.key');
  if (path.resolve(keyFile) !== canonicalKeyFile) {
    throw new Error('Production receipt key path is not host canonical');
  }
  let secret: string;
  try {
    secret = (await readFile(keyFile, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path.dirname(keyFile), { recursive: true });
    secret = randomBytes(32).toString('hex');
    await writeFileAtomic(keyFile, `${secret}\n`, { mode: 0o600 });
  }
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Production receipt key is invalid');
  return new HmacReceiptAuthority(secret, 'production', [secret], new Set(),
    await bootstrapProductionCreativeAdmissionSigner(keyFile));
}

export interface LiminalDomainDecisionAuthority {
  decide(input: { mode: LiminalEvalMode; evidence: BoundRenderedEvidence;
    evaluation: EvaluatorResult; expectedRenderer: string;
    expectedEvaluator: string;
    renderAuthorization: LiminalCreativeCommand['renderAuthorization'] }): AdmissionEvaluation;
}

interface LiminalCommandServiceOptions {
  readonly effects: LiminalCommandEffects;
  readonly artifacts: LiminalArtifactStore;
  readonly journal: LiminalOperationJournal;
  readonly authority: LiminalReceiptAuthority;
  readonly domainAuthority?: LiminalDomainDecisionAuthority;
  readonly verifyActionAuthority?: (input: Readonly<{
    /** Which child action the digest must authorize; a reevaluate grant never covers a re-render. */
    action: 'reevaluate' | 'rerender-reevaluate';
    digest: string; parent: LiminalAuthorityReceipt;
    /** reevaluate: the supplied evidence. rerender-reevaluate: the parent evidence it replaces. */
    evidenceDigest: string;
    maxTransportAttempts: 1;
  }>) => boolean;
  readonly idFactory?: () => string;
}

function resolvedRoles(command: LiminalCreativeCommand): Readonly<Record<LiminalRole, string>> {
  return Object.freeze({
    generator: command.generatorOverride?.trim() || command.roles.generator,
    evaluator: command.roles.evaluator,
    harness: command.roles.harness,
    studio: command.roles.studio,
  });
}

function validateCommand(command: LiminalCreativeCommand): void {
  if (command.schema !== 'sinter.liminal-command' || command.schemaVersion !== 1) {
    throw new Error('Unsupported Liminal command schema');
  }
  if (!command.idempotencyKey.trim() || !command.prompt.trim() || !command.domain.trim()) {
    throw new Error('Liminal command requires idempotency key, prompt, and domain');
  }
  if (command.layers.length < 1 || !command.layers.every(layer => layer.trim())) {
    throw new Error('Liminal command requires at least one named creative layer');
  }
  if (!/^[0-9a-f]{40}$/.test(command.canonicalMainSha)
    || !/^[0-9a-f]{64}$/.test(command.authorityPackageDigest)) {
    throw new Error('Liminal command requires frozen main and authority package digests');
  }
  if (command.safeMode === 'governed-production'
    && !/^[0-9a-f]{40}$/.test(command.sourceHeadSha ?? '')) {
    throw new Error('Governed production requires an exact source HEAD');
  }
  if (command.safeMode === 'c0-no-empirical-teaching' && command.teaching) {
    throw new Error('C0 command cannot consume teaching');
  }
  if (!Number.isSafeInteger(command.maxTransportAttempts) || command.maxTransportAttempts < 1) {
    throw new Error('Transport attempt maximum must be a positive integer');
  }
}

function decideAdmission(
  mode: LiminalEvalMode,
  renderAuthorization: LiminalCreativeCommand['renderAuthorization'],
  evidence: BoundRenderedEvidence,
  evaluation: EvaluatorResult,
  expectedRenderer: string,
  expectedEvaluator: string,
): AdmissionEvaluation {
  const reasons: string[] = [];
  if (mode === 'legacy' || evidence.evidenceDigest === null) reasons.push('rendered-evidence-required');
  if (evidence.status !== 'rendered') reasons.push(`rendered-evidence-${evidence.status}`);
  if (evaluation.degraded) reasons.push('evaluation-degraded');
  if (!evaluation.identityValid) reasons.push('evaluator-identity-invalid');
  if (evaluation.evaluatorIdentity !== expectedEvaluator) reasons.push('evaluator-identity-mismatch');
  if (evidence.rendererIdentity !== expectedRenderer) reasons.push('renderer-identity-mismatch');
  if (evidence.runtimeErrors.length > 0) reasons.push('render-runtime-errors');
  if (renderAuthorization === 'isolated-playwright' && (!evidence.containment
    || !evidence.containment.networkIsolated || !evidence.containment.permissionsDenied
    || !evidence.containment.cleanupSucceeded)) {
    reasons.push('render-containment-invalid');
  }
  if (evaluation.evidenceDigest !== evidence.evidenceDigest) reasons.push('evidence-digest-mismatch');
  if (evidence.audio.relevant && evidence.audio.state !== 'audible') reasons.push('audio-playback-unproven');
  if (evidence.audio.relevant && evidence.audio.floorFailure) reasons.push('audio-floor-failed');
  return Object.freeze({ ...evaluation, admissionEligible: reasons.length === 0,
    rejectionReasons: Object.freeze(reasons) });
}

export class RenderedAdmissionAuthority implements LiminalDomainDecisionAuthority {
  decide(input: { mode: LiminalEvalMode; evidence: BoundRenderedEvidence;
    evaluation: EvaluatorResult; expectedRenderer: string;
    expectedEvaluator: string;
    renderAuthorization: LiminalCreativeCommand['renderAuthorization'] }): AdmissionEvaluation {
    return decideAdmission(input.mode, input.renderAuthorization, input.evidence, input.evaluation,
      input.expectedRenderer, input.expectedEvaluator);
  }
}

function artifactRoot(artifacts: PersistedArtifacts): string {
  return digest({
    sourceDigest: artifacts.sourceDigest,
    playableDigest: artifacts.playableDigest,
    provenanceDigest: artifacts.provenanceDigest,
  });
}

function providerInputBound(command: LiminalCreativeCommand, actual: string): boolean {
  return [digest(command.prompt), digest({ prompt: command.prompt, domain: command.domain,
    layers: command.layers, empiricalContextDigests: [] })].includes(actual);
}

function createTransportGrant(authority: LiminalReceiptAuthority,
  reservation: LiminalEffectReservation, purpose: ProductTransportPurpose,
  role: LiminalRole): LiminalProductTransportGrant {
  const scope = Object.freeze({
    schema: 'sinter.product-transport-scope' as const,
    schemaVersion: 1 as const,
    operationId: reservation.operationId,
    effectId: reservation.effectId,
    reservationDigest: digest(reservation),
    purpose,
    role,
  });
  return Object.freeze({ scope, proof: sealInternalAdmission(authority, scope) });
}

const INFRA_RENDER_ERROR = /failed to initialize headless browser|browser context not initialized|executable|sandbox unavailable|playwright|chromium|browser|spawn|econnrefused/i;

/**
 * Why a run that never reached the evaluator has no score: the render
 * machinery was unavailable (`infra`), or the piece did not render (`render`).
 * Both are existing LoopConfig classes; before this the line read
 * `failureClass=unknown` (#1603).
 */
export function unscoredFailureClass(
  evidence: Pick<BoundRenderedEvidence, 'status' | 'runtimeErrors'>,
): 'infra' | 'render' {
  if (evidence.status === 'missing') return 'infra';
  return evidence.runtimeErrors.some(error => INFRA_RENDER_ERROR.test(error)) ? 'infra' : 'render';
}

function canEvaluateRenderedEvidence(
  command: LiminalCreativeCommand,
  evidence: BoundRenderedEvidence,
): boolean {
  const containmentValid = command.renderAuthorization !== 'isolated-playwright'
    || Boolean(evidence.containment?.networkIsolated
      && evidence.containment.permissionsDenied && evidence.containment.cleanupSucceeded);
  return evidence.status === 'rendered'
    && evidence.evidenceDigest !== null
    && evidence.rendererIdentity === command.rendererIdentity
    && evidence.runtimeErrors.length === 0
    && containmentValid
    && (!evidence.audio.relevant || evidence.audio.state === 'audible');
}

/** Thin product composition root; domain authorities remain behind injected ports. */
export class LiminalCommandService {
  private readonly broker: LiminalEffectBroker;
  private readonly projector: LiminalReceiptProjector;
  private readonly kernel: LiminalOperationKernel;
  private readonly domainAuthority: LiminalDomainDecisionAuthority;

  constructor(private readonly options: LiminalCommandServiceOptions) {
    this.broker = new LiminalEffectBroker(options.journal);
    this.projector = new LiminalReceiptProjector(options.journal, options.authority);
    this.kernel = new LiminalOperationKernel(
      options.journal, options.authority, options.idFactory ?? (() => randomUUID()),
    );
    this.domainAuthority = options.domainAuthority ?? new RenderedAdmissionAuthority();
  }

  verifyReceipt(receipt: LiminalAuthorityReceipt): boolean {
    return this.options.authority.verify(receipt);
  }

  async readVerifiedResult(idempotencyKey: string,
    expectedCommand?: LiminalCreativeCommand): Promise<LiminalCommandResult> {
    const result = await this.options.journal.findByIdempotencyKey(idempotencyKey);
    if (!result || !this.verifyReceipt(result.receipt)
      || result.receipt.operationId !== result.operationId
      || result.receipt.lineageId !== result.lineageId) {
      throw new Error('LIMINAL_RESULT_AUTHORITY_INVALID');
    }
    const events = await this.options.journal.eventsForOperation(result.operationId);
    const signedEvents = events.filter(event => event.type !== 'receipt-projected'
      && event.type !== 'domain-projection-linked');
    const commandBound = !expectedCommand
      || digest(expectedCommand) === result.receipt.commandDigest;
    const domain = result.domain || expectedCommand?.domain;
    const domainBound = Boolean(domain) && events.some(event => event.type === 'domain-authorized'
      && [digest({ domain }), liminalDurablePayloadDigest({ domain })]
        .includes(event.payloadDigest));
    const expectedBindings = !expectedCommand || (
      canonical(result.roles) === canonical(resolvedRoles(expectedCommand))
      && result.evidence.rendererIdentity === expectedCommand.rendererIdentity
      && result.evaluation.evaluatorIdentity === resolvedRoles(expectedCommand).evaluator
      && providerInputBound(expectedCommand, result.receipt.providerInputDigest));
    if (rebuildOperationTrace(signedEvents) !== result.receipt.operationTraceDigest
      || !commandBound || !result.domain || !domainBound || !expectedBindings
      || (expectedCommand !== undefined && domain !== expectedCommand.domain)
      || !events.some(event => event.type === 'render-observed'
        && [digest(result.evidence), liminalDurablePayloadDigest(result.evidence)]
          .includes(event.payloadDigest))
      || !events.some(event => event.type === 'evaluation-decided'
        && [digest(result.evaluation), liminalDurablePayloadDigest(result.evaluation)]
          .includes(event.payloadDigest))) {
      throw new Error('LIMINAL_RESULT_TRACE_INVALID');
    }
    return result;
  }

  linkDreamProjection(operationId: string, projectionDigest: string): Promise<void> {
    return this.options.journal.linkProjection(operationId, 'dream', projectionDigest);
  }

  async runJudgmentEffect<T>(input: { idempotencyKey: string; binding: unknown;
    identity: string; role: LiminalRole; maxTransportAttempts: 1;
    effect: () => Promise<T> }): Promise<T> {
    const purpose = productPurposeForRole(input.role);
    if (!purpose) throw new Error('LIMINAL_PRODUCT_TRANSPORT_ROLE_INVALID');
    const admission = await this.kernel.beginRoot(input.idempotencyKey, digest(input.binding));
    return this.broker.invoke({ operationId: admission.operationId, kind: 'judgment',
      authority: { identity: input.identity, bindingDigest: digest(input.binding) },
      effect: reservation => withLiminalProductTransportAuthority(
        createTransportGrant(this.options.authority, reservation, purpose, input.role), async () => {
        await this.options.journal.reserveTransportAttempt(admission.operationId,
          input.maxTransportAttempts, { kind: 'judgment', identity: input.identity });
        try {
          return await withProviderAttemptGuard(() => {
            // Guard registered for diagnostics; true nesting protection is enforced
            // by the executor attestation reservation/completion flow in LLMClient.
          }, input.effect);
        } catch (error) {
          await this.options.journal.failTransportAttempt(admission.operationId, error);
          throw error;
        }
      }) });
  }

  async readVerifiedArtifact(result: LiminalCommandResult): Promise<GeneratedArtifact> {
    if (!this.verifyReceipt(result.receipt)
      || artifactRoot(result.artifacts) !== result.receipt.artifactDigest) {
      throw new Error('LIMINAL_ARTIFACT_RECEIPT_INVALID');
    }
    const artifact = await this.options.artifacts.read(result.operationId);
    if (!artifact || digest(artifact.source) !== result.artifacts.sourceDigest
      || digest(artifact.playable) !== result.artifacts.playableDigest
      || digest(artifact.provenance) !== result.artifacts.provenanceDigest) {
      throw new Error('LIMINAL_ARTIFACT_DIGEST_MISMATCH');
    }
    return artifact;
  }

  async restoreVerifiedArtifact(parent: LiminalCommandResult,
    result: LiminalCommandResult): Promise<void> {
    const artifact = await this.readVerifiedArtifact(parent);
    if (!this.verifyReceipt(result.receipt)
      || result.receipt.artifactDigest !== parent.receipt.artifactDigest
      || canonical(result.artifacts) !== canonical(parent.artifacts)) {
      throw new Error('LIMINAL_ARTIFACT_RECEIPT_INVALID');
    }
    const persisted = await this.options.artifacts.persist(result.operationId, artifact);
    if (canonical(persisted) !== canonical(result.artifacts)) {
      throw new Error('LIMINAL_ARTIFACT_DIGEST_MISMATCH');
    }
  }

  async readVerifiedRenderedEvidence(result: LiminalCommandResult): Promise<void> {
    if (!this.verifyReceipt(result.receipt)) throw new Error('LIMINAL_EVIDENCE_RECEIPT_INVALID');
    const evidence = await this.options.artifacts.readRenderedEvidence?.(result.operationId);
    if (!evidence || evidence.earlyFrameDigest !== result.evidence.earlyFrameDigest
      || evidence.lateFrameDigest !== result.evidence.lateFrameDigest
      || result.receipt.evidenceDigest !== result.evidence.evidenceDigest) {
      throw new Error('LIMINAL_RENDERED_EVIDENCE_DIGEST_MISMATCH');
    }
  }

  async restoreVerifiedRenderedEvidence(result: LiminalCommandResult,
    observation: RenderedObservation): Promise<void> {
    if (!this.verifyReceipt(result.receipt)) throw new Error('LIMINAL_EVIDENCE_RECEIPT_INVALID');
    const evidence = bindEvidence(observation);
    const persistedShape = JSON.parse(JSON.stringify(evidence)) as BoundRenderedEvidence;
    const receiptShape = JSON.parse(JSON.stringify(result.evidence)) as BoundRenderedEvidence;
    if (canonical(persistedShape) !== canonical(receiptShape)
      || evidence.evidenceDigest !== result.receipt.evidenceDigest) {
      throw new Error('LIMINAL_RENDERED_EVIDENCE_DIGEST_MISMATCH');
    }
    const persisted = await this.options.artifacts.persistRenderedEvidence(
      result.operationId, observation);
    if (persisted.earlyFrameDigest !== result.evidence.earlyFrameDigest
      || persisted.lateFrameDigest !== result.evidence.lateFrameDigest) {
      throw new Error('LIMINAL_RENDERED_EVIDENCE_DIGEST_MISMATCH');
    }
  }

  sealOwnerReviewAdmission(value: unknown): CreativeAdmissionProof {
    const schema = value && typeof value === 'object'
      ? (value as { schema?: unknown }).schema : undefined;
    if (!['sinter.creative-label-admission', 'sinter.routing-outcome-admission',
      'sinter.exploration-decision-admission'].includes(String(schema))) {
      throw new Error('OWNER_REVIEW_ADMISSION_SCHEMA_FORBIDDEN');
    }
    return sealInternalAdmission(this.options.authority, value);
  }

  async execute(command: LiminalCreativeCommand): Promise<LiminalCommandResult> {
    validateCommand(command);
    const roles = resolvedRoles(command);
    const commandDigest = digest(command);
    const admission = await this.kernel.beginRoot(command.idempotencyKey, commandDigest);
    const prior = await this.options.journal.findByIdempotencyKey(command.idempotencyKey);
    if (prior) return prior;
    const { operationId, lineageId } = admission;
    await this.options.journal.authorizeDomain(operationId, command.domain);
    const providerInputDigest = digest(command.prompt);

    const generated = await this.broker.invoke({
      operationId, kind: 'generation', authority: { identity: roles.generator },
      effect: reservation => withLiminalProductTransportAuthority(
        createTransportGrant(this.options.authority, reservation, 'generation', 'generator'),
        () => this.options.effects.generate({
        prompt: command.prompt,
        identity: roles.generator,
        domain: command.domain,
        startTransport: payload => this.options.journal.reserveTransportAttempt(
          operationId, command.maxTransportAttempts,
          { kind: 'generation', identity: roles.generator, ...(payload as object | undefined) },
        ),
        failTransport: reason => this.options.journal.failTransportAttempt(operationId, reason),
      })),
    });
    const artifacts = await this.options.artifacts.persist(operationId, generated);
    await this.options.journal.append(operationId, 'artifacts-persisted', artifacts);

    const observation = await this.broker.invoke({
      operationId, kind: 'render', authority: { rendererIdentity: command.rendererIdentity },
      effect: () => this.options.effects.render({
        playable: generated.playable,
        domain: command.domain,
      }),
    });
    const evidence = bindEvidence(observation);
    const persistedEvidence = await this.options.artifacts.persistRenderedEvidence(
      operationId, observation);
    if (persistedEvidence.earlyFrameDigest !== evidence.earlyFrameDigest
      || persistedEvidence.lateFrameDigest !== evidence.lateFrameDigest) {
      throw new Error('LIMINAL_RENDERED_EVIDENCE_DIGEST_MISMATCH');
    }
    await this.options.journal.append(operationId, 'render-observed', evidence);

    // #925 COMPILE GATE: fatal shader-compile evidence means this artifact is
    // an error screen, not art — reject before evaluation/save. (The repair
    // chance is generate's smoke render, which feeds compile logs back first.)
    // Placed HERE, not only in effects.evaluate: evidence with runtimeErrors
    // never reaches evaluate (canEvaluateRenderedEvidence requires zero
    // errors), which is exactly how compile-error screens shipped as 1.0 art.
    const fatalShader = fatalShaderEvidence(command.domain, evidence.runtimeErrors);
    if (fatalShader) {
      throw new Error(
        `LIMINAL_GENERATION_INVALID:${command.domain}:shader-compile:${fatalShader}`);
    }

    let rawEvaluation: EvaluatorResult;
    if (command.evalMode === 'legacy') {
      rawEvaluation = await this.broker.invoke({
        operationId, kind: 'evaluation', authority: { identity: roles.evaluator },
        effect: reservation => withLiminalProductTransportAuthority(
          createTransportGrant(this.options.authority, reservation, 'evaluation', 'evaluator'),
          () => this.options.effects.evaluate({
          observation, domain: command.domain, source: generated.source, prompt: command.prompt,
          evidenceDigest: null, identity: roles.evaluator,
          startTransport: payload => this.options.journal.reserveTransportAttempt(
            operationId, command.maxTransportAttempts,
            { kind: 'evaluation', identity: roles.evaluator, ...(payload as object | undefined) },
          ),
          failTransport: reason => this.options.journal.failTransportAttempt(operationId, reason),
        })),
      });
    } else if (canEvaluateRenderedEvidence(command, evidence)) {
      rawEvaluation = await this.broker.invoke({
        operationId, kind: 'evaluation', authority: { identity: roles.evaluator },
        effect: reservation => withLiminalProductTransportAuthority(
          createTransportGrant(this.options.authority, reservation, 'evaluation', 'evaluator'),
          () => this.options.effects.evaluate({
          observation, domain: command.domain, source: generated.source, prompt: command.prompt,
          evidenceDigest: evidence.evidenceDigest, identity: roles.evaluator,
          startTransport: payload => this.options.journal.reserveTransportAttempt(
            operationId, command.maxTransportAttempts,
            { kind: 'evaluation', identity: roles.evaluator, ...(payload as object | undefined) },
          ),
          failTransport: reason => this.options.journal.failTransportAttempt(operationId, reason),
        })),
      });
    } else {
      rawEvaluation = {
        score: 0,
        degraded: true,
        failureClass: unscoredFailureClass(evidence),
        identityValid: true,
        evaluatorIdentity: roles.evaluator,
        evidenceDigest: evidence.evidenceDigest,
      };
    }
    const evaluation = this.domainAuthority.decide({ mode: command.evalMode,
      evidence, evaluation: rawEvaluation, expectedRenderer: command.rendererIdentity,
      expectedEvaluator: roles.evaluator, renderAuthorization: command.renderAuthorization });
    await this.options.journal.append(operationId, 'domain-decided', {
      domain: command.domain, admissionEligible: evaluation.admissionEligible,
      rejectionReasons: evaluation.rejectionReasons,
    });
    await this.options.journal.append(operationId, 'evaluation-decided', evaluation);

    const receipt = await this.projector.project({
      operationId,
      lineageId,
      commandDigest,
      providerInputDigest,
      artifactDigest: artifactRoot(artifacts),
      evidenceDigest: evidence.evidenceDigest,
      disabledTeachingReaders: DISABLED_TEACHING_READERS,
      empiricalContextDigests: Object.freeze(command.safeMode === 'governed-production'
        && command.teaching?.snapshotDigest ? [command.teaching.snapshotDigest] : []),
      // C0 proves perception only. Owner acceptance is a separate product action,
      // so this command can never authorize learning by itself.
      learningEligible: false,
    });
    await this.options.journal.append(operationId, 'receipt-projected', {
      authorityTier: receipt.authorityTier,
      signature: receipt.signature,
    });
    const result = Object.freeze({
      operationId,
      lineageId,
      domain: command.domain,
      roles,
      artifacts,
      evidence,
      evaluation,
      attempts: Object.freeze({
        consumed: await this.options.journal.attemptsConsumed(operationId),
        maximum: command.maxTransportAttempts,
      }),
      receipt,
    });
    await this.options.journal.bindResult(command.idempotencyKey, result);
    return result;
  }

  /** Re-evaluate the exact persisted artifact and frame bytes without regenerating. */
  async reevaluate(
    command: LiminalCreativeCommand,
    prior: LiminalCommandResult,
    observation: RenderedObservation,
    spec: LiminalReevaluationSpec,
    evidenceSource: LiminalCommandResult = prior,
  ): Promise<LiminalCommandResult> {
    validateCommand(command);
    const roles = resolvedRoles(command);
    this.assertReevaluationParent(command, prior, evidenceSource, roles);
    await this.readVerifiedArtifact(prior);
    if (!/^[0-9a-f]{64}$/.test(spec.actionAuthorityDigest)) {
      throw new Error('REEVALUATION_ACTION_AUTHORITY_INVALID');
    }
    const evidence = bindEvidence(observation);
    if (!canEvaluateRenderedEvidence(command, evidence)
      || evidence.evidenceDigest !== evidenceSource.receipt.evidenceDigest) {
      throw new Error('REEVALUATION_RENDERED_EVIDENCE_INVALID');
    }
    this.assertChildActionAuthority('reevaluate', prior, evidence.evidenceDigest!, spec);
    const existing = await this.options.journal.findByIdempotencyKey(spec.idempotencyKey);
    if (existing) return this.readVerifiedResult(spec.idempotencyKey, command);
    const admission = await this.kernel.beginChild(spec.idempotencyKey,
      digest({ kind: 'reevaluate-candidate', parent: prior.receipt.signature,
        evidenceDigest: evidence.evidenceDigest,
        actionAuthorityDigest: spec.actionAuthorityDigest }), prior.receipt);
    await this.options.journal.authorizeDomain(admission.operationId, command.domain);
    await this.persistObservedEvidence(admission.operationId, observation, evidence);
    return this.judgeChild(command, prior, roles, spec, admission.operationId,
      observation, evidence);
  }

  /**
   * Re-render the exact persisted artifact on the current renderer, then judge the fresh
   * evidence once (#1645). This is how a verified artifact gets re-judged after a renderer
   * or judging fix: plain reevaluate only accepts the parent's own evidence bytes.
   * The artifact, lineage and command stay bound to the parent; only the evidence is new.
   * The parent evidence digest is bound into the admission (and the parent receipt the
   * child begins from); the new one is in render-observed and the child receipt.
   */
  async rerenderAndReevaluate(
    command: LiminalCreativeCommand,
    prior: LiminalCommandResult,
    spec: LiminalReevaluationSpec,
  ): Promise<LiminalCommandResult> {
    validateCommand(command);
    const roles = resolvedRoles(command);
    this.assertReevaluationParent(command, prior, prior, roles);
    // A parent never bound to rendered evidence has nothing to replace.
    const parentEvidenceDigest = prior.receipt.evidenceDigest;
    if (!parentEvidenceDigest) throw new Error('REEVALUATION_PARENT_AUTHORITY_INVALID');
    const artifact = await this.readVerifiedArtifact(prior);
    if (!/^[0-9a-f]{64}$/.test(spec.actionAuthorityDigest)) {
      throw new Error('REEVALUATION_ACTION_AUTHORITY_INVALID');
    }
    // Authorized before the render: the grant names the parent evidence it replaces.
    this.assertChildActionAuthority('rerender-reevaluate', prior, parentEvidenceDigest, spec);
    const existing = await this.options.journal.findByIdempotencyKey(spec.idempotencyKey);
    if (existing) return this.readVerifiedResult(spec.idempotencyKey, command);
    const admission = await this.kernel.beginChild(spec.idempotencyKey,
      digest({ kind: 'rerender-reevaluate-candidate', parent: prior.receipt.signature,
        parentEvidenceDigest,
        actionAuthorityDigest: spec.actionAuthorityDigest }), prior.receipt);
    await this.options.journal.authorizeDomain(admission.operationId, command.domain);
    const observation = await this.broker.invoke({
      operationId: admission.operationId, kind: 'render',
      authority: { rendererIdentity: command.rendererIdentity },
      effect: () => this.options.effects.render({
        playable: artifact.playable,
        domain: command.domain,
      }),
    });
    const evidence = bindEvidence(observation);
    if (!canEvaluateRenderedEvidence(command, evidence)) {
      throw new Error('REEVALUATION_RENDERED_EVIDENCE_INVALID');
    }
    await this.persistObservedEvidence(admission.operationId, observation, evidence);
    return this.judgeChild(command, prior, roles, spec, admission.operationId,
      observation, evidence);
  }

  private assertReevaluationParent(command: LiminalCreativeCommand,
    prior: LiminalCommandResult, evidenceSource: LiminalCommandResult,
    roles: Readonly<Record<LiminalRole, string>>): void {
    const legacyDomain = (prior as Partial<LiminalCommandResult>).domain;
    if (!this.verifyReceipt(prior.receipt)
      || prior.receipt.operationId !== prior.operationId
      || prior.receipt.lineageId !== prior.lineageId
      || prior.receipt.commandDigest !== digest(command)
      || !providerInputBound(command, prior.receipt.providerInputDigest)
      || prior.receipt.artifactDigest !== artifactRoot(prior.artifacts)
      || prior.receipt.evidenceDigest !== prior.evidence.evidenceDigest
      || prior.receipt.learningEligible
      || (legacyDomain !== undefined && legacyDomain !== command.domain)
      || canonical(prior.roles) !== canonical(roles)
      || !this.verifyReceipt(evidenceSource.receipt)
      || evidenceSource.receipt.operationId !== evidenceSource.operationId
      || evidenceSource.receipt.lineageId !== prior.lineageId
      || evidenceSource.receipt.commandDigest !== prior.receipt.commandDigest
      || evidenceSource.receipt.artifactDigest !== prior.receipt.artifactDigest
      || !providerInputBound(command, evidenceSource.receipt.providerInputDigest)
      || evidenceSource.receipt.evidenceDigest !== evidenceSource.evidence.evidenceDigest
      || evidenceSource.receipt.learningEligible
      || canonical(evidenceSource.roles) !== canonical(roles)
      || evidenceSource.evidence.rendererIdentity !== command.rendererIdentity) {
      throw new Error('REEVALUATION_PARENT_AUTHORITY_INVALID');
    }
  }

  private assertChildActionAuthority(action: 'reevaluate' | 'rerender-reevaluate',
    prior: LiminalCommandResult, evidenceDigest: string, spec: LiminalReevaluationSpec): void {
    if (this.options.authority.tier === 'production'
      && (!this.options.verifyActionAuthority || !this.options.verifyActionAuthority({
        action, digest: spec.actionAuthorityDigest, parent: prior.receipt,
        evidenceDigest, maxTransportAttempts: spec.maxTransportAttempts,
      }))) {
      throw new Error('REEVALUATION_ACTION_AUTHORITY_INVALID');
    }
  }

  private async persistObservedEvidence(operationId: string,
    observation: RenderedObservation, evidence: ReturnType<typeof bindEvidence>): Promise<void> {
    const persistedEvidence = await this.options.artifacts.persistRenderedEvidence(
      operationId, observation);
    if (persistedEvidence.earlyFrameDigest !== evidence.earlyFrameDigest
      || persistedEvidence.lateFrameDigest !== evidence.lateFrameDigest) {
      throw new Error('LIMINAL_RENDERED_EVIDENCE_DIGEST_MISMATCH');
    }
    await this.options.journal.append(operationId, 'render-observed', evidence);
  }

  /** One evaluator transport on bound child evidence, then a never-learning-eligible receipt. */
  private async judgeChild(command: LiminalCreativeCommand, prior: LiminalCommandResult,
    roles: Readonly<Record<LiminalRole, string>>, spec: LiminalReevaluationSpec,
    operationId: string, observation: RenderedObservation,
    evidence: ReturnType<typeof bindEvidence>): Promise<LiminalCommandResult> {
    const rawEvaluation = await this.broker.invoke({
      operationId, kind: 'evaluation',
      authority: { identity: roles.evaluator },
      effect: reservation => withLiminalProductTransportAuthority(
        createTransportGrant(this.options.authority, reservation, 'evaluation', 'evaluator'),
        () => this.options.effects.evaluate({
        observation, domain: command.domain, prompt: command.prompt, evidenceDigest: evidence.evidenceDigest,
        identity: roles.evaluator,
        startTransport: payload => this.options.journal.reserveTransportAttempt(
          operationId, spec.maxTransportAttempts,
          { kind: 'evaluation', identity: roles.evaluator, ...(payload as object | undefined) },
        ),
        failTransport: reason => this.options.journal.failTransportAttempt(operationId, reason),
      })),
    });
    const evaluation = this.domainAuthority.decide({ mode: command.evalMode,
      evidence, evaluation: rawEvaluation, expectedRenderer: command.rendererIdentity,
      expectedEvaluator: roles.evaluator,
      renderAuthorization: command.renderAuthorization });
    await this.options.journal.append(operationId, 'domain-decided', {
      domain: command.domain, admissionEligible: evaluation.admissionEligible,
      rejectionReasons: evaluation.rejectionReasons,
    });
    await this.options.journal.append(operationId, 'evaluation-decided', evaluation);
    const receipt = await this.projector.project({
      operationId,
      lineageId: prior.lineageId,
      commandDigest: prior.receipt.commandDigest,
      providerInputDigest: prior.receipt.providerInputDigest,
      artifactDigest: prior.receipt.artifactDigest,
      evidenceDigest: evidence.evidenceDigest,
      actionAuthorityDigest: spec.actionAuthorityDigest,
      disabledTeachingReaders: prior.receipt.disabledTeachingReaders,
      empiricalContextDigests: prior.receipt.empiricalContextDigests,
      // Re-evaluation repairs evidence judgment; it does not manufacture owner acceptance.
      learningEligible: false,
    });
    await this.options.journal.append(operationId, 'receipt-projected', {
      authorityTier: receipt.authorityTier, signature: receipt.signature,
    });
    const result = Object.freeze({ operationId,
      lineageId: prior.lineageId, domain: command.domain,
      roles, artifacts: prior.artifacts,
      evidence, evaluation, attempts: Object.freeze({
        consumed: await this.options.journal.attemptsConsumed(operationId),
        maximum: spec.maxTransportAttempts,
      }), receipt });
    await this.options.journal.bindResult(spec.idempotencyKey, result);
    return result;
  }
}
