/**
 * PhaseTransitions — regime-change detection over the artifact score time
 * series (Forgejo #927). Reads the axes-bearing rows of trend.jsonl (the
 * `artifact_scored` rows; `generation_context` rows carry no axes and are
 * filtered out by the axes regex), builds a per-domain score series
 * (score = mean of judge axes D/A/R/N, same convention as bead `mean`),
 * and flags epochs where the rolling mean shifts more than k sigma.
 *
 * Statistic (simple, documented, no ML): two-window rolling z-score.
 * For a domain series x[0..n) with window w, slide a cut point i over
 * [w, n-w]; before = x[i-w, i), after = x[i, i+w). Flag the cut when
 * |mean(after) - mean(before)| > k * max(sd(before), minSigma). After a
 * flag the scan jumps 2w — the flagged after-window may straddle the true
 * change point, so w alone would re-flag the same regime — so one regime
 * change yields one detection (regime changes closer than 2w apart report
 * as one). Series shorter than 2w are never scanned.
 *
 * Additive organ — does not modify MapElites, LatentField, or the trend
 * writers; it only reads the substrate.
 */

/** One axes-bearing observation from trend.jsonl, in file (chronological) order. */
export interface TrendScorePoint {
  /** Observation index across the whole trend file (0-based). */
  seq: number;
  domain: string;
  /** Mean of judge axes D/A/R/N (same convention as bead `mean`). */
  score: number;
  /** Turn number when the row carries one (older trend schema). */
  turn?: number;
  /** ISO timestamp when the row carries one (current trend schema). */
  ts?: string;
  /** Artifact dir when the row carries one (islands partition uses its basename). */
  artifact?: string;
}

/** A detected regime change in one domain's score series. */
export interface PhaseTransition {
  domain: string;
  /** Index into that domain's score series of the first after-window point. */
  index: number;
  turn?: number;
  ts?: string;
  beforeMean: number;
  afterMean: number;
  /** Baseline (before-window) standard deviation actually used. */
  sigma: number;
  /** |afterMean - beforeMean| / sigma. */
  z: number;
  direction: 'up' | 'down';
}

export interface PhaseTransitionOptions {
  /** Rolling window size on both sides of the cut (default 8). */
  window?: number;
  /** Sigma threshold for the mean shift (default 3.0). */
  kSigma?: number;
  /** Floor for the baseline sd so flat regimes cannot divide by ~0 (default 0.2). */
  minSigma?: number;
}

interface DomainSeries {
  domain: string;
  scores: number[];
  points: TrendScorePoint[];
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

const AXES_RE = /D=([\d.]+) A=([\d.]+) R=([\d.]+) N=([\d.]+)/;

/**
 * Parse trend.jsonl text into score points. Only axes-bearing rows count
 * (artifact_scored); generation_context rows have no `axes` field and are
 * skipped, as are malformed lines.
 */
export function parseTrendScores(text: string): TrendScorePoint[] {
  const points: TrendScorePoint[] = [];
  const lines = text.split('\n');
  for (let seq = 0; seq < lines.length; seq++) {
    const line = lines[seq].trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line) as {
        domain?: string; axes?: string; turn?: number | string; ts?: string; artifact?: string;
      };
      if (!row.domain || !row.axes) continue; // generation_context and friends
      const m = AXES_RE.exec(row.axes);
      if (!m) continue;
      const score = (Number(m[1]) + Number(m[2]) + Number(m[3]) + Number(m[4])) / 4;
      const turn = row.turn === undefined ? undefined : Number(row.turn);
      points.push({
        seq,
        domain: row.domain,
        score,
        turn: Number.isFinite(turn) ? turn : undefined,
        ts: row.ts,
        artifact: row.artifact,
      });
    } catch { /* skip malformed rows */ }
  }
  return points;
}

function groupByDomain(points: TrendScorePoint[]): DomainSeries[] {
  const byDomain = new Map<string, DomainSeries>();
  for (const p of points) {
    let s = byDomain.get(p.domain);
    if (!s) { s = { domain: p.domain, scores: [], points: [] }; byDomain.set(p.domain, s); }
    s.scores.push(p.score);
    s.points.push(p);
  }
  return Array.from(byDomain.values());
}

/** Detect mean-shift transitions in a single domain's score series. */
export function detectSeriesTransitions(
  scores: number[],
  opts: PhaseTransitionOptions = {},
): Array<{ index: number; beforeMean: number; afterMean: number; sigma: number; z: number }> {
  const w = opts.window ?? 8;
  const k = opts.kSigma ?? 3.0;
  const minSigma = opts.minSigma ?? 0.2;
  const found: Array<{ index: number; beforeMean: number; afterMean: number; sigma: number; z: number }> = [];
  if (scores.length < 2 * w) return found;
  let i = w;
  while (i <= scores.length - w) {
    const before = scores.slice(i - w, i);
    const after = scores.slice(i, i + w);
    const sigma = Math.max(sd(before), minSigma);
    const beforeMean = mean(before);
    const afterMean = mean(after);
    const z = Math.abs(afterMean - beforeMean) / sigma;
    if (z > k) {
      found.push({ index: i, beforeMean, afterMean, sigma, z });
      i += 2 * w; // the flagged after-window may straddle the change — skip clear of it
    } else {
      i += 1;
    }
  }
  return found;
}

/** Detect phase transitions across all domains in a trend point series. */
export function detectPhaseTransitions(
  points: TrendScorePoint[],
  opts: PhaseTransitionOptions = {},
): PhaseTransition[] {
  const transitions: PhaseTransition[] = [];
  for (const series of groupByDomain(points)) {
    for (const hit of detectSeriesTransitions(series.scores, opts)) {
      const at = series.points[hit.index];
      transitions.push({
        domain: series.domain,
        index: hit.index,
        turn: at?.turn,
        ts: at?.ts,
        beforeMean: hit.beforeMean,
        afterMean: hit.afterMean,
        sigma: hit.sigma,
        z: hit.z,
        direction: hit.afterMean >= hit.beforeMean ? 'up' : 'down',
      });
    }
  }
  return transitions.sort((a, b) => a.domain.localeCompare(b.domain) || a.index - b.index);
}

/** Rolling tail stats per domain (mean ± sd over the last w observations). */
export function rollingTailStats(
  points: TrendScorePoint[],
  w = 8,
): Array<{ domain: string; n: number; mean: number; sd: number }> {
  return groupByDomain(points).map((s) => {
    const tail = s.scores.slice(-w);
    return { domain: s.domain, n: s.scores.length, mean: mean(tail), sd: sd(tail) };
  }).sort((a, b) => a.domain.localeCompare(b.domain));
}
