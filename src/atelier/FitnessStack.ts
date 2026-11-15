/**
 * Deterministic-first fitness (PRD P2): gates and metrics a machine can check.
 * Vision judges only see the residue; they never verify alone (A3).
 */
import type { AtelierMetrics, TaskAxis } from './GuiSpec.js';

export interface FitnessInput {
  readonly html: string;
  readonly renderSucceeded: boolean;
  readonly runtimeErrors: number;
  readonly renderMs: number;
  /** Operator controls the spec demands (data-* names searched in the DOM). */
  readonly requiredControls: readonly string[];
}

export interface FitnessResult {
  readonly gates: { build: boolean; render: boolean; runtimeErrors: boolean; coverageFloor: boolean; simplicityFloor: boolean };
  readonly metrics: AtMetricsAlias;
}

type AtMetricsAlias = AtelierMetrics;

/** Taste directives (sovereign): UI must stay SIMPLE — count VISIBLE controls
 *  beyond the operator's four verbs as complexity debt (CEO: organs autonomous). */
function simplicityScore(html: string): number {
  const buttons = (html.match(/<button/gi) ?? []).length;
  const inputs = (html.match(/<input|<select|<textarea/gi) ?? []).length;
  const interactive = buttons + inputs;
  // 4 verbs + <=3 organ status elements is the simple surface; beyond that, decay.
  return interactive <= 7 ? 1 : Math.max(0, 1 - (interactive - 7) * 0.1);
}

function countControlPresence(html: string, controls: readonly string[]): number {
  let present = 0;
  for (const control of controls) {
    const marker = `data-atelier-control="${control}"`;
    if (html.includes(marker)) present += 1;
  }
  return controls.length === 0 ? 1 : present / controls.length;
}

function countErrorStates(html: string, panels: readonly string[]): number {
  if (panels.length === 0) return 1;
  let visible = 0;
  for (const panel of panels) {
    if (html.includes(`data-atelier-panel="${panel}"`) && html.includes(`data-atelier-error-state="${panel}"`)) visible += 1;
  }
  return visible / panels.length;
}

/** Latency class: <=300ms fast=1, linear falloff to 0 at 5s (tolerance band, not a ratchet — Sol law 6). */
function latencyClass(ms: number): number {
  if (ms <= 300) return 1;
  if (ms >= 5000) return 0;
  return (5000 - ms) / 4700;
}

export function evaluateFitness(input: FitnessInput): FitnessResult {
  const simplicity = simplicityScore(input.html);
  const specPanels = ['create', 'state', 'gallery'] as const;
  const metrics: AtelierMetrics = {
    coverage: countControlPresence(input.html, input.requiredControls),
    latencyToFirstSignal: latencyClass(input.renderMs),
    errorVisibility: countErrorStates(input.html, [...specPanels]),
    findability: 0,
    renderMs: input.renderMs,
    runtimeErrors: input.runtimeErrors,
  };
  return {
    gates: {
      build: input.html.trim().length > 0 && input.html.includes('</html>'),
      render: input.renderSucceeded,
      runtimeErrors: input.runtimeErrors === 0,
      // Operator floor: a GUI missing most required controls is not admissible,
      // even as a first candidate — coverage is a task gate, not just a metric.
      coverageFloor: metrics.coverage >= 0.5,
      // CEO taste law: a complex cockpit is a gate failure, not a style choice.
      simplicityFloor: simplicity >= 0.6,
    },
    metrics,
  };
}

/** Pareto law (v3.1): improvement admits only when NO axis regresses outside tolerance. */
export function paretoImproves(candidate: AtelierMetrics, incumbent: AtelierMetrics): boolean {
  const axes: readonly TaskAxis[] = ['coverage', 'latencyToFirstSignal', 'errorVisibility'];
  const tol = 0.001;
  const noRegression = axes.every(axis => candidate[axis] >= incumbent[axis] - tol);
  const improves = axes.some(axis => candidate[axis] > incumbent[axis] + tol);
  return noRegression && improves;
}

export function deterministicTie(candidate: AtelierMetrics, incumbent: AtelierMetrics): boolean {
  const axes: readonly TaskAxis[] = ['coverage', 'latencyToFirstSignal', 'errorVisibility'];
  const tol = 0.001;
  return axes.every(axis => Math.abs(candidate[axis] - incumbent[axis]) <= tol);
}
