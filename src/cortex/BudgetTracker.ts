/**
 * Per-tick planning ESTIMATE for the cortex proposer (reset every tick by
 * SinterCortex). Not persistent, not actual usage, never spending authority —
 * metered accounting lives elsewhere (#1308). Invalid limits or estimates throw
 * so a negative/NaN estimate cannot silently refund the budget.
 */
export interface BudgetConfig { actionsLimit: number; tokenLimit: number; }
export interface ActionCost { tokenEstimate: number; }
export interface BudgetUsage { actionsTaken: number; actionsLimit: number; tokenEstimate: number; tokenLimit: number; }

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`BudgetTracker: ${label} must be a finite non-negative number (got ${value})`);
  }
}

export class BudgetTracker {
  private actionsTaken = 0; private tokenEstimate = 0;
  constructor(private config: BudgetConfig) {
    assertNonNegative(config.actionsLimit, 'actionsLimit');
    assertNonNegative(config.tokenLimit, 'tokenLimit');
  }
  canAfford(cost: ActionCost): boolean {
    assertNonNegative(cost.tokenEstimate, 'tokenEstimate');
    return this.actionsTaken < this.config.actionsLimit && this.tokenEstimate + cost.tokenEstimate <= this.config.tokenLimit;
  }
  record(cost: ActionCost): void {
    assertNonNegative(cost.tokenEstimate, 'tokenEstimate');
    this.actionsTaken++; this.tokenEstimate += cost.tokenEstimate;
  }
  getUsage(): BudgetUsage { return { actionsTaken: this.actionsTaken, actionsLimit: this.config.actionsLimit, tokenEstimate: this.tokenEstimate, tokenLimit: this.config.tokenLimit }; }
  /** Start a new tick's estimate window. */
  reset(): void { this.actionsTaken = 0; this.tokenEstimate = 0; }
}
