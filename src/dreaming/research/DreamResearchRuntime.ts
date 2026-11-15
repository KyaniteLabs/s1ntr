import type { DreamComparisonOutcome, DreamExperimentPlan,
  DreamResearchSnapshot } from './DreamResearchTypes.js';
import type { DreamHypothesisSelector, DreamResearchControllerState,
  DreamResearchHypothesis } from './DreamHypothesisSelector.js';
import type { DreamResearchService } from './DreamResearchService.js';
import type { DreamComparisonCapability } from './DreamDecisionAuthority.js';

export interface DreamExperimentExecution {
  baselineEvidenceDigest: string;
  variantEvidenceDigests: string[];
  variantArtifactDigests: string[];
  comparison: { outcome: DreamComparisonOutcome; reason: string };
  comparisonCapability?: DreamComparisonCapability;
}

export interface DreamExperimentExecutor {
  kind: 'fake' | 'provider';
  execute(plan: DreamExperimentPlan, transport?: DreamTransportGate): Promise<DreamExperimentExecution>;
}

export type DreamTransportGate = <T>(purpose: string,
  operation: () => Promise<T>, options?: { metered?: boolean }) => Promise<T>;

export type DreamRuntimeResult =
  | { kind: 'stopped'; reason: string }
  | { kind: 'completed'; aggregateId: string; state: DreamResearchSnapshot['state'];
      hypothesis: DreamResearchHypothesis; outcome: DreamComparisonOutcome };

export class DreamResearchRuntime {
  constructor(private readonly service: DreamResearchService,
    private readonly controller: DreamHypothesisSelector,
    private readonly executor: DreamExperimentExecutor) {}

  updateControllerState(state: DreamResearchControllerState,
    hypothesis: DreamResearchHypothesis,
    outcome: DreamComparisonOutcome): DreamResearchControllerState {
    const penalty = outcome === 'keeper' ? 0 : 1;
    return { completedExperiments: state.completedExperiments + 1,
      remainingAttempts: Math.max(0, state.remainingAttempts - 1),
      failureFamilyCounts: { ...state.failureFamilyCounts,
        [hypothesis.failureFamily]: (state.failureFamilyCounts[hypothesis.failureFamily] ?? 0)
          + penalty } };
  }

  async run(hypotheses: readonly DreamResearchHypothesis[],
    state: DreamResearchControllerState,
    buildPlan: (hypothesis: DreamResearchHypothesis) => DreamExperimentPlan,
  ): Promise<DreamRuntimeResult> {
    const choice = this.controller.choose(hypotheses, state);
    if (choice.kind === 'stop') return { kind: 'stopped', reason: choice.reason };
    const plan = buildPlan(choice.hypothesis);
    this.service.plan(plan, `${plan.aggregateId}:plan`);
    this.service.freeze(plan.aggregateId, 1, `${plan.aggregateId}:freeze`);
    const execution = await this.execute(plan);
    let revision = this.service.snapshot(plan.aggregateId).revision;
    this.service.recordBaseline(plan.aggregateId, revision,
      `${plan.aggregateId}:baseline`, execution.baselineEvidenceDigest);
    revision = this.service.snapshot(plan.aggregateId).revision;
    this.service.recordVariants(plan.aggregateId, revision,
      `${plan.aggregateId}:variants`, execution.variantEvidenceDigests,
      execution.variantArtifactDigests);
    revision = this.service.snapshot(plan.aggregateId).revision;
    if (execution.comparisonCapability) {
      this.service.compare(plan.aggregateId, revision,
        `${plan.aggregateId}:compare`, execution.comparisonCapability);
    } else {
      this.service.recordDiagnosticOutcome(plan.aggregateId, revision,
        `${plan.aggregateId}:compare`, execution.comparison);
    }
    return { kind: 'completed', aggregateId: plan.aggregateId,
      state: this.service.snapshot(plan.aggregateId).state,
      hypothesis: choice.hypothesis, outcome: execution.comparison.outcome };
  }

  private async execute(plan: DreamExperimentPlan): Promise<DreamExperimentExecution> {
    if (this.executor.kind === 'fake') return this.executor.execute(plan);
    return this.executor.execute(plan, (purpose, operation, options) =>
      this.executeOperation(plan, purpose, operation, options?.metered ?? true));
  }

  private async executeOperation<T>(plan: DreamExperimentPlan, purpose: string,
    operation: () => Promise<T>, metered: boolean): Promise<T> {
    return this.service.runOperation(plan.aggregateId, purpose, operation, metered);
  }
}
