/**
 * Atelier Loop types — PRD v5.1 (docs/plans/prd-gui-flywheel-atelier.md; state-tree
 * original under .omx/plans/ — doc pointer only, no build dependency).
 *
 * Two-layer law: OFFLINE the flywheel evolves an admitted pattern library through
 * fully gated cycles; RUNTIME the GUI composes per-intent views from that library
 * only (runtime = assembly, offline = evolution — free-form runtime codegen is an
 * evaluator backdoor and is forbidden by Sol's Evaluator Sovereignty Law).
 */

/** Deterministic task axes (Architect steelman: fitness is OPERATOR power, not aesthetics). */
export const TASK_AXES = ['coverage', 'latencyToFirstSignal', 'errorVisibility', 'findability'] as const;
export type TaskAxis = (typeof TASK_AXES)[number];

/** Deterministic metric record — every value must be mechanically checkable. */
export interface TaskMetrics {
  /** Fraction of the spec'd operator verbs reachable from the UI (0..1). */
  readonly coverage: number;
  /** Render-time ms budget honored; lower is better; 1 = fastest class (0..1). */
  readonly latencyToFirstSignal: number;
  /** Fraction of spec'd panels with an explicit error/degraded state (0..1). */
  readonly errorVisibility: number;
  /** Fraction of grounding probes located by the ensemble (0..1). */
  readonly findability: number;
}

export interface AtelierMetrics extends TaskMetrics {
  /** Render success is a hard gate, not a metric. Present for reporting. */
  readonly renderMs: number;
  readonly runtimeErrors: number;
}

/** A3 directive-eligibility law: a directive without a verifying metric is ineligible. */
export interface MutationDirective {
  readonly id: string;
  readonly nicheKey: string;
  readonly hypothesis: string;
  /** The deterministic metric this directive claims to improve — must exist in AtelierMetrics. */
  readonly verifyingMetric: TaskAxis | 'runtimeErrors';
  readonly boundedEdit: string;
  readonly authoredBy: string;
  readonly createdAt: string;
}

/** Element-anchored critique — rationale is the compounding asset (scores are exhaust). */
export interface ElementCritique {
  readonly element: string;
  readonly defect: string;
  readonly mechanicalFix: string;
  readonly vendor: string;
}

export interface EnsembleVerdict {
  readonly critiques: readonly ElementCritique[];
  readonly pairwiseWinsIncumbent: boolean | null;
  readonly probesPassed: number;
  readonly probesTotal: number;
}

export type AcceptDecision =
  | { readonly accepted: true; readonly reason: 'deterministic-pareto-improvement' | 'pairwise-tiebreak' }
  | { readonly accepted: false; readonly reason: 'gate-failed' | 'frozen-regression' | 'deterministic-tie-pairwise-loss' | 'pairwise-critique-failed' };

export interface CycleReport {
  readonly cycle: number;
  readonly nicheKey: string;
  readonly directive: MutationDirective;
  readonly gates: { readonly build: boolean; readonly render: boolean; readonly runtimeErrors: boolean; readonly coverageFloor: boolean; readonly simplicityFloor: boolean };
  readonly metrics: AtelierMetrics | null;
  readonly ensemble: EnsembleVerdict | null;
  readonly decision: AcceptDecision | null;
  readonly vlmOverrideAdmit: boolean;
  readonly telemetryAdmit: boolean;
  /** System-level meta-improvements observed this cycle (bonus law, CEO 2026-08-26). */
  readonly bonusObservations: number;
  readonly seedsFile: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** Transport surface the driver needs — LLMClient satisfies this; tests inject mocks. */
export interface AtelierTransport {
  readonly label: string;
  /** Author a directive for a niche. Must name a verifying metric (A3) — rejected otherwise. */
  authorDirective(input: { nicheKey: string; incumbents: string[]; librarySummaries: string[] }): Promise<MutationDirective>;
  /** Generate a candidate HTML page applying the directive to a base. */
  generateCandidate(input: { directive: MutationDirective; baseHtml: string }): Promise<string>;
  /** Critique a screenshot against the spec (returns element-anchored rationales). */
  critique(input: { html: string; specBrief: string; controls: readonly string[] }): Promise<ElementCritique[]>;
  /** Grounding probe: name the control visible in the rendered page description. */
  probe(input: { html: string; control: string }): Promise<boolean>;
}
