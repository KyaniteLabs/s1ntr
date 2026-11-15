import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import type { LiminalCommandResult, LiminalCommandService,
  LiminalCreativeCommand, RenderedObservation } from './LiminalCommandService.js';
import type { KnowledgeApplicationReceipt } from
  '../dreaming/research/DreamKnowledgeActivation.js';
import { createCreativeLabelAdmission, validateCreativeLabelAdmission,
  type CreativeLabelAdmission } from
  '../learning/CreativeLabelAdmission.js';
import { createRoutingOutcomeAdmission, validateRoutingOutcomeAdmission,
  type RoutingOutcomeAdmission } from
  '../routing/RoutingOutcomeAdmission.js';
import { createExplorationDecisionAdmission, validateExplorationDecisionAdmission,
  type ExplorationDecisionAdmission } from
  '../evolution/ExplorationDecisionAdmission.js';
import type { CreativeAdmissionSigner } from './CreativeAdmissionAuthority.js';
import { enforceProductionAuthorityEntrypoints } from './ProductionAuthorityRegistry.js';
import { scanProductionEntrypointAuthorityLocators }
  from './ProductionAuthorityScanner.js';

export type LiminalCreateSurface = 'cli' | 'studio' | 'chat' | 'campaign';
export type LiminalProposalSurface = 'cortex' | 'gardener' | 'daemon' | 'scheduler';

export interface VerifiedLiminalOwnerEvidence {
  readonly createKey: string;
  readonly ownerReviewKey: string;
  readonly operationId: string;
  readonly lineageId: string;
  readonly createCommandDigest: string;
  readonly createReceiptDigest: string;
  readonly reviewCommandDigest: string;
  readonly reviewDecisionDigest: string;
  readonly reviewReceiptDigest: string;
  readonly artifactDigest: string;
  readonly evidenceDigest: string;
  readonly criterionDigest: string;
  readonly domain: string;
  readonly quality: number;
  readonly decision: 'accepted';
}

export interface LiminalCommandProposal {
  readonly schema: 'sinter.liminal-proposal';
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly requestedKind: 'generate-candidate';
  readonly briefDigest: string;
  readonly authorityDigest: string;
}

export interface LiminalOwnerReviewCommand {
  readonly schema: 'sinter.liminal-owner-review-command';
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly createIdempotencyKey: string;
  readonly operationId: string;
  readonly artifactRootDigest: string;
  readonly evidenceRootDigest: string;
  readonly decision: 'accepted' | 'rejected';
  readonly feedback: string;
  readonly criterionDigest: string;
}

export interface LiminalReevaluationProjectionCommand {
  readonly idempotencyKey: string;
  readonly parentCreateIdempotencyKey: string;
  readonly reevaluationIdempotencyKey: string;
  readonly parentCommand: LiminalCreativeCommand;
  readonly renderedEvidence: RenderedObservation;
}

export interface LiminalOwnerReviewAdmissions {
  readonly creativeLabel: CreativeLabelAdmission;
  readonly routing: RoutingOutcomeAdmission;
  readonly exploration: ExplorationDecisionAdmission;
}

export interface LiminalTeachingReceipt {
  readonly doctrine?: { readonly doctrineDigest: string;
    readonly sourceReviewDigest: string; readonly inputDeltaDigest: string };
  readonly empirical?: KnowledgeApplicationReceipt;
  readonly preProviderInputDigest: string;
  readonly finalProviderInputDigest: string;
  readonly compilationDigest: string;
}

export type LiminalProductProjection =
  | { readonly kind: 'create'; readonly status: 'completed';
      readonly commandDigest: string; readonly result: LiminalCommandResult;
      readonly teachingReceipt?: LiminalTeachingReceipt }
  | { readonly kind: 'proposal'; readonly status: 'proposed';
      readonly commandDigest: string; readonly proposal: LiminalCommandProposal }
  | { readonly kind: 'owner-review'; readonly status: 'reviewed';
      readonly commandDigest: string; readonly command: LiminalOwnerReviewCommand;
      readonly receipt: LiminalOwnerReviewReceipt;
      readonly admissions: LiminalOwnerReviewAdmissions };

export interface LiminalProductCommandStore {
  read(key: string): Promise<LiminalProductProjection | null>;
  write(key: string, projection: LiminalProductProjection): Promise<void>;
  withLease?<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export class MemoryLiminalProductCommandStore implements LiminalProductCommandStore {
  private readonly values = new Map<string, LiminalProductProjection>();
  read(key: string): Promise<LiminalProductProjection | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  write(key: string, projection: LiminalProductProjection): Promise<void> {
    this.values.set(key, projection);
    return Promise.resolve();
  }
}

const DEFAULT_LEASE_TIMEOUT_MS = 90_000;

export interface FileLiminalProductCommandStoreOptions {
  /** Max wait for the single-writer lease. Env: LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT_MS. */
  readonly leaseTimeoutMs?: number;
  /** Called once when the lease is busy. Defaults to a stderr message. */
  readonly onLeaseWait?: (holder: string) => void;
}

export class FileLiminalProductCommandStore implements LiminalProductCommandStore {
  private queue = Promise.resolve();
  private readonly leaseTimeoutMs: number;
  private readonly onLeaseWait: (holder: string) => void;
  constructor(private readonly file: string, options: FileLiminalProductCommandStoreOptions = {}) {
    const envTimeout = Number(process.env.LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT_MS);
    this.leaseTimeoutMs = options.leaseTimeoutMs
      ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_LEASE_TIMEOUT_MS);
    this.onLeaseWait = options.onLeaseWait ?? (holder => {
      process.stderr.write(`Waiting for the product store lease held by ${holder} `
        + `(timeout ${Math.round(this.leaseTimeoutMs / 1000)}s; set LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT_MS to change)\n`);
    });
    if (!path.isAbsolute(file)) throw new Error('LIMINAL_PRODUCT_STORE_PATH_NOT_ABSOLUTE');
  }

  private async leaseOwnerAlive(lease: string): Promise<boolean> {
    try {
      const ownerText = await readFile(path.join(lease, 'owner.json'), 'utf8');
      const owner = JSON.parse(ownerText) as { pid?: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid! < 1) return false;
      process.kill(owner.pid!, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  private async leaseHolder(lease: string): Promise<string> {
    try {
      const owner = JSON.parse(await readFile(path.join(lease, 'owner.json'), 'utf8')) as { pid?: number };
      return Number.isSafeInteger(owner.pid) ? `pid ${owner.pid}` : 'unknown holder';
    } catch {
      return 'unknown holder';
    }
  }
  async read(key: string): Promise<LiminalProductProjection | null> {
    await this.queue;
    return (await this.readAll())[key] ?? null;
  }
  write(key: string, projection: LiminalProductProjection): Promise<void> {
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      // Short whole-file lease: re-read and merge under it so another process's key survives.
      await this.holdLease(`${this.file}.lease`, async () => {
        const values = await this.readAll();
        await writeFileAtomic(this.file, `${JSON.stringify({ ...values, [key]: projection }, null, 2)}\n`);
      });
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  /** Per-key operation lease: same key single-flights across processes, other keys run in parallel. */
  withLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const name = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return this.holdLease(path.join(`${this.file}.leases`, `${name}.lease`), operation);
  }
  /** Acquire `lease` (mkdir + owner.json), heartbeat while `operation` runs, then release. */
  private async holdLease<T>(lease: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(lease), { recursive: true });
    const token = randomUUID();
    // Lease cadence (aligned with LiminalCommandFilePersistence 2026-08-30):
    // takeover must be SHORTER than the deadline, or a stale lease can never
    // be reclaimed inside the wait window — every acquire after a crash was a
    // guaranteed timeout (the srv zero-production "missing root" sibling).
    const deadline = Date.now() + this.leaseTimeoutMs;
    let acquired = false;
    let announced = false;
    while (!acquired && Date.now() < deadline) {
      try {
        await mkdir(lease);
        await writeFileAtomic(path.join(lease, 'owner.json'),
          `${JSON.stringify({ token, pid: process.pid })}\n`);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - (await stat(lease)).mtimeMs > 20_000
            && !(await this.leaseOwnerAlive(lease))) {
            await rm(lease, { recursive: true, force: true });
            continue;
          }
        } catch (leaseError) {
          if ((leaseError as NodeJS.ErrnoException).code !== 'ENOENT') throw leaseError;
        }
        if (!announced) {
          announced = true;
          this.onLeaseWait(await this.leaseHolder(lease));
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!acquired) {
      throw new Error(`LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT: lease ${lease} held by `
        + `${await this.leaseHolder(lease)} after ${this.leaseTimeoutMs}ms`);
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lease, now, now).catch(() => undefined);
    }, 10_000);
    heartbeat.unref();
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    clearInterval(heartbeat);
    let releaseError: unknown;
    try {
      const ownerText = await readFile(path.join(lease, 'owner.json'), 'utf8');
      const owner = JSON.parse(ownerText) as { token?: string };
      if (owner.token === token) await rm(lease, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') releaseError = error;
    }
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return result as T;
  }
  private async readAll(): Promise<Record<string, LiminalProductProjection>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    key => `${JSON.stringify(key)}:${canonical(record[key])}`,
  ).join(',')}}`;
}

function commandDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

async function assertLiveProductionAuthorityCensus(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  enforceProductionAuthorityEntrypoints(await scanProductionEntrypointAuthorityLocators(
    packageRoot, ['src/runtime-core/LiminalProductCommandPort.ts']));
}

export interface LiminalOwnerReviewReceipt {
  readonly schema: 'sinter.liminal-owner-review-receipt';
  readonly schemaVersion: 1;
  readonly decisionDigest: string;
  readonly authorityKeyDigest: string;
  readonly signature: string;
}

export interface LiminalOwnerReviewAuthority {
  submit(command: LiminalOwnerReviewCommand): Promise<LiminalOwnerReviewReceipt>;
  verify(command: LiminalOwnerReviewCommand, receipt: LiminalOwnerReviewReceipt): boolean;
}

export interface LiminalTeachingCompiler {
  compile(command: LiminalCreativeCommand): Promise<Readonly<{
    command: LiminalCreativeCommand;
    receipt: LiminalTeachingReceipt;
  }>>;
}

/** The only capability product surfaces receive: submit commands or read projections. */
export class LiminalProductCommandPort {
  private readonly inFlight = new Map<string, Promise<LiminalProductProjection>>();
  constructor(private readonly createAuthority: Pick<LiminalCommandService,
    'execute' | 'verifyReceipt' | 'sealOwnerReviewAdmission' | 'readVerifiedArtifact'
    | 'restoreVerifiedArtifact' | 'readVerifiedRenderedEvidence'
    | 'restoreVerifiedRenderedEvidence'
    | 'readVerifiedResult' | 'linkDreamProjection' | 'runJudgmentEffect'>,
    private readonly reviewAuthority?: LiminalOwnerReviewAuthority,
    private readonly store: LiminalProductCommandStore = new MemoryLiminalProductCommandStore(),
    private readonly teachingCompiler?: LiminalTeachingCompiler) {}

  async submitCreate(surface: LiminalCreateSurface,
    command: LiminalCreativeCommand): Promise<LiminalProductProjection> {
    if (!['cli', 'studio', 'chat', 'campaign'].includes(surface)) {
      throw new Error('LIMINAL_SURFACE_CREATE_FORBIDDEN');
    }
    await assertLiveProductionAuthorityCensus();
    return this.settle(command.idempotencyKey, command, async digest => {
      if (command.teaching && !this.teachingCompiler) {
        throw new Error('LIMINAL_TEACHING_COMPILER_REQUIRED');
      }
      const compiled = command.teaching
        ? await this.teachingCompiler!.compile(command) : undefined;
      return { kind: 'create', status: 'completed', commandDigest: digest,
        result: await this.createAuthority.execute(compiled?.command ?? command),
        ...(compiled ? { teachingReceipt: compiled.receipt } : {}) };
    });
  }

  /** Projects a signed re-evaluation of the exact persisted Create artifact. */
  async submitReevaluation(surface: 'cli' | 'studio',
    command: LiminalReevaluationProjectionCommand): Promise<LiminalProductProjection> {
    if (!['cli', 'studio'].includes(surface)) {
      throw new Error('LIMINAL_SURFACE_REEVALUATION_FORBIDDEN');
    }
    return this.settle(command.idempotencyKey, command, async digest => {
      const parent = await this.store.read(command.parentCreateIdempotencyKey);
      const result = await this.createAuthority.readVerifiedResult(
        command.reevaluationIdempotencyKey, command.parentCommand);
      const valid = parent?.kind === 'create'
        && this.createAuthority.verifyReceipt(parent.result.receipt)
        && parent.result.receipt.commandDigest === result.receipt.commandDigest
        && this.createAuthority.verifyReceipt(result.receipt)
        && result.operationId !== parent.result.operationId
        && result.receipt.operationId === result.operationId
        && result.lineageId === parent.result.lineageId
        && result.receipt.lineageId === result.lineageId
        && result.domain === command.parentCommand.domain
        && canonical(result.artifacts) === canonical(parent.result.artifacts)
        && result.receipt.artifactDigest === parent.result.receipt.artifactDigest
        && SHA256.test(result.receipt.actionAuthorityDigest ?? '')
        && result.receipt.learningEligible === false
        && result.attempts.maximum === 1 && result.attempts.consumed <= 1
        && result.evidence.status === 'rendered'
        && SHA256.test(result.evidence.earlyFrameDigest ?? '')
        && SHA256.test(result.evidence.lateFrameDigest ?? '')
        && result.evidence.rendererIdentity === parent.result.evidence.rendererIdentity
        && result.evidence.runtimeErrors.length === 0
        && result.evidence.evidenceDigest === result.receipt.evidenceDigest
        && result.evaluation.evidenceDigest === result.receipt.evidenceDigest
        && result.evaluation.admissionEligible && !result.evaluation.degraded
        && result.evaluation.identityValid
        && result.evaluation.evaluatorIdentity === result.roles.evaluator;
      if (!valid) throw new Error('LIMINAL_REEVALUATION_PROJECTION_INVALID');
      await this.createAuthority.restoreVerifiedArtifact(parent.result, result);
      await this.createAuthority.restoreVerifiedRenderedEvidence(
        result, command.renderedEvidence);
      await this.createAuthority.readVerifiedRenderedEvidence(result);
      return { kind: 'create', status: 'completed', commandDigest: digest, result };
    });
  }

  async propose(surface: LiminalProposalSurface,
    proposal: LiminalCommandProposal): Promise<LiminalProductProjection> {
    if (!['cortex', 'gardener', 'daemon', 'scheduler'].includes(surface)) {
      throw new Error('LIMINAL_SURFACE_PROPOSAL_FORBIDDEN');
    }
    validateProposal(proposal);
    return this.settle(proposal.idempotencyKey, proposal, digest => Promise.resolve({
      kind: 'proposal', status: 'proposed', commandDigest: digest, proposal,
    }));
  }

  projection(idempotencyKey: string): Promise<LiminalProductProjection | null> {
    return this.store.read(idempotencyKey);
  }

  /** Re-verifies a durable Create projection before another product authority consumes it. */
  async verifiedCreate(idempotencyKey: string): Promise<Extract<LiminalProductProjection,
    { kind: 'create' }>> {
    const projection = await this.store.read(idempotencyKey);
    if (projection?.kind !== 'create'
      || !this.createAuthority.verifyReceipt(projection.result.receipt)
      || projection.result.evidence.status !== 'rendered'
      || !projection.result.evidence.evidenceDigest
      || projection.result.receipt.evidenceDigest !== projection.result.evidence.evidenceDigest
      || projection.result.evaluation.evidenceDigest !== projection.result.evidence.evidenceDigest
      || !projection.result.evaluation.admissionEligible
      || projection.result.evaluation.degraded
      || !projection.result.evaluation.identityValid) {
      throw new Error('LIMINAL_VERIFIED_CREATE_INVALID');
    }
    await this.createAuthority.readVerifiedRenderedEvidence(projection.result);
    return projection;
  }

  async verifiedArtifact(idempotencyKey: string) {
    const projection = await this.verifiedCreate(idempotencyKey);
    return this.createAuthority.readVerifiedArtifact(projection.result);
  }

  async verifiedOwnerEvidence(createKey: string,
    reviewKey: string): Promise<VerifiedLiminalOwnerEvidence> {
    const [create, review] = await Promise.all([this.store.read(createKey),
      this.store.read(reviewKey)]);
    if (create?.kind !== 'create' || review?.kind !== 'owner-review'
      || review.command.decision !== 'accepted'
      || review.command.createIdempotencyKey !== createKey
      || !this.reviewAuthority?.verify(review.command, review.receipt)
      || !this.createAuthority.verifyReceipt(create.result.receipt)
      || review.command.operationId !== create.result.operationId
      || review.command.artifactRootDigest !== create.result.receipt.artifactDigest
      || review.command.evidenceRootDigest !== create.result.evidence.evidenceDigest) {
      throw new Error('LIMINAL_VERIFIED_OWNER_EVIDENCE_INVALID');
    }
    validateCreativeLabelAdmission(review.admissions.creativeLabel, 'few-shot');
    validateRoutingOutcomeAdmission(review.admissions.routing, { role: 'generator',
      domain: create.result.domain, model: create.result.roles.generator });
    validateExplorationDecisionAdmission(review.admissions.exploration, {
      purpose: 'evolution-reward', artifactId: create.result.operationId,
      role: 'generator', domain: create.result.domain });
    if (review.admissions.exploration.criterionDigest !== review.command.criterionDigest
      || review.admissions.routing.artifactDigest !== create.result.receipt.artifactDigest
      || review.admissions.routing.evidenceDigest !== create.result.evidence.evidenceDigest
      || review.admissions.routing.criterionScore !== create.result.evaluation.score) {
      throw new Error('LIMINAL_VERIFIED_OWNER_EVIDENCE_INVALID');
    }
    return Object.freeze({ createKey, ownerReviewKey: reviewKey,
      operationId: create.result.operationId, lineageId: create.result.lineageId,
      createCommandDigest: create.commandDigest,
      createReceiptDigest: commandDigest(create.result.receipt),
      reviewCommandDigest: review.commandDigest,
      reviewDecisionDigest: review.receipt.decisionDigest,
      reviewReceiptDigest: commandDigest(review.receipt),
      artifactDigest: create.result.receipt.artifactDigest,
      evidenceDigest: create.result.evidence.evidenceDigest!,
      criterionDigest: review.command.criterionDigest, domain: create.result.domain,
      quality: review.admissions.routing.criterionScore, decision: review.command.decision });
  }

  linkDreamProjection(operationIds: readonly string[], projectionDigest: string): Promise<void[]> {
    return Promise.all(operationIds.map(operationId =>
      this.createAuthority.linkDreamProjection(operationId, projectionDigest)));
  }

  runCompoundJudgment<T>(input: { idempotencyKey: string; binding: unknown;
    identity: string; maxTransportAttempts: 1; effect: () => Promise<T> }): Promise<T> {
    return this.createAuthority.runJudgmentEffect({ ...input, role: 'evaluator' });
  }

  runResearchProviderEffect<T>(input: { idempotencyKey: string; binding: unknown;
    identity: string; role: 'generator' | 'evaluator' | 'harness' | 'studio';
    maxTransportAttempts: 1;
    effect: () => Promise<T> }): Promise<T> {
    return this.createAuthority.runJudgmentEffect(input);
  }

  async submitOwnerReview(surface: 'cli' | 'studio',
    command: LiminalOwnerReviewCommand): Promise<LiminalProductProjection> {
    if (!['cli', 'studio'].includes(surface)) {
      throw new Error('LIMINAL_SURFACE_OWNER_REVIEW_FORBIDDEN');
    }
    validateOwnerReview(command);
    if (!this.reviewAuthority) throw new Error('LIMINAL_OWNER_REVIEW_AUTHORITY_MISSING');
    return this.settle(command.idempotencyKey, command, async digest => {
      const create = await this.store.read(command.createIdempotencyKey);
      if (create?.kind !== 'create' || !this.createAuthority.verifyReceipt(create.result.receipt)
        || create.result.operationId !== command.operationId
        || create.result.receipt.artifactDigest !== command.artifactRootDigest
        || create.result.receipt.evidenceDigest !== command.evidenceRootDigest
        || create.result.evidence.evidenceDigest !== command.evidenceRootDigest
        || create.result.evidence.status !== 'rendered'
        || !create.result.evaluation.admissionEligible
        || create.result.evaluation.degraded || !create.result.evaluation.identityValid
        || create.result.evaluation.evidenceDigest !== command.evidenceRootDigest) {
        throw new Error('LIMINAL_OWNER_REVIEW_CREATE_EVIDENCE_INVALID');
      }
      const receipt = await this.reviewAuthority!.submit(command);
      if (!SHA256.test(receipt.decisionDigest) || !SHA256.test(receipt.authorityKeyDigest)
        || !SHA256.test(receipt.signature)
        || !this.reviewAuthority!.verify(command, receipt)) {
        throw new Error('LIMINAL_OWNER_REVIEW_RECEIPT_INVALID');
      }
      return { kind: 'owner-review', status: 'reviewed', commandDigest: digest, command,
        receipt, admissions: mintOwnerReviewAdmissions(
          command, receipt, create.result, {
            sealAdmission: value => this.createAuthority.sealOwnerReviewAdmission(value),
          }) };
    });
  }

  private async settle(key: string, command: unknown,
    operation: (digest: string) => Promise<LiminalProductProjection>):
    Promise<LiminalProductProjection> {
    if (!key.trim()) throw new Error('LIMINAL_PRODUCT_IDEMPOTENCY_KEY_REQUIRED');
    const digest = commandDigest(command);
    const existing = await this.store.read(key);
    if (existing) {
      if (existing.commandDigest !== digest) throw new Error('IDEMPOTENCY_KEY_REBOUND');
      return existing;
    }
    const running = this.inFlight.get(key);
    if (running) return running;
    const settleOnce = async (): Promise<LiminalProductProjection> => {
      const persisted = await this.store.read(key);
      if (persisted) {
        if (persisted.commandDigest !== digest) throw new Error('IDEMPOTENCY_KEY_REBOUND');
        return persisted;
      }
      const projection = await operation(digest);
      await this.store.write(key, projection);
      return projection;
    };
    const pending = (this.store.withLease
      ? this.store.withLease(key, settleOnce)
      : settleOnce()).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }
}

const SHA256 = /^[a-f0-9]{64}$/;

function mintOwnerReviewAdmissions(command: LiminalOwnerReviewCommand,
  receipt: LiminalOwnerReviewReceipt,
  create: LiminalCommandResult,
  authority: CreativeAdmissionSigner): LiminalOwnerReviewAdmissions {
  const evidence = {
    artifactDigest: create.receipt.artifactDigest,
    evidenceDigest: create.evidence.evidenceDigest!,
    decisionDigest: receipt.decisionDigest,
    rendered: (create.evidence.status === 'rendered') as true,
    identityValid: create.evaluation.identityValid as true,
    digestMatched: (create.evaluation.evidenceDigest
      === create.evidence.evidenceDigest) as true,
    degraded: create.evaluation.degraded as false,
  };
  return Object.freeze({
    creativeLabel: createCreativeLabelAdmission({ ...evidence,
      trustKind: 'owner-preference',
      allowedUses: command.decision === 'accepted'
        ? ['few-shot', 'evaluator-training'] : ['hard-negative'] }, authority),
    routing: createRoutingOutcomeAdmission({ ...evidence, role: 'generator',
      domain: create.domain, model: create.roles.generator,
      ownerDecision: command.decision,
      criterionScore: create.evaluation.score }, authority),
    exploration: createExplorationDecisionAdmission({ ...evidence,
      purpose: 'evolution-reward', artifactId: command.operationId,
      role: 'generator', domain: create.domain,
      ownerDecision: command.decision,
      criterionScore: create.evaluation.score,
      criterionDigest: command.criterionDigest }, authority),
  });
}

function validateProposal(value: LiminalCommandProposal): void {
  if (value.schema !== 'sinter.liminal-proposal' || value.schemaVersion !== 1
    || value.requestedKind !== 'generate-candidate' || !value.idempotencyKey.trim()
    || !SHA256.test(value.briefDigest) || !SHA256.test(value.authorityDigest)) {
    throw new Error('LIMINAL_COMMAND_PROPOSAL_INVALID');
  }
}

function validateOwnerReview(value: LiminalOwnerReviewCommand): void {
  if (value.schema !== 'sinter.liminal-owner-review-command' || value.schemaVersion !== 1
    || !value.idempotencyKey.trim() || !value.createIdempotencyKey.trim()
    || value.createIdempotencyKey === value.idempotencyKey || !value.operationId.trim()
    || !SHA256.test(value.artifactRootDigest) || !SHA256.test(value.evidenceRootDigest)
    || !value.feedback.trim() || !['accepted', 'rejected'].includes(value.decision)
    || !SHA256.test(value.criterionDigest)) {
    throw new Error('LIMINAL_OWNER_REVIEW_COMMAND_INVALID');
  }
}
