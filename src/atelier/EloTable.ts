/**
 * Elo table over artifacts + lessons (research: pairwise beats absolute under
 * judge noise — Spearman >0.9 with ground truth vs ~0.6 for direct scoring).
 * Every same-domain scorecard pair updates ratings; the ladder is the truth.
 */
import { copyFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { writeAtomicSync } from '../shared/fsAtomic.js';

export const SPU_SCORING_CONTRACT = 'spu-2.0-literal-v1' as const;
export interface ScoreContractFields {
  scoreScale: 10;
  scoringContract: typeof SPU_SCORING_CONTRACT;
}
export function hasScoreContract(value: unknown): value is ScoreContractFields {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ScoreContractFields>;
  return row.scoreScale === 10 && row.scoringContract === SPU_SCORING_CONTRACT;
}

export interface EloEntry extends Partial<ScoreContractFields> { rating: number; games: number; lastPlayed: string; }
export interface EloTableOptions { contract?: ScoreContractFields; }

const K = 24;
const START = 1000;

export class EloTable {
  private entries = new Map<string, EloEntry>();
  private legacyReplaced = false;

  constructor(private readonly path: string, private readonly options: EloTableOptions = {}) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, EloEntry>;
        for (const [k, v] of Object.entries(raw)) this.entries.set(k, v);
      }
    } catch {
      // Quarantine before save() can overwrite (audit M2 — torn read must not wipe the table).
      try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* nothing to quarantine */ }
    }
  }

  save(): void {
    if (this.legacyReplaced && existsSync(this.path)) {
      copyFileSync(this.path, `${this.path}.archive-${Date.now()}-${process.pid}`);
      this.legacyReplaced = false;
    }
    const out: Record<string, EloEntry> = {};
    for (const [k, v] of this.entries) out[k] = v;
    writeAtomicSync(this.path, JSON.stringify(out, null, 1));
  }

  private trusted(entry: EloEntry | undefined): boolean {
    if (!entry) return false;
    if (!this.options.contract) return true;
    return hasScoreContract(entry) && Number.isFinite(entry.rating) && Number.isFinite(entry.games) && entry.games >= 0;
  }

  rating(id: string): number {
    const entry = this.entries.get(id);
    if (!entry || !this.trusted(entry)) return START;
    return entry.rating;
  }
  games(id: string): number {
    const entry = this.entries.get(id);
    if (!entry || !this.trusted(entry)) return 0;
    return entry.games;
  }

  /** record(result: winner beats loser). Draw → winProb 0.5. */
  record(winnerId: string, loserId: string): void {
    this.apply(winnerId, loserId, 1);
  }

  apply(aId: string, bId: string, aScore: number): void {
    const ra = this.rating(aId), rb = this.rating(bId);
    const expected = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const delta = K * (aScore - expected);
    this.upsert(aId, ra + delta, aScore === 0.5 ? 0.5 : 1);
    this.upsert(bId, rb - delta, aScore === 0.5 ? 0.5 : 1);
    this.save();
  }

  private upsert(id: string, rating: number, games = 1): void {
    const existing = this.entries.get(id);
    if (existing && !this.trusted(existing)) this.legacyReplaced = true;
    const e = this.trusted(existing) ? existing! : { rating: START, games: 0, lastPlayed: '' };
    this.entries.set(id, {
      rating: Math.round(rating * 10) / 10,
      games: e.games + games,
      lastPlayed: new Date().toISOString(),
      ...(this.options.contract ?? {}),
    });
  }

  /** Domain ladder, credible games only (>=5 comparisons). */
  ladder(minGames = 5): { id: string; rating: number; games: number }[] {
    return [...this.entries.entries()]
      .filter(([, e]) => this.trusted(e) && e.games >= minGames)
      .sort((a, b) => b[1].rating - a[1].rating)
      .map(([id, e]) => ({ id, rating: e.rating, games: e.games }));
  }
}
