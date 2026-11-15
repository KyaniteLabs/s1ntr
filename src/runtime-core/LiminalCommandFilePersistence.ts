import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { classifyEffectFailure } from './LiminalEffectBroker.js';
import { encodeLiminalDurableValue, LIMINAL_BUFFER_TAG,
  liminalDurablePayloadDigest } from './LiminalPayloadDigest.js';
import type {
  GeneratedArtifact,
  LiminalArtifactStore,
  LiminalCommandResult,
  LiminalEffectKind,
  LiminalEffectOutcome,
  LiminalEffectReservation,
  LiminalOperationAdmission,
  LiminalOperationEvent,
  LiminalOperationEventType,
  LiminalOperationJournal,
  PersistedArtifacts,
  PersistedRenderedEvidence,
  RenderedObservation,
} from './LiminalCommandService.js';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function operationDirectory(root: string, operationId: string): string {
  return path.join(root, sha256(operationId));
}

export class FileLiminalArtifactStore implements LiminalArtifactStore {
  constructor(private readonly root: string) {}

  async persist(operationId: string, artifact: GeneratedArtifact): Promise<PersistedArtifacts> {
    const directory = operationDirectory(this.root, operationId);
    await mkdir(directory, { recursive: true });
    const persisted = Object.freeze({
      sourceDigest: sha256(artifact.source),
      playableDigest: sha256(artifact.playable),
      provenanceDigest: sha256(artifact.provenance),
    });
    await writeFileAtomic(path.join(directory, 'source.txt'), artifact.source);
    await writeFileAtomic(path.join(directory, 'playable.html'), artifact.playable);
    await writeFileAtomic(path.join(directory, 'provenance.txt'), artifact.provenance);
    await writeFileAtomic(path.join(directory, 'artifact-manifest.json'),
      `${JSON.stringify(persisted, null, 2)}\n`);
    return persisted;
  }

  async read(operationId: string): Promise<GeneratedArtifact | null> {
    const directory = operationDirectory(this.root, operationId);
    try {
      const [source, playable, provenance] = await Promise.all([
        readFile(path.join(directory, 'source.txt'), 'utf8'),
        readFile(path.join(directory, 'playable.html'), 'utf8'),
        readFile(path.join(directory, 'provenance.txt'), 'utf8'),
      ]);
      return Object.freeze({ source, playable, provenance });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readRenderedEvidence(operationId: string): Promise<PersistedRenderedEvidence | null> {
    const directory = operationDirectory(this.root, operationId);
    try {
      const [early, late] = await Promise.all([
        readFile(path.join(directory, 'early-frame.png')),
        readFile(path.join(directory, 'late-frame.png')),
      ]);
      return Object.freeze({ earlyFrameDigest: sha256(early), lateFrameDigest: sha256(late) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async persistRenderedEvidence(operationId: string,
    observation: RenderedObservation): Promise<PersistedRenderedEvidence> {
    const directory = operationDirectory(this.root, operationId);
    await mkdir(directory, { recursive: true });
    const persisted = Object.freeze({
      earlyFrameDigest: observation.earlyFrame ? sha256(observation.earlyFrame) : null,
      lateFrameDigest: observation.lateFrame ? sha256(observation.lateFrame) : null,
    });
    if (observation.earlyFrame) await writeFileAtomic(
      path.join(directory, 'early-frame.png'), observation.earlyFrame);
    if (observation.lateFrame) await writeFileAtomic(
      path.join(directory, 'late-frame.png'), observation.lateFrame);
    await writeFileAtomic(path.join(directory, 'rendered-evidence-manifest.json'),
      `${JSON.stringify(persisted, null, 2)}\n`);
    return persisted;
  }
}

interface JournalState {
  readonly schema: 'sinter.liminal-operation-journal';
  readonly schemaVersion: 3 | 4;
  readonly events: readonly LiminalOperationEvent[];
  readonly results: Readonly<Record<string, LiminalCommandResult>>;
  readonly operations: Readonly<Record<string, LiminalOperationAdmission>>;
  readonly effects: Readonly<Record<string, {
    readonly reservation: LiminalEffectReservation;
    readonly state: 'reserved' | 'started' | LiminalEffectOutcome;
    readonly result?: unknown;
    readonly resultDigest?: string;
  }>>;
  readonly nextFence: number;
}

const EMPTY_STATE: JournalState = Object.freeze({
  schema: 'sinter.liminal-operation-journal',
  schemaVersion: 4,
  events: Object.freeze([]),
  results: Object.freeze({}),
  operations: Object.freeze({}),
  effects: Object.freeze({}),
  nextFence: 1,
});

function payloadDigest(payload: unknown): string {
  return liminalDurablePayloadDigest(payload);
}

const EXTERNAL_BUFFER_TAG = 'sinter.buffer-ref.v1';
const EXTERNAL_BUFFER_MIN_BYTES = 64 * 1024;

function hasLargeInlineBuffer(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLargeInlineBuffer);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.$type === LIMINAL_BUFFER_TAG && typeof record.base64 === 'string'
    && Object.keys(record).length === 2) {
    return Buffer.byteLength(record.base64, 'base64') >= EXTERNAL_BUFFER_MIN_BYTES;
  }
  return Object.values(record).some(hasLargeInlineBuffer);
}

async function decodeDurableValue(value: unknown, blobs: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(item => decodeDurableValue(item, blobs)));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.$type === LIMINAL_BUFFER_TAG && typeof record.base64 === 'string'
      && Object.keys(record).length === 2) return Buffer.from(record.base64, 'base64');
    if (record.$type === EXTERNAL_BUFFER_TAG) {
      if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)
        || !Number.isSafeInteger(record.length) || (record.length as number) < 0
        || Object.keys(record).length !== 3) throw new Error('JOURNAL_BLOB_REFERENCE_INVALID');
      const buffer = await readFile(path.join(blobs, record.sha256));
      if (buffer.length !== record.length || sha256(buffer) !== record.sha256) {
        throw new Error('JOURNAL_BLOB_DIGEST_MISMATCH');
      }
      return buffer;
    }
    return Object.fromEntries(await Promise.all(Object.entries(record)
      .map(async ([key, item]) => [key, await decodeDurableValue(item, blobs)])));
  }
  return value;
}

function validateState(value: unknown): JournalState {
  if (!value || typeof value !== 'object') throw new Error('Invalid Liminal operation journal');
  const state = value as Omit<Partial<JournalState>, 'schemaVersion'>
    & { schemaVersion?: number };
  if (state.schema !== EMPTY_STATE.schema || ![1, 2, 3, 4].includes(state.schemaVersion ?? 0)
    || !Array.isArray(state.events) || !state.results || typeof state.results !== 'object'
    || !state.operations || typeof state.operations !== 'object') {
    throw new Error('Invalid Liminal operation journal');
  }
  if (state.schemaVersion === 1) {
    return { ...state, schemaVersion: 4, effects: Object.freeze({}), nextFence: 1 } as JournalState;
  }
  if (!state.effects || typeof state.effects !== 'object'
    || !Number.isSafeInteger(state.nextFence) || state.nextFence! < 1) {
    throw new Error('Invalid Liminal operation journal');
  }
  if (state.schemaVersion === 2) return { ...state, schemaVersion: 4 } as JournalState;
  return state as JournalState;
}

export class FileLiminalOperationJournal implements LiminalOperationJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  compactLegacy(backupFile: string): Promise<boolean> {
    if (backupFile === this.file || path.dirname(backupFile) !== path.dirname(this.file)) {
      return Promise.reject(new Error('JOURNAL_BACKUP_MUST_BE_DISTINCT_SIBLING'));
    }
    return this.transition(async (state, needsWrite) => {
      if (needsWrite) throw new Error('JOURNAL_COMPACTION_SCHEMA_UNSUPPORTED');
      if (state.schemaVersion === 4
        && !Object.values(state.effects).some(effect => hasLargeInlineBuffer(effect.result))) {
        return [state, false];
      }
      await copyFile(this.file, backupFile, constants.COPYFILE_EXCL);
      const entries: Array<[string, JournalState['effects'][string]]> = [];
      for (const [id, effect] of Object.entries(state.effects)) {
        if (!('result' in effect)) { entries.push([id, effect]); continue; }
        const result = await decodeDurableValue(effect.result, `${this.file}.blobs`);
        if (effect.resultDigest !== payloadDigest(result)) {
          throw new Error('JOURNAL_EFFECT_RESULT_DIGEST_MISMATCH');
        }
        entries.push([id, hasLargeInlineBuffer(effect.result)
          ? { ...effect, result: await this.externalizeBuffers(result) } : effect]);
      }
      return [{ ...state, schemaVersion: 4, effects: Object.fromEntries(entries) }, true];
    });
  }

  private async externalizeBuffers(value: unknown): Promise<unknown> {
    if (Buffer.isBuffer(value) && value.length >= EXTERNAL_BUFFER_MIN_BYTES) {
      const digest = sha256(value);
      const blobs = `${this.file}.blobs`;
      await mkdir(blobs, { recursive: true });
      await writeFileAtomic(path.join(blobs, digest), value, { mode: 0o600 });
      return { $type: EXTERNAL_BUFFER_TAG, sha256: digest, length: value.length };
    }
    if (Array.isArray(value)) return Promise.all(value.map(item => this.externalizeBuffers(item)));
    if (value && typeof value === 'object' && !(value instanceof Date)
      && !Buffer.isBuffer(value)) {
      return Object.fromEntries(await Promise.all(Object.entries(value)
        .map(async ([key, item]) => [key, await this.externalizeBuffers(item)])));
    }
    return value;
  }

  private async leaseOwnerAlive(lock: string): Promise<boolean> {
    try {
      const ownerText = await readFile(path.join(lock, 'owner.json'), 'utf8');
      const owner = JSON.parse(ownerText) as { pid?: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid! < 1) return false;
      process.kill(owner.pid!, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async acquireLease(): Promise<{ token: string; ownerFile: string }> {
    const lock = `${this.file}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await mkdir(lock, { recursive: false });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > 20_000
            && !(await this.leaseOwnerAlive(lock))) {
            await rm(lock, { recursive: true, force: true });
            continue;
          }
        } catch (leaseError) {
          if ((leaseError as NodeJS.ErrnoException).code !== 'ENOENT') throw leaseError;
        }
        if (Date.now() >= deadline) throw new Error('JOURNAL_LEASE_HELD');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const ownerFile = path.join(lock, 'owner.json');
    await writeFileAtomic(ownerFile, `${JSON.stringify({ token, pid: process.pid })}\n`);
    return { token, ownerFile };
  }

  private async assertLease(lease: { token: string; ownerFile: string }): Promise<void> {
    const owner = JSON.parse(await readFile(lease.ownerFile, 'utf8')) as { token?: string };
    if (owner.token !== lease.token) throw new Error('JOURNAL_LEASE_LOST');
  }

  private async releaseLease(lease: { token: string; ownerFile: string }): Promise<void> {
    try {
      await this.assertLease(lease);
      await rm(path.dirname(lease.ownerFile), { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  begin(key: string, proposed: LiminalOperationAdmission): Promise<LiminalOperationAdmission> {
    return this.transition(state => {
      const existing = state.operations[key];
      if (existing) {
        if (existing.commandDigest !== proposed.commandDigest) throw new Error('IDEMPOTENCY_KEY_REBOUND');
        return [state, existing];
      }
      const admitted = Object.freeze({ ...proposed, attemptsConsumed: 0 });
      const event = Object.freeze({ operationId: admitted.operationId,
        ordinal: state.events.length + 1, type: 'command-accepted' as const,
        payloadDigest: payloadDigest({ commandDigest: admitted.commandDigest,
          lineageId: admitted.lineageId }) });
      return [{ ...state, events: [...state.events, event],
        operations: { ...state.operations, [key]: admitted } }, admitted];
    });
  }

  reserveTransportAttempt(operationId: string, maximum: number, payload: unknown): Promise<number> {
    return this.transition(state => {
      const entry = Object.entries(state.operations)
        .find(([, operation]) => operation.operationId === operationId);
      if (!entry) throw new Error('UNKNOWN_LIMINAL_OPERATION');
      const [key, operation] = entry;
      if (operation.attemptsConsumed >= maximum) throw new Error('TRANSPORT_ATTEMPT_CAP_EXHAUSTED');
      const attempt = operation.attemptsConsumed + 1;
      const updated = Object.freeze({ ...operation, attemptsConsumed: attempt });
      const event = Object.freeze({ operationId, ordinal: state.events.length + 1,
        type: 'transport-started' as const, payloadDigest: payloadDigest({ ...payload as object, attempt }) });
      return [{ ...state, events: [...state.events, event],
        operations: { ...state.operations, [key]: updated } }, attempt];
    });
  }

  failTransportAttempt(operationId: string, reason?: unknown): Promise<void> {
    return this.transition(state => {
      const entry = Object.entries(state.operations)
        .find(([, operation]) => operation.operationId === operationId);
      if (!entry) throw new Error('UNKNOWN_LIMINAL_OPERATION');
      const [key, operation] = entry;
      // A timed-out attempt may have been billed: count it, never refund it (#1323).
      if (classifyEffectFailure(reason) === 'ambiguous') {
        const event = Object.freeze({ operationId, ordinal: state.events.length + 1,
          type: 'transport-failed' as const,
          payloadDigest: payloadDigest({ released: 0, outcome: 'ambiguous' }) });
        return [{ ...state, events: [...state.events, event] }, undefined];
      }
      if (operation.attemptsConsumed <= 0) return [state, undefined];
      const updated = Object.freeze({ ...operation,
        attemptsConsumed: operation.attemptsConsumed - 1 });
      const event = Object.freeze({ operationId, ordinal: state.events.length + 1,
        type: 'transport-failed' as const,
        payloadDigest: payloadDigest({ released: operation.attemptsConsumed }) });
      return [{ ...state, events: [...state.events, event],
        operations: { ...state.operations, [key]: updated } }, undefined];
    });
  }

  authorizeDomain(operationId: string, domain: string): Promise<void> {
    return this.append(operationId, 'domain-authorized', { domain });
  }

  reserveEffect(operationId: string, kind: LiminalEffectKind,
    payload: unknown): Promise<LiminalEffectReservation> {
    return this.transition(state => {
      if (!Object.values(state.operations).some(value => value.operationId === operationId)) {
        throw new Error('UNKNOWN_LIMINAL_OPERATION');
      }
      const prior = Object.values(state.effects).find(effect =>
        effect.reservation.operationId === operationId && effect.reservation.kind === kind);
      if (prior) {
        if (prior.state === 'reserved') return [state, prior.reservation];
        // A prior attempt that failed should not permanently block retries.
        // Drop the stale reservation and mint a fresh one; the audit trail
        // for the failed attempt is preserved in the events log (#865).
        if (prior.state !== 'failed') throw new Error('EFFECT_OUTCOME_UNRESOLVED');
      }
      const reservation = Object.freeze({ operationId, kind,
        effectId: `effect:${randomUUID()}`,
        capability: randomBytes(32).toString('hex'), fence: state.nextFence });
      const event = this.event(state, operationId, 'effect-reserved', {
        kind, effectId: reservation.effectId, fence: reservation.fence, payload });
      const effects = { ...state.effects };
      if (prior) delete effects[prior.reservation.effectId];
      return [{ ...state, events: [...state.events, event], nextFence: state.nextFence + 1,
        effects: { ...effects, [reservation.effectId]: {
          reservation, state: 'reserved' as const } } }, reservation];
    });
  }

  startEffect(reservation: LiminalEffectReservation): Promise<void> {
    return this.updateEffect(reservation, 'reserved', 'started', 'effect-started', {});
  }

  async completedEffect<T>(operationId: string, kind: LiminalEffectKind): Promise<T | null> {
    await this.queue;
    const effect = Object.values((await this.read()).effects).find(item =>
      item.reservation.operationId === operationId && item.reservation.kind === kind);
    if (effect?.state !== 'succeeded' || !('result' in effect)) return null;
    const result = await decodeDurableValue(effect.result, `${this.file}.blobs`);
    // A succeeded effect whose stored bytes no longer match their digest is an
    // integrity fault, not "no result": returning null would invite a second
    // invocation of an effect that already happened (#1323).
    if (effect.resultDigest !== payloadDigest(result)) {
      throw new Error('EFFECT_RESULT_DIGEST_MISMATCH');
    }
    return result as T;
  }

  completeEffect<T>(reservation: LiminalEffectReservation, result: T): Promise<void> {
    return this.transition(async state => {
      const effect = state.effects[reservation.effectId];
      if (!effect || effect.reservation.capability !== reservation.capability
        || effect.reservation.fence !== reservation.fence) {
        throw new Error('INVALID_EFFECT_CAPABILITY');
      }
      const resultDigest = payloadDigest(result);
      if (effect.state === 'succeeded' && effect.resultDigest === resultDigest) {
        return [state, undefined];
      }
      if (effect.state !== 'started') throw new Error('EFFECT_NOT_STARTED');
      const storedResult = await this.externalizeBuffers(result);
      const event = this.event(state, reservation.operationId, 'effect-result', {
        effectId: reservation.effectId, kind: reservation.kind,
        fence: reservation.fence, outcome: 'succeeded', resultDigest });
      return [{ ...state, schemaVersion: 4, events: [...state.events, event], effects: {
        ...state.effects, [reservation.effectId]: { ...effect,
          state: 'succeeded', result: storedResult, resultDigest },
      } }, undefined];
    });
  }

  finishEffect(reservation: LiminalEffectReservation,
    outcome: LiminalEffectOutcome, payload: unknown): Promise<void> {
    return this.updateEffect(reservation, 'started', outcome, 'effect-result', payload);
  }

  linkProjection(operationId: string, domain: 'campaign' | 'dream',
    projectionDigest: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(projectionDigest)) {
      return Promise.reject(new Error('DOMAIN_PROJECTION_DIGEST_INVALID'));
    }
    const expected = payloadDigest({ domain, projectionDigest });
    return this.transition(state => state.events.some(event => event.operationId === operationId
      && event.type === 'domain-projection-linked' && event.payloadDigest === expected)
      ? [state, undefined]
      : [{ ...state, events: [...state.events, this.event(state, operationId,
        'domain-projection-linked', { domain, projectionDigest })] }, undefined]);
  }

  async attemptsConsumed(operationId: string): Promise<number> {
    await this.queue;
    const operation = Object.values((await this.read()).operations)
      .find(candidate => candidate.operationId === operationId);
    return operation?.attemptsConsumed ?? 0;
  }

  append(operationId: string, type: LiminalOperationEventType, payload: unknown): Promise<void> {
    return this.mutate(state => ({
      ...state,
      events: [...state.events, Object.freeze({
        operationId,
        ordinal: state.events.length + 1,
        type,
        payloadDigest: payloadDigest(payload),
      })],
    }));
  }

  async findByIdempotencyKey(key: string): Promise<LiminalCommandResult | null> {
    await this.queue;
    return (await this.read()).results[key] ?? null;
  }

  bindResult(key: string, result: LiminalCommandResult): Promise<void> {
    return this.mutate(state => ({
      ...state,
      results: { ...state.results, [key]: result },
    }));
  }

  async events(): Promise<readonly LiminalOperationEvent[]> {
    await this.queue;
    return [...(await this.read()).events];
  }

  async eventsForOperation(operationId: string): Promise<readonly LiminalOperationEvent[]> {
    await this.queue;
    return (await this.read()).events.filter(event => event.operationId === operationId);
  }

  private mutate(transform: (state: JournalState) => JournalState): Promise<void> {
    return this.transition(state => [transform(state), undefined]);
  }

  private event(state: JournalState, operationId: string,
    type: LiminalOperationEventType, payload: unknown): LiminalOperationEvent {
    return Object.freeze({ operationId, ordinal: state.events.length + 1,
      type, payloadDigest: payloadDigest(payload) });
  }

  private updateEffect(reservation: LiminalEffectReservation,
    expected: 'reserved' | 'started', next: 'started' | LiminalEffectOutcome,
    type: 'effect-started' | 'effect-result', payload: unknown): Promise<void> {
    return this.mutate(state => {
      const effect = state.effects[reservation.effectId];
      if (!effect
        || effect.reservation.capability !== reservation.capability
        || effect.reservation.operationId !== reservation.operationId
        || effect.reservation.kind !== reservation.kind
        || effect.reservation.fence !== reservation.fence) {
        throw new Error('INVALID_EFFECT_CAPABILITY');
      }
      if (effect.state !== expected) {
        throw new Error(expected === 'reserved'
          ? 'EFFECT_RESERVATION_ALREADY_CLAIMED' : 'EFFECT_NOT_STARTED');
      }
      const event = this.event(state, reservation.operationId, type, {
        effectId: reservation.effectId, kind: reservation.kind,
        fence: reservation.fence, ...payload as object });
      return { ...state, events: [...state.events, event], effects: {
        ...state.effects, [reservation.effectId]: { ...effect, state: next },
      } };
    });
  }

  private transition<T>(transform: (state: JournalState, needsWrite: boolean) =>
    readonly [JournalState, T] | Promise<readonly [JournalState, T]>): Promise<T> {
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const lease = await this.acquireLease();
      try {
        const { state, needsWrite } = await this.readWithMigration();
        const [next, result] = await transform(state, needsWrite);
        await this.assertLease(lease);
        if (next !== state || needsWrite) {
          await writeFileAtomic(this.file,
            `${JSON.stringify(encodeLiminalDurableValue(next))}\n`);
        }
        return result;
      } finally {
        await this.releaseLease(lease);
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async read(): Promise<JournalState> {
    return (await this.readWithMigration()).state;
  }

  private async readWithMigration(): Promise<{ state: JournalState; needsWrite: boolean }> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      return { state: validateState(stored),
        needsWrite: ![3, 4].includes((stored as { schemaVersion?: number }).schemaVersion ?? 0) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: EMPTY_STATE, needsWrite: true };
      }
      throw error;
    }
  }
}
