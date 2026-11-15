import { describe, it, expect } from 'vitest';
import {
  EmptyArtifactFailure,
  isEmptyArtifactFailure,
} from '../../../src/runtime-core/emptyArtifactFailure.js';

const baseMetadata = {
  providerFamily: 'lmstudio',
  modelId: 'qwen2.5-coder-7b',
  requestedExecutor: 'qwen',
  resolvedExecutor: 'qwen2.5-coder-7b',
  toolName: 'validate_syntax',
  toolCallId: 'call-1',
  finishReason: 'stop',
  noToolsRetryAttempted: true,
  repairAttempted: false,
  causalTrace: [
    { stage: 'request', durationMs: 4 },
    { stage: 'assistant_payload', outcome: 'empty' }
  ],
};

describe('EmptyArtifactFailure — first-class typed failure (#717 / W8C-04)', () => {
  it('extends Error and exposes the typed failure reason', () => {
    const err = new EmptyArtifactFailure({
      failureReason: 'empty-artifact',
      message: 'LLM returned empty code',
      domain: 'p5',
      metadata: baseMetadata,
      upstreamError: 'no assistant payload',
      attemptId: 'attempt-1',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.failureReason).toBe('empty-artifact');
    expect(err.domain).toBe('p5');
    expect(err.attemptId).toBe('attempt-1');
    expect(err.upstreamError).toBe('no assistant payload');
    expect(err.isEmptyArtifact()).toBe(true);
  });

  it('isEmptyArtifactFailure() returns false for unrelated errors', () => {
    expect(isEmptyArtifactFailure(new Error('nope'))).toBe(false);
    expect(isEmptyArtifactFailure(null)).toBe(false);
    expect(isEmptyArtifactFailure({ message: 'plain object' })).toBe(false);
  });

  it('isEmptyArtifactFailure() returns true for the failure class', () => {
    const err = new EmptyArtifactFailure({
      failureReason: 'empty-artifact',
      message: 'empty',
      domain: 'svg',
      metadata: baseMetadata,
    });
    expect(isEmptyArtifactFailure(err)).toBe(true);
  });

  it('fingerprint is stable across equal metadata + failureReason', () => {
    const a = new EmptyArtifactFailure({
      failureReason: 'empty-artifact',
      message: 'm',
      domain: 'p5',
      metadata: baseMetadata,
    });
    const b = new EmptyArtifactFailure({
      failureReason: 'empty-artifact',
      message: 'm',
      domain: 'p5',
      metadata: baseMetadata,
    });
    expect(a.fingerprint()).toBe(b.fingerprint());
  });

  it('fingerprint changes when provider/model/tool/reason differ', () => {
    const a = new EmptyArtifactFailure({
      failureReason: 'empty-artifact',
      message: 'm',
      domain: 'p5',
      metadata: baseMetadata,
    });
    const b = new EmptyArtifactFailure({
      failureReason: 'empty-artifact',
      message: 'm',
      domain: 'three',
      metadata: { ...baseMetadata, modelId: 'different-model' },
    });
    expect(a.fingerprint()).not.toBe(b.fingerprint());
  });

  it('metadata is frozen (cannot be mutated)', () => {
    const err = new EmptyArtifactFailure({
      failureReason: 'empty-artifact',
      message: 'm',
      domain: 'p5',
      metadata: baseMetadata,
    });
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err.metadata as any).providerFamily = 'mutated';
    }).toThrow();
  });

  it('preserves causalTrace information for ranking without log parsing', () => {
    const err = new EmptyArtifactFailure({
      failureReason: 'timeout',
      message: 'timed out',
      domain: 'tone',
      metadata: baseMetadata,
    });
    expect(err.metadata.causalTrace).toHaveLength(2);
    expect(err.metadata.causalTrace[0].stage).toBe('request');
    expect(err.metadata.causalTrace[1].outcome).toBe('empty');
  });
});
