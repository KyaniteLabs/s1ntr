/**
 * SoupStateManager — persistent state management for the Compost Soup loop.
 * Handles load/save/mutation of SoupState.
 */

import fs from 'node:fs/promises';
import type { CompostConfig, SoupState, CompostFragment } from './types.js';
import { safeJsonParse, SoupStateSchema } from '../security/JsonSchemas.js';
import { Logger } from '../utils/Logger.js';

/** Default empty soup state. */
const DEFAULT_STATE: SoupState = {
  population: [],
  generation: 0,
  bestSeed: null,
  totalSeedsPromoted: 0,
  domainHeatmap: {},
  lastCycleAt: '',
};

export interface SoupStateLoadIssue {
  kind: 'invalid' | 'unreadable';
  detail: string;
  /** Where the bad state file was moved so the next save cannot destroy it. */
  quarantinedTo?: string;
}

export class SoupStateManager {
  private statePath: string;
  private lastLoadIssue: SoupStateLoadIssue | null = null;

  constructor(_config: CompostConfig, statePath?: string) {
    this.statePath = statePath ?? 'compost/soup-state.json';
  }

  /**
   * Load state from disk. A missing file starts fresh. An invalid or
   * unreadable file is quarantined (moved aside, never overwritten) and the
   * problem is recorded in getLastLoadIssue() before starting fresh.
   */
  async load(): Promise<SoupState> {
    this.lastLoadIssue = null;
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath, 'utf-8');
    } catch (err: unknown) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === 'ENOENT') {
        Logger.debug('SoupStateManager', 'No saved state found, starting fresh');
        return { ...DEFAULT_STATE };
      }
      return this.quarantine('unreadable', err instanceof Error ? err.message : String(err));
    }
    const parsed = safeJsonParse(raw, SoupStateSchema, 'SoupStateManager');
    if (!parsed) {
      return this.quarantine('invalid', 'state file failed JSON/schema validation');
    }
    return parsed;
  }

  /** The problem found by the most recent load(), or null if it loaded cleanly or was missing. */
  getLastLoadIssue(): SoupStateLoadIssue | null {
    return this.lastLoadIssue ? { ...this.lastLoadIssue } : null;
  }

  private async quarantine(kind: SoupStateLoadIssue['kind'], detail: string): Promise<SoupState> {
    const target = `${this.statePath}.corrupt-${Date.now()}`;
    let quarantinedTo: string | undefined;
    try {
      // Only move aside a regular file; never relocate a directory or special path.
      if ((await fs.stat(this.statePath)).isFile()) {
        await fs.rename(this.statePath, target);
        quarantinedTo = target;
      }
    } catch (err: unknown) {
      Logger.error('SoupStateManager', 'Failed to quarantine bad soup state:', err instanceof Error ? err.message : err);
    }
    this.lastLoadIssue = { kind, detail, ...(quarantinedTo ? { quarantinedTo } : {}) };
    Logger.error(
      'SoupStateManager',
      `Soup state ${kind} (${detail}); starting fresh${quarantinedTo ? `, original preserved at ${quarantinedTo}` : ''}`,
    );
    return { ...DEFAULT_STATE };
  }

  /** Save state to disk. */
  async save(state: SoupState): Promise<void> {
    const dir = this.statePath.substring(0, this.statePath.lastIndexOf('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /** Increment generation counter and update lastCycleAt. */
  updateGeneration(state: SoupState): SoupState {
    return {
      ...state,
      generation: state.generation + 1,
      lastCycleAt: new Date().toISOString(),
    };
  }

  /** Record a seed promotion. */
  recordPromotion(state: SoupState, seed: CompostFragment): SoupState {
    const isBest = !state.bestSeed || (seed.score ?? 0) > (state.bestSeed.score ?? 0);
    return {
      ...state,
      totalSeedsPromoted: state.totalSeedsPromoted + 1,
      bestSeed: isBest ? seed : state.bestSeed,
    };
  }

  /** Update domain heatmap score for a domain pair. */
  updateHeatmap(state: SoupState, domainA: string, domainB: string, score: number): SoupState {
    const key = [domainA, domainB].sort().join('-');
    const current = state.domainHeatmap[key] ?? 0;
    return {
      ...state,
      domainHeatmap: {
        ...state.domainHeatmap,
        [key]: Math.max(current, score),
      },
    };
  }

  /** Replace the lowest-scored population member if the new one is better. */
  replaceWorst(state: SoupState, candidate: CompostFragment): SoupState {
    if (state.population.length === 0) {
      return { ...state, population: [candidate] };
    }

    const worstIdx = state.population.reduce(
      (minIdx, frag, idx) =>
        (frag.score ?? 0) < (state.population[minIdx].score ?? 0) ? idx : minIdx,
      0
    );

    if ((candidate.score ?? 0) > (state.population[worstIdx].score ?? 0)) {
      const newPop = [...state.population];
      newPop[worstIdx] = candidate;
      return { ...state, population: newPop };
    }

    return state;
  }
}
