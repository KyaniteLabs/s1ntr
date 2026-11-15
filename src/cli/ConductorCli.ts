/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * ConductorCli — the `sinter conductor` command surface: operator view of the
 * Elixis Conductor lane (kill-switch state, daily budget, last plan, verdicts)
 * plus the manual adherence check the sss-score path runs automatically
 * (PRD 2026-09-01 item E).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkIfPending, type TrendRowLike } from '../atelier/ConductorCheck.js';

interface StateLike { enabled?: boolean; reason?: string; evidence?: unknown; subBaselineStreak?: number }
interface PlanLike { primary?: string; secondary?: string; ts?: string }

export function runConductorCommand(cmdArgs: string[]): void {
  const cwd = process.cwd();
  const game = (name: string) => join(cwd, '.omx', 'atelier', 'game', name);
  const readJson = <T>(name: string): T | null => {
    try { return JSON.parse(readFileSync(game(name), 'utf8')) as T; } catch { return null; }
  };

  if (cmdArgs[0] === 'check') {
    let lastRow: TrendRowLike | null = null;
    try {
      const lines = readFileSync(join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl'), 'utf8')
        .split('\n').filter(l => l.trim());
      lastRow = JSON.parse(lines[lines.length - 1]) as TrendRowLike;
    } catch { /* no trend stream yet */ }
    const verdict = lastRow ? checkIfPending(cwd, lastRow) : null;
    if (!verdict) console.log('[conductor] no pending plan in the turn window (nothing to check)');
    else console.log(`[conductor] adherence: ${verdict.adhered ? 'ADHERED' : 'MISSED'} declared=${JSON.stringify(verdict.declared)}`);
    return;
  }

  // status (default)
  const state = readJson<StateLike>('conductor.state');
  const paused = state?.enabled === false;
  console.log(`[conductor] lane: ${paused ? 'PAUSED' : 'active'}${process.env.SINTER_CONDUCTOR_OFF === '1' ? ' (env kill switch SINTER_CONDUCTOR_OFF=1)' : ''}`);
  if (paused) console.log(`[conductor] reason: ${state?.reason ?? 'unspecified'}`);
  if (state && state.enabled !== false) console.log(`[conductor] sub-baseline streak: ${state.subBaselineStreak ?? 0}/2`);
  const count = readJson<{ wave?: string; used?: number }>('conductor-count.json');
  console.log(`[conductor] budget: ${count && count.wave === new Date().toISOString().slice(0, 10) ? `${count.used ?? 0}/2` : '0/2'} combination turns today`);
  const last = readJson<PlanLike>('conductor-last.json');
  console.log(`[conductor] last plan: ${last ? `${last.primary}+${last.secondary} @ ${last.ts}` : 'none pending'}`);
  const verdictsPath = game('conductor-verdicts.jsonl');
  if (existsSync(verdictsPath)) {
    const lines = readFileSync(verdictsPath, 'utf8').split('\n').filter(l => l.trim());
    const lastVerdict = lines.length > 0 ? lines[lines.length - 1] : null;
    console.log(`[conductor] verdicts recorded: ${lines.length}${lastVerdict ? ` — latest: ${lastVerdict}` : ''}`);
  } else {
    console.log('[conductor] verdicts recorded: 0');
  }
}
