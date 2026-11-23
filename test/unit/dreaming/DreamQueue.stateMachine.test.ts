/**
 * DreamQueue lifecycle as an explicit state machine:
 * transition table, every legal / illegal move, legacy on-disk values, and a
 * seeded model test over random command sequences (including reloads).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DREAM_TASK_STATUSES,
  DREAM_TASK_TRANSITIONS,
  DreamQueue,
  IllegalDreamTaskTransitionError,
  isDreamTaskStatus,
  isTerminalDreamTaskStatus,
  transitionDreamTask,
  type DreamTask,
  type DreamTaskStatus,
} from '../../../src/dreaming/DreamQueue.js';
import type { CompositionDreamPlan } from '../../../src/dreaming/CompositionDreamTypes.js';
import { pick, runModel } from '../../helpers/stateMachineModel.js';

const EXPECTED_TABLE: Record<DreamTaskStatus, DreamTaskStatus[]> = {
  queued: ['running'],
  running: ['completed', 'failed', 'queued'],
  completed: [],
  failed: [],
};

function task(status: DreamTaskStatus): DreamTask {
  return {
    id: 'dream-1-0',
    kind: 'artifact',
    strategy: 'elite-x-elite',
    sources: [],
    priority: 0.5,
    status,
    enqueuedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('DreamQueue state machine — table', () => {
  it('declares a transition row for every status and no others', () => {
    expect(Object.keys(DREAM_TASK_TRANSITIONS).sort()).toEqual([...DREAM_TASK_STATUSES].sort());
    for (const status of DREAM_TASK_STATUSES) {
      expect([...DREAM_TASK_TRANSITIONS[status]].sort()).toEqual([...EXPECTED_TABLE[status]].sort());
    }
  });

  it('marks exactly completed and failed as terminal', () => {
    expect(DREAM_TASK_STATUSES.filter(isTerminalDreamTaskStatus).sort()).toEqual(['completed', 'failed']);
  });

  it('getStatus reports exactly one counter per status', () => {
    expect(Object.keys(new DreamQueue().getStatus()).sort()).toEqual([...DREAM_TASK_STATUSES].sort());
  });

  for (const from of DREAM_TASK_STATUSES) {
    for (const to of DREAM_TASK_STATUSES) {
      const legal = EXPECTED_TABLE[from].includes(to);
      it(`${from} -> ${to} is ${legal ? 'allowed' : 'refused'}`, () => {
        const t = task(from);
        if (legal) {
          transitionDreamTask(t, to, '2026-02-02T00:00:00.000Z');
          expect(t.status).toBe(to);
          if (to === 'running') expect(t.startedAt).toBe('2026-02-02T00:00:00.000Z');
          if (isTerminalDreamTaskStatus(to)) expect(t.completedAt).toBe('2026-02-02T00:00:00.000Z');
        } else {
          expect(() => transitionDreamTask(t, to)).toThrow(IllegalDreamTaskTransitionError);
          expect(t.status).toBe(from);
          expect(t.startedAt).toBeUndefined();
          expect(t.completedAt).toBeUndefined();
        }
      });
    }
  }

  it('stays strict about an unknown in-memory status', () => {
    const t = { ...task('queued'), status: 'cancelled' as unknown as DreamTaskStatus };
    expect(() => transitionDreamTask(t, 'running')).toThrow(IllegalDreamTaskTransitionError);
  });
});

describe('DreamQueue state machine — public API refusals', () => {
  it('complete/fail return false and change nothing unless the task is running', () => {
    const queue = new DreamQueue();
    const id = queue.enqueue('elite-x-elite', [], 0.5)!;
    expect(queue.complete(id, { candidateDescriptor: [], parentIds: [] })).toBe(false);
    expect(queue.fail(id)).toBe(false);
    expect(queue.getTasks()[0]).toMatchObject({ status: 'queued' });
    expect(queue.getTasks()[0].completedAt).toBeUndefined();

    queue.dequeue();
    expect(queue.complete(id, { candidateDescriptor: [1], parentIds: [] })).toBe(true);
    expect(queue.fail(id)).toBe(false);
    expect(queue.complete(id, { candidateDescriptor: [2], parentIds: [] })).toBe(false);
    expect(queue.getTasks()[0].result?.candidateDescriptor).toEqual([1]);
  });

  it('dequeueExact never re-claims a terminal task', () => {
    const queue = new DreamQueue();
    const id = queue.enqueue('elite-x-elite', [], 0.5)!;
    queue.dequeueExact(id);
    queue.fail(id);
    expect(queue.dequeueExact(id)).toBeUndefined();
  });

  it('finishing a task frees its concurrency slot', () => {
    const queue = new DreamQueue({ maxConcurrent: 1 });
    const a = queue.enqueue('elite-x-elite', [], 0.9)!;
    queue.enqueue('cross-modal', [], 0.5);
    expect(queue.dequeue()?.id).toBe(a);
    expect(queue.dequeue()).toBeUndefined();
    queue.complete(a, { candidateDescriptor: [], parentIds: [] });
    expect(queue.dequeue()?.strategy).toBe('cross-modal');
  });
});

describe('DreamQueue state machine — persisted / legacy values', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamq-sm-'));
    file = path.join(dir, 'queue.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTasks(tasks: Array<Record<string, unknown>>): void {
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks }), 'utf-8');
  }

  it('reads every legal persisted status back unchanged (except running, which is reclaimed)', () => {
    writeTasks(DREAM_TASK_STATUSES.map((status, i) => ({ ...task(status), id: `dream-${i + 1}-0` })));
    const queue = new DreamQueue({ persistPath: file });
    const byId = Object.fromEntries(queue.getTasks().map(t => [t.id, t.status]));
    expect(byId).toEqual({
      'dream-1-0': 'queued',
      'dream-2-0': 'queued', // was running: its consumer died
      'dream-3-0': 'completed',
      'dream-4-0': 'failed',
    });
  });

  it('a task with a status no reader handles does not leak a queue slot forever', () => {
    // Regression: such a task was never dequeued, pruned, or evicted, and
    // getStatus() grew a NaN counter for it.
    writeTasks([
      { ...task('queued'), id: 'dream-1-0', status: 'cancelled' },
      { ...task('queued'), id: 'dream-2-0', status: undefined },
    ]);
    const queue = new DreamQueue({ persistPath: file, maxQueueSize: 2 });

    const counts = queue.getStatus();
    expect(Object.keys(counts).sort()).toEqual([...DREAM_TASK_STATUSES].sort());
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2);
    expect(queue.getTasks().every(t => isDreamTaskStatus(t.status))).toBe(true);

    // The queue was "full" of unhandled tasks; admission must still succeed.
    expect(queue.enqueue('elite-x-elite', [], 0.5)).toEqual(expect.any(String));
    expect(queue.getTasks().map(t => t.status)).toEqual(['queued']);
  });

  it('keeps the persisted byte layout of a freshly enqueued task', () => {
    const queue = new DreamQueue({ persistPath: file });
    queue.enqueue('elite-x-elite', [], 0.5);
    queue.enqueueComposition({ domains: [] } as unknown as CompositionDreamPlan, [], 0.4);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version: number; tasks: Array<Record<string, unknown>> };
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.tasks[0])).toEqual(['id', 'kind', 'strategy', 'sources', 'priority', 'status', 'enqueuedAt']);
    expect(Object.keys(saved.tasks[1])).toEqual([
      'id', 'kind', 'strategy', 'sources', 'priority', 'status', 'compositionPlan', 'enqueuedAt',
    ]);
  });
});

describe('DreamQueue state machine — model test', () => {
  interface World {
    dir: string;
    file: string;
    maxConcurrent: number;
    queue: DreamQueue;
    /** Model: id -> status (pruned ids removed). */
    model: Map<string, DreamTaskStatus>;
  }

  const MAX_CONCURRENT = 2;
  const MAX_QUEUE = 6;

  function reopen(w: World): void {
    w.queue = new DreamQueue({ persistPath: w.file, maxConcurrent: w.maxConcurrent, maxQueueSize: MAX_QUEUE });
    for (const [id, status] of w.model) if (status === 'running') w.model.set(id, 'queued');
  }

  function dropTerminal(w: World): void {
    for (const [id, status] of [...w.model]) if (isTerminalDreamTaskStatus(status)) w.model.delete(id);
  }

  it('random command sequences never break the lifecycle invariants', () => {
    runModel<World>({
      runs: 40,
      steps: 60,
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamq-model-'));
        const file = path.join(dir, 'queue.json');
        const w: World = {
          dir, file, maxConcurrent: MAX_CONCURRENT, model: new Map(),
          queue: new DreamQueue({ persistPath: file, maxConcurrent: MAX_CONCURRENT, maxQueueSize: MAX_QUEUE }),
        };
        return w;
      },
      teardown: w => fs.rmSync(w.dir, { recursive: true, force: true }),
      commands: [
        {
          name: 'enqueue',
          run: (w, rand) => {
            dropTerminal(w); // admission prunes first
            const id = w.queue.enqueue('elite-x-elite', [], rand());
            if (id) w.model.set(id, 'queued');
            else expect(w.model.size).toBe(MAX_QUEUE);
          },
        },
        {
          name: 'enqueueComposition',
          run: (w, rand) => {
            dropTerminal(w);
            const id = w.queue.enqueueComposition({} as CompositionDreamPlan, [], rand());
            if (id) w.model.set(id, 'queued');
          },
        },
        {
          name: 'dequeue',
          run: (w, rand) => {
            const kind = rand() < 0.5 ? 'artifact' : 'composition';
            const t = w.queue.dequeue(kind);
            if (t) {
              expect(w.model.get(t.id)).toBe('queued');
              w.model.set(t.id, 'running');
            }
          },
        },
        {
          name: 'dequeueExact',
          run: (w, rand) => {
            const ids = [...w.model.keys()];
            if (ids.length === 0) return;
            const id = pick(rand, ids);
            const before = w.model.get(id);
            const running = [...w.model.values()].filter(s => s === 'running').length;
            const t = w.queue.dequeueExact(id);
            expect(Boolean(t)).toBe(before === 'queued' && running < w.maxConcurrent);
            if (t) w.model.set(id, 'running');
          },
        },
        {
          name: 'complete',
          run: (w, rand) => {
            const ids = [...w.model.keys()];
            if (ids.length === 0) return;
            const id = pick(rand, ids);
            const ok = w.queue.complete(id, { candidateDescriptor: [], parentIds: [] });
            expect(ok).toBe(w.model.get(id) === 'running');
            if (ok) w.model.set(id, 'completed');
          },
        },
        {
          name: 'fail',
          run: (w, rand) => {
            const ids = [...w.model.keys()];
            if (ids.length === 0) return;
            const id = pick(rand, ids);
            const ok = w.queue.fail(id);
            expect(ok).toBe(w.model.get(id) === 'running');
            if (ok) w.model.set(id, 'failed');
          },
        },
        { name: 'prune', run: w => { w.queue.prune(); dropTerminal(w); } },
        { name: 'reload', run: w => reopen(w) },
      ],
      invariant: w => {
        const tasks = w.queue.getTasks();
        expect(new Map(tasks.map(t => [t.id, t.status]))).toEqual(w.model);
        const counts = w.queue.getStatus();
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(tasks.length);
        expect(counts.running).toBeLessThanOrEqual(w.maxConcurrent);
        expect(tasks.length).toBeLessThanOrEqual(MAX_QUEUE);
        for (const t of tasks) {
          expect(isDreamTaskStatus(t.status)).toBe(true);
          expect(Boolean(t.completedAt)).toBe(isTerminalDreamTaskStatus(t.status));
          if (t.status === 'running') expect(typeof t.startedAt).toBe('string');
        }
        // what is on disk is what a fresh process would see (modulo reclaim)
        if (!fs.existsSync(w.file)) return;
        const disk = JSON.parse(fs.readFileSync(w.file, 'utf-8')) as { tasks: DreamTask[] };
        expect(disk.tasks.map(t => t.id).sort()).toEqual(tasks.map(t => t.id).sort());
      },
    });
  });
});
