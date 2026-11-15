/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * PopulationCli — CLI surface for the #927 population organs:
 *   `sinter islands` — speciate the artifact population into per-domain
 *     islands and run the ring migration operator (top-k exemplar seeding).
 *   `sinter phases`  — detect phase transitions (regime changes) in the
 *     per-domain score time series from trend.jsonl.
 *
 * Substrates: .omx/atelier/fleet/merged/trend.jsonl (falls back to the
 * single-host .omx/atelier/lessons/trend.jsonl), plus LatentField.emptyRegions
 * for the cross-domain frontier corridors migration would seed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseTrendScores,
  detectPhaseTransitions,
  rollingTailStats,
} from '../evolution/PhaseTransitions.js';
import {
  islandsFromPoints,
  runMigration,
  islandSummary,
} from '../evolution/Islands.js';
import { emptyRegions } from '../atelier/LatentField.js';

function resolveTrendPath(cmdArgs: string[]): string {
  const flagIdx = cmdArgs.indexOf('--trend');
  if (flagIdx !== -1 && cmdArgs[flagIdx + 1]) return cmdArgs[flagIdx + 1];
  const cwd = process.cwd();
  const merged = join(cwd, '.omx', 'atelier', 'fleet', 'merged', 'trend.jsonl');
  if (existsSync(merged)) return merged;
  return join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl');
}

function flagNum(cmdArgs: string[], flag: string, fallback: number): number {
  const idx = cmdArgs.indexOf(flag);
  if (idx === -1 || !cmdArgs[idx + 1]) return fallback;
  const v = Number(cmdArgs[idx + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function shortTs(ts?: string): string {
  return ts ? ts.slice(0, 19).replace('T', ' ') : '';
}

export function runPhasesCommand(cmdArgs: string[]): void {
  const trendPath = resolveTrendPath(cmdArgs);
  const w = flagNum(cmdArgs, '--window', 8);
  const k = flagNum(cmdArgs, '--k-sigma', 3.0);
  const domainFilter = cmdArgs.includes('--domain') ? cmdArgs[cmdArgs.indexOf('--domain') + 1] : null;
  if (!existsSync(trendPath)) {
    console.log(`[phases] no trend substrate at ${trendPath} — nothing to analyze yet`);
    return;
  }
  let points = parseTrendScores(readFileSync(trendPath, 'utf8'));
  if (domainFilter) points = points.filter((p) => p.domain === domainFilter);
  console.log(`[phases] trend: ${trendPath} (${points.length} scored observations${domainFilter ? `, domain=${domainFilter}` : ''})`);
  console.log(`[phases] statistic: two-window rolling z (window=${w}, k=${k}σ, minσ=0.2) — mean shift > ${k}σ flags a regime change`);
  const transitions = detectPhaseTransitions(points, { window: w, kSigma: k });
  if (transitions.length === 0) {
    console.log('[phases] 0 phase transitions detected — all domains in stable regime');
  } else {
    console.log(`[phases] ${transitions.length} phase transition${transitions.length === 1 ? '' : 's'} detected:`);
    for (const t of transitions) {
      const when = t.ts ? ` ts=${shortTs(t.ts)}` : t.turn !== undefined ? ` turn=${t.turn}` : '';
      const delta = t.afterMean - t.beforeMean;
      console.log(
        `[phases]   ${t.domain} @ obs#${t.index}${when}: mean ${t.beforeMean.toFixed(2)} → ${t.afterMean.toFixed(2)} ` +
        `(Δ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}, ${t.z.toFixed(1)}σ ${t.direction})`,
      );
    }
  }
  const tails = rollingTailStats(points, w);
  const tailLine = tails.map((s) => `${s.domain} ${s.mean.toFixed(2)}±${s.sd.toFixed(2)}(n=${s.n})`).join(' | ');
  console.log(`[phases] rolling tail (mean±sd, last ${w}): ${tailLine}`);
}

export function runIslandsCommand(cmdArgs: string[]): void {
  const trendPath = resolveTrendPath(cmdArgs);
  const epochs = flagNum(cmdArgs, '--epochs', 1);
  const k = flagNum(cmdArgs, '--k', 2);
  if (!existsSync(trendPath)) {
    console.log(`[islands] no trend substrate at ${trendPath} — nothing to speciate yet`);
    return;
  }
  const points = parseTrendScores(readFileSync(trendPath, 'utf8'));
  const islands = islandsFromPoints(points);
  const totalResidents = islands.reduce((s, i) => s + i.residents.length, 0);
  console.log(`[islands] ${islands.length} islands from ${totalResidents} artifacts (trend: ${trendPath})`);
  for (const island of islands) {
    const s = islandSummary(island);
    const top = s.top ? `top=${s.top.id.slice(0, 12)} (${s.top.score.toFixed(2)})` : 'empty';
    console.log(`[islands]   ${s.domain.padEnd(12)} residents=${String(s.residents).padEnd(5)} ${top}`);
  }
  console.log(`[islands] migration: ring topology, k=${k}, epochs=${epochs}`);
  const records = runMigration(islands, epochs, k);
  const lastEpoch = records.filter((r) => r.epoch === epochs);
  for (const r of lastEpoch) {
    const listing = r.migrants.map((m) => `${m.id.slice(0, 10)}(${m.score.toFixed(2)})`).join(', ');
    console.log(`[islands]   epoch ${r.epoch}: ${r.from} → ${r.to} [${listing}]`);
  }
  const immigrantTotals = islands
    .filter((i) => i.immigrants.length > 0)
    .map((i) => `${i.domain}+${i.immigrants.length}`)
    .join(' ');
  if (immigrantTotals) console.log(`[islands] immigrant exemplars after ${epochs} epoch(s): ${immigrantTotals}`);

  // Frontier corridors from the Latent Field substrate: the cross-domain
  // empty regions that migrated exemplars would seed next.
  const cwd = process.cwd();
  try {
    const frontier = emptyRegions(cwd, { max: 12 });
    if (frontier.length > 0) {
      const corridors = frontier.map((f) => `${f.domainA}×${f.domainB}`);
      console.log(`[islands] frontier corridors (LatentField.emptyRegions, ${frontier.length}): ${corridors.join(', ')}`);
    } else {
      console.log('[islands] frontier corridors: none open (board too thin or fully threaded)');
    }
  } catch {
    console.log('[islands] frontier corridors: LatentField substrate unavailable');
  }
}
