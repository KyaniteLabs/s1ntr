/**
 * Harvest entropy from a project's own state: recent atelier trend rows, compost heap files, and the
 * success rate of those rows. Same project state gives the same seed; any new piece, reject or compost file moves it.
 * Used by `sinter entropy` and by `sinter best-of` (the diversity phrase that steers the tries apart).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MetabolicEntropyEngine } from './MetabolicEntropyEngine.js';
import type { EntropyResult } from './types.js';

function readTrend(cwd: string): unknown[] {
  const file = path.join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl');
  if (!existsSync(file)) return [];
  const rows: unknown[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch { /* skip a torn line */ }
  }
  return rows;
}

export async function harvestProjectEntropy(cwd: string): Promise<EntropyResult> {
  const rows = readTrend(cwd);
  const heapDir = path.join(cwd, 'compost', 'heap');
  const heapFiles = existsSync(heapDir) ? readdirSync(heapDir).sort() : [];
  const scored = rows.filter((r): r is { score: number } => typeof (r as { score?: unknown }).score === 'number');
  const engine = new MetabolicEntropyEngine({
    eventStore: { getRecent: (count: number) => rows.slice(-count) },
    heap: { listFiles: () => Promise.resolve(heapFiles) },
    telemetry: { getSummary: () => ({
      successRate: scored.length ? scored.filter(r => r.score >= 0.5).length / scored.length : 0,
      avgDurationMs: 0, totalTasks: rows.length, totalViolations: heapFiles.length,
    }) },
  });
  return engine.harvest();
}
