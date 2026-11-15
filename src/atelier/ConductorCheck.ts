/**
 * ConductorCheck — adherence + auto-disable for the Elixis Conductor lane
 * (PRD 2026-09-01 item E/G). After a combination turn is scored, the trend
 * row's declared domains[] are compared against the plan recorded in
 * conductor-last.json: adhered = both plan domains declared, primary first.
 * Every verdict lands in conductor-verdicts.jsonl. A MISS removes the plan
 * record so the candidate is NOT consumed and can be retried; a HIT consumes
 * it. When adhered, the row's 4-axis mean is compared against the median of
 * the last 20 scored rows on this machine — 2 consecutive sub-baseline
 * combination turns write conductor.state {enabled:false} (the PromptOrgan
 * kill switch reads this) with the evidence recorded.
 */

import { readFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';

export interface ConductorPlan {
  primary: string;
  secondary: string;
  ts: string;
}

export interface TrendRowLike {
  ts?: string;
  domain?: string;
  artifact?: string;
  domains?: string[];
  axes?: string;
}

export interface AdherenceVerdict {
  adhered: boolean;
  declared: string[];
}

const PLAN_FRESH_MS = 30 * 60 * 1000; // plan must be scored within 30 minutes
const BASELINE_WINDOW = 20;
const AUTO_DISABLE_STREAK = 2;

const lastPlanPath = (cwd: string) => join(cwd, '.omx', 'atelier', 'game', 'conductor-last.json');
const verdictsPath = (cwd: string) => join(cwd, '.omx', 'atelier', 'game', 'conductor-verdicts.jsonl');
const statePath = (cwd: string) => join(cwd, '.omx', 'atelier', 'game', 'conductor.state');
const trendPath = (cwd: string) => join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl');

/** The scored row belongs to this plan only when both timestamps exist and
 *  sit within the 30-minute turn window. */
export function planIsFresh(lastPlan: ConductorPlan, trendRow: TrendRowLike, windowMs = PLAN_FRESH_MS): boolean {
  const planTs = Date.parse(String(lastPlan?.ts ?? ''));
  const rowTs = Date.parse(String(trendRow?.ts ?? ''));
  if (!Number.isFinite(planTs) || !Number.isFinite(rowTs)) return false;
  return Math.abs(rowTs - planTs) <= windowMs;
}

/** 4-axis mean from a `D=x A=y R=z N=w ...` axes string, or null. */
function meanOf(axes?: string): number | null {
  const m = /D=([\d.]+) A=([\d.]+) R=([\d.]+) N=([\d.]+)/.exec(axes ?? '');
  if (!m) return null;
  return m.slice(1).map(Number).reduce((a, b) => a + b, 0) / 4;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function readScoredRows(cwd: string): TrendRowLike[] {
  try {
    return readFileSync(trendPath(cwd), 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line) as TrendRowLike; } catch { return null; } })
      .filter((r): r is TrendRowLike => r !== null && meanOf(r.axes) !== null);
  } catch {
    return [];
  }
}

/**
 * Judge one scored conductor turn. Writes the verdict, consumes or releases
 * the plan record, and (on adhered turns) maintains the auto-disable streak.
 */
export function checkAdherence(cwd: string, lastPlan: ConductorPlan, trendRow: TrendRowLike): AdherenceVerdict {
  const declared = Array.isArray(trendRow?.domains)
    ? trendRow.domains.filter((d): d is string => typeof d === 'string' && d.length > 0)
    : [];
  const idxPrimary = declared.indexOf(lastPlan.primary);
  const idxSecondary = declared.indexOf(lastPlan.secondary);
  const adhered = idxPrimary !== -1 && idxSecondary !== -1 && idxPrimary < idxSecondary; // primary FIRST

  try {
    appendFileSync(verdictsPath(cwd), JSON.stringify({
      ts: new Date().toISOString(),
      plan: { primary: lastPlan.primary, secondary: lastPlan.secondary, ts: lastPlan.ts },
      declared,
      adhered,
    }) + '\n');
  } catch { /* verdict log is best-effort */ }

  // Consume the plan either way — but a MISS releases it WITHOUT consuming
  // the candidate, so the same pair can be retried on a later turn.
  try { rmSync(lastPlanPath(cwd), { force: true }); } catch { /* best-effort */ }

  if (adhered) updateAutoDisable(cwd, trendRow);
  return { adhered, declared };
}

/** Baseline gate: the row's 4-axis mean vs the median of the last 20 scored
 *  rows on this machine. 2 consecutive sub-baseline conductor turns pause the
 *  lane (conductor.state {enabled:false}) with the evidence recorded. */
function updateAutoDisable(cwd: string, trendRow: TrendRowLike): void {
  const rowMean = meanOf(trendRow.axes);
  if (rowMean === null) return;
  const priorRows = readScoredRows(cwd)
    .filter(r => !(r.ts === trendRow.ts && r.artifact === trendRow.artifact))
    .slice(-BASELINE_WINDOW);
  if (priorRows.length === 0) return; // no baseline yet — nothing to compare
  const baseline = median(priorRows.map(r => meanOf(r.axes)!));

  let state: { enabled?: boolean; subBaselineStreak?: number } = {};
  try {
    state = JSON.parse(readFileSync(statePath(cwd), 'utf8')) as { enabled?: boolean; subBaselineStreak?: number };
  } catch { /* no state yet */ }
  if (state.enabled === false) return; // already paused — keep the original evidence

  const streak = rowMean < baseline ? (state.subBaselineStreak ?? 0) + 1 : 0;
  const evidence = {
    rowMean: Math.round(rowMean * 100) / 100,
    baselineMedian: Math.round(baseline * 100) / 100,
    baselineWindow: priorRows.length,
    rowTs: trendRow.ts ?? null,
    streak,
  };
  try {
    if (streak >= AUTO_DISABLE_STREAK) {
      const paused = {
        enabled: false,
        reason: `auto-disable: ${AUTO_DISABLE_STREAK} consecutive conductor combination turns below the machine baseline median`,
        evidence,
      };
      writeState(cwd, paused);
    } else {
      writeState(cwd, { enabled: true, subBaselineStreak: streak, lastCheck: evidence });
    }
  } catch { /* state write is best-effort */ }
}

function writeState(cwd: string, state: unknown): void {
  writeAtomicSync(statePath(cwd), JSON.stringify(state, null, 1));
}

/** A plan that aged past its freshness window with no matching scored row
 *  burned budget silently (verifier finding 2026-09-01: attempt 2 expired
 *  with zero output and zero alert). Record an EXPIRED verdict and release
 *  the plan record so the budget trail stays honest. */
export function expireStalePlan(cwd: string, lastPlan: ConductorPlan): void {
  try {
    appendFileSync(verdictsPath(cwd), JSON.stringify({
      ts: new Date().toISOString(),
      plan: { primary: lastPlan.primary, secondary: lastPlan.secondary, ts: lastPlan.ts },
      declared: [],
      adhered: false,
      expired: true,
      reason: 'no scored row landed within the plan freshness window — budget consumed, no output',
    }) + '\n');
  } catch { /* verdict log is best-effort */ }
  try { rmSync(lastPlanPath(cwd), { force: true }); } catch { /* best-effort */ }
}

/** Convenience for the bin wiring: check only when a plan record exists and
 *  the scored row matches its turn window. Returns null when out of scope. */
export function checkIfPending(cwd: string, trendRow: TrendRowLike): AdherenceVerdict | null {
  try {
    const path = lastPlanPath(cwd);
    if (!existsSync(path)) return null;
    const lastPlan = JSON.parse(readFileSync(path, 'utf8')) as ConductorPlan;
    if (!planIsFresh(lastPlan, trendRow)) {
      expireStalePlan(cwd, lastPlan);
      return null;
    }
    return checkAdherence(cwd, lastPlan, trendRow);
  } catch {
    return null;
  }
}
