/**
 * StuckDetector — Phase 13, Increment 4
 *
 * Analyzes active processes against class-based duration thresholds
 * to flag possibly-stuck workers.
 *
 * Classes and thresholds are derived from substrings of the process name and
 * fixed donor minutes, not a declared health class or a progress watermark,
 * and elapsed time cannot tell slow work from no progress. Output is a
 * warning for an owner: it never authorizes retries, restarts, deadline
 * extensions or relaxed evaluation (#1309). Processes whose age cannot be
 * measured are reported via detectUnobservable(), not silently dropped.
 */

import type { ActiveProcess, StuckWorker, UnobservableWorker } from './types.js';

type ProcessClass = 'leaf' | 'wiring' | 'harness-quality' | 'orchestrator' | 'unknown';

const THRESHOLDS_MS: Record<ProcessClass, number> = {
  leaf: 2 * 60 * 1000,           // 2 minutes
  wiring: 5 * 60 * 1000,         // 5 minutes
  'harness-quality': 10 * 60 * 1000, // 10 minutes
  orchestrator: 15 * 60 * 1000,  // 15 minutes
  unknown: 5 * 60 * 1000,        // 5 minutes default
};

export class StuckDetector {
  detect(processes: ActiveProcess[], now: string): StuckWorker[] {
    const nowMs = new Date(now).getTime();
    const stuck: StuckWorker[] = [];

    for (const proc of processes) {
      const startedMs = new Date(proc.startedAt).getTime();
      if (isNaN(startedMs) || isNaN(nowMs)) continue;

      const durationMs = nowMs - startedMs;
      const cls = this.classifyProcess(proc.name);
      const thresholdMs = THRESHOLDS_MS[cls];

      if (durationMs > thresholdMs) {
        stuck.push({
          processName: proc.name,
          durationMs,
          thresholdMs,
          suggestedRecovery: this.suggestRecovery(cls),
        });
      }
    }

    return stuck;
  }

  /** Processes whose age cannot be measured; detect() cannot judge these. */
  detectUnobservable(processes: ActiveProcess[], now: string): UnobservableWorker[] {
    const nowInvalid = isNaN(new Date(now).getTime());
    const unobservable: UnobservableWorker[] = [];
    for (const proc of processes) {
      if (nowInvalid) {
        unobservable.push({ processName: proc.name, startedAt: proc.startedAt, reason: 'invalid-now' });
      } else if (isNaN(new Date(proc.startedAt).getTime())) {
        unobservable.push({ processName: proc.name, startedAt: proc.startedAt, reason: 'invalid-started-at' });
      }
    }
    return unobservable;
  }

  classifyProcess(name: string): ProcessClass {
    const lower = name.toLowerCase();
    if (lower.includes('orchestrator') || lower.includes('loop') || lower.includes('cortex')) {
      return 'orchestrator';
    }
    if (lower.includes('harness') || lower.includes('quality') || lower.includes('evaluate')) {
      return 'harness-quality';
    }
    if (lower.includes('wiring') || lower.includes('wire') || lower.includes('bridge') || lower.includes('connect')) {
      return 'wiring';
    }
    if (lower.includes('leaf') || lower.includes('task') || lower.includes('generate') || lower.includes('render')) {
      return 'leaf';
    }
    return 'unknown';
  }

  private suggestRecovery(cls: ProcessClass): string {
    return `Advisory: no completion seen past the name-derived ${cls} threshold; `
      + 'check for progress and escalate to the owner. Do not auto-retry, restart, '
      + 'or relax evaluation thresholds on this signal.';
  }
}
