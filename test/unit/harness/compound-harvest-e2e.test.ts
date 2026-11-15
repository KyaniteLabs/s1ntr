/**
 * Harvest E2E: failure → pattern path → memory adaptation → withLearnedGuidance delta.
 * (IW-S02 / IW-S04 acceptance slice)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withLearnedGuidance,
  recordSelfImproveOutcome,
  LEARNED_SECTION_HEADER,
  verifyPatternBeforeLearn,
} from '../../../src/harness/SelfImproveCompoundLoop.js';
import {
  createEnvelope,
  appendProofStep,
  linkGuidanceContinuity,
  evaluateWaveGate,
} from '../../../src/harness/CompoundRunEnvelope.js';
import { Status } from '../../../src/types/status.js';

const {
  mockLog,
  mockAnalyze,
  mockRecordPattern,
  mockRecordAdaptation,
  mockRecordEpisode,
  mockGetAdaptations,
  mockInitialize,
  mockSave,
} = vi.hoisted(() => ({
  mockLog: vi.fn(() => ({ written: true as const, path: '/tmp/failures/1-abcdefghi.json', id: '1-abcdefghi' })),
  mockAnalyze: vi.fn(() => [{ name: 'timeout-storm', severity: 'high' }]),
  mockRecordPattern: vi.fn(),
  mockRecordAdaptation: vi.fn(() => 'adapt_e2e_1'),
  mockRecordEpisode: vi.fn(() => 'ep_e2e'),
  mockGetAdaptations: vi.fn(() => []),
  mockInitialize: vi.fn(async () => undefined),
  mockSave: vi.fn(async () => ({ isErr: () => false })),
}));

vi.mock('../../../src/harness/FailureLogger.js', () => ({
  failureLogger: {
    log: mockLog,
    getSessionId: () => 'e2e-session',
  },
}));

vi.mock('../../../src/harness/PatternDetector.js', () => ({
  patternDetector: {
    analyze: mockAnalyze,
  },
}));

vi.mock('../../../src/harness/HarnessMemory.js', () => ({
  harnessMemory: {
    initialize: mockInitialize,
    save: mockSave,
    recordPatternOccurrence: mockRecordPattern,
    recordAdaptation: mockRecordAdaptation,
    recordEpisode: mockRecordEpisode,
    getAdaptations: mockGetAdaptations,
  },
}));

describe('compound harvest e2e', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnalyze.mockReturnValue([{ name: 'timeout-storm', severity: 'high' }]);
    mockRecordAdaptation.mockReturnValue('adapt_e2e_1');
    mockGetAdaptations.mockReturnValue([]);
  });

  it('failure attempt records adaptation; second description gets learned guidance', async () => {
    const r = await recordSelfImproveOutcome(
      {
        status: Status.FAILED,
        stepCount: 10,
        lastPlanError: 'The operation was aborted due to timeout',
        toolsUsed: ['executeSkill'],
      },
      {
        taskId: 'attempt-1',
        model: 'moonshotai/kimi-k3',
        description: 'Diagnose compound loop residual',
        kind: 'diagnose',
      },
    );
    expect(r.loggedFailure).toBe(true);
    expect(r.adaptationIds).toEqual(['adapt_e2e_1']);
    expect(mockRecordPattern).toHaveBeenCalledWith('timeout-storm', 'harness-diagnose');
    expect(mockSave).toHaveBeenCalled();

    mockGetAdaptations.mockReturnValue([
      // Attempt 2: memory returns the lesson from attempt 1
      {
        description: 'Self-improve attempt-1: timeout-storm — The operation was aborted due to timeout',
      },
    ]);
    const guided = withLearnedGuidance('Diagnose compound loop residual');
    expect(guided).toContain(LEARNED_SECTION_HEADER);
    expect(guided).toContain('timeout-storm');
    expect(guided.indexOf(LEARNED_SECTION_HEADER)).toBeLessThan(guided.indexOf('Diagnose compound'));
  });

  it('harmful pattern is not persisted (verify-before-learn)', async () => {
    mockAnalyze.mockReturnValue([{ name: 'harmful-wipe-repo', severity: 'critical' }]);
    const r = await recordSelfImproveOutcome(
      {
        status: Status.FAILED,
        stepCount: 2,
        lastPlanError: 'boom',
        toolsUsed: [],
      },
      {
        taskId: 'attempt-bad',
        model: 'test',
        description: 'x',
        kind: 'diagnose',
      },
    );
    expect(r.adaptationIds).toEqual([]);
    expect(mockRecordPattern).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalled();
    const rejectLog = mockLog.mock.calls.some(
      (c) => String(c[0]?.thinking || '').includes('harmful-pattern-rejected'),
    );
    expect(rejectLog).toBe(true);
    expect(verifyPatternBeforeLearn({ name: 'harmful-wipe-repo' })).toBe('harmful-pattern-rejected');
  });

  it('two-attempt continuity: dual-green independence (W9-L1-01)', () => {
    const seat = {
      resolvedModel: 'test',
      requestedModel: 'test',
      provider: 'test',
      endpointHost: 'localhost',
      branch: 'test',
      commitSha: 'abc',
    };
    let env = createEnvelope({ taskId: 'two-attempt', seat });
    env = appendProofStep(env, { stage: 'prompt', ok: true });
    env = {
      ...env,
      outcome: 'ok',
      planContentDigest: 'd'.repeat(64),
      planReceiptPath: '/tmp/p.md',
    };
    // Seat path: no continuity required → green
    expect(evaluateWaveGate(env).decision).toBe('green');
    // Recursive path without link → red
    expect(evaluateWaveGate(env, { requireGuidanceContinuity: true }).decision).toBe('red');
    // Same producer/consumer rejected
    env = linkGuidanceContinuity(env, {
      producerAttemptId: 'a1',
      consumerAttemptId: 'a1',
      guidanceId: 'g1',
    });
    expect(evaluateWaveGate(env, { requireGuidanceContinuity: true }).decision).toBe('red');
    // Fresh env with proper link
    let env2 = createEnvelope({ taskId: 'two-attempt-2', seat });
    env2 = appendProofStep(env2, { stage: 'prompt', ok: true });
    env2 = {
      ...env2,
      outcome: 'ok',
      planContentDigest: 'e'.repeat(64),
      planReceiptPath: '/tmp/p2.md',
    };
    env2 = linkGuidanceContinuity(env2, {
      producerAttemptId: 'attempt-1',
      consumerAttemptId: 'attempt-2',
      guidanceId: 'guidance-from-attempt-1',
    });
    expect(evaluateWaveGate(env2, { requireGuidanceContinuity: true }).decision).toBe('green');
  });
});
