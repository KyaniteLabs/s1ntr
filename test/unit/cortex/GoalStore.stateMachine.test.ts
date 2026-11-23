/**
 * GoalStore lifecycle as an explicit state machine, against a real SinterFS.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SinterFS } from '../../../src/fs/SinterFS.js';
import {
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  GoalStore,
  IllegalGoalTransitionError,
  canTransitionGoal,
  isGoalStatus,
} from '../../../src/cortex/GoalStore.js';
import type { GoalStatus } from '../../../src/cortex/types.js';
import { pick, runModel } from '../../helpers/stateMachineModel.js';

const EXPECTED_TABLE: Record<GoalStatus, GoalStatus[]> = {
  active: ['completed', 'dropped'],
  completed: ['dropped'],
  dropped: [],
};

describe('GoalStore state machine', () => {
  let dir: string;
  let sfs: SinterFS;
  let store: GoalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-sm-'));
    sfs = SinterFS.open(dir);
    store = new GoalStore(sfs);
  });

  afterEach(() => {
    sfs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Put a goal into `status` by writing its manifest directly. */
  function goalIn(status: string): string {
    const goal = store.addGoal({ text: `goal in ${status}` });
    sfs.writeManifest(`cortex/goal/${goal.id}/manifest`, { ...goal, status });
    return goal.id;
  }

  function move(id: string, to: GoalStatus): unknown {
    return to === 'completed' ? store.completeGoal(id) : store.removeGoal(id);
  }

  it('declares a transition row for every status and no others', () => {
    expect(Object.keys(GOAL_TRANSITIONS).sort()).toEqual([...GOAL_STATUSES].sort());
    for (const s of GOAL_STATUSES) expect([...GOAL_TRANSITIONS[s]].sort()).toEqual([...EXPECTED_TABLE[s]].sort());
  });

  it('new goals start active', () => {
    expect(store.addGoal({ text: 'x' }).status).toBe('active');
  });

  // Every (from, to) pair reachable through the public API.
  for (const from of GOAL_STATUSES) {
    for (const to of ['completed', 'dropped'] as const) {
      const legal = EXPECTED_TABLE[from].includes(to);
      it(`${from} -> ${to} is ${legal ? 'allowed' : 'refused'}`, () => {
        const id = goalIn(from);
        const before = store.getGoal(id)!;
        if (legal) {
          const result = move(id, to);
          expect(result === null || result === false).toBe(false);
          expect(store.getGoal(id)!.status).toBe(to);
        } else {
          expect(() => move(id, to)).toThrow(IllegalGoalTransitionError);
          expect(store.getGoal(id)).toEqual(before);
        }
      });
    }
  }

  it('regression: a removed (dropped) goal cannot be resurrected as completed', () => {
    const goal = store.addGoal({ text: 'abandoned' });
    store.removeGoal(goal.id);
    expect(() => store.completeGoal(goal.id)).toThrow(IllegalGoalTransitionError);
    expect(store.getGoal(goal.id)!.status).toBe('dropped');
  });

  it('unknown goals still report not-found rather than throwing', () => {
    expect(store.completeGoal('goal-missing')).toBeNull();
    expect(store.removeGoal('goal-missing')).toBe(false);
  });

  it('a legacy / unknown status on disk is still listed and is treated leniently as active', () => {
    const id = goalIn('archived');
    expect(isGoalStatus('archived')).toBe(false);
    expect(canTransitionGoal('archived', 'dropped')).toBe(true);
    expect(canTransitionGoal('archived', 'completed')).toBe(true);
    expect(store.listGoals().map(g => g.id)).toContain(id);
    expect(store.removeGoal(id)).toBe(true);
    expect(store.getGoal(id)!.status).toBe('dropped');
  });

  it('an existing-format persisted goal file still loads and behaves the same', () => {
    // Shape written by pre-state-machine GoalStore (same keys, same strings).
    const id = 'goal-legacy-1';
    const legacy = {
      id, text: 'raise coverage', priority: 'high', category: 'coverage',
      status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    sfs.writeManifest(`cortex/goal/${id}/manifest`, legacy as unknown as Record<string, unknown>);
    const loaded = store.getGoal(id)!;
    expect(loaded).toMatchObject({ id, status: 'active', priority: 'high', category: 'coverage' });
    expect(store.listGoals().map(g => g.id)).toContain(id);
    expect(store.completeGoal(id)!.status).toBe('completed');
    expect(store.getGoal(id)).toMatchObject({ text: 'raise coverage', priority: 'high' });
  });

  it('model: random moves keep the store in sync with the transition table', () => {
    runModel<{ model: Map<string, GoalStatus> }>({
      runs: 15,
      steps: 30,
      setup: () => ({ model: new Map() }),
      commands: [
        { name: 'add', run: w => { w.model.set(store.addGoal({ text: 't' }).id, 'active'); } },
        ...(['completed', 'dropped'] as const).map(to => ({
          name: to,
          run: (w: { model: Map<string, GoalStatus> }, rand: () => number) => {
            const ids = [...w.model.keys()];
            if (ids.length === 0) return;
            const id = pick(rand, ids);
            const from = w.model.get(id)!;
            if (EXPECTED_TABLE[from].includes(to)) {
              move(id, to);
              w.model.set(id, to);
            } else {
              expect(() => move(id, to)).toThrow(IllegalGoalTransitionError);
            }
          },
        })),
      ],
      invariant: w => {
        for (const [id, status] of w.model) expect(store.getGoal(id)!.status).toBe(status);
        const active = [...w.model].filter(([, s]) => s === 'active').map(([id]) => id).sort();
        expect(store.getActiveGoals().map(g => g.id).filter(id => w.model.has(id)).sort()).toEqual(active);
      },
    });
  });
});
