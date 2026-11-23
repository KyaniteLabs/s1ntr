/**
 * GoalLifecycle — the cortex goal state machine (enforced by GoalStore).
 */

/**
 * Goal lifecycle (enforced by GoalStore.transitionGoal):
 *
 *   addGoal ─► active ──complete──► completed
 *                 │                    │
 *                 └──────drop──────────┴──► dropped   (tombstone, terminal)
 *
 * A dropped goal can never be completed (no resurrection), and no move
 * re-enters the state it started from.
 */
export const GOAL_STATUSES = ['active', 'completed', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  active: ['completed', 'dropped'],
  completed: ['dropped'],
  dropped: [],
};

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === 'string' && (GOAL_STATUSES as readonly string[]).includes(value);
}

/**
 * Lenient read of a persisted status: a missing or unrecognised value (an
 * older or hand-edited manifest) is treated as `active` for transition
 * purposes. The stored value is not rewritten until a legal move is applied.
 */
export function normalizeGoalStatus(value: unknown): GoalStatus {
  return isGoalStatus(value) ? value : 'active';
}

export function canTransitionGoal(from: unknown, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[normalizeGoalStatus(from)].includes(to);
}

export class IllegalGoalTransitionError extends Error {
  constructor(readonly goalId: string, readonly from: unknown, readonly to: GoalStatus) {
    super(`Goal "${goalId}" is ${String(from)}; cannot move it to ${to}.`);
    this.name = 'IllegalGoalTransitionError';
  }
}
