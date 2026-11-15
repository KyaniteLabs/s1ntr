/**
 * Lesson Bandit Engine (PRD: .omx/plans/prd-lesson-bandit.md).
 *
 * Composite mechanism from the ML/RL research: per-lesson Beta posteriors updated
 * from lesson-SET outcomes with Monte-Carlo Shapley credit, Thompson-sampled subset
 * selection per turn, sliding window for drift, and credibility-gated promotion
 * with a minimum-outcomes floor (the N=4 cull trap is dead — no verdict before 15).
 */
import { readFileSync, renameSync, existsSync } from 'node:fs';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import { join } from 'node:path';
import { Logger } from '../utils/Logger.js';
import { isEnoent } from '../utils/errors.js';

export interface LessonPosterior {
  readonly id: string;
  a: number; // Beta alpha (pseudo-count of weighted wins)
  b: number; // Beta beta (weighted losses)
  outcomes: number;
  /** Per-lesson last-15 outcome deque (Architect amendment: verdicts over the
   *  lesson's OWN recent outcomes, not a global window — kills promote/demote
   *  livelock when the global window outruns the outcome floor). */
  recent: boolean[];
  updatedAt: string;
}

export interface BanditOutcome {
  readonly turn: number;
  readonly domain: string;
  readonly lessonIds: readonly string[];
  readonly win: boolean;
  readonly at: string;
}

const WINDOW = 25;

export class LessonBandit {
  private readonly posteriors = new Map<string, LessonPosterior>();
  private history: BanditOutcome[] = [];

  constructor(private readonly statePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.statePath)) return;
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as {
        posteriors: LessonPosterior[]; history: BanditOutcome[] };
      for (const p of parsed.posteriors ?? []) this.posteriors.set(p.id, p);
      this.history = parsed.history ?? [];
    } catch {
      // Quarantine the unreadable file before any save() can overwrite it —
      // fresh state in memory is fine, but destroying the on-disk evidence
      // of what broke turns a torn write into a total table wipe (audit M2).
      try { renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`); } catch (renameErr) {
        // ENOENT: already gone, nothing to quarantine. Anything else leaves the corrupt file exposed to overwrite.
        if (!isEnoent(renameErr)) Logger.warn('LessonBandit', `could not quarantine corrupt state ${this.statePath}:`, renameErr);
      }
    }
  }

  save(): void {
    const payload = {
      schema: 'sinter.lesson-bandit.v1',
      posteriors: [...this.posteriors.values()],
      history: this.history.slice(-WINDOW * 4),
      savedAt: new Date().toISOString(),
    };
    writeAtomicSync(this.statePath, JSON.stringify(payload, null, 2));
  }

  private posterior(id: string): LessonPosterior {
    let p = this.posteriors.get(id);
    if (!p) {
      p = { id, a: 1, b: 1, outcomes: 0, recent: [], updatedAt: new Date().toISOString() };
      this.posteriors.set(id, p);
    }
    return p;
  }

  /** Positional credit split across the coalition (critic-corrected naming: this
   *  is a permutation-discount split, NOT Monte-Carlo Shapley — a linear value
   *  function would yield uniform 1/n; the discount approximates decreasing
   *  marginal contribution under bounded permutations). */
  private shapleyWeights(lessonIds: readonly string[], perms = 20): Map<string, number> {
    const weights = new Map<string, number>();
    for (const id of lessonIds) weights.set(id, 0);
    if (lessonIds.length <= 1) {
      for (const id of lessonIds) weights.set(id, 1);
      return weights;
    }
    for (let p = 0; p < perms; p += 1) {
      const order = [...lessonIds];
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      // Marginal-contribution model: earlier lessons in the permutation carry more
      // of the set's outcome credit (standard MC-Shapley over uniform permutations
      // with a linear value function of coalition size).
      order.forEach((id, idx) => {
        const credit = 1 / (idx + 1);
        weights.set(id, (weights.get(id) ?? 0) + credit);
      });
    }
    const total = [...weights.values()].reduce((s, v) => s + v, 0) || 1;
    for (const [id, w] of weights) weights.set(id, w / total);
    return weights;
  }

  recordOutcome(input: { turn: number; domain: string; lessonIds: readonly string[]; win: boolean }): void {
    const outcome: BanditOutcome = { ...input, at: new Date().toISOString() };
    this.history.push(outcome);
    // Window: drop outcomes older than the last WINDOW for these lessons' domain.
    if (this.history.length > WINDOW * 4) this.history = this.history.slice(-WINDOW * 4);
    const weights = this.shapleyWeights(input.lessonIds);
    for (const [id, weight] of weights) {
      const p = this.posterior(id);
      // Set-level outcome weighted by Shapley credit: a lesson's pseudo-count moves
      // proportionally to its share of the coalition's contribution.
      p.a += input.win ? weight : 0;
      p.b += input.win ? 0 : weight;
      p.outcomes += 1;
      p.recent.push(input.win);
      if (p.recent.length > 15) p.recent.shift();
      p.updatedAt = new Date().toISOString();
    }
    this.save();
  }

  /** Bounded ablation (Architect amendment 2): inject ALL eligible lessons except
   *  a sampled 1-2 of the lowest-credibility ones — the variation Shapley needs,
   *  with bounded regret, instead of free TS subsets that cannot be learned at
   *  our sample sizes. */
  selectLessons(domain: string, allLessons: readonly { id: string; domains: string[] | 'all' }[]): string[] {
    const eligible = allLessons.filter(l => l.domains === 'all' || l.domains.includes(domain));
    const withCred = eligible.map(l => ({ id: l.id, cred: this.credibility(l.id) }))
      .sort((x, y) => x.cred - y.cred);
    const dropCount = Math.min(withCred.length > 4 ? 1 + (Math.random() < 0.5 ? 1 : 0) : 0, 2);
    const dropped = new Set(withCred.slice(0, dropCount).map(x => x.id));
    return eligible.filter(l => !dropped.has(l.id)).map(l => l.id);
  }


  /** Lower bound of the 95% credibility interval (Wald — conservative for small n). */
  credibility(id: string): number {
    const p = this.posterior(id);
    const mean = p.a / (p.a + p.b);
    const sd = Math.sqrt(mean * (1 - mean) / (p.a + p.b));
    return mean - 1.96 * sd;
  }

  outcomesFor(id: string): number {
    return this.posterior(id).outcomes;
  }

  /** Promotion law: promote at credibility > 0.55 with >= 15 outcomes; demote < 0.35. */
  verdict(id: string): 'promote' | 'demote' | 'pending' {
    const p = this.posterior(id);
    if (p.recent.length < 15) return 'pending'; // no verdict before 15 own outcomes
    const wins = p.recent.filter(Boolean).length;
    const rate = wins / p.recent.length;
    const cred = rate - 1.96 * Math.sqrt(Math.max(rate * (1 - rate), 1e-4) / p.recent.length);
    if (cred > 0.55) return 'promote';
    if (cred < 0.35) return 'demote';
    return 'pending';
  }

  stats(): { lessons: number; history: number; promoted: string[]; pending: number } {
    const promoted: string[] = [];
    let pending = 0;
    for (const id of this.posteriors.keys()) {
      const v = this.verdict(id);
      if (v === 'promote') promoted.push(id);
      else pending += 1;
    }
    return { lessons: this.posteriors.size, history: this.history.length, promoted, pending };
  }
}

export function banditStatePath(root = process.cwd()): string {
  return join(root, '.omx', 'atelier', 'lessons', 'bandit.json');
}
