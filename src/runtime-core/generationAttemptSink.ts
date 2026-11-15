import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import {
  GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION,
  type GenerationAttemptCounterDelta,
  type GenerationAttemptEventV1,
  type GenerationAttemptFailureReason,
  type GenerationAttemptTelemetryContext,
} from '../telemetry/generationAttemptEvent.js';
import type { ExecutorAttestationRef } from '../identity/harnessTransportGuard.js';

export interface GenerationAttemptCounters {
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  activeTimeMs: number;
  quotaUnits: number;
}

export interface GenerationFailureProjection {
  failureClass: GenerationAttemptFailureReason;
  action: string;
  runId: string;
  candidateId: string;
  attemptId: string;
}

/**
 * Durable per-attempt binding of ordered signed completion refs. Keyed by
 * `attemptId` so concurrent attempts within a candidate (primary + recovery)
 * cannot cross-bind. Survives `FileGenerationAttemptPersistence` restart.
 */
export type AttemptAttestationBinding = Record<string, readonly ExecutorAttestationRef[]>;

export interface CandidateAttemptLedgerRecord {
  schemaVersion: 1;
  runId: string;
  candidateId: string;
  nextAttemptOrdinal: number;
  executorReservationDigest?: string;
  campaignFundingReservationDigest?: string;
  /**
   * Per-attemptId ordered signed completion refs. Preserved across restart.
   * Absence means the
   * attempt is explicitly unattested (no signed receipt); never fabricated.
   */
  attemptBindings?: AttemptAttestationBinding;
  recovery: {
    allowance: 1;
    consumedByAttemptId: string | null;
    recoveryAttemptId: string | null;
  };
  counters: GenerationAttemptCounters;
  events: GenerationAttemptEventV1[];
}

export interface GenerationAttemptPersistence {
  read(runId: string, candidateId: string): Promise<CandidateAttemptLedgerRecord | null>;
  write(record: CandidateAttemptLedgerRecord): Promise<void>;
  claim<T>(runId: string, candidateId: string, operation: () => Promise<T>): Promise<T>;
}

const ZERO_COUNTERS: GenerationAttemptCounters = {
  providerCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  retries: 0,
  activeTimeMs: 0,
  quotaUnits: 0,
};

function key(runId: string, candidateId: string): string {
  return createHash('sha256').update(`${runId}\0${candidateId}`).digest('hex');
}

function validateRecord(value: unknown): CandidateAttemptLedgerRecord {
  if (!value || typeof value !== 'object') throw new Error('Generation attempt ledger record is invalid');
  const record = value as CandidateAttemptLedgerRecord;
  if (record.schemaVersion !== 1 || !record.runId || !record.candidateId
    || !Number.isSafeInteger(record.nextAttemptOrdinal) || record.nextAttemptOrdinal < 1
    || record.recovery?.allowance !== 1 || !record.counters || !Array.isArray(record.events)) {
    throw new Error('Generation attempt ledger record is invalid');
  }
  if (record.attemptBindings !== undefined) {
    if (!record.attemptBindings || typeof record.attemptBindings !== 'object') {
      throw new Error('Generation attempt ledger record is invalid');
    }
    for (const refs of Object.values(record.attemptBindings)) {
      if (!Array.isArray(refs)) throw new Error('Generation attempt ledger record is invalid');
      for (const ref of refs) {
        if (!ref || typeof ref !== 'object' || typeof ref.attestationDigest !== 'string') {
          throw new Error('Generation attempt ledger record is invalid');
        }
      }
    }
  }
  return record;
}

export class MemoryGenerationAttemptPersistence implements GenerationAttemptPersistence {
  private readonly records = new Map<string, CandidateAttemptLedgerRecord>();
  private readonly pending = new Map<string, Promise<void>>();

  read(runId: string, candidateId: string): Promise<CandidateAttemptLedgerRecord | null> {
    const record = this.records.get(key(runId, candidateId));
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  write(record: CandidateAttemptLedgerRecord): Promise<void> {
    this.records.set(key(record.runId, record.candidateId), structuredClone(validateRecord(record)));
    return Promise.resolve();
  }

  async claim<T>(runId: string, candidateId: string, operation: () => Promise<T>): Promise<T> {
    const ledgerKey = key(runId, candidateId);
    const previous = this.pending.get(ledgerKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.pending.set(ledgerKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.pending.get(ledgerKey) === queued) this.pending.delete(ledgerKey);
    }
  }
}

const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 10;

export class FileGenerationAttemptPersistence implements GenerationAttemptPersistence {
  constructor(private readonly root: string) {}

  private file(runId: string, candidateId: string): string {
    return path.join(this.root, `${key(runId, candidateId)}.json`);
  }

  async read(runId: string, candidateId: string): Promise<CandidateAttemptLedgerRecord | null> {
    try {
      return validateRecord(JSON.parse(await readFile(this.file(runId, candidateId), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(record: CandidateAttemptLedgerRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFileAtomic(this.file(record.runId, record.candidateId), `${JSON.stringify(validateRecord(record))}\n`);
  }

  async claim<T>(runId: string, candidateId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const lock = `${this.file(runId, candidateId)}.lock`;
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const info = await stat(lock);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await rm(lock, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

function initialRecord(runId: string, candidateId: string): CandidateAttemptLedgerRecord {
  return {
    schemaVersion: 1,
    runId,
    candidateId,
    nextAttemptOrdinal: 1,
    recovery: { allowance: 1, consumedByAttemptId: null, recoveryAttemptId: null },
    counters: { ...ZERO_COUNTERS },
    events: [],
  };
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function failureAction(failureClass: GenerationAttemptFailureReason): string {
  switch (failureClass) {
    case 'timeout': return 'Retry after provider health recovers; the candidate recovery allowance is already bounded.';
    case 'provider_denied': return 'Check executor eligibility, funding, and provider access before retrying.';
    case 'malformed_tool_result': return 'Inspect the named tool contract and repair its structured result.';
    case 'validation_failed': return 'Repair the generated artifact against the domain validator.';
    case 'extraction_failed':
    case 'tool_call_without_artifact':
    case 'empty-artifact': return 'Inspect the tool-loop trace and repair artifact submission or extraction.';
    case 'recovery_exhausted': return 'Start a new candidate; this candidate has consumed its one recovery.';
    case 'consumer_abort': return 'The consumer stopped reading the completed provider stream.';
    default: return 'Inspect the redacted attempt trace before starting a new candidate.';
  }
}

export class GenerationAttemptLedger {
  constructor(private readonly persistence: GenerationAttemptPersistence) {}

  async beginPrimary(input: {
    runId: string;
    candidateId: string;
    attemptId?: string;
    domain?: string;
    executorReservationDigest?: string;
    campaignFundingReservationDigest?: string;
  }): Promise<GenerationAttemptTelemetryContext> {
    return this.persistence.claim(input.runId, input.candidateId, async () => {
      const record = await this.persistence.read(input.runId, input.candidateId)
        ?? initialRecord(input.runId, input.candidateId);
      if (input.executorReservationDigest !== undefined
        && !/^[0-9a-f]{64}$/.test(input.executorReservationDigest)) {
        throw new Error('Executor reservation digest must be SHA-256 hex');
      }
      if (record.executorReservationDigest && input.executorReservationDigest
        && record.executorReservationDigest !== input.executorReservationDigest) {
        throw new Error('Executor reservation digest changed within a candidate');
      }
      record.executorReservationDigest ??= input.executorReservationDigest;
      if (input.campaignFundingReservationDigest !== undefined
        && !/^[0-9a-f]{64}$/.test(input.campaignFundingReservationDigest)) {
        throw new Error('Campaign funding reservation digest must be SHA-256 hex');
      }
      if (record.campaignFundingReservationDigest && input.campaignFundingReservationDigest
        && record.campaignFundingReservationDigest !== input.campaignFundingReservationDigest) {
        throw new Error('Campaign funding reservation digest changed within a candidate');
      }
      record.campaignFundingReservationDigest ??= input.campaignFundingReservationDigest;
      const ordinal = record.nextAttemptOrdinal;
      record.nextAttemptOrdinal += 1;
      await this.persistence.write(record);
      return this.context({
        ...input,
        executorReservationDigest: record.executorReservationDigest,
        campaignFundingReservationDigest: record.campaignFundingReservationDigest,
        attemptId: input.attemptId ?? `attempt-${randomUUID()}`,
        attemptOrdinal: ordinal,
      });
    });
  }

  async reserveRecovery(input: {
    runId: string;
    candidateId: string;
    failedAttemptId: string;
    recoveryAttemptId?: string;
    domain?: string;
  }): Promise<{ granted: false; consumedByAttemptId: string | null } | {
    granted: true;
    context: GenerationAttemptTelemetryContext;
  }> {
    return this.persistence.claim(input.runId, input.candidateId, async () => {
      const record = await this.persistence.read(input.runId, input.candidateId)
        ?? initialRecord(input.runId, input.candidateId);
      if (record.recovery.consumedByAttemptId !== null) {
        return { granted: false as const, consumedByAttemptId: record.recovery.consumedByAttemptId };
      }
      const attemptId = input.recoveryAttemptId ?? `recovery-${randomUUID()}`;
      if (record.recovery.recoveryAttemptId && record.recovery.recoveryAttemptId !== attemptId) {
        throw new Error('Recovery attempt id changed within a candidate');
      }
      const ordinal = record.nextAttemptOrdinal;
      record.nextAttemptOrdinal += 1;
      record.recovery.consumedByAttemptId = input.failedAttemptId;
      record.recovery.recoveryAttemptId = attemptId;
      record.counters.retries += 1;
      await this.persistence.write(record);
      return {
        granted: true as const,
        context: this.context({
          ...input,
          attemptId,
          attemptOrdinal: ordinal,
          recoveryOfAttemptId: input.failedAttemptId,
          executorReservationDigest: record.executorReservationDigest,
          campaignFundingReservationDigest: record.campaignFundingReservationDigest,
        }),
      };
    });
  }

  async snapshot(runId: string, candidateId: string): Promise<CandidateAttemptLedgerRecord | null> {
    return this.persistence.read(runId, candidateId);
  }

  async failureProjection(runId: string, candidateId: string): Promise<GenerationFailureProjection | undefined> {
    const record = await this.persistence.read(runId, candidateId);
    const failure = [...(record?.events ?? [])].reverse().find((event) => event.stage === 'failure_class' && event.failureReason);
    if (!failure?.failureReason) return undefined;
    return {
      failureClass: failure.failureReason,
      action: failureAction(failure.failureReason),
      runId,
      candidateId,
      attemptId: failure.attemptId,
    };
  }

  private context(input: {
    runId: string;
    candidateId: string;
    attemptId: string;
    attemptOrdinal: number;
    domain?: string;
    recoveryOfAttemptId?: string;
    executorReservationDigest?: string;
    campaignFundingReservationDigest?: string;
  }): GenerationAttemptTelemetryContext {
    return {
      ...input,
      emit: (event, counters, attestations) => this.record(event, counters, input.attemptId, attestations),
    };
  }

  /**
   * Append new signed completion refs to the named logical attempt. Event
   * attribution is immutable: earlier events are never rewritten when a later
   * retry or fallback completes.
   */
  private applyAttestationBinding(
    record: CandidateAttemptLedgerRecord,
    attemptId: string,
    newRefs: readonly ExecutorAttestationRef[],
  ): void {
    if (newRefs.length === 0) return;
    if (!record.attemptBindings) record.attemptBindings = {};
    const existing = record.attemptBindings[attemptId] ?? [];
    // Dedup by attestationDigest — a retry of the same logical attempt must not
    // double-count the same signed receipt.
    const seen = new Set(existing.map((ref) => ref.attestationDigest));
    const merged = [...existing];
    for (const ref of newRefs) {
      if (!seen.has(ref.attestationDigest)) {
        merged.push(ref);
        seen.add(ref.attestationDigest);
      }
    }
    record.attemptBindings[attemptId] = Object.freeze(merged);
  }

  private async record(
    event: GenerationAttemptEventV1,
    delta: GenerationAttemptCounterDelta = {},
    attemptId: string,
    attestations?: readonly ExecutorAttestationRef[],
  ): Promise<void> {
    if (event.schemaVersion !== GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION) {
      throw new Error('Generation attempt event schema is unsupported');
    }
    await this.persistence.claim(event.runId, event.candidateId, async () => {
      const record = await this.persistence.read(event.runId, event.candidateId)
        ?? initialRecord(event.runId, event.candidateId);
      const exactRef = attestations?.at(-1);
      const stamped = exactRef
        ? {
          ...event,
          attestationDigest: exactRef.attestationDigest,
          attemptDigest: exactRef.attemptDigest,
          requestDigest: exactRef.requestDigest,
          routeDigest: exactRef.routeDigest,
        }
        : event;
      record.events.push(stamped);
      if (attestations && attestations.length > 0) {
        this.applyAttestationBinding(record, attemptId, attestations);
      }
      record.counters.providerCalls += nonNegative(delta.providerCalls);
      record.counters.inputTokens += nonNegative(delta.inputTokens);
      record.counters.outputTokens += nonNegative(delta.outputTokens);
      record.counters.retries += nonNegative(delta.retries);
      record.counters.activeTimeMs += nonNegative(delta.activeTimeMs);
      record.counters.quotaUnits += nonNegative(delta.quotaUnits);
      await this.persistence.write(record);
    });
  }
}
