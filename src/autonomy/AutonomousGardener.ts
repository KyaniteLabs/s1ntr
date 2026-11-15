/**
 * AutonomousGardener — Phase 16
 *
 * Top-level orchestrator for the autonomous garden runtime.
 * Coordinates policy decisions, scheduling, stagnation detection,
 * and budget enforcement across garden cycles.
 */

import type { ArchiveCell, CreativeTaskType, DescriptorAxis } from '../emergence/types.js';
import { GardenPolicy } from './GardenPolicy.js';
import { GardenScheduler, type GardenMode } from './GardenScheduler.js';
import { LoopMixPolicy } from './LoopMixPolicy.js';
import { StagnationDetector, type StagnationResult } from './StagnationDetector.js';
import type { GardenHealthMetrics } from './GardenHealthMonitor.js';
import { ArchiveTaskPlanner } from './ArchiveTaskPlanner.js';
import { PromisingStateSelector } from './PromisingStateSelector.js';
import { ReplayBudgetPolicy } from './ReplayBudgetPolicy.js';
import { ReplayBiasPolicy } from '../learning/ReplayBiasPolicy.js';
import type { TasteModelWeights } from '../learning/TasteModelTrainer.js';
import { DreamPlanner } from '../dreaming/DreamPlanner.js';
import { RecombinationEngine, type RecombinationResult } from '../dreaming/RecombinationEngine.js';
import type { DreamArchiveSourceAdmission } from '../dreaming/research/DreamArchiveSourceAdmission.js';

type PlannedDreamTask = ReturnType<DreamPlanner['plan']>['tasks'][number];

export interface GardenerCycleResult {
  cycle: number;
  mode: GardenMode;
  actions: number;
  health: GardenHealthMetrics;
  stagnation: StagnationResult;
  budgetRemaining: number;
  /** Breakdown of action types this cycle */
  taskBreakdown?: { fresh: number; replay: number; dream: number };
  /** Tasks planned by ArchiveTaskPlanner */
  plannedTasks?: number;
  /** Promising states selected for replay */
  promisingStates?: number;
  /** Dream recombination results from this cycle */
  dreamResults?: RecombinationResult[];
  /** Number of taste-aligned entries in this cycle */
  tasteAlignedCount?: number;
  /** Archive entry IDs selected by the loaded taste model during replay */
  tasteSelectedEntryIds?: string[];
}

export interface AutonomousGardenerConfig {
  /** Garden mode (default: 'co-create') */
  mode?: GardenMode;
  /** Total budget per session in abstract units (default: 100) */
  totalBudget?: number;
  /** Stagnation detection config */
  stagnationWindow?: number;
  /** Loop mix overrides */
  explorationFraction?: number;
  /** Replay budget config */
  replayRatio?: number;
  /** Max consecutive replay actions (default: 3) */
  maxConsecutiveReplay?: number;
  /** Max archive tasks per cycle (default: 10) */
  maxArchiveTasks?: number;
  /** Taste bias strength for replay selection (0–1, default: 0.7) */
  replayBiasStrength?: number;
  /** Minimum taste score for priority replay (default: 0.5) */
  minTasteScore?: number;
  /** Proposal-only port. Gardener never receives Dream queue or effect authority. */
  proposeDream?: (proposal: GardenerDreamProposal) => void;
  dreamSourceAdmission?: DreamArchiveSourceAdmission;
}

export interface GardenerDreamProposal {
  readonly key: string;
  readonly strategy: PlannedDreamTask['strategy'];
  readonly sources: PlannedDreamTask['sources'];
  readonly priority: number;
}

type GardenerLifecycle =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly controller: AbortController; readonly done: Promise<void> }
  | { readonly kind: 'stopped' };

export class AutonomousGardener {
  private readonly policy: GardenPolicy;
  private readonly scheduler: GardenScheduler;
  private readonly mixPolicy: LoopMixPolicy;
  private readonly stagnationDetector: StagnationDetector;
  private readonly archiveTaskPlanner: ArchiveTaskPlanner;
  private readonly promisingStateSelector: PromisingStateSelector;
  private readonly replayBudgetPolicy: ReplayBudgetPolicy;
  private readonly replayBiasPolicy: ReplayBiasPolicy;
  private readonly dreamPlanner: DreamPlanner;
  private readonly recombinationEngine: RecombinationEngine;
  private readonly proposeDream?: (proposal: GardenerDreamProposal) => void;
  /** Signatures already proposed this gardener's lifetime. */
  private readonly proposedDreamKeys = new Set<string>();
  private readonly mode: GardenMode;
  private budgetRemaining: number;
  private cycleCount = 0;
  private lifecycle: GardenerLifecycle = { kind: 'idle' };
  /** Tracks actions within a cycle for replay budget gating */
  private currentCycleActions: Array<{ type: CreativeTaskType }> = [];

  constructor(config: AutonomousGardenerConfig = {}) {
    this.mode = config.mode ?? 'co-create';
    this.budgetRemaining = config.totalBudget ?? 100;
    this.policy = new GardenPolicy({ explorationFraction: config.explorationFraction });
    this.scheduler = new GardenScheduler();
    this.mixPolicy = new LoopMixPolicy({ defaultExploration: config.explorationFraction });
    this.stagnationDetector = new StagnationDetector({ stagnationWindow: config.stagnationWindow });
    this.archiveTaskPlanner = new ArchiveTaskPlanner({ maxTasks: config.maxArchiveTasks });
    this.promisingStateSelector = new PromisingStateSelector();
    this.replayBudgetPolicy = new ReplayBudgetPolicy({
      replayRatio: config.replayRatio,
      maxConsecutiveReplay: config.maxConsecutiveReplay,
    });
    this.replayBiasPolicy = new ReplayBiasPolicy({
      biasStrength: config.replayBiasStrength,
      minTasteScore: config.minTasteScore,
    });
    this.dreamPlanner = new DreamPlanner({ sourceAdmission: config.dreamSourceAdmission });
    this.recombinationEngine = new RecombinationEngine();
    this.proposeDream = config.proposeDream;
  }

  /**
   * Run a single garden cycle. Returns the result or null if budget exhausted.
   * Uses ArchiveTaskPlanner, PromisingStateSelector, ReplayBudgetPolicy,
   * DreamPlanner, and RecombinationEngine to drive structured creative actions.
   */
  cycle(
    cells: ArchiveCell[],
    axes: DescriptorAxis[],
    preferenceCounts?: Map<string, { positive: number; negative: number }>,
  ): GardenerCycleResult | null {
    if (this.budgetRemaining <= 0) return null;

    this.cycleCount++;
    this.currentCycleActions = [];

    // 1. Get policy decisions (existing GardenPolicy as fallback)
    const decisions = this.policy.decide(cells, axes);

    // 2. Measure health
    const health = this.policy.getHealthMonitor().measure(cells);

    // 3. Detect stagnation
    const history = this.policy.getHealthMonitor().getHistory();
    const stagnation = this.stagnationDetector.detect(history);

    // 4. Plan structured tasks from archive state
    const archivePlan = this.archiveTaskPlanner.plan(cells, axes, preferenceCounts);

    // 5. Compute archive coverage for budget gating
    const occupiedCells = cells.filter(c => c.elite !== undefined).length;
    const archiveCoverage = cells.length > 0 ? occupiedCells / cells.length : 0;

    // 6. Use ReplayBudgetPolicy to decide each action type
    let freshCount = 0;
    let replayCount = 0;
    let dreamCount = 0;
    let promisingStatesCount = 0;
    let tasteAlignedCount = 0;
    const tasteSelectedEntryIds: string[] = [];
    const dreamResults: RecombinationResult[] = [];
    const budgetPerAction = 10;

    const elites = cells
      .map(c => c.elite)
      .filter((e): e is NonNullable<typeof e> => e !== undefined);

    for (let i = 0; i < archivePlan.tasks.length; i++) {
      if (this.budgetRemaining < budgetPerAction) break;

      const nextType = this.replayBudgetPolicy.decideNextTask(
        this.currentCycleActions,
        archiveCoverage,
      );

      this.currentCycleActions.push({ type: nextType });
      this.budgetRemaining -= budgetPerAction;

      // Categorize for reporting
      if (nextType === 'fresh-exploration' || nextType === 'perturbation-probe') {
        freshCount++;
      } else if (nextType === 'dream-recombination') {
        dreamCount++;
        // Dream tasks: use DreamPlanner + RecombinationEngine
        const dreamPlan = this.dreamPlanner.plan(cells, axes);
        for (const dt of dreamPlan.tasks) {
          if (dt.sources.length >= 2) {
            const result = this.recombinationEngine.recombine(
              { id: dt.sources[0].id, descriptor: dt.sources[0].descriptor },
              { id: dt.sources[1].id, descriptor: dt.sources[1].descriptor },
            );
            dreamResults.push(result);
            this.proposeDreamTask(dt.strategy, dt.sources, dt.priority);
          }
        }
      } else {
        // Replay/branch tasks: use taste-biased selection when model is loaded,
        // fall back to PromisingStateSelector otherwise
        replayCount++;
        if (this.replayBiasPolicy.isModelLoaded()) {
          const tasteSelected = this.replayBiasPolicy.selectForReplay(elites, 3);
          tasteSelectedEntryIds.push(...tasteSelected.map(e => e.id));
          promisingStatesCount += tasteSelected.length;
          tasteAlignedCount += tasteSelected.filter(e => this.replayBiasPolicy.isTasteAligned(e)).length;
        } else {
          const promising = this.promisingStateSelector.select(
            elites,
            preferenceCounts ?? new Map(),
            3,
          );
          promisingStatesCount += promising.length;
        }
      }
    }

    this.replayBudgetPolicy.recordCycle(freshCount, replayCount);

    // 7. Fallback to existing GardenPolicy + scheduler for remaining budget
    const mix = this.mixPolicy.computeMix(health, stagnation);
    const activities = mix.map(m => m.activity);
    const affordable = decisions.filter(() => this.budgetRemaining >= budgetPerAction);
    const cost = affordable.length * budgetPerAction;
    this.budgetRemaining -= cost;
    const scheduled = this.scheduler.schedule(affordable, activities, this.mode, health);

    const archiveActionsExecuted = this.currentCycleActions.length;
    const totalActions = archiveActionsExecuted + scheduled.length;
    if (totalActions === 0) return null;

    return {
      cycle: this.cycleCount,
      mode: this.mode,
      actions: totalActions,
      health,
      stagnation,
      budgetRemaining: this.budgetRemaining,
      taskBreakdown: { fresh: freshCount, replay: replayCount, dream: dreamCount },
      plannedTasks: archivePlan.tasks.length,
      promisingStates: promisingStatesCount,
      dreamResults: dreamResults.length > 0 ? dreamResults : undefined,
      tasteAlignedCount,
      tasteSelectedEntryIds: tasteSelectedEntryIds.length > 0 ? tasteSelectedEntryIds : undefined,
    };
  }

  /** Emit a deduplicated command proposal without queue or execution authority. */
  private proposeDreamTask(
    strategy: PlannedDreamTask['strategy'],
    sources: PlannedDreamTask['sources'],
    priority: number,
  ): void {
    if (!this.proposeDream) return;
    const key = `${strategy}:${sources.map(s => s.id).sort().join('+')}`;
    if (this.proposedDreamKeys.has(key)) return;
    this.proposeDream(Object.freeze({ key, strategy, sources, priority }));
    this.proposedDreamKeys.add(key);
  }

  /**
   * Start continuous autonomous gardening (for autopilot mode).
   */
  async start(
    getCells: () => ArchiveCell[],
    getAxes: () => DescriptorAxis[],
    onCycle?: (result: GardenerCycleResult) => void,
    getPreferenceCounts?: () => Map<string, { positive: number; negative: number }>,
  ): Promise<void> {
    // Stopped is terminal; a second start while running joins the live loop
    // instead of spawning a parallel one.
    if (this.lifecycle.kind === 'stopped') return;
    if (this.lifecycle.kind === 'running') return this.lifecycle.done;
    const controller = new AbortController();
    const done = this.runLoop(controller.signal, getCells, getAxes, onCycle, getPreferenceCounts)
      .finally(() => {
        if (this.lifecycle.kind === 'running' && this.lifecycle.controller === controller) {
          this.lifecycle = { kind: 'idle' };
        }
      });
    this.lifecycle = { kind: 'running', controller, done };
    return done;
  }

  private async runLoop(
    signal: AbortSignal,
    getCells: () => ArchiveCell[],
    getAxes: () => DescriptorAxis[],
    onCycle?: (result: GardenerCycleResult) => void,
    getPreferenceCounts?: () => Map<string, { positive: number; negative: number }>,
  ): Promise<void> {
    const interval = this.scheduler.getCycleInterval(this.mode);
    while (!signal.aborted) {
      const result = this.cycle(getCells(), getAxes(), getPreferenceCounts?.());
      if (!result) return;
      onCycle?.(result);

      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, interval);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }

  /**
   * Stop the autonomous gardener. Terminal: a stopped gardener never restarts.
   */
  stop(): void {
    if (this.lifecycle.kind === 'running') this.lifecycle.controller.abort();
    this.lifecycle = { kind: 'stopped' };
  }

  isActive(): boolean {
    return this.lifecycle.kind === 'running';
  }

  getMode(): GardenMode {
    return this.mode;
  }

  getBudgetRemaining(): number {
    return this.budgetRemaining;
  }

  getCycleCount(): number {
    return this.cycleCount;
  }

  getScheduler(): GardenScheduler {
    return this.scheduler;
  }

  getPolicy(): GardenPolicy {
    return this.policy;
  }

  /**
   * Load a trained taste model for replay bias.
   * Once loaded, replay selection uses taste scores to prioritize
   * artifacts aligned with user preferences.
   */
  loadTasteModel(weights: TasteModelWeights): void {
    this.replayBiasPolicy.loadModel(weights);
  }

  /**
   * Check whether a taste model is loaded and active.
   */
  isTasteModelLoaded(): boolean {
    return this.replayBiasPolicy.isModelLoaded();
  }
}
