/**
 * Unified compound-run envelope (Wave 7 / IW-S01).
 * Single artifact for identity, proofChain, provenance, and wave-gate inputs.
 * Terminal green only when mandatory fields + proofChain validate.
 */

import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Closed-set failure classes for diagnose / compound seats. */
export type CompoundFailureClass =
  | 'json-parse'
  | 'provider-timeout'
  | 'harness-deadline'
  | 'missing-plan'
  | 'provenance'
  | 'harmful-pattern-rejected'
  | 'auth'
  | 'other';

export interface ResolvedSeat {
  requestedModel?: string;
  resolvedModel: string;
  provider?: string;
  endpointHost?: string;
  branch?: string;
  commitSha?: string;
  /** True when worktree branch ≠ main but SHA matches authorized tip. */
  shaEqualsAuthorizedTip?: boolean;
}

export interface ProofChainStep {
  stage: 'prompt' | 'classify' | 'harvest' | 'memory-write' | 'guidance' | 'plan' | 'gate';
  at: string;
  ok: boolean;
  detail?: string;
  guidanceId?: string;
  patternId?: string;
}

export interface ProofChain {
  steps: ProofChainStep[];
  /** Guidance IDs applied (or emitted) for the next attempt. */
  guidanceIds: string[];
  lessonIds: string[];
  /**
   * L1 continuity: failed attempt that produced guidance → consumer attempt.
   * Gate may require producerAttemptId + consumerAttemptId + shared guidanceId.
   */
  continuity?: {
    producerAttemptId: string;
    consumerAttemptId: string;
    guidanceId: string;
  };
}

export interface CompoundRunEnvelope {
  version: 1;
  runId: string;
  attemptId: string;
  parentAttemptId?: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  seat: ResolvedSeat;
  outcome: 'pending' | 'ok' | 'fail' | 'timeout' | 'abort';
  failureClass?: CompoundFailureClass;
  proofChain: ProofChain;
  planReceiptPath?: string;
  planContentDigest?: string;
  batteryResult?: string;
  waveGate?: 'pending' | 'green' | 'red';
  waveGateReason?: string;
  /** Boundary timings (ms) — no prompt/secret payloads. */
  boundaryMs?: Partial<Record<ProofChainStep['stage'] | 'model-invoke', number>>;
  timeoutSource?: 'provider' | 'harness' | 'cancel' | 'queue' | 'unknown';
}

export function newRunIds(taskId: string): { runId: string; attemptId: string } {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  return { runId, attemptId: `${runId}_a1_${taskId.slice(0, 24)}` };
}

export function createEnvelope(input: {
  taskId: string;
  seat: ResolvedSeat;
  runId?: string;
  attemptId?: string;
  parentAttemptId?: string;
}): CompoundRunEnvelope {
  const ids = newRunIds(input.taskId);
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: input.runId ?? ids.runId,
    attemptId: input.attemptId ?? ids.attemptId,
    parentAttemptId: input.parentAttemptId,
    taskId: input.taskId,
    createdAt: now,
    updatedAt: now,
    seat: input.seat,
    outcome: 'pending',
    proofChain: { steps: [], guidanceIds: [], lessonIds: [] },
    waveGate: 'pending',
  };
}

export function appendProofStep(
  env: CompoundRunEnvelope,
  step: Omit<ProofChainStep, 'at'> & { at?: string },
): CompoundRunEnvelope {
  const next: CompoundRunEnvelope = {
    ...env,
    updatedAt: new Date().toISOString(),
    proofChain: {
      ...env.proofChain,
      steps: [
        ...env.proofChain.steps,
        { ...step, at: step.at ?? new Date().toISOString() },
      ],
      guidanceIds: step.guidanceId
        ? [...new Set([...env.proofChain.guidanceIds, step.guidanceId])]
        : env.proofChain.guidanceIds,
      lessonIds: step.patternId
        ? [...new Set([...env.proofChain.lessonIds, step.patternId])]
        : env.proofChain.lessonIds,
    },
  };
  return next;
}

export function digestPlanContent(planText: string): string {
  return createHash('sha256').update(planText).digest('hex').slice(0, 16);
}

/** Stable lesson identity from evidence (not timestamps). */
export function lessonIdentity(parts: {
  failureClass?: string;
  errorSnippet: string;
  domain?: string;
  scope?: string;
}): string {
  const raw = [
    parts.failureClass ?? 'other',
    parts.domain ?? '',
    parts.scope ?? '',
    parts.errorSnippet.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160),
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

export interface EnvelopeValidation {
  ok: boolean;
  reasons: string[];
}

/**
 * Fail-closed validation for wave-gate / green terminal.
 * Diagnose seats may pass with explicit no-verification stance via proofChain note.
 */
export function validateEnvelopeForGreen(env: CompoundRunEnvelope): EnvelopeValidation {
  const reasons: string[] = [];
  if (!env.runId) reasons.push('missing_runId');
  if (!env.attemptId) reasons.push('missing_attemptId');
  if (!env.seat?.resolvedModel) reasons.push('missing_resolvedModel');
  if (!env.proofChain || !Array.isArray(env.proofChain.steps)) {
    reasons.push('missing_proofChain');
  } else if (env.proofChain.steps.length === 0) {
    reasons.push('empty_proofChain');
  }
  if (env.outcome === 'timeout' || env.outcome === 'abort') {
    reasons.push(`terminal_non_green_outcome=${env.outcome}`);
  }
  if (env.outcome === 'fail') {
    reasons.push('outcome_fail');
  }
  if (env.seat.shaEqualsAuthorizedTip === false && env.seat.branch && env.seat.branch !== 'main') {
    // Only hard-fail when explicitly marked not equal; undefined is ok (unknown).
    reasons.push('worktree_sha_not_authorized');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Record two-attempt guidance continuity (L1 / Wave8 Sol residual).
 * Pure: returns new envelope; does not I/O.
 */
export function linkGuidanceContinuity(
  env: CompoundRunEnvelope,
  link: { producerAttemptId: string; consumerAttemptId: string; guidanceId: string },
): CompoundRunEnvelope {
  return {
    ...env,
    updatedAt: new Date().toISOString(),
    proofChain: {
      ...env.proofChain,
      continuity: { ...link },
      guidanceIds: [...new Set([...env.proofChain.guidanceIds, link.guidanceId])],
    },
  };
}


/** Fail-closed check used by gates that require recursive improvement proof. */
export function validateGuidanceContinuity(env: CompoundRunEnvelope): EnvelopeValidation {
  const c = env.proofChain?.continuity;
  const reasons: string[] = [];
  if (!c) {
    reasons.push('missing_guidance_continuity');
    return { ok: false, reasons };
  }
  if (!c.producerAttemptId || !c.consumerAttemptId || !c.guidanceId) {
    reasons.push('incomplete_guidance_continuity');
  }
  if (c.producerAttemptId === c.consumerAttemptId) {
    reasons.push('continuity_same_attempt');
  }
  if (!env.proofChain.guidanceIds.includes(c.guidanceId)) {
    reasons.push('continuity_guidance_not_in_chain');
  }
  return { ok: reasons.length === 0, reasons };
}


/**
 * Production multi-attempt requeue continuity (#471 / W9-L1-02).
 * Pure: if prior attempt was non-ok and retryable, link guidance onto current envelope.
 * First attempt / missing prior / non-retryable prior → no continuity requirement (single-shot safe).
 */
export function attachRequeueContinuity(input: {
  prior: CompoundRunEnvelope | null | undefined;
  current: CompoundRunEnvelope;
  guidanceId?: string;
}): {
  env: CompoundRunEnvelope;
  requireGuidanceContinuity: boolean;
  linked: boolean;
  guidanceId: string | null;
} {
  const prior = input.prior;
  if (!prior || prior.outcome === 'ok' || prior.outcome === 'pending') {
    return {
      env: input.current,
      requireGuidanceContinuity: false,
      linked: false,
      guidanceId: null,
    };
  }
  if (!isFailureRetryable(prior.failureClass)) {
    return {
      env: input.current,
      requireGuidanceContinuity: false,
      linked: false,
      guidanceId: null,
    };
  }
  const guidanceId =
    input.guidanceId ||
    lessonIdentity({
      failureClass: String(prior.failureClass || 'other'),
      errorSnippet: prior.waveGateReason || String(prior.failureClass || 'requeue'),
      domain: 'harness-requeue',
    });
  const env = linkGuidanceContinuity(input.current, {
    producerAttemptId: prior.attemptId,
    consumerAttemptId: input.current.attemptId,
    guidanceId,
  });
  return {
    env,
    requireGuidanceContinuity: true,
    linked: true,
    guidanceId,
  };
}

/** Pure wave-gate: only the envelope decides (IW-S05). */
export function evaluateWaveGate(
  env: CompoundRunEnvelope,
  opts?: { requireGuidanceContinuity?: boolean },
): {
  decision: 'green' | 'red';
  reason: string;
} {
  if (env.outcome !== 'ok') {
    return { decision: 'red', reason: `outcome=${env.outcome}` };
  }
  const v = validateEnvelopeForGreen(env);
  if (!v.ok) {
    return { decision: 'red', reason: v.reasons.join(';') };
  }
  if (opts?.requireGuidanceContinuity) {
    const c = validateGuidanceContinuity(env);
    if (!c.ok) {
      return { decision: 'red', reason: c.reasons.join(';') };
    }
  }
  return { decision: 'green', reason: 'envelope_ok' };
}

export function writeEnvelope(runDir: string, env: CompoundRunEnvelope): string {
  const dir = join(runDir, 'receipts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${env.taskId}-envelope.json`);
  writeFileSync(path, JSON.stringify(env, null, 2) + '\n', 'utf8');
  return path;
}

export function readEnvelope(path: string): CompoundRunEnvelope | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CompoundRunEnvelope;
  } catch {
    return null;
  }
}

/**
 * Timeout / abort retry policy (IW-S07 / IW-K03).
 * Attempt is non-green; logical task may retry when retryable=true.
 */
export function isFailureRetryable(failureClass: CompoundFailureClass | string | undefined): boolean {
  switch (failureClass) {
    case 'provider-timeout':
    case 'harness-deadline':
      return true;
    case 'json-parse':
    case 'missing-plan':
    case 'auth':
    case 'provenance':
    case 'harmful-pattern-rejected':
      return false;
    default:
      return false;
  }
}

export type TimeoutSource = NonNullable<CompoundRunEnvelope['timeoutSource']>;

/**
 * Single timeout taxonomy writer (H-TELEM-05 / W1 diagnose P0.1).
 * Prefer structured ownership over free-text — a provider abort whose message
 * contains "deadline" must stay provider-timeout when timeoutSource is set.
 */
export function classifyTimeoutError(
  messageOrOpts: string | { message?: string; timeoutSource?: TimeoutSource | null },
): CompoundFailureClass {
  if (typeof messageOrOpts === 'object' && messageOrOpts !== null) {
    const src = messageOrOpts.timeoutSource;
    if (src === 'provider' || src === 'queue') return 'provider-timeout';
    if (src === 'harness' || src === 'cancel') return 'harness-deadline';
    // unknown / unset → message fallback
    return classifyTimeoutError(String(messageOrOpts.message || ''));
  }
  const m = String(messageOrOpts || '').toLowerCase();
  if (!m) return 'other';
  if (m.includes('deadline') || m.includes('harness')) return 'harness-deadline';
  if (m.includes('timeout') || m.includes('aborted') || m.includes('abort')) return 'provider-timeout';
  return 'other';
}
