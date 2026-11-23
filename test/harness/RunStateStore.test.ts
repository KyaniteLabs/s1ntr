/**
 * Proof test for RunStateStore checkpoint/resume flow.
 *
 * Verifies that run state can be saved, read, and cleared,
 * and that resume detection works correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveRunState,
  readRunState,
  clearRunState,
  hasResumableRun,
  formatResumeContext,
  SemanticBoundary,
  type RunState,
} from '../../src/harness/RunStateStore.js';
import { Logger } from '../../src/utils/Logger.js';
import { Status } from '../../src/types/status.js';

function makeRunState(overrides?: Partial<RunState>): RunState {
  return {
    runId: 'run-001',
    taskId: 'task-abc',
    taskTitle: 'Test task',
    taskDescription: 'A test task for checkpoint/resume',
    status: Status.SUSPENDED,
    phase: SemanticBoundary.MUTATION_APPLIED,
    stepsCompleted: 3,
    maxSteps: 10,
    continueUntilDone: false,
    startedAt: '2026-04-11T10:00:00.000Z',
    suspendedAt: '2026-04-11T10:05:00.000Z',
    exploredPaths: ['src/foo.ts', 'src/bar.ts'],
    progressSummary: 'Applied mutation to src/foo.ts, pending verification',
    hadMutations: true,
    mutationApplied: true,
    mutatedFiles: ['src/foo.ts'],
    ...overrides,
  };
}

describe('RunStateStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'runstate-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('saves and reads run state', async () => {
    const state = makeRunState();
    await saveRunState(state, tempDir);

    const loaded = await readRunState(tempDir);
    expect(loaded!.runId).toBe('run-001');
    expect(loaded!.taskId).toBe('task-abc');
    expect(loaded!.status).toBe(Status.SUSPENDED);
    expect(loaded!.phase).toBe(SemanticBoundary.MUTATION_APPLIED);
    expect(loaded!.stepsCompleted).toBe(3);
    expect(loaded!.maxSteps).toBe(10);
    expect(loaded!.exploredPaths).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(loaded!.mutatedFiles).toEqual(['src/foo.ts']);
  });

  it('publishes a replacement without changing the checkpoint an existing reader opened', async () => {
    await saveRunState(makeRunState(), tempDir);
    const previous = await open(join(tempDir, '.omx', 'run-state.json'), 'r');
    try {
      const next = makeRunState({ stepsCompleted: 10, lastCheckpointHash: 'feedface' });
      await saveRunState(next, tempDir);
      expect(JSON.parse(await previous.readFile('utf8')).stepsCompleted).toBe(3);
      expect(await hasResumableRun(next.taskId, tempDir)).toEqual(next);
    } finally {
      await previous.close();
    }
  });

  it('accepts legacy tombstones and surfaces a corrupt ledger', async () => {
    await mkdir(join(tempDir, '.omx'));
    const path = join(tempDir, '.omx', 'run-state.json');
    await writeFile(path, '  \n');
    expect(await readRunState(tempDir)).toBeNull();
    await writeFile(path, '{"runId":');
    await expect(readRunState(tempDir)).rejects.toThrow(/corrupt.*run-state|run-state.*corrupt/i);
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    try {
      expect(await hasResumableRun('task-abc', tempDir)).toBeNull();
      expect(warn).toHaveBeenCalledWith('RunStateStore', expect.stringContaining('task-abc'), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('distinguishes an unreadable checkpoint from a missing one', async () => {
    await mkdir(join(tempDir, '.omx', 'run-state.json'), { recursive: true });
    await expect(readRunState(tempDir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('returns null when no run state exists', async () => {
    const loaded = await readRunState(tempDir);
    expect(loaded).toBeNull();
  });

  it('only treats suspended run-state as resumable', async () => {
    const state = makeRunState({ status: Status.FAILED as RunState['status'] });
    await saveRunState(state, tempDir);

    const loaded = await readRunState(tempDir);
    expect(loaded).toBeNull();
  });

  it('clears run state', async () => {
    const state = makeRunState();
    await saveRunState(state, tempDir);

    await clearRunState(tempDir);

    const loaded = await readRunState(tempDir);
    expect(loaded).toBeNull();
  });

  it('detects resumable run by task ID', async () => {
    const state = makeRunState();
    await saveRunState(state, tempDir);

    const found = await hasResumableRun('task-abc', tempDir);
    expect(found!.runId).toBe('run-001');
  });

  it('returns null for mismatched task ID', async () => {
    const state = makeRunState();
    await saveRunState(state, tempDir);

    const found = await hasResumableRun('wrong-task', tempDir);
    expect(found).toBeNull();
  });

  it('returns null for resumable run when no state exists', async () => {
    const found = await hasResumableRun(undefined, tempDir);
    expect(found).toBeNull();
  });

  it('formats resume context with phase and verification continuity details', () => {
    const state = makeRunState({
      lastCheckpointHash: 'abcdef1234567890',
      phase: SemanticBoundary.VERIFICATION_STARTED,
      lastVerification: {
        passed: false,
        type: 'test',
        error: 'LLMModeAgent tests failed',
        timestamp: '2026-04-11T10:04:30.000Z',
      },
    });

    const context = formatResumeContext(state);

    expect(context).toContain('Resume Context');
    expect(context).toContain('3/10 steps');
    expect(context).toContain('Phase at suspension: verification_started');
    expect(context).toContain('Files already mutated: src/foo.ts');
    expect(context).toContain('src/foo.ts');
    expect(context).toContain('src/bar.ts');
    expect(context).toContain('abcdef12');
    expect(context).toContain('Last verification: test failed at 2026-04-11T10:04:30.000Z — LLMModeAgent tests failed');
    expect(context).toContain('Do NOT re-explore');
  });

  it('guides a suspended run to verify uncheckpointed edits without repeating them', () => {
    const state = makeRunState({ stepsCompleted: 10, focusStatus: 'committed' });
    const context = formatResumeContext(state);
    expect(context).toContain('10/10 steps');
    expect(context).toContain('Task ID: task-abc');
    expect(context).toContain('Focus status: committed');
    expect(context).toMatch(/without a recorded checkpoint/i);
    expect(context).toMatch(/verify.*before.*edit/i);
    expect(context).toMatch(/do not re-apply/i);
    expect(context).not.toContain('Mutations were made and checkpointed.');
  });

  it('includes a zero inspection budget and omits an absent budget', () => {
    const context = formatResumeContext(makeRunState({
      focusInspectionBudgetRemaining: 0,
    }));

    expect(context.split('\n')).toContain('Focus inspection reads remaining: 0');
    expect(formatResumeContext(makeRunState())).not.toContain('Focus inspection reads remaining:');
  });

  it('preserves all semantic boundary values in round-trip', async () => {
    for (const phase of Object.values(SemanticBoundary)) {
      const state = makeRunState({ phase });
      await saveRunState(state, tempDir);
      const loaded = await readRunState(tempDir);
      expect(loaded!.phase).toBe(phase);
      await clearRunState(tempDir);
    }
  });

  it('preserves workspace fingerprint in round-trip', async () => {
    const state = makeRunState({
      workspaceFingerprint: {
        gitHead: 'abc1234567890',
        gitBranch: 'feature/test',
        workingTreeClean: true,
        timestamp: '2026-04-11T10:05:00.000Z',
      },
    });
    await saveRunState(state, tempDir);

    const loaded = await readRunState(tempDir);
    expect(loaded!.workspaceFingerprint).toEqual({
      gitHead: 'abc1234567890',
      gitBranch: 'feature/test',
      workingTreeClean: true,
      timestamp: '2026-04-11T10:05:00.000Z',
    });
  });

  it('preserves verification state in round-trip', async () => {
    const state = makeRunState({
      lastVerification: {
        passed: false,
        type: 'build',
        error: 'TypeScript error in foo.ts:42',
        timestamp: '2026-04-11T10:04:30.000Z',
      },
    });
    await saveRunState(state, tempDir);

    const loaded = await readRunState(tempDir);
    expect(loaded!.lastVerification).toEqual({
      passed: false,
      type: 'build',
      error: 'TypeScript error in foo.ts:42',
      timestamp: '2026-04-11T10:04:30.000Z',
    });
  });

  it('preserves planning failure receipts in round-trip and resume context', async () => {
    const receipt = 'upstream rejected request | provider=openai | model=gpt-5.4-mini | endpoint=https://api.openai.com/v1/chat/completions | status=429 | retryable=true | body={"error":"quota exceeded"}';
    const state = makeRunState({
      lastPlanError: receipt,
    });
    await saveRunState(state, tempDir);

    const loaded = await readRunState(tempDir);
    expect(loaded!.lastPlanError).toBe(receipt);
    expect(formatResumeContext(loaded!)).toContain(`Last planning failure: ${receipt}`);
    expect(formatResumeContext(loaded!)).toContain('Recommended next action: Resume checkpoint');
  });
});
