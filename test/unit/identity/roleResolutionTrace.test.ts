import { describe, it, expect } from 'vitest';
import {
  computeTraceDigest,
  freezeTrace,
  verifyTraceDigest,
  chainTrace,
  type RoleResolutionTrace,
} from '../../../src/identity/roleResolutionTrace.js';
import type { ExecutorIdentity } from '../../../src/identity/types.js';

const baseIdentity: ExecutorIdentity = { provider: 'anthropic', model: 'claude-opus-4-1', effort: 'high' };
const lunaIdentity: ExecutorIdentity = { provider: 'openai', model: 'gpt-5.6-luna', effort: 'max' };

describe('RoleResolutionTrace', () => {
  it('computes a deterministic digest for the same inputs', () => {
    const a = computeTraceDigest({
      policyVersion: 'v1',
      phase: 'pre-primary-transport',
      sourceLayer: 'project-config',
      role: 'harness',
      requestedIdentity: baseIdentity,
      resolvedIdentity: baseIdentity,
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      priorDigest: null,
      policyInvokedAt: ['config-mutation', 'pre-primary-transport'],
    });
    const b = computeTraceDigest({
      policyVersion: 'v1',
      phase: 'pre-primary-transport',
      sourceLayer: 'project-config',
      role: 'harness',
      requestedIdentity: baseIdentity,
      resolvedIdentity: baseIdentity,
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      priorDigest: null,
      // different order should normalize
      policyInvokedAt: ['pre-primary-transport', 'config-mutation'],
    });
    expect(a).toBe(b);
  });

  it('digest changes when resolved identity changes (request Sol, execute Luna)', () => {
    const base = {
      policyVersion: 'v1',
      phase: 'pre-primary-transport' as const,
      sourceLayer: 'project-config' as const,
      role: 'generator' as const,
      requestedIdentity: baseIdentity,
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      priorDigest: null,
      policyInvokedAt: ['config-mutation', 'pre-primary-transport'] as const,
    };
    const dSol = computeTraceDigest({ ...base, resolvedIdentity: baseIdentity });
    const dLuna = computeTraceDigest({ ...base, resolvedIdentity: lunaIdentity });
    expect(dSol).not.toBe(dLuna);
  });

  it('freezeTrace includes its own phase in policyInvokedAt or fails closed', () => {
    expect(() =>
      freezeTrace({
        policyVersion: 'v1',
        phase: 'pre-primary-transport',
        sourceLayer: 'project-config',
        role: 'harness',
        requestedIdentity: baseIdentity,
        resolvedIdentity: baseIdentity,
        fallbackOrdinal: 0,
        retryOrdinal: 0,
        priorDigest: null,
        policyInvokedAt: ['config-mutation'], // missing the phase
      }),
    ).toThrow(/PHASE_SKIPPED/);
  });

  it('verifyTraceDigest detects tampering', () => {
    const trace: RoleResolutionTrace = freezeTrace({
      policyVersion: 'v1',
      phase: 'pre-primary-transport',
      sourceLayer: 'project-config',
      role: 'harness',
      requestedIdentity: baseIdentity,
      resolvedIdentity: baseIdentity,
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      priorDigest: null,
      policyInvokedAt: ['config-mutation', 'pre-primary-transport'],
    });
    expect(verifyTraceDigest(trace)).toBe(true);
    const tampered = { ...trace, fallbackOrdinal: 99 };
    expect(verifyTraceDigest(tampered)).toBe(false);
  });

  it('chainTrace links priorDigest to previous trace', () => {
    const first: RoleResolutionTrace = freezeTrace({
      policyVersion: 'v1',
      phase: 'config-mutation',
      sourceLayer: 'project-config',
      role: 'harness',
      requestedIdentity: baseIdentity,
      resolvedIdentity: baseIdentity,
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      priorDigest: null,
      policyInvokedAt: ['config-mutation'],
    });
    const second = chainTrace(first, 'pre-primary-transport', ['config-mutation', 'pre-primary-transport']);
    expect(second.priorDigest).toBe(first.digest);
  });
});
