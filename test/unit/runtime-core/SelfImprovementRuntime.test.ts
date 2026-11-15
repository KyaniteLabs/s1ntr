import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecuteTask, mockCreateLLMModeAgent, mockWithLearned, mockRecordOutcome } = vi.hoisted(() => {
  const executeTask = vi.fn();
  return {
    mockExecuteTask: executeTask,
    mockCreateLLMModeAgent: vi.fn(() => ({ executeTask })),
    mockWithLearned: vi.fn((d: string) => d),
    mockRecordOutcome: vi.fn(async () => ({ loggedFailure: false, patterns: 0, adaptationIds: [] })),
  };
});

vi.mock('../../../src/harness/agent/index.js', () => ({
  createLLMModeAgent: mockCreateLLMModeAgent,
}));

vi.mock('../../../src/harness/SelfImproveCompoundLoop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/harness/SelfImproveCompoundLoop.js')>();
  return {
    ...actual,
    withLearnedGuidance: mockWithLearned,
    recordSelfImproveOutcome: mockRecordOutcome,
  };
});

import {
  LLMModeSelfImprovementRuntime,
  assertIdentityOracle,
  assertBehaviorOracle,
} from '../../../src/runtime-core/SelfImprovementRuntime.js';
import { Status } from '../../../src/types/status.js';

function stableTaskIdentity(task: any) {
  return {
    ...task,
    id: 'stable-id',
    experimentAuthority: {
      ...task.experimentAuthority,
      contract: {
        ...task.experimentAuthority.contract,
        experimentId: 'stable-id',
        lineageId: 'stable-id',
      },
    },
  };
}

describe('LLMModeSelfImprovementRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithLearned.mockImplementation((d: string) => d);
    mockRecordOutcome.mockResolvedValue({ loggedFailure: false, patterns: 0, adaptationIds: [] });
  });

  it('binds every prepared run to the W5-01 recursive contract', () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'grok-4.5' })) } as any;
    const prepared = runtime.prepare({
      llm,
      description: 'Improve the bounded runtime',
    });

    expect(prepared.recursiveContract).toMatchObject({
      version: 1,
      loop: 'autoresearch',
      state: 'observe',
      stage: 'shadow',
      sourceMutationRequested: true,
    });
    expect(prepared.recursiveContract.lineageId).toBe(prepared.taskId);
    expect(() => runtime.prepare({
      llm,
      description: 'Attempt a mutation from Dream',
      recursiveContract: {
        ...prepared.recursiveContract,
        loop: 'dream',
      },
    })).toThrow(/MUTATION_AUTHORITY_DENIED/);
  });

  it('prepare surfaces adaptation ids for identity/behavior oracles (#583/#584 pass-B consumer)', () => {
    const adaptationId = 'adapt_passA_cafe01';
    const guided =
      `## Learned from prior runs\n` +
      `- [adaptation:${adaptationId} provenance:harness-memory] Persist receipts on diagnose\n\n` +
      `ARCHITECT DIAGNOSE ONLY`;
    mockWithLearned.mockImplementation(() => guided);

    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'moonshotai/kimi-k3' })) } as any;
    const prepared = runtime.prepare({
      llm,
      description: 'ARCHITECT DIAGNOSE ONLY',
      forbidMutations: true,
      kind: 'diagnose',
    });

    expect(prepared.composedDescription).toContain(`[adaptation:${adaptationId}`);
    expect(prepared.injectedAdaptationIds).toEqual([adaptationId]);
    expect(prepared.task.description).toContain(`[adaptation:${adaptationId}`);
    expect(assertIdentityOracle(prepared, adaptationId)).toBe(true);
    const persistsReceipts = (text: string) => /Persist receipts on diagnose/.test(text);
    expect(assertBehaviorOracle(prepared, adaptationId, { custom: persistsReceipts })).toBe(true);
    // Tag + suffix alone is not acceptance: a failing predeclared check fails (#1325)
    expect(assertBehaviorOracle(prepared, adaptationId, { custom: () => false })).toBe(false);
    expect(() => (assertBehaviorOracle as (...a: unknown[]) => boolean)(prepared, adaptationId))
      .toThrow(/predeclared behavior check/);
    // Id-only citation is insufficient for behavior oracle
    const emptyCite = {
      ...prepared,
      composedDescription: `[adaptation:${adaptationId}]`,
      task: { ...prepared.task, description: `[adaptation:${adaptationId}]` },
      injectedAdaptationIds: [adaptationId],
    };
    expect(assertBehaviorOracle(emptyCite, adaptationId, { custom: () => true })).toBe(false);
    expect(assertIdentityOracle(emptyCite, adaptationId)).toBe(true);
  });

  it('preserves bounded packet contracts across runtime-core and runstate preparations', () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'glm-5.1' })) } as any;
    const cases = [
      {
        description: 'Tighten the bounded runtime-core self-improvement facade',
        expectedDomain: 'runtime-core',
      },
      {
        description: 'Resume checkpoint state after WORKSPACE fingerprint drift',
        expectedDomain: 'runstate',
      },
    ] as const;

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_775_960_625_337)
      .mockReturnValueOnce(1_775_960_625_338)
      .mockReturnValueOnce(1_775_960_625_339);

    for (const testCase of cases) {
      const prepared = runtime.prepare({ llm, description: testCase.description });
      expect(prepared.task.fileHint).toBe(prepared.task.primaryFiles?.[0]);
      expect(prepared.task.workingSet).toEqual([
        ...(prepared.task.primaryFiles || []),
        ...(prepared.task.secondaryFiles || []),
      ]);
      expect(new Set(prepared.task.workingSet || []).size).toBe(prepared.task.workingSet?.length);
      expect(prepared.task.domain).toBe(testCase.expectedDomain);
      expect((prepared.task.secondaryFiles || []).length).toBeLessThanOrEqual(prepared.task.expansionBudget || 0);
      expect(prepared.task.expansionStatus).toBe(((prepared.task.deferredSecondaryFiles || []).length > 0) ? 'allowed' : 'exhausted');
      expect(prepared.task.verificationTargets?.length).toBeGreaterThan(0);
      expect(prepared.task.verificationTargets?.[0].priority).toBe(1);
      expect(prepared.task.description).toContain('## Deterministic Task Packet');
      expect(prepared.task.description).toContain(`Primary files:\n- ${(prepared.task.primaryFiles || []).join('\n- ')}`);
      expect(prepared.task.description).toContain(`Secondary files:\n- ${(prepared.task.secondaryFiles || []).join('\n- ')}`);
      expect(prepared.task.description).toContain(`Verification targets:\n- ${(prepared.task.verificationTargets || []).map((target) => `${target.tool}${target.pattern ? ` (${target.pattern})` : ''}: ${target.reason}`).join('\n- ')}`);
      expect(prepared.task.description).toContain(`Preferred verification targets after a mutation:\n- ${(prepared.task.verificationTargets || []).map((target) => `${target.tool}${target.pattern ? ` (${target.pattern})` : ''}: ${target.reason}`).join('\n- ')}`);
      expect(prepared.task.description).toContain(`Expansion budget: ${prepared.task.expansionBudget} additional files before broadening beyond this packet`);
      expect(prepared.task.description).toContain(`Expansion status: ${prepared.task.expansionStatus}`);
      expect(prepared.task.description).toContain(`Localization confidence: ${prepared.task.localizationConfidence}`);
      expect(prepared.task.description).toContain(`Domain: ${prepared.task.domain}`);
      expect(prepared.task.description).toContain(`Hint: ${prepared.task.fileHint}`);
      expect(prepared.task.description).toContain(`Current active focus file: ${prepared.task.fileHint}`);
      expect(prepared.task.description).toContain('Your first explicit tool call should stay on the current active focus file unless you are editing or verifying.');
      expect(prepared.task.description).toContain(`Do not jump to ${(prepared.task.primaryFiles || [])[1]} until you finish the current focus or explicitly reject it.`);
      expect(prepared.task.description).toContain('If readFile returns truncated=true with startLine/endLine, continue that file with offset=endLine rather than rereading from the top.');
      expect(prepared.task.description).toContain('If you need a specific method, symbol, or error location inside a large file, use search with the current file path before reading more pages.');
    }
  });

  it('runs self-improvement requests with the bounded runtime task policy', async () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = {
      getConfig: vi.fn(() => ({ model: 'glm-5.1' })),
    } as any;
    const session = {
      status: Status.SUCCESS,
      startTime: '2026-04-11T18:00:00.000Z',
      endTime: '2026-04-11T18:00:01.000Z',
      stepCount: 2,
    } as any;

    mockExecuteTask.mockResolvedValue(session);

    const result = await runtime.run({
      llm,
      description: 'Fix the Bubble Tea runtime lane',
    });

    expect(mockCreateLLMModeAgent).toHaveBeenCalledWith(llm);
    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^tui-self-/),
      title: 'Bubble Tea TUI self-improvement request',
      description: expect.stringContaining('Fix the Bubble Tea runtime lane'),
      fileHint: 'src/runtime-core/SelfImprovementRuntime.ts',
      workingSet: [
        'src/runtime-core/SelfImprovementRuntime.ts',
        'src/harness/agent/LLMModeAgent.ts',
        'src/harness/RunStateStore.ts',
        'test/unit/LLMModeAgent.test.ts',
      ],
      domain: 'runtime-core',
      maxSteps: 20,
      approved: true,
      completionPolicy: 'stop_after_verification',
    }));
    expect(result).toEqual({
      modelName: 'glm-5.1',
      maxSteps: 20,
      session,
      taskId: expect.stringMatching(/^tui-self-/),
      lifecycle: expect.objectContaining({
        status: Status.SUCCESS,
        category: 'succeeded',
        succeeded: true,
        resumable: false,
        nextAction: expect.objectContaining({ action: 'none' }),
      }),
    });
    expect(mockExecuteTask).toHaveBeenCalledWith(result.session ? expect.objectContaining({
      id: result.taskId,
      maxSteps: result.maxSteps,
    }) : expect.anything());
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        taskId: result.taskId,
        model: 'glm-5.1',
        description: 'Fix the Bubble Tea runtime lane',
      }),
    );
  });

  it('applies learned guidance when preparing tasks and records outcomes after run', async () => {
    mockWithLearned.mockImplementation((d: string) => `## Learned from prior runs\n- prior tip\n\n${d}`);
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'grok-4.5' })) } as any;
    const session = {
      status: Status.FAILED,
      lastPlanError: 'no plan',
      stepCount: 5,
    } as any;
    mockExecuteTask.mockResolvedValue(session);

    const prepared = runtime.prepare({
      llm,
      description: 'ARCHITECT DIAGNOSE ONLY',
      forbidMutations: true,
      kind: 'diagnose',
    });
    expect(mockWithLearned).toHaveBeenCalledTimes(1);
    expect(prepared.task.description).toContain('## Learned from prior runs');
    expect(prepared.task.description).toContain('prior tip');
    expect(prepared.task.description).toContain('comorbidity-check');
    expect(prepared.task.description).toContain('systematic-debugging');
    expect(prepared.task.description).toContain('executeSkill');
    expect(prepared.task.id).toMatch(/^tui-diagnose-/);

    await runtime.run({
      llm,
      description: 'ARCHITECT DIAGNOSE ONLY',
      forbidMutations: true,
      kind: 'diagnose',
    });
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
  });

  it('preloads checkpoint/resume runs with a deterministic working set', async () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'glm-5.1' })) } as any;
    const session = {
      status: 'success',
      startTime: '2026-04-11T18:00:00.000Z',
      endTime: '2026-04-11T18:00:01.000Z',
      stepCount: 1,
    } as any;
    mockExecuteTask.mockResolvedValue(session);

    await runtime.run({
      llm,
      description: 'Add a checkpoint resume proof for workspace fingerprint drift',
    });

    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      fileHint: 'src/harness/RunStateStore.ts',
      workingSet: [
        'src/harness/RunStateStore.ts',
        'src/harness/agent/LLMModeAgent.ts',
        'test/unit/LLMModeAgent.test.ts',
        'test/harness/RunStateStore.test.ts',
      ],
      domain: 'runstate',
      description: expect.stringContaining('Deterministic Task Packet'),
    }));
    const task = mockExecuteTask.mock.calls[0][0];
    expect(task.description).toContain('src/harness/agent/LLMModeAgent.ts');
    expect(task.description).toContain('test/harness/RunStateStore.test.ts');
  });

  it('prepares RepoIndexLite-first packets for localization-focused bounded-runtime work', async () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'glm-5.1' })) } as any;
    const session = {
      status: 'success',
      startTime: '2026-04-11T18:00:00.000Z',
      endTime: '2026-04-11T18:00:01.000Z',
      stepCount: 1,
    } as any;
    mockExecuteTask.mockResolvedValue(session);

    await runtime.run({
      llm,
      description: 'Tighten RepoIndexLite task packet shaping and expansion budget determinism',
    });

    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      fileHint: 'src/runtime-core/RepoIndexLite.ts',
      primaryFiles: [
        'src/runtime-core/RepoIndexLite.ts',
        'src/runtime-core/SelfImprovementRuntime.ts',
      ],
      secondaryFiles: [
        'test/unit/runtime-core/RepoIndexLite.test.ts',
        'test/unit/runtime-core/SelfImprovementRuntime.test.ts',
      ],
      deferredSecondaryFiles: [
        'src/harness/agent/LLMModeAgent.ts',
      ],
      expansionBudget: 2,
      expansionStatus: 'allowed',
      localizationConfidence: 'high',
      verificationTargets: [
        {
          tool: 'runFocusedTests',
          pattern: 'RepoIndexLite',
          reason: 'RepoIndexLite packet-shaping changes should hit focused runtime tests first',
          priority: 1,
        },
        {
          tool: 'runBuild',
          reason: 'Full TypeScript build after packet-shaping edits',
          priority: 2,
        },
      ],
      domain: 'runtime-core',
    }));
    const task = mockExecuteTask.mock.calls[0][0];
    expect(task.workingSet).toEqual([...task.primaryFiles, ...task.secondaryFiles]);
    expect(task.workingSet).not.toContain('src/harness/agent/LLMModeAgent.ts');
    expect(task.description).toContain('Deferred secondary files:');
    expect(task.description).toContain('Expansion status: allowed');
    expect(task.description).toContain('Localization confidence: high');
    expect(task.description).toContain('Expansion budget: 2 additional files before broadening beyond this packet');
  });

  it('prepares repeatable bounded checkpoint-resume task packets for the same description', async () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'glm-5.1' })) } as any;
    const session = {
      status: 'success',
      startTime: '2026-04-11T18:00:00.000Z',
      endTime: '2026-04-11T18:00:01.000Z',
      stepCount: 1,
    } as any;
    mockExecuteTask.mockResolvedValue(session);

    const description = 'Resume checkpoint state after workspace fingerprint drift';
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_775_960_625_337)
      .mockReturnValueOnce(1_775_960_625_338);
    const first = runtime.prepare({ llm, description });
    const second = runtime.prepare({ llm, description });

    expect(mockCreateLLMModeAgent).not.toHaveBeenCalled();

    await first.execute();
    await second.execute();

    const firstTask = mockExecuteTask.mock.calls[0][0];
    const secondTask = mockExecuteTask.mock.calls[1][0];

    expect(firstTask.id).not.toBe(secondTask.id);
    expect(firstTask).toEqual(expect.objectContaining({
      fileHint: 'src/harness/RunStateStore.ts',
      maxSteps: 20,
      approved: true,
      completionPolicy: 'stop_after_verification',
    }));
    expect(secondTask).toEqual(expect.objectContaining({
      fileHint: 'src/harness/RunStateStore.ts',
      maxSteps: 20,
      approved: true,
      completionPolicy: 'stop_after_verification',
    }));
    expect(firstTask.expansionBudget).toBe(firstTask.secondaryFiles.length);
    expect(secondTask.expansionBudget).toBe(secondTask.secondaryFiles.length);
    expect(firstTask.expansionStatus).toBe('exhausted');
    expect(secondTask.expansionStatus).toBe('exhausted');
    expect(firstTask.workingSet).toEqual([...firstTask.primaryFiles, ...firstTask.secondaryFiles]);
    expect(secondTask.workingSet).toEqual([...secondTask.primaryFiles, ...secondTask.secondaryFiles]);
    expect(stableTaskIdentity(firstTask)).toEqual(stableTaskIdentity(secondTask));
  });

  it('prepares repeatable bounded runtime-core task packets for the same description', () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'glm-5.1' })) } as any;
    const description = 'Tighten the bounded runtime-core self-improvement facade';

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_775_960_800_000)
      .mockReturnValueOnce(1_775_960_800_001);

    const first = runtime.prepare({ llm, description });
    const second = runtime.prepare({ llm, description });

    expect(first.task.domain).toBe('runtime-core');
    expect(second.task.domain).toBe('runtime-core');
    expect(first.task.id).not.toBe(second.task.id);
    expect(first.task.expansionBudget).toBe(2);
    expect(second.task.expansionBudget).toBe(2);
    expect(first.task.expansionStatus).toBe('exhausted');
    expect(second.task.expansionStatus).toBe('exhausted');
    expect(first.task.workingSet).toEqual([
      ...(first.task.primaryFiles || []),
      ...(first.task.secondaryFiles || []),
    ]);
    expect(second.task.workingSet).toEqual([
      ...(second.task.primaryFiles || []),
      ...(second.task.secondaryFiles || []),
    ]);
    expect(stableTaskIdentity(first.task)).toEqual(stableTaskIdentity(second.task));
  });

  it('prepares a concrete bounded runtime task packet once and reuses it for execution', async () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'glm-5.1' })) } as any;
    const session = {
      status: 'success',
      startTime: '2026-04-11T18:00:00.000Z',
      endTime: '2026-04-11T18:00:01.000Z',
      stepCount: 1,
    } as any;
    mockExecuteTask.mockResolvedValue(session);

    const originalMaxSteps = process.env.LIMINAL_TUI_AGENT_MAX_STEPS;
    process.env.LIMINAL_TUI_AGENT_MAX_STEPS = '7';
    vi.spyOn(Date, 'now').mockReturnValue(1_775_960_700_000);

    try {
      const prepared = runtime.prepare({
        llm,
        description: 'Fix checkpoint resume handoff behavior',
      });

      expect(prepared.task).toEqual(expect.objectContaining({
        id: 'tui-self-1775960700000',
        title: 'Bubble Tea TUI self-improvement request',
        description: expect.stringContaining('Fix checkpoint resume handoff behavior'),
        fileHint: 'src/harness/RunStateStore.ts',
        workingSet: [
          'src/harness/RunStateStore.ts',
          'src/harness/agent/LLMModeAgent.ts',
          'test/unit/LLMModeAgent.test.ts',
          'test/harness/RunStateStore.test.ts',
        ],
        primaryFiles: [
          'src/harness/RunStateStore.ts',
          'src/harness/agent/LLMModeAgent.ts',
        ],
        secondaryFiles: [
          'test/unit/LLMModeAgent.test.ts',
          'test/harness/RunStateStore.test.ts',
        ],
        deferredSecondaryFiles: [],
        expansionBudget: 2,
        expansionStatus: 'exhausted',
        localizationConfidence: 'high',
        verificationTargets: [
          {
            tool: 'runTests',
            pattern: 'LLMModeAgent|RunStateStore',
            reason: 'Checkpoint/resume regressions should hit focused runtime tests first',
            priority: 1,
          },
          {
            tool: 'runBuild',
            reason: 'Full TypeScript build after resume/checkpoint changes',
            priority: 2,
          },
        ],
        domain: 'runstate',
        maxSteps: 7,
        approved: true,
        completionPolicy: 'stop_after_verification',
      }));
      expect(prepared.maxSteps).toBe(7);
      expect(prepared.task.description).toContain('Primary files:');
      expect(prepared.task.description).toContain('Secondary files:');
      expect(prepared.task.description).toContain('Verification targets:');
      expect(prepared.task.description).toContain('Preferred verification targets after a mutation:');
      expect(prepared.task.description).toContain('Expansion status: exhausted');
      expect(prepared.task.description).toContain('Expansion budget: 2 additional files before broadening beyond this packet');
      expect(prepared.task.description).toContain('Localization confidence: high');
      expect(prepared.task.description).toContain(`Hint: ${prepared.task.fileHint}`);
      expect(prepared.task.description).toContain(`Current active focus file: ${prepared.task.fileHint}`);
      expect(prepared.task.description).toContain('Your first explicit tool call should stay on the current active focus file unless you are editing or verifying.');
      expect(prepared.task.description).toContain('Preferred verification targets after a mutation:');

      process.env.LIMINAL_TUI_AGENT_MAX_STEPS = '99';
      await prepared.execute();

      expect(mockExecuteTask).toHaveBeenCalledWith(prepared.task);
      expect(prepared.task.maxSteps).toBe(7);
    } finally {
      if (originalMaxSteps === undefined) {
        delete process.env.LIMINAL_TUI_AGENT_MAX_STEPS;
      } else {
        process.env.LIMINAL_TUI_AGENT_MAX_STEPS = originalMaxSteps;
      }
    }
  });

  it('falls back to the default max steps when the env override is invalid', () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'glm-5.1' })) } as any;

    const originalMaxSteps = process.env.LIMINAL_TUI_AGENT_MAX_STEPS;
    process.env.LIMINAL_TUI_AGENT_MAX_STEPS = 'not-a-number';

    try {
      const prepared = runtime.prepare({
        llm,
        description: 'Improve Bubble Tea self-improvement startup and convergence',
      });

      expect(prepared.maxSteps).toBe(20);
      expect(prepared.task.maxSteps).toBe(20);
    } finally {
      if (originalMaxSteps === undefined) {
        delete process.env.LIMINAL_TUI_AGENT_MAX_STEPS;
      } else {
        process.env.LIMINAL_TUI_AGENT_MAX_STEPS = originalMaxSteps;
      }
    }
  });

  it('diagnose seats skip mutation packet, honor maxSteps input, and default higher budget', () => {
    const runtime = new LLMModeSelfImprovementRuntime();
    const llm = { getConfig: vi.fn(() => ({ model: 'grok-4.5' })) } as any;
    const originalMaxSteps = process.env.LIMINAL_TUI_AGENT_MAX_STEPS;
    delete process.env.LIMINAL_TUI_AGENT_MAX_STEPS;

    try {
      const prepared = runtime.prepare({
        llm,
        description: 'ARCHITECT DIAGNOSE ONLY — study compound loop',
        forbidMutations: true,
        kind: 'diagnose',
        maxSteps: 12,
      });

      expect(prepared.maxSteps).toBe(12);
      expect(prepared.task.maxSteps).toBe(12);
      expect(prepared.task.forbidMutations).toBe(true);
      expect(prepared.task.kind).toBe('diagnose');
      expect(prepared.task.primaryFiles).toBeUndefined();
      expect(prepared.task.verificationTargets).toEqual([]);
      expect(prepared.task.description).toContain('Architect Diagnose Contract');
      expect(prepared.task.description).not.toContain('Primary files:');
      expect(prepared.task.description).not.toContain('Your first explicit tool call should stay on the current active focus');

      const defaultDiagnose = runtime.prepare({
        llm,
        description: 'diagnose default budget',
        forbidMutations: true,
        kind: 'diagnose',
      });
      expect(defaultDiagnose.maxSteps).toBe(28);
    } finally {
      if (originalMaxSteps === undefined) {
        delete process.env.LIMINAL_TUI_AGENT_MAX_STEPS;
      } else {
        process.env.LIMINAL_TUI_AGENT_MAX_STEPS = originalMaxSteps;
      }
    }
  });
});
