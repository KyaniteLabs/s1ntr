/**
 * GoalStore — Phase 13 Increment 2
 *
 * CRUD persistence for CortexGoal objects via SinterFS manifests.
 * Storage layout: .sinter/manifests/cortex/goal/<id>/manifest.json
 *
 * Follows the same pattern as TaskLedger (src/ledger/TaskLedger.ts).
 *
 * Usage:
 *   const store = new GoalStore(fs);
 *   const goal = store.addGoal({ text: 'Fix coverage above 80%', priority: 'high', category: 'coverage' });
 *   const active = store.getActiveGoals();
 *   store.completeGoal(goal.id);
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { SinterFS } from '../fs/SinterFS.js';
import { canTransitionGoal, IllegalGoalTransitionError } from './GoalLifecycle.js';
import type { CortexGoal, GoalPriority, GoalCategory, GoalStatus } from './types.js';

export {
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  IllegalGoalTransitionError,
  canTransitionGoal,
  isGoalStatus,
} from './GoalLifecycle.js';

const GOAL_PREFIX = 'cortex/goal';

export class GoalStore {
  constructor(private fs: SinterFS) {}

  /**
   * Add a new goal. Auto-generates ID and timestamps.
   */
  addGoal(input: { text: string; priority?: GoalPriority; category?: GoalCategory }): CortexGoal {
    const now = new Date().toISOString();
    const id = `goal-${Date.now()}-${randomBytes(3).toString('hex')}`;

    const goal: CortexGoal = {
      id,
      text: input.text,
      priority: input.priority ?? 'normal',
      category: input.category ?? 'maintenance',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    this.fs.writeManifest(`${GOAL_PREFIX}/${goal.id}/manifest`, goal as unknown as Record<string, unknown>);
    return goal;
  }

  /**
   * Load a goal by ID. Returns null if not found.
   */
  getGoal(goalId: string): CortexGoal | null {
    const data = this.fs.readManifest(`${GOAL_PREFIX}/${goalId}/manifest`);
    return data as unknown as CortexGoal | null;
  }

  /**
   * List all goals, optionally filtered by status.
   */
  listGoals(filter?: { status?: GoalStatus }): CortexGoal[] {
    const manifestsDir = join(this.fs.getProjectRoot(), '.sinter', 'manifests', 'cortex', 'goal');
    if (!existsSync(manifestsDir)) {
      return [];
    }

    const entries = readdirSync(manifestsDir, { withFileTypes: true });
    const goals: CortexGoal[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const data = this.fs.readManifest(`${GOAL_PREFIX}/${entry.name}/manifest`);
      if (!data) continue;

      const goal = data as unknown as CortexGoal;
      if (filter?.status !== undefined && goal.status !== filter.status) continue;
      goals.push(goal);
    }

    // Sort by creation time (oldest first) — spread to avoid in-place mutation
    return [...goals].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * List only active goals (convenience method).
   */
  getActiveGoals(): CortexGoal[] {
    return this.listGoals({ status: 'active' });
  }

  /**
   * Mark a goal as completed. Returns null if the goal does not exist; throws
   * {@link IllegalGoalTransitionError} if it is already completed or dropped.
   */
  completeGoal(goalId: string): CortexGoal | null {
    return this.transitionGoal(goalId, 'completed');
  }

  /**
   * Remove a goal (writes a 'dropped' tombstone). Returns false if the goal
   * does not exist; throws {@link IllegalGoalTransitionError} if it is
   * already dropped.
   */
  removeGoal(goalId: string): boolean {
    return this.transitionGoal(goalId, 'dropped') !== null;
  }

  /** The single writer of `status` for an existing goal. */
  private transitionGoal(goalId: string, to: GoalStatus): CortexGoal | null {
    const goal = this.getGoal(goalId);
    if (!goal) return null;
    if (!canTransitionGoal(goal.status, to)) {
      throw new IllegalGoalTransitionError(goalId, goal.status, to);
    }
    goal.status = to;
    goal.updatedAt = new Date().toISOString();
    this.fs.writeManifest(`${GOAL_PREFIX}/${goalId}/manifest`, goal as unknown as Record<string, unknown>);
    return goal;
  }
}
