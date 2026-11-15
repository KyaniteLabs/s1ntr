import { describe, it, expect } from 'vitest';
import {
  GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION,
  buildGenerationAttemptEventV1,
} from '../../../src/telemetry/generationAttemptEvent.js';

const RUN = 'run-test';
const CANDIDATE = 'candidate-A';
const ATTEMPT = 'attempt-1';

const REQUIRED_BASE = {
  runId: RUN,
  candidateId: CANDIDATE,
  attemptId: ATTEMPT,
  stage: 'request' as const,
};

describe('GenerationAttemptEvent v1 schema (#717 / W8C-04)', () => {
  it('uses schemaVersion=1 and emits lineageId from run/candidate/attempt', () => {
    const event = buildGenerationAttemptEventV1(REQUIRED_BASE);
    expect(event.schemaVersion).toBe(GENERATION_ATTEMPT_EVENT_SCHEMA_VERSION);
    expect(event.schemaVersion).toBe(1);
    expect(event.runId).toBe(RUN);
    expect(event.candidateId).toBe(CANDIDATE);
    expect(event.attemptId).toBe(ATTEMPT);
    expect(event.lineageId).toBe(`${RUN}/${CANDIDATE}/${ATTEMPT}`);
    expect(event.stage).toBe('request');
    expect(typeof event.timestamp).toBe('string');
    expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('rejects negative payloadByteLength', () => {
    expect(() =>
      buildGenerationAttemptEventV1({
        ...REQUIRED_BASE,
        payloadByteLength: -1,
      })
    ).toThrow(/payloadByteLength/);
  });

  it('rejects non-integer payloadByteLength', () => {
    expect(() =>
      buildGenerationAttemptEventV1({
        ...REQUIRED_BASE,
        payloadByteLength: 12.5,
      })
    ).toThrow(/payloadByteLength/);
  });

  it('rejects negative durationMs', () => {
    expect(() =>
      buildGenerationAttemptEventV1({
        ...REQUIRED_BASE,
        durationMs: -10,
      })
    ).toThrow(/durationMs/);
  });

  it('preserves empty-string check on runId/candidateId/attemptId', () => {
    for (const key of ['runId', 'candidateId', 'attemptId'] as const) {
      expect(() =>
        buildGenerationAttemptEventV1({ ...REQUIRED_BASE, [key]: '   ' })
      ).toThrow(new RegExp(`GenerationAttemptEvent: ${key}`));
    }
  });

  it('redaction contract: forbids raw credential field names', () => {
    expect(() =>
      buildGenerationAttemptEventV1({
        ...REQUIRED_BASE,
        password: 'leaked' as unknown as never,
      } as unknown as Parameters<typeof buildGenerationAttemptEventV1>[0])
    ).toThrow(/redaction rejected forbidden field/);
    expect(() =>
      buildGenerationAttemptEventV1({
        ...REQUIRED_BASE,
        apiKey: 'leaked' as unknown as never,
      } as unknown as Parameters<typeof buildGenerationAttemptEventV1>[0])
    ).toThrow(/redaction rejected forbidden field/);
  });

  it('redaction contract: accepts a 64-hex payloadDigest and rejects malformed digests', () => {
    const payloadDigest = 'a'.repeat(64);
    const event = buildGenerationAttemptEventV1({ ...REQUIRED_BASE, payloadDigest });
    expect(event.payloadDigest).toBe(payloadDigest);
    expect(() => buildGenerationAttemptEventV1({ ...REQUIRED_BASE, payloadDigest: 'not-hex' }))
      .toThrow(/payloadDigest must be 64-character hex SHA-256/);
    expect(() => buildGenerationAttemptEventV1({ ...REQUIRED_BASE, payloadDigest: 'a'.repeat(63) }))
      .toThrow(/payloadDigest must be 64-character hex SHA-256/);
  });

  it('stamps + validates signed attestation binding digests (#717 / W8C-04)', () => {
    const binding = {
      requestDigest: '1'.repeat(64),
      routeDigest: '2'.repeat(64),
      attemptDigest: '3'.repeat(64),
      attestationDigest: '4'.repeat(64),
    };
    const event = buildGenerationAttemptEventV1({ ...REQUIRED_BASE, ...binding });
    expect(event.requestDigest).toBe(binding.requestDigest);
    expect(event.routeDigest).toBe(binding.routeDigest);
    expect(event.attemptDigest).toBe(binding.attemptDigest);
    expect(event.attestationDigest).toBe(binding.attestationDigest);
    for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
      expect(() => buildGenerationAttemptEventV1({ ...REQUIRED_BASE, [key]: 'z'.repeat(64) }))
        .toThrow(new RegExp(`${key} must be 64-character hex SHA-256`));
    }
  });

  it('emits structured stage progression record', () => {
    const stages = [
      'request',
      'tool_selection',
      'tool_call',
      'tool_result',
      'assistant_payload',
      'extracted_artifact',
      'validation',
      'failure_class',
      'recovery_decision',
      'terminal',
    ] as const;
    for (const stage of stages) {
      const event = buildGenerationAttemptEventV1({ ...REQUIRED_BASE, stage });
      expect(event.stage).toBe(stage);
    }
  });

  it('links recovery lineage via recoveryOfAttemptId and recoveredByAttemptId', () => {
    const recovered = buildGenerationAttemptEventV1({
      ...REQUIRED_BASE,
      attemptId: 'attempt-recovered',
      stage: 'terminal',
      recoveryOfAttemptId: ATTEMPT,
      recoveryDecision: 'repaired_tools',
    });
    expect(recovered.recoveryOfAttemptId).toBe(ATTEMPT);
    expect(recovered.recoveryDecision).toBe('repaired_tools');

    const primary = buildGenerationAttemptEventV1({
      ...REQUIRED_BASE,
      stage: 'terminal',
      failureReason: 'empty-artifact',
      recoveredByAttemptId: 'attempt-recovered',
    });
    expect(primary.recoveredByAttemptId).toBe('attempt-recovered');
    expect(primary.failureReason).toBe('empty-artifact');
  });

});
