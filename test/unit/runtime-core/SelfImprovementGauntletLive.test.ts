import { describe, expect, it } from 'vitest';
import {
  LIVE_GAUNTLET_DESCRIPTION,
  runLiveSelfImprovementGauntlet,
  type LiveGauntletEditDetection,
} from '../../../src/runtime-core/SelfImprovementGauntletLive.js';
import type {
  SelfImprovementRuntime,
  SelfImprovementRuntimeInput,
  SelfImprovementRuntimeResult,
} from '../../../src/runtime-core/SelfImprovementRuntime.js';
import { Status } from '../../../src/types/status.js';

/**
 * Behavioral tests for the live self-improvement gauntlet orchestration.
 *
 * The LLM boundary is mocked by injecting a fake SelfImprovementRuntime (the
 * seam directly above the real LLMClient / LLMModeAgent). The sandbox
 * filesystem boundary is mocked via detectSandboxEdits. This proves the
 * verification logic that decides whether a real bounded edit was produced,
 * without calling a live provider.
 */

interface FakeRuntimeSession {
  status: Status | string;
  stepCount: number;
  mutatedFiles?: Set<string>;
  successfulMutatedFiles?: Set<string>;
  lastPlanError?: string;
  lastVerification?: unknown;
}

function fakeRuntime(
  session: FakeRuntimeSession,
  modelName = 'MiniMax-M2.7',
): { runtime: SelfImprovementRuntime; calls: SelfImprovementRuntimeInput[] } {
  const calls: SelfImprovementRuntimeInput[] = [];
  const runtime: SelfImprovementRuntime = {
    prepare() {
      throw new Error('prepare should not be called by the live gauntlet');
    },
    async run(input: SelfImprovementRuntimeInput): Promise<SelfImprovementRuntimeResult> {
      calls.push(input);
      return {
        taskId: 'tui-self-fake',
        modelName,
        maxSteps: 20,
        session: session as unknown as SelfImprovementRuntimeResult['session'],
        lifecycle: { status: session.status } as unknown as SelfImprovementRuntimeResult['lifecycle'],
      };
    },
  };
  return { runtime, calls };
}

const fakeLlm = { getConfig: () => ({ model: 'MiniMax-M2.7' }) } as never;

function detection(d: LiveGauntletEditDetection): () => LiveGauntletEditDetection {
  return () => d;
}

describe('runLiveSelfImprovementGauntlet', () => {
  it('verifies a real edit when the runtime mutated AND the sandbox shows the change', async () => {
    const { runtime, calls } = fakeRuntime({
      status: Status.SUCCESS,
      stepCount: 4,
      mutatedFiles: new Set(['src/runtime-core/RepoIndexLite.ts']),
      successfulMutatedFiles: new Set(['src/runtime-core/RepoIndexLite.ts']),
    });

    const result = await runLiveSelfImprovementGauntlet({
      llm: fakeLlm,
      runtime,
      detectSandboxEdits: detection({
        hasUncommittedChange: true,
        changedFiles: ['src/runtime-core/RepoIndexLite.ts'],
      }),
    });

    expect(result.verified).toBe(true);
    expect(result.status).toBe(Status.SUCCESS);
    expect(result.stepCount).toBe(4);
    expect(result.mutatedFiles).toEqual(['src/runtime-core/RepoIndexLite.ts']);
    expect(result.sandboxChangedFiles).toEqual(['src/runtime-core/RepoIndexLite.ts']);
    expect(result.modelName).toBe('MiniMax-M2.7');
    expect(result.description).toBe(LIVE_GAUNTLET_DESCRIPTION);
    expect(result.reason).toContain('Bounded self-improvement edited src/runtime-core/RepoIndexLite.ts');
    // The bounded description is the one handed to the real runtime, with the
    // mutation gate on by default so an inspection-only pass cannot pass.
    expect(calls).toHaveLength(1);
    expect(calls[0].description).toBe(LIVE_GAUNTLET_DESCRIPTION);
    expect(calls[0].llm).toBe(fakeLlm);
    expect(calls[0].requiresMutation).toBe(true);
  });

  it('lets the caller disable the mutation gate explicitly', async () => {
    const { runtime, calls } = fakeRuntime({
      status: Status.SUCCESS,
      stepCount: 2,
      mutatedFiles: new Set(),
      successfulMutatedFiles: new Set(),
    });

    const result = await runLiveSelfImprovementGauntlet({
      llm: fakeLlm,
      runtime,
      requiresMutation: false,
      detectSandboxEdits: detection({ hasUncommittedChange: false, changedFiles: [] }),
    });

    expect(calls[0].requiresMutation).toBe(false);
    expect(result.verified).toBe(false);
  });

  it('rejects an inspection-only pass that mutated nothing on either side', async () => {
    const { runtime } = fakeRuntime({
      status: Status.FAILED,
      stepCount: 10,
      mutatedFiles: new Set(),
      successfulMutatedFiles: new Set(),
    });

    const result = await runLiveSelfImprovementGauntlet({
      llm: fakeLlm,
      runtime,
      detectSandboxEdits: detection({ hasUncommittedChange: false, changedFiles: [] }),
    });

    expect(result.verified).toBe(false);
    expect(result.mutatedFiles).toEqual([]);
    expect(result.sandboxChangedFiles).toEqual([]);
    expect(result.reason).toBe(
      'No edit produced: runtime tracked no mutation and the sandbox has no uncommitted change (status=failed).',
    );
  });

  it('rejects a phantom mutation the runtime tracked but the sandbox never persisted', async () => {
    const { runtime } = fakeRuntime({
      status: Status.SUCCESS,
      stepCount: 3,
      mutatedFiles: new Set(['src/runtime-core/RepoIndexLite.ts']),
      successfulMutatedFiles: new Set(),
    });

    const result = await runLiveSelfImprovementGauntlet({
      llm: fakeLlm,
      runtime,
      detectSandboxEdits: detection({ hasUncommittedChange: false, changedFiles: [] }),
    });

    expect(result.verified).toBe(false);
    expect(result.mutatedFiles).toEqual(['src/runtime-core/RepoIndexLite.ts']);
    expect(result.sandboxChangedFiles).toEqual([]);
    expect(result.reason).toBe(
      'Runtime tracked mutation(s) (src/runtime-core/RepoIndexLite.ts) but the sandbox shows no matching uncommitted change (status=success).',
    );
  });

  it('rejects a stray sandbox change the runtime never attributed to a mutation', async () => {
    const { runtime } = fakeRuntime({
      status: Status.SUCCESS,
      stepCount: 2,
      mutatedFiles: new Set(),
      successfulMutatedFiles: new Set(),
    });

    const result = await runLiveSelfImprovementGauntlet({
      llm: fakeLlm,
      runtime,
      detectSandboxEdits: detection({ hasUncommittedChange: true, changedFiles: ['untracked.tmp'] }),
    });

    expect(result.verified).toBe(false);
    expect(result.sandboxChangedFiles).toEqual(['untracked.tmp']);
    expect(result.reason).toBe(
      'Sandbox changed (untracked.tmp) but the runtime reported no in-process mutation (status=success).',
    );
  });

  it('awaits an async sandbox edit detector and honors a custom bounded description', async () => {
    const { runtime, calls } = fakeRuntime({
      status: Status.SUCCESS,
      stepCount: 5,
      mutatedFiles: new Set(['src/runtime-core/SelfImprovementRuntime.ts']),
      successfulMutatedFiles: new Set(['src/runtime-core/SelfImprovementRuntime.ts']),
    });

    const result = await runLiveSelfImprovementGauntlet({
      llm: fakeLlm,
      runtime,
      description: 'Custom bounded runtime-core improvement',
      detectSandboxEdits: async () => ({
        hasUncommittedChange: true,
        changedFiles: ['src/runtime-core/SelfImprovementRuntime.ts'],
      }),
    });

    expect(result.verified).toBe(true);
    expect(result.description).toBe('Custom bounded runtime-core improvement');
    expect(calls[0].description).toBe('Custom bounded runtime-core improvement');
    expect(result.successfulMutatedFiles).toEqual(['src/runtime-core/SelfImprovementRuntime.ts']);
  });

  it('treats a session with no mutation Sets as no edit (defensive against missing fields)', async () => {
    const { runtime } = fakeRuntime({
      status: Status.SUCCESS,
      stepCount: 1,
      // mutatedFiles / successfulMutatedFiles intentionally undefined
    });

    const result = await runLiveSelfImprovementGauntlet({
      llm: fakeLlm,
      runtime,
      detectSandboxEdits: detection({ hasUncommittedChange: false, changedFiles: [] }),
    });

    expect(result.verified).toBe(false);
    expect(result.mutatedFiles).toEqual([]);
    expect(result.successfulMutatedFiles).toEqual([]);
  });
});
