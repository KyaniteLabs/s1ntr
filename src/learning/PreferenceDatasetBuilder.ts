/**
 * PreferenceDatasetBuilder — Phase 15
 *
 * Builds a training dataset from user preference interactions:
 * pairwise selections, pins, favorites, branches, compost saves,
 * "more like this" actions, and accepted descendants.
 *
 * Outputs structured preference pairs suitable for taste model training.
 */

import type { ArchiveEntry, PreferenceAction } from '../emergence/types.js';

export interface PreferencePair {
  /** The preferred artifact */
  winner: { id: string; descriptor: number[]; quality: number };
  /** The less-preferred artifact */
  loser: { id: string; descriptor: number[]; quality: number };
  /** What kind of preference this represents */
  source: PreferenceAction;
  /**
   * Who the label came from: a human action, or a pseudo-label derived from
   * evaluator scores. Pseudo-labels never masquerade as human preference.
   */
  channel: PreferenceChannel;
  /** How confident we are in this signal (0–1) */
  confidence: number;
  /** When the preference was captured */
  capturedAt: string;
}

export type PreferenceChannel = 'human' | 'pseudo';

export interface PreferenceDataset {
  pairs: PreferencePair[];
  /** Summary statistics */
  stats: {
    totalPairs: number;
    uniqueArtifacts: number;
    sources: Record<string, number>;
    avgConfidence: number;
    /** Pair counts per label channel */
    channels: Record<PreferenceChannel, number>;
    /** Share of total confidence mass carried by pseudo-labels (0–1) */
    pseudoMassFraction: number;
  };
}

export interface PreferenceDatasetBuilderConfig {
  /** Minimum confidence for including a pair (default: 0.3) */
  minConfidence?: number;
  /** Whether to include inferred preferences (default: true) */
  includeInferred?: boolean;
  /** Whether to infer pairs from evaluator score gaps when entries carry no
   *  user preference — the auto-feed that lets the taste model train before
   *  any human pins exist (default: true; audit F7). */
  includeScoreGapPairs?: boolean;
  /** Minimum qualityScore gap for an inferred score pair (default: 0.2). */
  scoreGapThreshold?: number;
  /**
   * When human pairs exist, total pseudo-label confidence may not exceed this
   * multiple of total human confidence (default: 0.5). Low per-pair weight
   * alone does not stop pseudo-label volume from dominating.
   */
  maxPseudoMassRatio?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.3;
const DEFAULT_SCORE_GAP_THRESHOLD = 0.2;
/** Below every human signal (pairwise 1.0, pin 0.6, branch 0.5) by design. */
const SCORE_GAP_CONFIDENCE = 0.4;
/** Each winner pairs against at most this many lower-scored entries. */
const SCORE_GAP_MAX_PAIRS_PER_WINNER = 2;
const DEFAULT_MAX_PSEUDO_MASS_RATIO = 0.5;

function descriptorDistance(a: ArchiveEntry, b: ArchiveEntry): number {
  const av = a.descriptor.values;
  const bv = b.descriptor.values;
  let sum = 0;
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (av[i]?.value ?? 0) - (bv[i]?.value ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** The `k` candidates nearest to `anchor` in descriptor space (ties by id). */
function nearestNeighbors(anchor: ArchiveEntry, candidates: ArchiveEntry[], k: number): ArchiveEntry[] {
  return candidates
    .map(c => ({ c, d: descriptorDistance(anchor, c) }))
    .sort((x, y) => x.d - y.d || x.c.id.localeCompare(y.c.id))
    .slice(0, k)
    .map(x => x.c);
}

function unorderedKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export class PreferenceDatasetBuilder {
  private readonly minConfidence: number;
  private readonly includeInferred: boolean;
  private readonly includeScoreGapPairs: boolean;
  private readonly scoreGapThreshold: number;
  private readonly maxPseudoMassRatio: number;

  constructor(config: PreferenceDatasetBuilderConfig = {}) {
    this.minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.includeInferred = config.includeInferred ?? true;
    this.includeScoreGapPairs = config.includeScoreGapPairs ?? true;
    this.scoreGapThreshold = config.scoreGapThreshold ?? DEFAULT_SCORE_GAP_THRESHOLD;
    this.maxPseudoMassRatio = config.maxPseudoMassRatio ?? DEFAULT_MAX_PSEUDO_MASS_RATIO;
  }

  /**
   * Build a preference dataset from archive entries and their preference records.
   */
  build(entries: ArchiveEntry[]): PreferenceDataset {
    const pairs: PreferencePair[] = [];

    for (const entry of entries) {
      if (!entry.preference) continue;

      // Direct pairwise comparisons
      if (entry.preference.action === 'pairwise-a' || entry.preference.action === 'pairwise-b') {
        const other = entries.find(e => e.id === entry.preference!.comparedTo);
        if (!other) continue;

        const winner = entry.preference.action === 'pairwise-a' ? entry : other;
        const loser = entry.preference.action === 'pairwise-a' ? other : entry;

        pairs.push(this.makePair(winner, loser, entry.preference.action, 1.0, entry.preference.capturedAt, 'human'));
      }

      // Pin/favorite → preferred over unpinned entries
      if (entry.preference.action === 'pin' || entry.preference.action === 'favorite') {
        if (!this.includeInferred) continue;
        const unpinned = entries.filter(e =>
          e.id !== entry.id && e.preference?.action !== 'pin' && e.preference?.action !== 'favorite',
        );
        // Compare against the 3 nearest unpinned neighbors in descriptor space
        const neighbors = nearestNeighbors(entry, unpinned, 3);
        for (const neighbor of neighbors) {
          pairs.push(this.makePair(
            entry, neighbor, entry.preference.action,
            0.6, // Inferred preference has lower confidence
            entry.preference!.capturedAt, 'human',
          ));
        }
      }

      // Branch → user preferred parent enough to branch from it
      if (entry.preference.action === 'branch' && this.includeInferred) {
        // The branched artifact is preferred over its 2 nearest-niche neighbors
        const others = entries.filter(e => e.id !== entry.id);
        const neighbors = nearestNeighbors(entry, others, 2);
        for (const neighbor of neighbors) {
          pairs.push(this.makePair(
            entry, neighbor, 'branch', 0.5,
            entry.preference!.capturedAt, 'human',
          ));
        }
      }

      // Reject → the rejected artifact loses to its nearest neighbours (human channel), whatever the evaluator scored it.
      if (entry.preference.action === 'reject') {
        const others = entries.filter(e => e.id !== entry.id && e.preference?.action !== 'reject');
        for (const neighbor of nearestNeighbors(entry, others, 3)) {
          pairs.push(this.makePair(neighbor, entry, 'reject', 0.8, entry.preference.capturedAt, 'human'));
        }
      }

      // More-like-this → explicit positive signal
      if (entry.preference.action === 'more-like-this') {
        if (!this.includeInferred) continue;
        const rejected = entries.filter(e =>
          e.id !== entry.id && e.preference?.action === 'less-like-this',
        );
        for (const r of rejected.slice(0, 2)) {
          pairs.push(this.makePair(
            entry, r, 'more-like-this', 0.8,
            entry.preference!.capturedAt, 'human',
          ));
        }
      }
    }

    // Pseudo-label channel (audit F7): the evaluator's own scores carry a
    // usable ordering, so entries whose quality differs by a clear gap become
    // low-confidence `score-gap` pairs. With zero human pairs this bootstraps
    // training; once human pairs exist, total pseudo mass is capped at
    // `maxPseudoMassRatio` × human mass (largest gaps first) and pseudo pairs
    // never duplicate an artifact pair a human already labeled.
    const humanPairs = pairs.filter(p => p.confidence >= this.minConfidence);
    const pseudoPairs: PreferencePair[] = [];
    if (this.includeInferred && this.includeScoreGapPairs) {
      const humanKeys = new Set(humanPairs.map(p => unorderedKey(p.winner.id, p.loser.id)));
      const candidates: Array<{ pair: PreferencePair; gap: number }> = [];
      // an owner-rejected artifact may not win a pseudo pair: the evaluator's score must not outvote the owner
      const byScore = entries.filter(e => e.preference?.action !== 'reject').sort((a, b) => b.qualityScore - a.qualityScore);
      for (let i = 0; i < byScore.length; i++) {
        const winner = byScore[i];
        let made = 0;
        for (let j = byScore.length - 1; j > i && made < SCORE_GAP_MAX_PAIRS_PER_WINNER; j--) {
          const loser = byScore[j];
          const gap = winner.qualityScore - loser.qualityScore;
          if (gap < this.scoreGapThreshold) break;
          if (humanKeys.has(unorderedKey(winner.id, loser.id))) continue;
          candidates.push({
            pair: this.makePair(
              winner, loser, 'score-gap', SCORE_GAP_CONFIDENCE,
              winner.archivedAt ?? new Date().toISOString(), 'pseudo',
            ),
            gap,
          });
          made++;
        }
      }
      const humanMass = humanPairs.reduce((sum, p) => sum + p.confidence, 0);
      const budget = humanPairs.length > 0 ? humanMass * this.maxPseudoMassRatio : Infinity;
      let pseudoMass = 0;
      for (const { pair } of candidates.sort((a, b) => b.gap - a.gap)) {
        if (pair.confidence < this.minConfidence) continue;
        if (pseudoMass + pair.confidence > budget + 1e-9) break;
        pseudoPairs.push(pair);
        pseudoMass += pair.confidence;
      }
    }

    const filtered = [...humanPairs, ...pseudoPairs];
    const uniqueIds = new Set<string>();
    for (const p of filtered) {
      uniqueIds.add(p.winner.id);
      uniqueIds.add(p.loser.id);
    }

    const sources: Record<string, number> = {};
    const channels: Record<PreferenceChannel, number> = { human: 0, pseudo: 0 };
    let totalConf = 0;
    let pseudoConf = 0;
    for (const p of filtered) {
      sources[p.source] = (sources[p.source] ?? 0) + 1;
      channels[p.channel]++;
      totalConf += p.confidence;
      if (p.channel === 'pseudo') pseudoConf += p.confidence;
    }

    return {
      pairs: filtered,
      stats: {
        totalPairs: filtered.length,
        uniqueArtifacts: uniqueIds.size,
        sources,
        avgConfidence: filtered.length > 0 ? totalConf / filtered.length : 0,
        channels,
        pseudoMassFraction: totalConf > 0 ? pseudoConf / totalConf : 0,
      },
    };
  }

  /**
   * Build a synthetic preference pair (e.g., from quality scoring). It is a
   * pseudo-label: source `score-gap`, channel `pseudo` — never a human action.
   */
  addSyntheticPair(
    winner: ArchiveEntry,
    loser: ArchiveEntry,
    confidence: number,
  ): PreferencePair {
    return this.makePair(winner, loser, 'score-gap', confidence, new Date().toISOString(), 'pseudo');
  }

  private makePair(
    winner: ArchiveEntry,
    loser: ArchiveEntry,
    source: PreferenceAction,
    confidence: number,
    capturedAt: string,
    channel: PreferenceChannel,
  ): PreferencePair {
    return {
      winner: {
        id: winner.id,
        descriptor: winner.descriptor.values.map(v => v.value),
        quality: winner.qualityScore,
      },
      loser: {
        id: loser.id,
        descriptor: loser.descriptor.values.map(v => v.value),
        quality: loser.qualityScore,
      },
      source,
      channel,
      confidence,
      capturedAt,
    };
  }
}
