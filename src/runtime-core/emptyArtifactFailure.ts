/**
 * EmptyArtifactFailure — first-class typed failure for empty tool-loop output
 * (#717 / W8C-04).
 *
 * Unlike the legacy "generic retry" message, EmptyArtifactFailure carries the
 * full response/tool metadata and a causal trace: which tool returned empty,
 * which provider/model produced it, the finishReason, and the upstream error.
 * This lets downstream consumers rank empty-artifact causes by
 * provider/model/domain/tool without parsing log lines.
 */

import { GenerationError } from '../errors/GenerationError.js';
import { GenerationAttemptFailureReason } from '../telemetry/generationAttemptEvent.js';

/** Bounded, redacted metadata about the upstream empty response. */
export interface EmptyArtifactMetadata {
  providerFamily: string | null;
  modelId: string | null;
  requestedExecutor: string | null;
  resolvedExecutor: string | null;
  toolName: string | null;
  toolCallId: string | null;
  finishReason: string | null;
  /** True when a no-tools retry was attempted and also returned empty. */
  noToolsRetryAttempted: boolean;
  /** True when a harness-guided repair prompt was attempted. */
  repairAttempted: boolean;
  /** Causal trace of stages that executed before the empty result. */
  causalTrace: ReadonlyArray<EmptyArtifactTraceStage>;
}

export interface EmptyArtifactTraceStage {
  stage: string;
  durationMs?: number;
  toolStatus?: string;
  outcome?: string;
}

export interface EmptyArtifactFailureInit {
  failureReason: GenerationAttemptFailureReason;
  message: string;
  domain: string;
  metadata: EmptyArtifactMetadata;
  /** Optional underlying provider error string (redacted). */
  upstreamError?: string;
  /** Attempt that produced the empty result — used to link the recovery event. */
  attemptId?: string;
}

export class EmptyArtifactFailure extends GenerationError {
  readonly failureReason: GenerationAttemptFailureReason;
  // domain is inherited from GenerationError
  readonly metadata: EmptyArtifactMetadata;
  readonly upstreamError?: string;
  readonly attemptId?: string;

  constructor(init: EmptyArtifactFailureInit) {
    super(init.message, init.domain, {
      failureReason: init.failureReason,
      ...(init.upstreamError !== undefined ? { upstreamError: init.upstreamError } : {}),
      ...(init.attemptId !== undefined ? { attemptId: init.attemptId } : {}),
    });
    this.name = 'EmptyArtifactFailure';
    this.failureReason = init.failureReason;
    this.metadata = Object.freeze(init.metadata);
    if (init.upstreamError !== undefined) this.upstreamError = init.upstreamError;
    if (init.attemptId !== undefined) this.attemptId = init.attemptId;
  }

  /** True when this represents the spec's named "empty-artifact" failure class. */
  isEmptyArtifact(): boolean {
    return this.failureReason === 'empty-artifact';
  }

  /** Stable fingerprint for telemetry aggregation without log parsing. */
  fingerprint(): string {
    const m = this.metadata;
    return [
      this.failureReason,
      m.providerFamily ?? 'unknown',
      m.modelId ?? 'unknown',
      this.domain,
      m.toolName ?? 'no-tool',
      m.finishReason ?? 'unknown'
    ].join('|');
  }
}

/** Type guard for EmptyArtifactFailure */
export function isEmptyArtifactFailure(err: unknown): err is EmptyArtifactFailure {
  return err instanceof EmptyArtifactFailure;
}
