/**
 * Task-axis MAP-Elites wrapper (PRD A6: Wave 4 LMX crossover uses getParentElites
 * which returns ADMITTED-only cells — atelier must insertAdmitted or pools are empty).
 */
import { MapElites } from '../evolution/MapElites.js';
import { Logger } from '../utils/Logger.js';
import type { AtelierMetrics } from './GuiSpec.js';

export interface LibraryEntry {
  readonly id: string;
  readonly html: string;
  readonly metrics: AtelierMetrics;
  readonly admittedAt: string;
  readonly nicheKey: string;
}

export class GuiEvolution {
  private readonly archive = new MapElites([2, 2, 2, 2]); // 4 task axes, 2 bins each
  private readonly library = new Map<string, LibraryEntry>();
  private incumbent: LibraryEntry | null = null;

  /** Descriptor vector: each task axis normalized to a bin (0 or 1 at 0.5). */
  static descriptors(metrics: AtelierMetrics): number[] {
    return [
      metrics.coverage >= 0.5 ? 1 : 0,
      metrics.latencyToFirstSignal >= 0.5 ? 1 : 0,
      metrics.errorVisibility >= 0.5 ? 1 : 0,
      metrics.findability >= 0.5 ? 1 : 0,
    ];
  }

  static nicheKey(descriptors: readonly number[]): string {
    return descriptors.join(',');
  }

  admit(entry: LibraryEntry): void {
    this.library.set(entry.id, entry);
    this.archive.insert(entry.id, GuiEvolution.descriptors(entry.metrics), this.composite(entry.metrics), undefined, entry.nicheKey);
    if (!this.incumbent || this.composite(entry.metrics) > this.composite(this.incumbent.metrics)) {
      this.incumbent = entry;
    }
  }

  /** Engagement cap (Sol v5.1): findability/telemetry axes capped at 30% of composite. */
  composite(metrics: AtelierMetrics): number {
    return 0.7 * ((metrics.coverage + metrics.latencyToFirstSignal + metrics.errorVisibility) / 3)
      + 0.3 * metrics.findability;
  }

  getIncumbent(): LibraryEntry | null {
    return this.incumbent;
  }

  getEntry(id: string): LibraryEntry | null {
    return this.library.get(id) ?? null;
  }

  allEntries(): readonly LibraryEntry[] {
    return [...this.library.values()];
  }

  /** Select next niche: prefer unexplored cells; else the incumbent's neighborhood. */
  selectNiche(): string {
    const explored = new Set(this.allEntries().map(e => e.nicheKey));
    for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) for (const d of [0, 1]) {
      const key = `${a},${b},${c},${d}`;
      if (!explored.has(key)) return key;
    }
    return this.incumbent ? this.incumbent.nicheKey : '0,0,0,0';
  }

  save(): string {
    return JSON.stringify({ entries: this.allEntries() }, null, 2);
  }

  load(state: string): void {
    try {
      const parsed = JSON.parse(state) as { entries: LibraryEntry[] };
      for (const entry of parsed.entries ?? []) this.admit(entry);
    } catch (err) {
      // A corrupt state starts a fresh archive (accumulation lives in reports/seeds anyway), but say so.
      Logger.warn('GuiEvolution', 'archive state unreadable (starting a fresh archive):', err);
    }
  }
}
