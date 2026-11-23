/**
 * TaskLedger task-status lifecycle as an explicit state machine, against a
 * real SinterFS in a temp directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SinterFS } from '../../../src/fs/SinterFS.js';
import { TaskLedger } from '../../../src/ledger/TaskLedger.js';
import { execute } from '../../../src/ledger/cli.js';
import {
  IllegalTaskTransitionError,
  TASK_STATUSES,
  TASK_STATUS_TRANSITIONS,
  canTransitionTask,
  type TaskStatus,
} from '../../../src/ledger/types.js';
import { pick, runModel } from '../../helpers/stateMachineModel.js';

const EXPECTED_TABLE: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in-progress', 'completed', 'failed', 'skipped'],
  'in-progress': ['completed', 'failed', 'skipped'],
  failed: ['completed'],
  completed: [],
  skipped: [],
};

describe('TaskLedger state machine', () => {
  let dir: string;
  let sfs: SinterFS;
  let ledger: TaskLedger;
  let n = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-sm-'));
    sfs = SinterFS.open(dir);
    ledger = new TaskLedger(sfs);
  });

  afterEach(() => {
    sfs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function newTask(): string {
    const id = `T${++n}`;
    ledger.createTask({
      id,
      title: 't',
      description: 'd',
      taskClass: 'leaf',
      files: { allowlist: ['src/**'], denylist: [] },
      verifyCommand: 'true',
      scoringCriteria: ['technical'],
      lane: 1,
      maxAttempts: 3,
    });
    return id;
  }

  /** Force a status onto disk, bypassing the state machine (legacy data). */
  function taskIn(status: string): string {
    const id = newTask();
    const task = ledger.loadTask(id)!;
    sfs.writeManifest(`task/${id}/manifest`, { ...task, status } as unknown as Record<string, unknown>);
    return id;
  }

  function decisionCount(taskId: string): number {
    const d = join(dir, '.sinter', 'manifests', 'task', taskId, 'decision');
    return existsSync(d) ? readdirSync(d).length : 0;
  }

  it('declares a transition row for every status and no others', () => {
    expect(Object.keys(TASK_STATUS_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    for (const s of TASK_STATUSES) {
      expect([...TASK_STATUS_TRANSITIONS[s]].sort()).toEqual([...EXPECTED_TABLE[s]].sort());
    }
  });

  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      const legal = EXPECTED_TABLE[from].includes(to);
      it(`${from} -> ${to} is ${legal ? 'allowed' : 'refused'}`, () => {
        const id = taskIn(from);
        const before = ledger.loadTask(id)!;
        if (legal) {
          ledger.updateTaskStatus(id, to);
          expect(ledger.loadTask(id)!.status).toBe(to);
        } else {
          expect(() => ledger.updateTaskStatus(id, to)).toThrow(IllegalTaskTransitionError);
          expect(ledger.loadTask(id)).toEqual(before);
        }
      });
    }
  }

  it('recordAttempt promotes only pending tasks and never touches terminal ones', () => {
    for (const from of TASK_STATUSES) {
      const id = taskIn(from);
      ledger.recordAttempt({
        id: `a-${id}`, taskId: id, startedAt: '2026-01-01T00:00:00Z',
      } as Parameters<TaskLedger['recordAttempt']>[0]);
      const task = ledger.loadTask(id)!;
      expect(task.status).toBe(from === 'pending' ? 'in-progress' : from);
      expect(task.attemptCount).toBe(1);
    }
  });

  it('an accepted decision on a completed task is refused without writing an orphan decision', () => {
    const id = newTask();
    const accept = (dec: string) => ledger.recordDecision({
      id: dec, taskId: id, candidateId: 'c', decision: 'accepted',
      rationale: 'ok', score: 1, decidedAt: '2026-01-01T00:00:00Z',
    });
    accept('dec-1');
    expect(ledger.loadTask(id)!.status).toBe('completed');
    expect(() => accept('dec-2')).toThrow(IllegalTaskTransitionError);
    expect(decisionCount(id)).toBe(1);
    expect(ledger.loadLatestDecision(id)!.id).toBe('dec-1');
  });

  it('CLI accept on a completed task exits 1 with a clear message instead of a stack trace', async () => {
    const id = newTask();
    ledger.updateTaskStatus(id, 'completed');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(execute({ command: 'accept', taskId: id, candidateId: 'c' }, ledger)).rejects.toThrow('exit 1');
      expect(err).toHaveBeenCalledWith(`Cannot accept: task ${id} is already completed.`);
      expect(decisionCount(id)).toBe(0);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });

  it('a late manual accept can still complete a failed task', () => {
    const id = newTask();
    ledger.updateTaskStatus(id, 'failed');
    ledger.recordDecision({
      id: 'dec-1', taskId: id, candidateId: 'c', decision: 'accepted',
      rationale: 'ok', score: 1, decidedAt: '2026-01-01T00:00:00Z',
    });
    expect(ledger.loadTask(id)!.status).toBe('completed');
  });

  it('legacy / unknown statuses still load and list, and are treated leniently as pending', () => {
    const id = taskIn('blocked');
    expect(ledger.listTasks().map(t => t.id)).toContain(id);
    expect(ledger.loadTask(id)!.status).toBe('blocked');
    expect(canTransitionTask('blocked', 'completed')).toBe(true);
    ledger.updateTaskStatus(id, 'completed');
    expect(ledger.loadTask(id)!.status).toBe('completed');
  });

  it('an existing-format persisted task manifest still loads and behaves the same', () => {
    // Shape written by the pre-state-machine ledger (same keys, same strings).
    const legacy = {
      id: 'OLD-1', title: 't', description: 'd', taskClass: 'leaf', status: 'in-progress',
      files: { allowlist: ['src/**'], denylist: [] }, verifyCommand: 'pnpm test', scoringCriteria: [],
      lane: 1, attemptCount: 2, maxAttempts: 3,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    sfs.writeManifest('task/OLD-1/manifest', legacy as unknown as Record<string, unknown>);
    expect(ledger.loadTask('OLD-1')).toMatchObject({ id: 'OLD-1', status: 'in-progress', attemptCount: 2 });
    expect(ledger.listTasks({ status: 'in-progress' }).map(t => t.id)).toContain('OLD-1');
    ledger.updateTaskStatus('OLD-1', 'failed');
    expect(ledger.loadTask('OLD-1')!.status).toBe('failed');
  });

  it('model: random status moves match the transition table', () => {
    runModel<{ model: Map<string, TaskStatus> }>({
      runs: 8,
      steps: 25,
      setup: () => ({ model: new Map() }),
      commands: [
        { name: 'create', run: w => { w.model.set(newTask(), 'pending'); } },
        {
          name: 'attempt',
          run: (w, rand) => {
            const ids = [...w.model.keys()];
            if (ids.length === 0) return;
            const id = pick(rand, ids);
            ledger.recordAttempt({ id: `a${rand()}`.replace('.', ''), taskId: id, startedAt: 'x' } as Parameters<TaskLedger['recordAttempt']>[0]);
            if (w.model.get(id) === 'pending') w.model.set(id, 'in-progress');
          },
        },
        {
          name: 'move',
          run: (w, rand) => {
            const ids = [...w.model.keys()];
            if (ids.length === 0) return;
            const id = pick(rand, ids);
            const to = pick(rand, TASK_STATUSES);
            if (EXPECTED_TABLE[w.model.get(id)!].includes(to)) {
              ledger.updateTaskStatus(id, to);
              w.model.set(id, to);
            } else {
              expect(() => ledger.updateTaskStatus(id, to)).toThrow(IllegalTaskTransitionError);
            }
          },
        },
      ],
      invariant: w => {
        for (const [id, status] of w.model) expect(ledger.loadTask(id)!.status).toBe(status);
      },
    });
  });
});
