/**
 * CycleDriver — the 7-stage atelier cycle with per-stage checkpoints (PRD A6):
 * select niche → author directive → generate → deterministic gates →
 * render+screenshot+diff → vision ensemble → accept.
 *
 * Sovereignty (Sol v4/v5.1): evaluator assets are read-only here; the driver only
 * CONSUMES them. Telemetry/engagement axes are capped in GuiEvolution.composite.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AcceptDecision, AtelierMetrics, CycleReport, EnsembleVerdict, ElementCritique,
  MutationDirective,
} from './GuiSpec.js';
import { evaluateFitness, paretoImproves, deterministicTie } from './FitnessStack.js';
import { GuiEvolution, type LibraryEntry } from './GuiEvolution.js';

export interface RenderPort {
  renderHtml(html: string): Promise<{ succeeded: boolean; runtimeErrors: number; renderMs: number; screenshotBase64?: string }>;
}

export interface CycleDriverOptions {
  readonly rootDir: string;
  readonly brain: import('./GuiSpec.js').AtelierTransport;
  readonly generator: import('./GuiSpec.js').AtelierTransport;
  readonly eyes: readonly import('./GuiSpec.js').AtelierTransport[];
  readonly renderer: RenderPort;
  readonly evolution: GuiEvolution;
  readonly baseHtml: string;
  readonly requiredControls: readonly string[];
  readonly specBrief: string;
  readonly now?: () => Date;
}

type Stage = 'selected' | 'directed' | 'generated' | 'gated' | 'rendered' | 'critiqued' | 'decided';

interface Checkpoint {
  readonly cycleId: string;
  readonly cycle: number;
  readonly stage: Stage;
  readonly nicheKey: string;
  readonly directive?: MutationDirective;
  readonly html?: string;
  readonly metrics?: AtelierMetrics;
  readonly ensemble?: EnsembleVerdict;
}

export class CycleDriver {
  private lastGates: { build: boolean; render: boolean; runtimeErrors: boolean; coverageFloor: boolean; simplicityFloor: boolean } | null = null;

  constructor(private readonly options: CycleDriverOptions) {}

  private cyclesDir(): string {
    return join(this.options.rootDir, '.omx', 'atelier', 'cycles');
  }

  private seedsDir(): string {
    return join(this.options.rootDir, '.omx', 'atelier', 'seeds');
  }

  private loadCheckpoint(cycleId: string): Checkpoint | null {
    const path = join(this.cyclesDir(), cycleId, 'checkpoint.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Checkpoint : null;
  }

  private saveCheckpoint(cp: Checkpoint): void {
    const dir = join(this.cyclesDir(), cp.cycleId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(cp, null, 2));
    if (cp.html) writeFileSync(join(dir, 'candidate.html'), cp.html);
  }

  /** Element-anchored rationales → seeds JSONL (PRD fix 2: exact path + ingest contract). */
  private writeSeeds(cycleId: string, cycle: number, critiques: readonly ElementCritique[]): string {
    mkdirSync(this.seedsDir(), { recursive: true });
    const path = join(this.seedsDir(), `cycle-${cycle}.jsonl`);
    const lines = critiques.map(c => JSON.stringify({
      kind: 'atelier-rationale', cycle, cycleId, ...c,
      ingestedBy: `node bin/sinter compost add ${path}`,
    }));
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  async runCycle(cycle: number): Promise<CycleReport> {
    // Stable id per cycle index: crash-resume actually finds prior state
    // (review critical 3a — randomUUID made checkpoint lookup dead code).
    const cycleId = `cycle-${cycle}`;
    const startedAt = (this.options.now?.() ?? new Date()).toISOString();
    let cp: Checkpoint = this.loadCheckpoint(cycleId) ?? { cycleId, cycle, stage: 'selected', nicheKey: this.options.evolution.selectNiche() };
    const resume = this.loadCheckpoint(cycleId) !== null;

    if (cp.stage === 'selected' || cp.stage === 'directed') {
      const incumbent = this.options.evolution.getIncumbent();
      const directive = await this.options.brain.authorDirective({
        nicheKey: cp.nicheKey,
        incumbents: incumbent ? [JSON.stringify(incumbent.metrics)] : [],
        librarySummaries: this.options.evolution.allEntries().slice(-5).map(e => e.nicheKey),
      });
      if (!directive.verifyingMetric) throw new Error('ATELIER_DIRECTIVE_INELIGIBLE: no verifying metric (A3 law)');
      cp = { ...cp, stage: 'generated', directive };
      this.saveCheckpoint(cp);
    }
    void resume;

    let html: string;
    if (cp.stage === 'generated' && cp.html) {
      html = cp.html;
    } else {
      html = await this.options.generator.generateCandidate({ directive: cp.directive!, baseHtml: this.options.baseHtml });
      cp = { ...cp, stage: 'gated', html };
      this.saveCheckpoint(cp);
    }

    const render = await this.options.renderer.renderHtml(html);
    const fitness = evaluateFitness({
      html, renderSucceeded: render.succeeded, runtimeErrors: render.runtimeErrors,
      renderMs: render.renderMs, requiredControls: this.options.requiredControls,
    });
    this.lastGates = fitness.gates;
    const gatesGreen = fitness.gates.build && fitness.gates.render && fitness.gates.runtimeErrors && fitness.gates.coverageFloor && fitness.gates.simplicityFloor;
    cp = { ...cp, stage: 'rendered', metrics: fitness.metrics };
    this.saveCheckpoint(cp);

    if (!gatesGreen) {
      return this.finish(cp, { accepted: false, reason: 'gate-failed' }, null, startedAt, fitness.metrics);
    }

    // Vision ensemble: independent critiques from every eye + consensus grounding probes.
    // Tolerance law (PRD pre-mortem 3): one flaky eye degrades the cycle honestly,
    // never kills it — retry once, then proceed with the eyes that answered.
    const withRetry = async <T>(op: () => Promise<T>): Promise<T | null> => {
      try { return await op(); } catch { try { return await op(); } catch { return null; } }
    };
    const allCritiques: ElementCritique[] = [];
    const liveEyes: import('./GuiSpec.js').AtelierTransport[] = [];
    for (const eye of this.options.eyes) {
      const critiques = await withRetry(() => eye.critique({ html, specBrief: this.options.specBrief, controls: this.options.requiredControls }));
      if (critiques !== null) { liveEyes.push(eye); allCritiques.push(...critiques); }
    }
    let probesPassed = 0;
    const probesTotal = Math.max(1, this.options.requiredControls.length);
    for (const control of this.options.requiredControls) {
      let located = 0;
      for (const eye of liveEyes) {
        const ok = await withRetry(() => eye.probe({ html, control }));
        if (ok === true) located += 1;
      }
      if (liveEyes.length > 0 && located === liveEyes.length) probesPassed += 1; // consensus of live eyes
    }
    const metrics: AtelierMetrics = { ...fitness.metrics, findability: probesPassed / probesTotal };
    let ensemble: EnsembleVerdict = { critiques: allCritiques, pairwiseWinsIncumbent: null, probesPassed, probesTotal };
    cp = { ...cp, stage: 'critiqued', metrics, ensemble };
    this.saveCheckpoint(cp);

    // Accept law (v3.1): deterministic Pareto improvement admits even on VLM loss;
    // randomized pairwise decides deterministic ties only; VLM is never the sole gate.
    const incumbent = this.options.evolution.getIncumbent();
    let decision: AcceptDecision;
    if (incumbent && paretoImproves(metrics, incumbent.metrics)) {
      decision = { accepted: true, reason: 'deterministic-pareto-improvement' };
    } else if (!incumbent) {
      decision = { accepted: true, reason: 'deterministic-pareto-improvement' };
    } else if (deterministicTie(metrics, incumbent.metrics)) {
      // A critique that throws during the tie-break must not abort the cycle (#1710):
      // the incumbent stays and the report says the tie-break could not run.
      let wins: boolean | null;
      try { wins = await this.pairwise(html, incumbent.html); } catch { wins = null; }
      decision = wins === null
        ? { accepted: false, reason: 'pairwise-critique-failed' }
        : wins
          ? { accepted: true, reason: 'pairwise-tiebreak' }
          : { accepted: false, reason: 'deterministic-tie-pairwise-loss' };
      ensemble = { ...ensemble, pairwiseWinsIncumbent: wins };
    } else {
      decision = { accepted: false, reason: 'frozen-regression' };
    }
    return this.finish(cp, decision, ensemble, startedAt, metrics);
  }

  private async pairwise(candidateHtml: string, incumbentHtml: string): Promise<boolean> {
    const eye = this.options.eyes[0];
    if (!eye) return false;
    // Honest pairwise (review critical 3c): BOTH pages critiqued; fewer anchored
    // defects wins. Order still randomized so neither page benefits from
    // position-dependent critique depth.
    const order = Math.random() < 0.5;
    const [firstHtml, secondHtml] = order ? [candidateHtml, incumbentHtml] : [incumbentHtml, candidateHtml];
    const run = async (html: string, label: string) =>
      (await eye.critique({ html, specBrief: `${this.options.specBrief}\nPAIRWISE page ${label}: list every operator-facing defect.`,
        controls: this.options.requiredControls })).filter(c => c.defect.trim().length > 0);
    const first = await run(firstHtml, 'A');
    const second = await run(secondHtml, 'B');
    const candidateDefects = order ? first.length : second.length;
    const incumbentDefects = order ? second.length : first.length;
    return candidateDefects < incumbentDefects;
  }

  private finish(cp: Checkpoint, decision: AcceptDecision, ensemble: EnsembleVerdict | null,
    startedAt: string, metrics: AtelierMetrics | null): CycleReport {
    let seedsFile: string | null = null;
    if (ensemble && ensemble.critiques.length > 0) {
      seedsFile = this.writeSeeds(cp.cycleId, cp.cycle, ensemble.critiques);
    }
    if (decision.accepted && metrics) {
      const entry: LibraryEntry = {
        id: cp.cycleId, html: cp.html!, metrics,
        admittedAt: (this.options.now?.() ?? new Date()).toISOString(), nicheKey: cp.nicheKey,
      };
      this.options.evolution.admit(entry);
    }
    const bonusObservations = ensemble
      ? ensemble.critiques.filter(c => c.element === '#system').length
      : 0;
    const report: CycleReport = {
      cycle: cp.cycle, nicheKey: cp.nicheKey, directive: cp.directive!,
      gates: this.lastGates ?? { build: true, render: true, runtimeErrors: metrics?.runtimeErrors === 0, coverageFloor: (metrics?.coverage ?? 0) >= 0.5, simplicityFloor: true },
      metrics, ensemble, decision,
      vlmOverrideAdmit: decision.accepted && decision.reason === 'deterministic-pareto-improvement',
      bonusObservations,
      telemetryAdmit: false,
      seedsFile, startedAt, completedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.saveCheckpoint({ ...cp, stage: 'decided' });
    writeFileSync(join(this.cyclesDir(), cp.cycleId, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  }
}
