export type ProviderActionStage = 'generate' | 'evaluate' | 'learn' | 'dream';

export interface ActionProviderBudgetPlan {
  readonly maxProviderCalls: number;
  readonly stages: readonly ProviderActionStage[];
  readonly plannedMinimumCalls: number;
  readonly plannedMaximumCalls: number;
}

export interface ActionProviderBudgetSnapshot extends ActionProviderBudgetPlan {
  readonly attemptedCalls: number;
  readonly remainingCalls: number;
}

export class ActionProviderBudget {
  private attemptedCalls = 0;

  constructor(readonly plan: ActionProviderBudgetPlan) {
    if (!Number.isInteger(plan.maxProviderCalls) || plan.maxProviderCalls < 0) {
      throw new Error('maxProviderCalls must be a non-negative integer');
    }
    if (plan.plannedMaximumCalls > plan.maxProviderCalls) {
      throw new Error(`Planned provider calls (${plan.plannedMaximumCalls}) exceed action cap (${plan.maxProviderCalls})`);
    }
    if (plan.plannedMinimumCalls < 0 || plan.plannedMinimumCalls > plan.plannedMaximumCalls) {
      throw new Error('Provider call plan requires 0 <= minimum <= maximum');
    }
    if (plan.stages.length === 0 || new Set(plan.stages).size !== plan.stages.length) {
      throw new Error('Provider action stages must be non-empty and unique');
    }
    const known = new Set<ProviderActionStage>(['generate', 'evaluate', 'learn', 'dream']);
    if (plan.stages.some((stage) => !known.has(stage))) {
      throw new Error('Provider action plan contains an unknown stage');
    }
  }

  readonly guard = (): void => {
    if (this.attemptedCalls >= this.plan.maxProviderCalls) {
      throw new Error(`Action provider-call budget exhausted (${this.plan.maxProviderCalls}); blocked before call ${this.attemptedCalls + 1}`);
    }
    this.attemptedCalls += 1;
  };

  snapshot(): ActionProviderBudgetSnapshot {
    return Object.freeze({ ...this.plan, attemptedCalls: this.attemptedCalls,
      remainingCalls: this.plan.maxProviderCalls - this.attemptedCalls });
  }
}
