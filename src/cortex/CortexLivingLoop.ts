import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CORTEX_LIVING_LOOP_SCHEMA_VERSION = 1 as const;

export const LIVING_LOOP_STEPS = [
  'create-evidence',
  'consolidate',
  'dream',
  'autoresearch',
  'review',
  'assimilate',
  'candidate-request',
  'follow-up-create',
] as const;

export type LivingLoopStep = typeof LIVING_LOOP_STEPS[number];
export type LivingLoopEffect =
  | 'evidence-admission'
  | 'dream-admission'
  | 'consolidation-admission'
  | 'mutation'
  | 'review'
  | 'veto'
  | 'assimilation-recommendation'
  | 'candidate'
  | 'promotion-request'
  | 'follow-up-artifact';

export interface LivingLoopBudgets {
  maxActions: number;
  maxTokens: number;
  maxCostUsd: number;
  maxWallClockMs: number;
}

export interface LivingLoopUsage {
  actions: number;
  tokens: number;
  costUsd: number;
  wallClockMs: number;
}

export interface LivingLoopAuthority {
  independentReviewRequired: true;
  sealedControlsRequired: true;
  stageOneNoMerge: true;
}

export interface LivingLoopRequest {
  cycleId: string;
  lineageId: string;
  sourceFingerprint: string;
  autonomyLevel: 'assist' | 'co-create' | 'autopilot';
  prerequisites: {
    dreamReceiptDigest: string;
    causalReceiptDigest: string;
    domainReceiptDigest: string;
    assimilationReceiptDigest: string;
  };
  budgets: LivingLoopBudgets;
  concurrencyLimit: number;
  leaseTtlMs: number;
}

export interface LivingLoopPlanStep {
  step: LivingLoopStep;
  transition: string;
  prerequisite: string;
  idempotencyKey: string;
  expectedEffects: LivingLoopEffect[];
}

export interface LivingLoopDryRun {
  cycleId: string;
  autonomyLevel: LivingLoopRequest['autonomyLevel'];
  writes: false;
  authority: LivingLoopAuthority;
  budgets: LivingLoopBudgets;
  concurrencyLimit: number;
  steps: LivingLoopPlanStep[];
}

export interface LivingLoopRecordedEffect {
  type: LivingLoopEffect;
  id: string;
}

export interface LivingLoopStepRecord extends LivingLoopPlanStep {
  status: 'pending' | 'running' | 'completed';
  effects: LivingLoopRecordedEffect[];
  receiptRefs: string[];
  usage: LivingLoopUsage;
}

export interface LivingLoopLease {
  ownerId: string;
  token: string;
  epoch: number;
  expiresAtMs: number;
}

export interface LivingLoopCheckpoint {
  schemaVersion: typeof CORTEX_LIVING_LOOP_SCHEMA_VERSION;
  version: number;
  cycleId: string;
  lineageId: string;
  sourceFingerprint: string;
  requestDigest: string;
  state: 'running' | 'completed' | 'stopped';
  authority: LivingLoopAuthority;
  budgets: LivingLoopBudgets;
  concurrencyLimit: number;
  maxObservedConcurrency: number;
  leaseTtlMs: number;
  lease: LivingLoopLease | null;
  fenced: boolean;
  stopReason?: string;
  startedAtMs: number;
  updatedAtMs: number;
  usage: LivingLoopUsage;
  steps: LivingLoopStepRecord[];
}

export interface LivingLoopExecutionResult {
  idempotencyKey: string;
  effects: LivingLoopRecordedEffect[];
  receiptRefs: string[];
  usage: LivingLoopUsage;
}

export interface LivingLoopExecutionContext {
  cycleId: string;
  step: LivingLoopStep;
  idempotencyKey: string;
  authority: LivingLoopAuthority;
  remaining: LivingLoopBudgets;
  deadlineMs: number;
  /** Aborted when the conductor's independent wall-clock timer fires (#1307). */
  signal?: AbortSignal;
}

export interface LivingLoopStepExecutor {
  execute(context: LivingLoopExecutionContext): Promise<LivingLoopExecutionResult>;
  recover(context: LivingLoopExecutionContext): Promise<LivingLoopExecutionResult | null>;
}

const AUTHORITY: LivingLoopAuthority = {
  independentReviewRequired: true,
  sealedControlsRequired: true,
  stageOneNoMerge: true,
};

const ZERO_USAGE: LivingLoopUsage = {
  actions: 0,
  tokens: 0,
  costUsd: 0,
  wallClockMs: 0,
};

const STEP_SPEC: Record<LivingLoopStep, {
  transition: string;
  prerequisite: keyof LivingLoopRequest['prerequisites'];
  effects: LivingLoopEffect[];
}> = {
  'create-evidence': {
    transition: 'admit Create-derived evidence',
    prerequisite: 'causalReceiptDigest',
    effects: ['evidence-admission'],
  },
  dream: {
    transition: 'recombine admitted evidence into a Dream',
    prerequisite: 'dreamReceiptDigest',
    effects: ['dream-admission'],
  },
  consolidate: {
    transition: 'consolidate evidence into a falsifiable hypothesis',
    prerequisite: 'causalReceiptDigest',
    effects: ['consolidation-admission'],
  },
  autoresearch: {
    transition: 'run one bounded source experiment',
    prerequisite: 'causalReceiptDigest',
    effects: ['mutation'],
  },
  review: {
    transition: 'seal and independently review the experiment',
    prerequisite: 'causalReceiptDigest',
    effects: ['review', 'veto'],
  },
  assimilate: {
    transition: 'admit role-specific model recommendations',
    prerequisite: 'assimilationReceiptDigest',
    effects: ['assimilation-recommendation'],
  },
  'candidate-request': {
    transition: 'package an owner-controlled promotion request',
    prerequisite: 'domainReceiptDigest',
    effects: ['candidate', 'promotion-request'],
  },
  'follow-up-create': {
    transition: 'create the next artifact from reviewed causal evidence',
    prerequisite: 'causalReceiptDigest',
    effects: ['follow-up-artifact'],
  },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function assertCycleId(cycleId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(cycleId)) throw new Error('INVALID_CYCLE_ID');
}

function assertRequest(request: LivingLoopRequest): void {
  assertCycleId(request.cycleId);
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(request.lineageId)) {
    throw new Error('INVALID_LINEAGE_ID');
  }
  if (!/^[a-f0-9]{64}$/.test(request.sourceFingerprint)) {
    throw new Error('INVALID_SOURCE_FINGERPRINT');
  }
  for (const value of Object.values(request.prerequisites)) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('INVALID_PREREQUISITE_DIGEST');
  }
  const budgetValues = Object.values(request.budgets);
  if (budgetValues.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('INVALID_LIVING_LOOP_BUDGET');
  }
  if (!Number.isInteger(request.concurrencyLimit) || request.concurrencyLimit < 1) {
    throw new Error('INVALID_CONCURRENCY_LIMIT');
  }
  // The conductor runs steps sequentially. Accepting a higher limit would
  // claim parallel organ support it does not have (#1307).
  if (request.concurrencyLimit > 1) {
    throw new Error('PARALLEL_EXECUTION_UNSUPPORTED');
  }
  if (!Number.isFinite(request.leaseTtlMs) || request.leaseTtlMs <= 0) {
    throw new Error('INVALID_LEASE_TTL');
  }
}

function buildPlan(request: LivingLoopRequest): LivingLoopPlanStep[] {
  return LIVING_LOOP_STEPS.map(step => {
    const spec = STEP_SPEC[step];
    const prerequisite = request.prerequisites[spec.prerequisite];
    return {
      step,
      transition: spec.transition,
      prerequisite: `${spec.prerequisite}:${prerequisite}`,
      idempotencyKey: sha256({ cycleId: request.cycleId, step, prerequisite }),
      expectedEffects: [...spec.effects],
    };
  });
}

function addUsage(left: LivingLoopUsage, right: LivingLoopUsage): LivingLoopUsage {
  return {
    actions: left.actions + right.actions,
    tokens: left.tokens + right.tokens,
    costUsd: left.costUsd + right.costUsd,
    wallClockMs: left.wallClockMs + right.wallClockMs,
  };
}

function remaining(checkpoint: LivingLoopCheckpoint, nowMs: number): LivingLoopBudgets {
  return {
    maxActions: checkpoint.budgets.maxActions - checkpoint.usage.actions,
    maxTokens: checkpoint.budgets.maxTokens - checkpoint.usage.tokens,
    maxCostUsd: checkpoint.budgets.maxCostUsd - checkpoint.usage.costUsd,
    maxWallClockMs: checkpoint.budgets.maxWallClockMs
      - (nowMs - checkpoint.startedAtMs),
  };
}

function assertUsage(result: LivingLoopExecutionResult, limits: LivingLoopBudgets): void {
  const values = Object.values(result.usage);
  if (values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('INVALID_EXECUTOR_USAGE');
  }
  if (result.usage.actions < 1
    || result.usage.actions > limits.maxActions
    || result.usage.tokens > limits.maxTokens
    || result.usage.costUsd > limits.maxCostUsd
    || result.usage.wallClockMs > limits.maxWallClockMs) {
    throw new Error('LIVING_LOOP_BUDGET_EXCEEDED');
  }
}

function assertResult(
  result: LivingLoopExecutionResult,
  record: LivingLoopStepRecord,
  limits: LivingLoopBudgets,
): void {
  if (result.idempotencyKey !== record.idempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_MISMATCH');
  }
  const expected = [...record.expectedEffects].sort();
  const actual = result.effects.map(effect => effect.type).sort();
  if (canonical(expected) !== canonical(actual)) {
    throw new Error('LIVING_LOOP_EFFECT_MISMATCH');
  }
  const effectIds = result.effects.map(effect => effect.id);
  if (effectIds.some(id => !id) || new Set(effectIds).size !== effectIds.length) {
    throw new Error('INVALID_LIVING_LOOP_EFFECT_IDS');
  }
  if (result.receiptRefs.length === 0 || result.receiptRefs.some(ref => !ref)) {
    throw new Error('MISSING_LIVING_LOOP_RECEIPT');
  }
  assertUsage(result, limits);
}

function initialCheckpoint(request: LivingLoopRequest, nowMs: number): LivingLoopCheckpoint {
  return {
    schemaVersion: CORTEX_LIVING_LOOP_SCHEMA_VERSION,
    version: 0,
    cycleId: request.cycleId,
    lineageId: request.lineageId,
    sourceFingerprint: request.sourceFingerprint,
    requestDigest: sha256(request),
    state: 'running',
    authority: AUTHORITY,
    budgets: request.budgets,
    concurrencyLimit: request.concurrencyLimit,
    maxObservedConcurrency: 0,
    leaseTtlMs: request.leaseTtlMs,
    lease: null,
    fenced: false,
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    usage: { ...ZERO_USAGE },
    steps: buildPlan(request).map(step => ({
      ...step,
      status: 'pending',
      effects: [],
      receiptRefs: [],
      usage: { ...ZERO_USAGE },
    })),
  };
}

function cloneCheckpoint(checkpoint: LivingLoopCheckpoint): LivingLoopCheckpoint {
  return structuredClone(checkpoint);
}

function leaseError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function isLeaseLoss(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: string }).code === 'LEASE_LOST';
}

const CHECKPOINT_LOCK_STALE_MS = 30_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function cycleAuthorityHeld(authority: LivingLoopAuthority): boolean {
  return authority.independentReviewRequired === true
    && authority.sealedControlsRequired === true
    && authority.stageOneNoMerge === true;
}

function assertCheckpoint(value: unknown, cycleId: string): LivingLoopCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_CORTEX_CHECKPOINT');
  }
  const checkpoint = value as LivingLoopCheckpoint;
  const validState = ['running', 'completed', 'stopped'].includes(checkpoint.state);
  const stepsValid = Array.isArray(checkpoint.steps)
    && canonical(checkpoint.steps.map(step => step.step)) === canonical(LIVING_LOOP_STEPS)
    && checkpoint.steps.every(step =>
      ['pending', 'running', 'completed'].includes(step.status)
      && /^[a-f0-9]{64}$/.test(step.idempotencyKey));
  if (
    checkpoint.schemaVersion !== CORTEX_LIVING_LOOP_SCHEMA_VERSION
    || checkpoint.cycleId !== cycleId
    || !/^[a-z0-9][a-z0-9-]{2,127}$/.test(checkpoint.lineageId)
    || !/^[a-f0-9]{64}$/.test(checkpoint.sourceFingerprint)
    || !/^[a-f0-9]{64}$/.test(checkpoint.requestDigest)
    || !validState
    || !checkpoint.authority
    || !cycleAuthorityHeld(checkpoint.authority)
    || !stepsValid
  ) throw new Error('INVALID_CORTEX_CHECKPOINT');
  if (checkpoint.state === 'completed'
    && checkpoint.steps.some(step => step.status !== 'completed')) {
    throw new Error('INVALID_CORTEX_CHECKPOINT');
  }
  const ids = checkpoint.steps.flatMap(step => step.effects.map(effect => effect.id));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new Error('INVALID_CORTEX_CHECKPOINT');
  }
  return checkpoint;
}

class LivingLoopDeadlineError extends Error {
  constructor() { super('LIVING_LOOP_EXECUTOR_DEADLINE_EXCEEDED'); }
}

export class FileCortexCycleStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('CORTEX_CYCLE_ROOT_MUST_BE_ABSOLUTE');
  }

  async read(cycleId: string): Promise<LivingLoopCheckpoint | null> {
    assertCycleId(cycleId);
    try {
      const raw = await readFile(this.statePath(cycleId), 'utf8');
      return assertCheckpoint(JSON.parse(raw), cycleId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private cycleDir(cycleId: string): string {
    return path.join(this.root, cycleId);
  }

  private statePath(cycleId: string): string {
    return path.join(this.cycleDir(cycleId), 'checkpoint.json');
  }

  private async write(checkpoint: LivingLoopCheckpoint): Promise<void> {
    const target = this.statePath(checkpoint.cycleId);
    const temporary = path.join(this.cycleDir(checkpoint.cycleId),
      `checkpoint.${randomUUID()}.tmp`);
    // Durable commit (#1307): fsync the temp file before rename and the
    // directory after it, so a crash cannot leave a renamed-but-empty file.
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    const dir = await open(this.cycleDir(checkpoint.cycleId), 'r');
    try {
      await dir.sync();
    } catch (error) {
      // Some filesystems reject directory fsync; the file itself is synced.
      if ((error as NodeJS.ErrnoException).code !== 'EINVAL'
        && (error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    } finally {
      await dir.close();
    }
  }

  private async canReclaimLock(lock: string): Promise<boolean> {
    try {
      const raw = await readFile(path.join(lock, 'owner.json'), 'utf8');
      const owner = JSON.parse(raw) as { pid?: number };
      return typeof owner.pid === 'number' && !processIsAlive(owner.pid);
    } catch (error) {
      if (!['ENOENT', undefined].includes((error as NodeJS.ErrnoException).code)) {
        throw error;
      }
      const info = await stat(lock);
      return Date.now() - info.mtimeMs > CHECKPOINT_LOCK_STALE_MS;
    }
  }

  private async claimLock(lock: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(lock);
        await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
          pid: process.pid,
          token: randomUUID(),
          createdAtMs: Date.now(),
        }), { flag: 'wx' });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await this.canReclaimLock(lock))) throw leaseError('CHECKPOINT_BUSY');
        await rm(lock, { recursive: true, force: true });
      }
    }
    throw leaseError('CHECKPOINT_BUSY');
  }

  private async withLock(
    cycleId: string,
    mutate: (current: LivingLoopCheckpoint | null) => LivingLoopCheckpoint,
  ): Promise<LivingLoopCheckpoint> {
    assertCycleId(cycleId);
    const directory = this.cycleDir(cycleId);
    const lock = path.join(directory, '.lock');
    await mkdir(directory, { recursive: true });
    await this.claimLock(lock);
    try {
      const next = mutate(await this.read(cycleId));
      await this.write(next);
      return cloneCheckpoint(next);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async acquire(
    request: LivingLoopRequest,
    ownerId: string,
    nowMs: number,
  ): Promise<LivingLoopCheckpoint> {
    assertRequest(request);
    if (!ownerId) throw new Error('OWNER_ID_REQUIRED');
    return this.withLock(request.cycleId, current => {
      const checkpoint = current ?? initialCheckpoint(request, nowMs);
      if (checkpoint.requestDigest !== sha256(request)) {
        throw new Error('CYCLE_REQUEST_MISMATCH');
      }
      if (checkpoint.fenced || checkpoint.state !== 'running') return checkpoint;
      const active = checkpoint.lease && checkpoint.lease.expiresAtMs > nowMs;
      if (active && checkpoint.lease?.ownerId !== ownerId) {
        throw leaseError('LEASE_HELD');
      }
      const epoch = checkpoint.lease?.epoch ?? 0;
      checkpoint.lease = active && checkpoint.lease?.ownerId === ownerId
        ? { ...checkpoint.lease, expiresAtMs: nowMs + checkpoint.leaseTtlMs }
        : {
            ownerId,
            token: randomUUID(),
            epoch: epoch + 1,
            expiresAtMs: nowMs + checkpoint.leaseTtlMs,
          };
      checkpoint.version += 1;
      checkpoint.updatedAtMs = nowMs;
      return checkpoint;
    });
  }

  async update(
    cycleId: string,
    leaseToken: string,
    nowMs: number,
    mutate: (checkpoint: LivingLoopCheckpoint) => void,
  ): Promise<LivingLoopCheckpoint> {
    return this.withLock(cycleId, current => {
      if (!current) throw new Error('CYCLE_NOT_FOUND');
      if (current.fenced
        || !current.lease
        || current.lease.token !== leaseToken
        || current.lease.expiresAtMs <= nowMs) {
        throw leaseError('LEASE_LOST');
      }
      mutate(current);
      current.version += 1;
      current.updatedAtMs = nowMs;
      current.lease.expiresAtMs = nowMs + current.leaseTtlMs;
      return current;
    });
  }

  async fence(
    cycleId: string,
    reason: string,
    nowMs: number,
  ): Promise<LivingLoopCheckpoint> {
    return this.withLock(cycleId, current => {
      if (!current) throw new Error('CYCLE_NOT_FOUND');
      if (current.state === 'completed') return current;
      current.fenced = true;
      current.state = 'stopped';
      current.stopReason = reason;
      current.lease = null;
      current.version += 1;
      current.updatedAtMs = nowMs;
      return current;
    });
  }
}

function contextFor(
  checkpoint: LivingLoopCheckpoint,
  record: LivingLoopStepRecord,
  nowMs: number,
): LivingLoopExecutionContext {
  return {
    cycleId: checkpoint.cycleId,
    step: record.step,
    idempotencyKey: record.idempotencyKey,
    authority: checkpoint.authority,
    remaining: remaining(checkpoint, nowMs),
    deadlineMs: checkpoint.startedAtMs + checkpoint.budgets.maxWallClockMs,
  };
}

export class CortexLivingLoopConductor {
  constructor(
    private readonly store: FileCortexCycleStore,
    private readonly now: () => number = Date.now,
  ) {}

  dryRun(request: LivingLoopRequest): LivingLoopDryRun {
    assertRequest(request);
    return {
      cycleId: request.cycleId,
      autonomyLevel: request.autonomyLevel,
      writes: false,
      authority: { ...AUTHORITY },
      budgets: { ...request.budgets },
      concurrencyLimit: request.concurrencyLimit,
      steps: buildPlan(request),
    };
  }

  async run(
    request: LivingLoopRequest,
    actorId: string,
    executor: LivingLoopStepExecutor,
  ): Promise<LivingLoopCheckpoint> {
    let checkpoint = await this.store.acquire(request, actorId, this.now());
    if (checkpoint.state !== 'running' || checkpoint.fenced) return checkpoint;
    const leaseToken = checkpoint.lease?.token;
    if (!leaseToken) throw new Error('LEASE_NOT_GRANTED');

    for (const planned of LIVING_LOOP_STEPS) {
      let record = checkpoint.steps.find(item => item.step === planned);
      if (!record) throw new Error(`MISSING_LIVING_LOOP_STEP:${planned}`);
      if (record.status === 'completed') continue;
      const nowMs = this.now();
      const limits = remaining(checkpoint, nowMs);
      if (Object.values(limits).some(value => value <= 0)) {
        return this.stop(checkpoint.cycleId, leaseToken, 'budget-exhausted');
      }
      const recovering = record.status === 'running';
      if (!recovering) {
        try {
          checkpoint = await this.store.update(
            checkpoint.cycleId,
            leaseToken,
            nowMs,
            current => {
              const step = current.steps.find(item => item.step === planned);
              if (!step || step.status !== 'pending') {
                throw new Error(`INVALID_STEP_TRANSITION:${planned}`);
              }
              step.status = 'running';
              current.maxObservedConcurrency = Math.max(
                current.maxObservedConcurrency,
                1,
              );
            },
          );
        } catch (error) {
          if (isLeaseLoss(error)) {
            return this.store.fence(checkpoint.cycleId, 'split-brain', this.now());
          }
          throw error;
        }
        record = checkpoint.steps.find(item => item.step === planned);
        if (!record) throw new Error(`MISSING_LIVING_LOOP_STEP:${planned}`);
      }

      const controller = new AbortController();
      const context = { ...contextFor(checkpoint, record, this.now()), signal: controller.signal };
      let result: LivingLoopExecutionResult | null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Independent real timer (#1307): a hung executor cannot outlive the
        // wall-clock budget even when the injected clock never advances.
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new LivingLoopDeadlineError());
          }, Math.max(0, context.remaining.maxWallClockMs));
        });
        result = await Promise.race([
          recovering ? executor.recover(context) : executor.execute(context),
          deadline,
        ]);
      } catch (executorError) {
        if (executorError instanceof LivingLoopDeadlineError) {
          // Effect outcome is UNKNOWN: the step stays 'running' so the next
          // owner must recover() it rather than re-execute.
          return this.stop(checkpoint.cycleId, leaseToken,
            'executor-deadline-exceeded:outcome-unknown');
        }
        try {
          await this.store.update(
            checkpoint.cycleId,
            leaseToken,
            this.now(),
            () => {},
          );
        } catch (leaseCheckError) {
          if (isLeaseLoss(leaseCheckError)) {
            return this.store.fence(
              checkpoint.cycleId,
              'split-brain',
              this.now(),
            );
          }
          throw leaseCheckError;
        }
        throw executorError;
      } finally {
        clearTimeout(timer);
      }
      if (!result) {
        return this.stop(checkpoint.cycleId, leaseToken, 'recovery-required');
      }
      try {
        const afterExecution = remaining(checkpoint, this.now());
        assertResult(result, record, {
          ...context.remaining,
          maxWallClockMs: Math.min(
            context.remaining.maxWallClockMs,
            afterExecution.maxWallClockMs,
          ),
        });
        checkpoint = await this.completeStep(checkpoint, leaseToken, result);
      } catch (error) {
        if (isLeaseLoss(error)) {
          return this.store.fence(checkpoint.cycleId, 'split-brain', this.now());
        }
        return this.stop(checkpoint.cycleId, leaseToken,
          error instanceof Error ? error.message : 'executor-result-invalid');
      }
    }
    try {
      checkpoint = await this.store.update(
        checkpoint.cycleId,
        leaseToken,
        this.now(),
        current => {
          if (current.steps.some(step => step.status !== 'completed')) {
            throw new Error('LIVING_LOOP_INCOMPLETE');
          }
          current.state = 'completed';
        },
      );
    } catch (error) {
      if (isLeaseLoss(error)) {
        return this.store.fence(checkpoint.cycleId, 'split-brain', this.now());
      }
      throw error;
    }
    return checkpoint;
  }

  private async completeStep(
    checkpoint: LivingLoopCheckpoint,
    leaseToken: string,
    result: LivingLoopExecutionResult,
  ): Promise<LivingLoopCheckpoint> {
    return this.store.update(
      checkpoint.cycleId,
      leaseToken,
      this.now(),
      current => {
        const step = current.steps.find(item =>
          item.idempotencyKey === result.idempotencyKey);
        if (!step || step.status !== 'running') {
          throw new Error('INVALID_STEP_COMPLETION');
        }
        const existingIds = new Set(current.steps.flatMap(item =>
          item.effects.map(effect => effect.id)));
        if (result.effects.some(effect => existingIds.has(effect.id))) {
          throw new Error('DUPLICATE_LIVING_LOOP_EFFECT');
        }
        step.status = 'completed';
        step.effects = structuredClone(result.effects);
        step.receiptRefs = [...result.receiptRefs];
        step.usage = { ...result.usage };
        current.usage = addUsage(current.usage, result.usage);
      },
    );
  }

  private async stop(
    cycleId: string,
    leaseToken: string,
    reason: string,
  ): Promise<LivingLoopCheckpoint> {
    try {
      return await this.store.update(
        cycleId,
        leaseToken,
        this.now(),
        current => {
          current.state = 'stopped';
          current.stopReason = reason;
        },
      );
    } catch (error) {
      if (isLeaseLoss(error)) {
        return this.store.fence(cycleId, 'split-brain', this.now());
      }
      throw error;
    }
  }
}
