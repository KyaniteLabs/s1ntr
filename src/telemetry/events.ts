/**
 * Event-specific payload types for the system-agnostic Sinter event ledger.
 *
 * Envelope (`SinterEvent`) lives in EventLedger.ts and deliberately imports
 * nothing from Sinter domains so sibling projects can rehost the contract.
 * These payloads are typed for producers inside this repo.
 */

/** FitnessObservation v1 fields nested under generation.scored.payload */
export interface GenerationScoredPayload {
  schemaVersion: 1;
  timestamp: string;
  runId: string;
  episodeId: string | null;
  domain: string;
  provider: string | null;
  model: string | null;
  sourceFingerprint: string;
  score: number;
  confidence: number;
  failureClass: string;
  honest: boolean;
  graduationEligible: boolean;
  activeAdaptationIds: string[];
  cohort: 'control' | 'treatment';
}

/** Evaluator verdict including vision evidence refs + degraded flag */
export interface EvalVerdictPayload {
  score?: number;
  confidence?: number;
  failureClass?: string;
  degraded: boolean;
  reason?: string;
  /** Vision / render evidence references (paths or labeled refs) */
  visionEvidenceRefs?: string[];
}

/** Harness tool boundary — args hashed, never raw secrets / freeform errors */
export interface HarnessActionPayload {
  tool: string;
  argsHash: string;
  outcome: 'success' | 'failure' | 'error';
  /** Bounded error class only — never raw tool error prose */
  errorClass?:
    | 'string_not_found'
    | 'timeout'
    | 'rate_limit'
    | 'permission_denied'
    | 'not_found'
    | 'tool_error';
  durationMs?: number;
}

/** Harness LLM call start — seat-attributed planning/completion request */
export interface HarnessCallStartPayload {
  phase: 'plan' | 'complete' | 'recover';
  step?: number;
}

/** Harness LLM call end — latency + optional token usage (incl. thinking) */
export interface HarnessCallEndPayload {
  phase: 'plan' | 'complete' | 'recover';
  step?: number;
  success: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  errorClass?: string;
}

/** Harness step — tool planned or executed (args hashed only) */
export interface HarnessStepPayload {
  phase: 'planned' | 'executed';
  step: number;
  tool: string;
  argsHash?: string;
  outcome?: 'success' | 'failure' | 'error' | 'skipped';
  errorClass?: string;
  durationMs?: number;
}

/** Harness pass complete — one bounded self-improve / agent task */
export interface HarnessPassCompletePayload {
  steps: number;
  /** True when at least one verified mutation succeeded */
  verifiedEdit: boolean;
  /** True when the pass rolled back mutations */
  rollback: boolean;
  status: string;
  /** Honest gap marker when any ledger write failed during the pass */
  telemetryGap?: boolean;
}

/** Fail-open gap marker when a harness ledger write fails */
export interface HarnessTelemetryGapPayload {
  failedEvent: string;
  reason: string;
}

/** Free-form seat observation */
export interface SeatObservationPayload {
  note: string;
  seat: string;
  actorModel: string;
}

/** Audition result with blind-pick placeholder */
export interface AuditionResultPayload {
  configLabel: string;
  domain: string;
  scores: Record<string, number>;
  /** Reserved for future blind A/B pick; null until implemented */
  blindPick: string | null;
}

export type EventPayloadByName = {
  'generation.scored': GenerationScoredPayload;
  'eval.verdict': EvalVerdictPayload;
  'harness.action': HarnessActionPayload;
  'harness.call.start': HarnessCallStartPayload;
  'harness.call.end': HarnessCallEndPayload;
  'harness.step': HarnessStepPayload;
  'harness.pass.complete': HarnessPassCompletePayload;
  'harness.telemetryGap': HarnessTelemetryGapPayload;
  'seat.observation': SeatObservationPayload;
  'audition.result': AuditionResultPayload;
};

export type KnownEventName = keyof EventPayloadByName;

/** Lane derived from dotted event name (generation.scored → generation) */
export function laneForEvent(event: string): string {
  const dot = event.indexOf('.');
  return dot === -1 ? event : event.slice(0, dot);
}
