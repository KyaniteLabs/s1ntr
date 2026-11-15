/**
 * CortexPerceptionBus — Phase 13 Increment 1
 *
 * Subscribes to EventBus and maintains a bounded in-memory aggregate
 * of system state (task pipeline, LLM health, score trends, active processes).
 *
 * Follows the same subscription pattern as the SWARM_ROUND listener
 * in TuiBridgeService (constructor, line 116).
 *
 * Usage:
 *   const bus = new CortexPerceptionBus(eventBus);
 *   bus.start();
 *   const snapshot = bus.getSnapshot();
 *   bus.stop();
 *
 * This is a volatile, best-effort projection, not an authoritative ledger
 * (#1310). Processes are keyed by name only, so it cannot tell two concurrent
 * same-name runs apart, and events carry no id, so replays cannot be fully
 * deduplicated. The invariants it does keep:
 *   - `inProgress` always equals the number of tracked active processes; a
 *     second start for an already-active name is a restart, not a new run.
 *   - A repeated PROCESS_END for a name that already ended (with no start in
 *     between) is a duplicate/replay and does not count again. A first end
 *     with no observed start (e.g. the bus subscribed late) still counts.
 *   - `activeProvider`/`activeModel` are the last LLM_REQUEST seen on the
 *     bus, not attributed to any process.
 */

import type { BusEvent } from '../core/EventBus.js';
import { EventTypes } from '../core/EventBus.js';
import type {
  CortexSnapshot,
  TaskPipelineSummary,
  LLMHealthSummary,
  ScoreTrend,
  ActiveProcess,
} from './types.js';

/** Maximum scores to keep in the rolling window */
const MAX_SCORE_WINDOW = 20;

/** Maximum latency samples for averaging */
const MAX_LATENCY_SAMPLES = 20;

/** Maximum active processes to track */
const MAX_ACTIVE_PROCESSES = 10;

/** Maximum ended process names remembered for duplicate-end detection */
const MAX_ENDED_NAMES = 100;

export class CortexPerceptionBus {
  private listener: ((event: BusEvent) => void) | null = null;

  // Task pipeline tracking
  private taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0, skipped: 0 };
  private failureBreakdown: Record<string, number> = {};

  // LLM health tracking
  private latencies: number[] = [];
  private llmSuccesses = 0;
  private llmFailures = 0;
  private recentErrors: string[] = [];
  private activeProvider: string | null = null;
  private activeModel: string | null = null;

  // Score tracking
  private recentScores: number[] = [];

  // Active process tracking
  private activeProcesses: ActiveProcess[] = [];
  /** Names whose run has ended and not restarted since (duplicate-end guard). */
  private endedNames = new Set<string>();

  // Event counter
  private eventsProcessed = 0;

  constructor(
    private eventBus: {
      onEvent: (handler: (event: BusEvent) => void) => unknown;
      offEvent: (handler: (event: BusEvent) => void) => unknown;
    },
  ) {}

  /**
   * Start subscribing to EventBus events.
   */
  start(): void {
    if (this.listener) return;
    this.listener = (event) => this.handleEvent(event);
    this.eventBus.onEvent(this.listener);
  }

  /**
   * Stop subscribing and clear subscriptions.
   */
  stop(): void {
    if (this.listener) {
      this.eventBus.offEvent(this.listener);
      this.listener = null;
    }
  }

  /**
   * Get the current perception snapshot.
   */
  getSnapshot(): CortexSnapshot {
    return {
      timestamp: new Date().toISOString(),
      taskPipeline: this.buildTaskPipeline(),
      llmHealth: this.buildLLMHealth(),
      scoreTrend: this.buildScoreTrend(),
      activeProcesses: [...this.activeProcesses],
      eventsProcessed: this.eventsProcessed,
    };
  }

  /**
   * Reset all aggregated state.
   */
  reset(): void {
    this.taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0, skipped: 0 };
    this.failureBreakdown = {};
    this.latencies = [];
    this.llmSuccesses = 0;
    this.llmFailures = 0;
    this.recentErrors = [];
    this.activeProvider = null;
    this.activeModel = null;
    this.recentScores = [];
    this.activeProcesses = [];
    this.endedNames.clear();
    this.eventsProcessed = 0;
  }

  // ── Event Handling ────────────────────────────────────────────────

  private handleEvent(event: BusEvent): void {
    this.eventsProcessed++;

    switch (event.type) {
      case EventTypes.PROCESS_START:
        this.handleProcessStart(event);
        break;
      case EventTypes.PROCESS_END:
        this.handleProcessEnd(event);
        break;
      case EventTypes.LLM_REQUEST:
        this.handleLLMRequest(event);
        break;
      case EventTypes.LLM_RESPONSE:
        this.handleLLMResponse(event);
        break;
      case EventTypes.LOOP_ITERATION:
        this.handleLoopIteration(event);
        break;
      case EventTypes.LOOP_EVALUATION:
        this.handleLoopEvaluation(event);
        break;
      default:
        // Ignore events not relevant to perception
        break;
    }
  }

  private handleProcessStart(event: BusEvent): void {
    const processName = event.data.process as string ?? 'unknown';
    this.endedNames.delete(processName);
    // Remove any existing entry for this process (restart)
    this.activeProcesses = this.activeProcesses.filter((p) => p.name !== processName);
    this.activeProcesses.push({
      name: processName,
      startedAt: event.timestamp,
      stage: event.data.stage as string | undefined,
    });
    // Bound active processes
    if (this.activeProcesses.length > MAX_ACTIVE_PROCESSES) {
      this.activeProcesses = this.activeProcesses.slice(-MAX_ACTIVE_PROCESSES);
    }
    // A same-name restart replaces its entry, so it must not add a run (#1310).
    this.taskCounts.inProgress = this.activeProcesses.length;
  }

  private handleProcessEnd(event: BusEvent): void {
    const processName = event.data.process as string ?? 'unknown';
    this.activeProcesses = this.activeProcesses.filter((p) => p.name !== processName);
    this.taskCounts.inProgress = this.activeProcesses.length;

    // A second end for a run that already ended is a duplicate/replay and
    // must not count as another completion or failure (#1310).
    if (this.endedNames.has(processName)) return;
    this.endedNames.add(processName);
    if (this.endedNames.size > MAX_ENDED_NAMES) {
      const oldest = this.endedNames.values().next().value;
      if (oldest !== undefined) this.endedNames.delete(oldest);
    }

    // Track success/failure for all processes
    const success = event.data.success as boolean;
    if (success === true) {
      this.taskCounts.completed++;
    } else if (success === false) {
      this.taskCounts.failed++;
      // Track failure class
      const errorClass = (event.data.errorClass as string) ?? processName;
      this.failureBreakdown[errorClass] = (this.failureBreakdown[errorClass] ?? 0) + 1;
    }
  }

  private handleLLMRequest(event: BusEvent): void {
    this.activeProvider = (event.data.provider as string) ?? null;
    this.activeModel = (event.data.model as string) ?? null;
  }

  private handleLLMResponse(event: BusEvent): void {
    const success = event.data.success as boolean;
    const latencyMs = event.data.latencyMs as number;

    if (success) {
      this.llmSuccesses++;
    } else {
      this.llmFailures++;
      const error = event.data.error as string;
      if (error) {
        this.recentErrors.push(error);
        if (this.recentErrors.length > 10) {
          this.recentErrors.shift();
        }
      }
    }

    if (typeof latencyMs === 'number' && latencyMs > 0) {
      this.latencies.push(latencyMs);
      if (this.latencies.length > MAX_LATENCY_SAMPLES) {
        this.latencies.shift();
      }
    }
  }

  private handleLoopIteration(event: BusEvent): void {
    const score = event.data.score as number;
    if (typeof score === 'number') {
      this.recentScores.push(score);
      if (this.recentScores.length > MAX_SCORE_WINDOW) {
        this.recentScores.shift();
      }
    }
  }

  private handleLoopEvaluation(_event: BusEvent): void {
    // Evaluation events carry dimension scores; we could track per-dimension
    // but for now the overall score from loop:iteration is sufficient.
  }

  // ── Builders ──────────────────────────────────────────────────────

  private buildTaskPipeline(): TaskPipelineSummary {
    const total = this.taskCounts.completed + this.taskCounts.failed + this.taskCounts.skipped;
    return {
      ...this.taskCounts,
      acceptanceRate: total > 0 ? this.taskCounts.completed / total : 0,
      failureBreakdown: { ...this.failureBreakdown },
    };
  }

  private buildLLMHealth(): LLMHealthSummary {
    const total = this.llmSuccesses + this.llmFailures;
    return {
      avgLatencyMs: this.latencies.length > 0
        ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
        : 0,
      successRate: total > 0 ? this.llmSuccesses / total : 0,
      recentErrorCount: this.recentErrors.length,
      lastError: this.recentErrors.length > 0 ? this.recentErrors[this.recentErrors.length - 1] : null,
      activeProvider: this.activeProvider,
      activeModel: this.activeModel,
    };
  }

  private buildScoreTrend(): ScoreTrend {
    const count = this.recentScores.length;
    return {
      scores: [...this.recentScores],
      average: count > 0 ? this.recentScores.reduce((a, b) => a + b, 0) / count : 0,
      count,
    };
  }
}
