/**
 * Harness-lane telemetry (#401 F2/F1): event shapes, seat attribution, fail-open.
 * No live API calls.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSaveRunState,
  mockReadRunState,
  mockClearRunState,
  mockCaptureWorkspaceFingerprint,
  mockValidateWorkspaceFingerprint,
} = vi.hoisted(() => ({
  mockSaveRunState: vi.fn(async () => {}),
  mockReadRunState: vi.fn(async () => null),
  mockClearRunState: vi.fn(async () => {}),
  mockCaptureWorkspaceFingerprint: vi.fn(async () => ({
    host: 'local',
    repoRoot: '/tmp/repo',
    gitDir: '/tmp/repo/.git',
    worktreePath: '/tmp/repo',
  })),
  mockValidateWorkspaceFingerprint: vi.fn(async () => ({ valid: true })),
}));

// Mirror test/unit/LLMModeAgent.test.ts:105-122 — never touch real .omx/run-state.json.
vi.mock('../../../src/harness/RunStateStore.js', () => ({
  saveRunState: mockSaveRunState,
  readRunState: mockReadRunState,
  clearRunState: mockClearRunState,
  captureWorkspaceFingerprint: mockCaptureWorkspaceFingerprint,
  validateWorkspaceFingerprint: mockValidateWorkspaceFingerprint,
  formatResumeContext: vi.fn(() => 'resume context'),
  SemanticBoundary: {
    RUN_CREATED: 'run_created',
    PLAN_COMMITTED: 'plan_committed',
    MUTATION_APPLIED: 'mutation_applied',
    VERIFICATION_STARTED: 'verification_started',
    VERIFICATION_FINISHED: 'verification_finished',
    INTERRUPTED: 'interrupted',
    COMPLETED: 'completed',
    FAILED: 'failed',
  },
}));

import { LLMModeAgent } from '../../../src/harness/agent/LLMModeAgent.js';
import { rateLimiter } from '../../../src/harness/tools/RateLimiter.js';
import { telemetryWrapper } from '../../../src/harness/tools/TelemetryWrapper.js';
import type { LLMClient } from '../../../src/llm/LLMClient.js';
import {
  EventLedger,
  queryEventLedger,
} from '../../../src/telemetry/EventLedger.js';
import {
  recordHarnessLaneEvent,
  resolveHarnessSeat,
  resolveHarnessSeatModel,
  scrubLedgerReason,
} from '../../../src/telemetry/harnessLane.js';
import { Status } from '../../../src/types/status.js';

const roots: string[] = [];

beforeEach(() => {
  mockReadRunState.mockResolvedValue(null);
  mockSaveRunState.mockClear();
  mockClearRunState.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SINTER_EVENT_LEDGER_PATH;
  delete process.env.SINTER_EVENT_LEDGER_FORCE;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tempBase(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinter-harness-lane-'));
  roots.push(root);
  return root;
}

function mockHarnessLLM(overrides: {
  model?: string;
  provider?: string;
  baseUrl?: string;
  completeImpl?: () => Promise<unknown>;
} = {}): LLMClient {
  const model = overrides.model ?? 'kimi-k3';
  const provider = overrides.provider ?? 'openrouter';
  const baseUrl = overrides.baseUrl ?? 'https://openrouter.ai/api/v1';
  const config = { model, provider, baseUrl };
  const complete = overrides.completeImpl ?? (async () => ({
    success: true,
    text: JSON.stringify({
      thought: 'read focus file',
      tool: 'complete',
      params: {},
      expectedResult: 'done',
    }),
    provider,
    model,
    usage: { inputTokens: 10, outputTokens: 20, thinkingTokens: 5 },
  }));
  return {
    getConfig: () => ({ ...config }),
    resolveEffectiveModel: async () => model,
    complete,
  } as unknown as LLMClient;
}

describe('resolveHarnessSeat / resolveHarnessSeatModel', () => {
  it('attributes resolved model + provider route (not auto)', async () => {
    const llm = mockHarnessLLM({ model: 'kimi-k3', provider: 'openrouter' });
    const seat = resolveHarnessSeat(llm);
    expect(seat).toEqual({
      model: 'kimi-k3',
      provider: 'openrouter',
      role: 'harness',
    });
    expect(await resolveHarnessSeatModel(llm)).toBe('kimi-k3');
  });

  it('coerces literal auto model to null (remote hosts skip auto-detect)', () => {
    const seat = resolveHarnessSeat({
      getConfig: () => ({
        model: 'auto',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    });
    expect(seat.model).toBeNull();
    expect(seat.provider).toBe('openrouter');
    expect(seat.role).toBe('harness');
  });

  it('resolveHarnessSeatModel falls back without throwing when resolve fails', async () => {
    const llm = {
      getConfig: () => ({ model: 'fallback-model' }),
      resolveEffectiveModel: async () => {
        throw new Error('network boom');
      },
    };
    expect(await resolveHarnessSeatModel(llm)).toBe('fallback-model');
  });

  it('detects provider from baseUrl when config.provider missing', () => {
    const llm = {
      getConfig: () => ({
        model: 'gpt-test',
        baseUrl: 'https://api.openai.com/v1',
      }),
    };
    const seat = resolveHarnessSeat(llm as never);
    expect(seat.model).toBe('gpt-test');
    expect(seat.provider).toBe('openai');
    expect(seat.role).toBe('harness');
  });
});

describe('scrubLedgerReason', () => {
  it('strips absolute paths including /Users/<user>/...', () => {
    const scrubbed = scrubLedgerReason(
      'ENOENT: no such file /Users/user/workspaces/project/.omx/run-state.json',
    );
    expect(scrubbed).not.toContain('/Users/');
    expect(scrubbed).not.toContain('/Users/user');
    expect(scrubbed).toContain('[path]');
  });
});

describe('recordHarnessLaneEvent fail-open', () => {
  it('never throws when primary write fails; records telemetryGap marker', async () => {
    const baseDir = await tempBase();
    const spy = vi.spyOn(EventLedger.prototype, 'record');
    spy.mockImplementation(async (input) => {
      if (input.event === 'harness.call.start') {
        throw new Error('disk full at /Users/user/.sinter/telemetry/events');
      }
      // Gap marker writes through a fresh unspied ledger instance via original.
      spy.mockRestore();
      try {
        return await new EventLedger({ baseDir, day: '2026-07-26', forceInTest: true }).record(input);
      } finally {
        // leave unspied — gap write done
      }
    });

    let threw = false;
    let result: { ok: boolean; telemetryGap: boolean } | undefined;
    try {
      result = await recordHarnessLaneEvent({
        event: 'harness.call.start',
        model: 'kimi-k3',
        provider: 'openrouter',
        role: 'harness',
        runId: 'run-1',
        episodeId: null,
        domain: 'harness',
        inputHash: null,
        verdict: 'start',
        latencyMs: null,
        costUsd: null,
        evidenceRefs: [],
        payload: { phase: 'plan', step: 1 },
      }, { baseDir, day: '2026-07-26', forceInTest: true });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toEqual({ ok: false, telemetryGap: true });

    const { events } = await queryEventLedger({ role: 'harness' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    const gap = events.find(e => e.event === 'harness.telemetryGap');
    expect(gap?.event).toBe('harness.telemetryGap');
    expect(gap?.payload.failedEvent).toBe('harness.call.start');
    expect(String(gap?.payload.reason)).not.toContain('/Users/');
    expect(String(gap?.payload.reason)).toContain('[path]');
    // Primary event must NOT be faked
    expect(events.some(e => e.event === 'harness.call.start')).toBe(false);
  });

  it('records happy-path harness.call.start without gap', async () => {
    const baseDir = await tempBase();
    const result = await recordHarnessLaneEvent({
      event: 'harness.call.start',
      model: 'kimi-k3',
      provider: 'openrouter',
      runId: 'run-2',
      episodeId: null,
      domain: 'harness',
      inputHash: null,
      verdict: 'start',
      latencyMs: null,
      costUsd: null,
      evidenceRefs: [],
      payload: { phase: 'plan', step: 1 },
    }, { baseDir, day: '2026-07-26', forceInTest: true });

    expect(result).toEqual({ ok: true, telemetryGap: false });
    const { events } = await queryEventLedger({ event: 'harness.call.start' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe('harness');
    expect(events[0].model).toBe('kimi-k3');
    expect(events[0].provider).toBe('openrouter');
    expect(events[0].payload).toMatchObject({ phase: 'plan', step: 1 });
  });
});

describe('LLMModeAgent harness lane emission shapes', () => {
  it('emits call start/end after successful parse exactly once', async () => {
    const baseDir = await tempBase();
    process.env.SINTER_EVENT_LEDGER_PATH = baseDir;

    const llm = mockHarnessLLM({
      model: 'kimi-k3',
      provider: 'openrouter',
      completeImpl: async () => ({
        success: true,
        text: JSON.stringify({
          thought: 'done',
          tool: 'complete',
          params: {},
          expectedResult: 'task complete',
        }),
        provider: 'openrouter',
        model: 'kimi-k3',
        usage: { inputTokens: 11, outputTokens: 22, thinkingTokens: 7 },
      }),
    });

    vi.spyOn(rateLimiter, 'execute').mockImplementation(async (_op, fn) => ({ result: await fn() }));
    vi.spyOn(telemetryWrapper, 'wrap').mockImplementation(async (tool, params) => tool.execute(params));

    const agent = new LLMModeAgent(llm);
    const session = await agent.executeTask({
      id: 'tui-self-test-1',
      title: 'test pass',
      description: 'noop complete',
      approved: true,
      maxSteps: 3,
      completionPolicy: 'stop_after_verification',
    });

    expect(session.status).toBe(Status.SUCCESS);
    await new Promise(r => setTimeout(r, 30));

    const { events } = await queryEventLedger({ role: 'harness' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    const callEnds = events.filter(e => e.event === 'harness.call.end');
    expect(callEnds).toHaveLength(1);
    expect(callEnds[0].payload).toMatchObject({
      phase: 'plan',
      success: true,
      inputTokens: 11,
      outputTokens: 22,
      thinkingTokens: 7,
    });
    expect(events.filter(e => e.event === 'harness.call.start')).toHaveLength(1);
    expect(events.some(e => e.event === 'harness.step')).toBe(true);
    expect(events.some(e => e.event === 'harness.pass.complete')).toBe(true);

    for (const row of events) {
      expect(row.role).toBe('harness');
      expect(row.model).toBe('kimi-k3');
      expect(row.provider).toBe('openrouter');
      expect(row.runId).toBe('tui-self-test-1');
    }

    const pass = events.find(e => e.event === 'harness.pass.complete');
    expect(pass?.payload).toMatchObject({
      steps: 1,
      verifiedEdit: false,
      rollback: false,
      status: Status.SUCCESS,
    });
    expect(mockClearRunState).toHaveBeenCalledTimes(1);
    expect(mockReadRunState).toHaveBeenCalledTimes(1);
  });

  it('parse-failure emits call.end success:false with parse_error exactly once', async () => {
    const baseDir = await tempBase();
    process.env.SINTER_EVENT_LEDGER_PATH = baseDir;

    const llm = mockHarnessLLM({
      model: 'kimi-k3',
      provider: 'openrouter',
      completeImpl: async () => ({
        success: true,
        // Valid HTTP body but not a tool-call JSON object — parseToolCallText returns null.
        text: 'I think we should maybe read a file first, not sure which.',
        provider: 'openrouter',
        model: 'kimi-k3',
        usage: { inputTokens: 9, outputTokens: 12, thinkingTokens: 3 },
      }),
    });

    vi.spyOn(rateLimiter, 'execute').mockImplementation(async (_op, fn) => ({ result: await fn() }));

    const agent = new LLMModeAgent(llm);
    const session = await agent.executeTask({
      id: 'tui-self-parse-fail',
      title: 'parse fail pass',
      description: 'should fail parse',
      approved: true,
      maxSteps: 2,
      completionPolicy: 'stop_after_verification',
    });

    expect(session.status).toBe(Status.FAILED);
    await new Promise(r => setTimeout(r, 30));

    const { events } = await queryEventLedger({ role: 'harness' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    const callStarts = events.filter(e => e.event === 'harness.call.start');
    const callEnds = events.filter(e => e.event === 'harness.call.end');
    // One plan attempt may run per step; each start has matching end with parse_error.
    expect(callStarts.length).toBeGreaterThanOrEqual(1);
    expect(callEnds.length).toBe(callStarts.length);
    for (const end of callEnds) {
      expect(end.payload).toMatchObject({
        phase: 'plan',
        success: false,
        errorClass: 'parse_error',
      });
      // Must not claim success before parse.
      expect(end.payload.success).toBe(false);
    }
    // No planned steps when parse never yields a toolCall.
    expect(events.some(e => e.event === 'harness.step' && e.payload.phase === 'planned')).toBe(false);
  });

  it('query by role harness returns only harness rows', async () => {
    const baseDir = await tempBase();
    await recordHarnessLaneEvent({
      event: 'harness.pass.complete',
      model: 'kimi-k3',
      provider: 'openrouter',
      runId: 'g-1',
      episodeId: null,
      domain: 'harness',
      inputHash: null,
      verdict: 'success',
      latencyMs: 100,
      costUsd: null,
      evidenceRefs: [],
      payload: { steps: 5, verifiedEdit: true, rollback: false, status: 'success' },
    }, { baseDir, day: '2026-07-26', forceInTest: true });

    await new EventLedger({ baseDir, day: '2026-07-26', forceInTest: true }).record({
      event: 'generation.scored',
      model: 'gpt-test',
      provider: 'openai',
      role: 'generator',
      runId: 'g-1',
      episodeId: null,
      domain: 'p5',
      inputHash: null,
      verdict: 'honest',
      latencyMs: 1,
      costUsd: null,
      evidenceRefs: [],
      payload: { schemaVersion: 1, score: 0.5 },
    });

    const harnessOnly = await queryEventLedger({ role: 'harness' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    expect(harnessOnly.events.length).toBeGreaterThanOrEqual(1);
    expect(harnessOnly.events.every(e => e.role === 'harness')).toBe(true);
    expect(harnessOnly.events.some(e => e.event === 'generation.scored')).toBe(false);
  });
});
