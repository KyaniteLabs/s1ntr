/**
 * ModelRotator — rotates generator models across the fleet per wave.
 * Each machine cycles through its available models, learning which
 * produces the best art per domain. The rotation state is atomic.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import type { RotationLane } from './DispatchRotation.js';

interface RotationState {
  currentIndex: number;
  waveCount: number;
  modelScores: Record<string, { total: number; count: number; domains: Record<string, number[]> }>;
}

const STATE_PATH = (cwd: string) => join(cwd, '.omx', 'atelier', 'prompts', 'rotation-state.json');
const MATRIX_PATH = (cwd: string) => join(cwd, '.omx', 'atelier', 'prompts', 'model-rotation.json');

export class ModelRotator {
  private state: RotationState;
  private matrix: RotationLane[];

  constructor(private cwd: string) {
    try {
      this.state = JSON.parse(readFileSync(STATE_PATH(cwd), 'utf8'));
    } catch {
      this.state = { currentIndex: 0, waveCount: 0, modelScores: {} };
    }
    try {
      const full = JSON.parse(readFileSync(MATRIX_PATH(cwd), 'utf8'));
      // Find this machine's entry by hostname
      
      // macOS hostnames drift with network (.local/.lan suffixes) — match on
      // the normalized name (lowercased, suffix-stripped), exact only: a
      // prefix match would collide on short names like "Mac" vs "MacBookPro".
      const norm = (h: string): string => h.toLowerCase().replace(/\.(local|lan)$/, '');
      const host = norm(hostname());
      // LAPTOP DRIFT SERIES (CEO catch chain 2026-09-02): this machine's
      // hostname drifts through Mac-<N> names every few hours (Mac-29 ...
      // Mac-62+). Exact-match against a static entry silently kills the
      // whole rotation ("no rotation matrix" -> every turn on the default
      // seat). Entries may carry a hostRegex for exactly this class.
      type MatrixModel = { modelId?: string; id?: string; provider?: string; baseUrl?: string; base?: string; note?: string; dispatchExecutor?: string };
      type MachineEntry = { hostname?: unknown; hostRegex?: string; models?: MatrixModel[] };
      const values = Object.values(full as Record<string, MachineEntry | null | undefined>);
      const machineEntry =
        values.find(m => norm(String(m?.hostname ?? '')) === host)
        ?? values.find(m => {
          try { return m?.hostRegex ? new RegExp(m.hostRegex).test(host) : false; }
          catch { return false; }
        });
      // Matrix file uses id/base; normalize to modelId/baseUrl so every
      // consumer (RotateCli, system-loop env wiring) sees one shape.
      // A lane without a model id or provider cannot be dispatched; drop it
      // rather than rotate onto an undefined model.
      this.matrix = (machineEntry?.models ?? []).flatMap(m => {
        const modelId = m.modelId ?? m.id;
        if (!modelId || !m.provider) return [];
        return [{
          modelId,
          provider: m.provider,
          baseUrl: m.baseUrl ?? m.base ?? undefined,
          note: m.note,
          dispatchExecutor: m.dispatchExecutor,
        }];
      });
    } catch {
      this.matrix = [];
    }
  }

  lanes(): readonly RotationLane[] { return this.matrix; }

  /** Advance only to a lane with current eligibility evidence. */
  nextEligible(eligible: ReadonlySet<string>): RotationLane | null {
    if (this.matrix.length === 0) return null;
    for (let offset = 1; offset <= this.matrix.length; offset++) {
      const index = (this.state.currentIndex + offset) % this.matrix.length;
      const lane = this.matrix[index];
      if (!eligible.has(`${lane.modelId}|${lane.baseUrl ?? ''}`)) continue;
      this.state.currentIndex = index;
      this.state.waveCount += 1;
      this.save();
      return lane;
    }
    return null;
  }

  /** Record which model produced what score on which domain. */
  recordOutcome(modelId: string, domain: string, mean: number): void {
    if (!this.state.modelScores[modelId]) {
      this.state.modelScores[modelId] = { total: 0, count: 0, domains: {} };
    }
    const s = this.state.modelScores[modelId];
    s.total += mean;
    s.count += 1;
    if (!s.domains[domain]) s.domains[domain] = [];
    s.domains[domain].push(mean);
    this.save();
  }

  /** Get the best model for a specific domain (learned from outcomes). */
  bestForDomain(domain: string): string | null {
    let best: string | null = null;
    let bestScore = 0;
    for (const [modelId, s] of Object.entries(this.state.modelScores)) {
      const domainScores = s.domains[domain] ?? [];
      if (domainScores.length < 2) continue; // need at least 2 samples
      const avg = domainScores.reduce((a, b) => a + b, 0) / domainScores.length;
      if (avg > bestScore) {
        bestScore = avg;
        best = modelId;
      }
    }
    return best;
  }

  /** Stats for the control center. */
  stats(): { models: Array<{ id: string; avgScore: number; turns: number; bestDomain: string }>; currentModel: string } {
    const models = Object.entries(this.state.modelScores).map(([id, s]) => {
      const avg = s.count > 0 ? s.total / s.count : 0;
      let bestDomain = '';
      let bestAvg = 0;
      for (const [dom, scores] of Object.entries(s.domains)) {
        if (scores.length < 1) continue;
        const dAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (dAvg > bestAvg) { bestAvg = dAvg; bestDomain = dom; }
      }
      return { id, avgScore: Number(avg.toFixed(2)), turns: s.count, bestDomain };
    }).sort((a, b) => b.avgScore - a.avgScore);
    const current = this.matrix[this.state.currentIndex]?.modelId ?? 'unknown';
    return { models, currentModel: current };
  }

  save(): void {
    mkdirSync(join(this.cwd, '.omx', 'atelier', 'prompts'), { recursive: true });
    writeAtomicSync(STATE_PATH(this.cwd), JSON.stringify(this.state, null, 1));
  }
}
