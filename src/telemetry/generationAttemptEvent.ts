/**
 * GenerationAttemptEvent v1 — structured telemetry for tool-loop generator attempts
 * (#717 / W8C-04).
 *
 * Every tool-loop generation attempt emits one event per stage transition so the
 * causal chain (request → tool selection → tool calls → assistant payload →
 * extracted artifact → validation → failure class) can be reconstructed without
 * parsing log lines. Events remain linkable to the lineage of a recovered
 * attempt (the recovered event links back to the failed primary attempt).
 *
 * Redaction contract: events MUST NOT carry raw credentials, raw system/user
 * prompts, private memory, or unrestricted tool payloads. Payloads are
 * represented only by byte length + a redaction-safe SHA-256; generated source
 * is never persisted raw.
 */

import type { ExecutorAttestationRef } from '../identity/harnessTransportGuard.js';

export const GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION = 1 as const;
export const GENERATION_ATTEMPT_EVENT_NAME = 'generation.attempt' as const;

/** GenerationAttemptEvent v1 stages — strict ordering per spec. */
export type GenerationAttemptStage =
  | 'request'
  | 'tool_selection'
  | 'tool_call'
  | 'tool_result'
  | 'assistant_payload'
  | 'extracted_artifact'
  | 'validation'
  | 'failure_class'
  | 'recovery_decision'
  | 'terminal';

/** GenerationAttemptEvent v1 typed failure reasons — bounded enumeration. */
export type GenerationAttemptFailureReason =
  | 'empty-artifact'
  | 'malformed_assistant_payload'
  | 'tool_call_without_artifact'
  | 'malformed_tool_result'
  | 'extraction_failed'
  | 'validation_failed'
  | 'timeout'
  | 'provider_denied'
  | 'recovery_exhausted'
  | 'consumer_abort'
  | 'unknown';

/** GenerationAttemptEvent v1 tool-call/result status. */
export type GenerationAttemptToolStatus = 'success' | 'error' | 'skipped' | 'forbidden';

/** GenerationAttemptEvent v1 extraction/validation outcomes. */
export type GenerationAttemptOutcome = 'pass' | 'fail' | 'skip';

/** GenerationAttemptEvent v1 recovery decision. */
export type GenerationAttemptRecoveryDecision =
  | 'no_recovery'
  | 'repaired_tools'
  | 'recovered_no_tools'
  | 'terminal_failure';

export interface GenerationAttemptRedactionMetadata {
  schemaVersion: typeof GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION;
  /** Schema guarantees: never raw prompts, never secrets, never memory. */
  redactedPrompts: true;
  redactedSecrets: true;
  redactedMemory: true;
  redactedToolPayloads: true;
}

/**
 * GenerationAttemptEvent v1 — single stage transition for one tool-loop attempt.
 * Records identity, stage, safe tool name, byte lengths, outcome, timing, and
 * recovery link.
 */
export interface GenerationAttemptEventV1 {
  schemaVersion: typeof GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION;
  /** Run / candidate / attempt IDs — same shape across provider attempts. */
  runId: string;
  candidateId: string;
  attemptId: string;
  /** Monotonic per-(run,candidate) ordinal hydrated from the durable ledger. */
  attemptOrdinal: number;
  /** Composed "<runId>/<candidateId>/<attemptId>" for log-friendly display. */
  lineageId: string;
  /** Stage this event represents. */
  stage: GenerationAttemptStage;
  /** ISO timestamp at emission time. */
  timestamp?: string;
  /** Provider-attested (or, pre-W8C-03, model string) requested executor. */
  requestedExecutor?: string;
  /** Provider-resolved executor (e.g. resolved model after fallback chain). */
  resolvedExecutor?: string;
  /** Deterministic request/run/attempt digest of the executor reservation. */
  executorReservationDigest?: string;
  /** Host-signed finite-campaign reservation binding, when campaign governed. */
  campaignFundingReservationDigest?: string;
  /**
   * Pre-transport correlation digests stamped on every event for the logical
   * attempt. Recorded before the provider call so post-transport attestation
   * binding can be correlated exactly (#717 / W8C-04).
   */
  requestDigest?: string;
  routeDigest?: string;
  /**
   * Exact post-transport binding for this event. Earlier events remain
   * immutable when later retries or fallbacks complete. `undefined` means the
   * event is explicitly unattested (no signed receipt); never fabricated.
   */
  attemptDigest?: string;
  attestationDigest?: string;
  /** Tool name (when stage is tool selection/call/result). */
  toolName?: string;
  /** Status of the tool call/result (omitted for non-tool stages). */
  toolStatus?: GenerationAttemptToolStatus;
  /** Byte length of payload before truncation/redaction. */
  payloadByteLength?: number;
  /** Redaction-safe SHA-256 of the raw payload (content/tool args). Never raw. */
  payloadDigest?: string;
  /** Extraction outcome (only on extraction stage). */
  extractionOutcome?: GenerationAttemptOutcome;
  /** Validation outcome (only on validation stage). */
  validationOutcome?: GenerationAttemptOutcome;
  /** Typed failure class (only on failure_class stage). */
  failureReason?: GenerationAttemptFailureReason;
  /** Recovery decision (only on recovery_decision / terminal). */
  recoveryDecision?: GenerationAttemptRecoveryDecision;
  /** Linkage: when this attempt is a recovery of a prior failed attempt. */
  recoveryOfAttemptId?: string;
  /** Linkage: when this attempt triggered a recovery. */
  recoveredByAttemptId?: string;
  /** Stage timing in milliseconds. */
  durationMs?: number;
  /** Domain (per-tier classification). */
  domain?: string;
  /** Provider family — derived from baseUrl/host, used for telemetry aggregation only. */
  providerFamily?: string;
}

/** Durable resource deltas charged at the exact boundary that consumed them. */
export interface GenerationAttemptCounterDelta {
  providerCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  retries?: number;
  activeTimeMs?: number;
  quotaUnits?: number;
}

/** Narrow shared-transport seam used by LLMClient and the composition runtime. */
export interface GenerationAttemptTelemetryContext {
  runId: string;
  candidateId: string;
  attemptId: string;
  attemptOrdinal: number;
  domain?: string;
  recoveryOfAttemptId?: string;
  /** Narrow #716 adapter: host-signed executor reservation digest only. */
  executorReservationDigest?: string;
  campaignFundingReservationDigest?: string;
  /**
   * Ordered signed completion refs collected for this logical attempt so far.
   * The ledger reads this list after every emit to preserve ordered bindings
   * and stamp only the exact event that received them (#717 / W8C-04).
   */
  executorAttestations?: readonly ExecutorAttestationRef[];
  emit: (
    event: GenerationAttemptEventV1,
    counters?: GenerationAttemptCounterDelta,
    /** Latest signed completion ref(s) to bind atomically to this attempt. */
    attestations?: readonly ExecutorAttestationRef[],
  ) => void | Promise<void>;
}

export const GENERATION_ATTEMPT_EVENT_REDACTION: GenerationAttemptRedactionMetadata = {
  schemaVersion: GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION,
  redactedPrompts: true,
  redactedSecrets: true,
  redactedMemory: true,
  redactedToolPayloads: true,
};

const SHA256_HEX_LENGTH = 64;

function isHex64(s: unknown): s is string {
  return typeof s === 'string'
    && s.length === SHA256_HEX_LENGTH
    && /^[0-9a-f]{64}$/.test(s);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`GenerationAttemptEvent: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Redaction-safe constructor for GenerationAttemptEvent v1. Strips or rejects
 * raw prompts, credentials, and unrestricted tool payloads before producing
 * the event.
 */
export function buildGenerationAttemptEventV1(
  partial: Omit<GenerationAttemptEventV1, 'schemaVersion' | 'lineageId' | 'attemptOrdinal'> & {
    runId: string;
    candidateId: string;
    attemptId: string;
    attemptOrdinal?: number;
    stage: GenerationAttemptStage;
  }
): GenerationAttemptEventV1 {
  const runId = asNonEmptyString(partial.runId, 'runId');
  const candidateId = asNonEmptyString(partial.candidateId, 'candidateId');
  const attemptId = asNonEmptyString(partial.attemptId, 'attemptId');
  const attemptOrdinal = partial.attemptOrdinal ?? 1;
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) {
    throw new Error('GenerationAttemptEvent: attemptOrdinal must be a positive integer');
  }

  if (partial.executorReservationDigest !== undefined
      && !isHex64(partial.executorReservationDigest)) {
    throw new Error(
      'GenerationAttemptEvent: executorReservationDigest must be 64-character hex SHA-256'
    );
  }
  if (partial.campaignFundingReservationDigest !== undefined
      && !isHex64(partial.campaignFundingReservationDigest)) {
    throw new Error(
      'GenerationAttemptEvent: campaignFundingReservationDigest must be 64-character hex SHA-256'
    );
  }
  for (const digestField of [
    'requestDigest', 'routeDigest', 'attemptDigest', 'attestationDigest', 'payloadDigest',
  ] as const) {
    const value = (partial as Record<string, unknown>)[digestField];
    if (value !== undefined && !isHex64(value)) {
      throw new Error(
        `GenerationAttemptEvent: ${digestField} must be 64-character hex SHA-256`
      );
    }
  }
  if (partial.payloadByteLength !== undefined) {
    if (!Number.isInteger(partial.payloadByteLength) || partial.payloadByteLength < 0) {
      throw new Error(
        'GenerationAttemptEvent: payloadByteLength must be a non-negative integer'
      );
    }
  }
  if (partial.durationMs !== undefined
      && (!Number.isFinite(partial.durationMs) || partial.durationMs < 0)) {
    throw new Error('GenerationAttemptEvent: durationMs must be a non-negative finite number');
  }

  // Reject raw credential-like keys if any accidental prompt snippets were
  // passed under field names that look like secrets. Bounded allow-list only.
  const FORBIDDEN_KEYS = ['password', 'secret', 'apiKey', 'authorization', 'cookie', 'session'] as const;
  const record = partial as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_KEYS) {
    if (key in record) {
      throw new Error(`GenerationAttemptEvent: redaction rejected forbidden field "${key}"`);
    }
  }

  const event: GenerationAttemptEventV1 = {
    schemaVersion: GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION,
    runId,
    candidateId,
    attemptId,
    attemptOrdinal,
    lineageId: `${runId}/${candidateId}/${attemptId}`,
    stage: partial.stage,
    timestamp: partial.timestamp ?? new Date().toISOString(),
  };

  if (partial.requestedExecutor !== undefined) event.requestedExecutor = partial.requestedExecutor;
  if (partial.resolvedExecutor !== undefined) event.resolvedExecutor = partial.resolvedExecutor;
  if (partial.executorReservationDigest !== undefined) {
    event.executorReservationDigest = partial.executorReservationDigest;
  }
  if (partial.campaignFundingReservationDigest !== undefined) {
    event.campaignFundingReservationDigest = partial.campaignFundingReservationDigest;
  }
  if (partial.requestDigest !== undefined) event.requestDigest = partial.requestDigest;
  if (partial.routeDigest !== undefined) event.routeDigest = partial.routeDigest;
  if (partial.attemptDigest !== undefined) event.attemptDigest = partial.attemptDigest;
  if (partial.attestationDigest !== undefined) event.attestationDigest = partial.attestationDigest;
  if (partial.toolName !== undefined) event.toolName = partial.toolName;
  if (partial.toolStatus !== undefined) event.toolStatus = partial.toolStatus;
  if (partial.payloadByteLength !== undefined) event.payloadByteLength = partial.payloadByteLength;
  if (partial.payloadDigest !== undefined) event.payloadDigest = partial.payloadDigest;
  if (partial.extractionOutcome !== undefined) event.extractionOutcome = partial.extractionOutcome;
  if (partial.validationOutcome !== undefined) event.validationOutcome = partial.validationOutcome;
  if (partial.failureReason !== undefined) event.failureReason = partial.failureReason;
  if (partial.recoveryDecision !== undefined) event.recoveryDecision = partial.recoveryDecision;
  if (partial.recoveryOfAttemptId !== undefined) event.recoveryOfAttemptId = partial.recoveryOfAttemptId;
  if (partial.recoveredByAttemptId !== undefined) event.recoveredByAttemptId = partial.recoveredByAttemptId;
  if (partial.durationMs !== undefined) event.durationMs = partial.durationMs;
  if (partial.domain !== undefined) event.domain = partial.domain;
  if (partial.providerFamily !== undefined) event.providerFamily = partial.providerFamily;

  return event;
}
