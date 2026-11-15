/**
 * Islands — domain-partitioned subpopulations with ring migration
 * (Forgejo #927, Glass Bead Game follow-on). The artifact population is
 * speciated into one island per domain (islands = domains); each migration
 * epoch, the top-k residents of every island are copied into the ring
 * neighbor island as immigrant exemplars (migration = cross-domain exemplar
 * seeding). Copied, not moved: an island's resident partition is immutable —
 * a p5 exemplar never becomes a three resident, it seeds the neighbor's
 * candidate pool as a marked immigrant with its origin intact.
 *
 * Topology: the classic island-model ring — islands sorted by domain name,
 * each migrates to its successor (last wraps to first). Deterministic, no
 * randomness, no ML. Pure data structure beside MapElites; the trend
 * substrate is parsed by PhaseTransitions.parseTrendScores and handed in.
 */

import { basename } from 'node:path';
import type { TrendScorePoint } from './PhaseTransitions.js';

/** One artifact in an island population. */
export interface IslandResident {
  /** Artifact id (trend rows are keyed by artifact dir basename). */
  id: string;
  domain: string;
  /** Mean judge score (mean of D/A/R/N). */
  score: number;
  /** Observation index in the trend file (provenance). */
  seq?: number;
}

/** One domain island: its own residents plus immigrant exemplars seeded in by neighbors. */
export interface Island {
  domain: string;
  /** Residents sorted by score, best first. Never contains other domains' artifacts. */
  residents: IslandResident[];
  /** Exemplars migrated in from ring neighbors, accumulated across epochs. */
  immigrants: IslandResident[];
}

/** One migration movement: top-k of `from` copied into `to`. */
export interface MigrationRecord {
  epoch: number;
  from: string;
  to: string;
  migrants: IslandResident[];
}

/**
 * Build islands from trend score points: partition by domain, residents
 * sorted best-first. Rows without an artifact dir are skipped; an artifact
 * rescored in a later row keeps its latest score.
 */
export function islandsFromPoints(points: TrendScorePoint[]): Island[] {
  const byDomain = new Map<string, Map<string, IslandResident>>();
  for (const p of points) {
    if (!p.artifact) continue;
    let island = byDomain.get(p.domain);
    if (!island) { island = new Map(); byDomain.set(p.domain, island); }
    island.set(basename(p.artifact), {
      id: basename(p.artifact),
      domain: p.domain,
      score: p.score,
      seq: p.seq,
    });
  }
  const islands: Island[] = [];
  for (const [domain, residents] of byDomain) {
    islands.push({
      domain,
      residents: Array.from(residents.values()).sort((a, b) => b.score - a.score),
      immigrants: [],
    });
  }
  return islands.sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Ring neighbor of an island: successor in domain-sorted order, last wraps to first. */
export function ringNeighbor(islands: Island[], island: Island): Island {
  if (islands.length < 2) return island;
  const idx = islands.findIndex((i) => i.domain === island.domain);
  return islands[(idx + 1) % islands.length];
}

/**
 * One migration epoch: the top-k residents of every island are copied into
 * their ring neighbor's immigrants (dedup by id — first seeding wins).
 * Returns the movement log.
 */
export function migrateOnce(islands: Island[], k: number, epoch: number): MigrationRecord[] {
  const records: MigrationRecord[] = [];
  for (const island of islands) {
    if (island.residents.length === 0) continue;
    const target = ringNeighbor(islands, island);
    if (target === island) continue; // single island — nowhere to migrate
    const migrants = island.residents.slice(0, k).map((m) => ({ ...m }));
    const known = new Set(target.immigrants.map((m) => m.id));
    for (const m of migrants) {
      if (!known.has(m.id)) target.immigrants.push(m);
    }
    records.push({ epoch, from: island.domain, to: target.domain, migrants });
  }
  return records;
}

/** Run `epochs` migration epochs over the islands. Mutates `islands`. */
export function runMigration(islands: Island[], epochs: number, k: number): MigrationRecord[] {
  const all: MigrationRecord[] = [];
  for (let e = 1; e <= epochs; e++) {
    all.push(...migrateOnce(islands, k, e));
  }
  return all;
}

/** Compact per-island summary for reports. */
export function islandSummary(island: Island): {
  domain: string; residents: number; immigrants: number; top: IslandResident | null;
} {
  return {
    domain: island.domain,
    residents: island.residents.length,
    immigrants: island.immigrants.length,
    top: island.residents[0] ?? null,
  };
}
