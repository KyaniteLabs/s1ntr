/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * Best-of-N tournament selection (wayfinder #933), pulled out of bin/sinter so the rules are testable.
 *
 * Sol audit F06. Two defects lived in the inline version:
 *  - losers were MOVED into .omx/atelier/tournament-rejects, but the durable receipt/product store resolves an artifact by
 *    its original directory, so every moved loser's receipt stopped verifying (ENOENT -> null). Losers are now left where
 *    they are and only REFERENCED from the rejects folder.
 *  - the child `generate` was run with execFileSync, so exit status 3 ("generated but not accepted, files saved") threw
 *    before the Saved line was parsed. Eligibility is now explicit: only a child that exits 0 (accepted) can win; a status-3
 *    child keeps its saved artifact and is reported, never silently dropped.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ChildRun {
  /** Process exit status; null when the child was killed or timed out. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface TournamentDeps {
  runChild(prompt: string, index: number): ChildRun;
  /** Mean of the four sss axes for an artifact directory, or null when scoring failed. */
  score(dir: string): number | null;
  rejectDir: string;
  log(line: string): void;
  /** Phrase harvested from the project's own state; appended to every variant so the tries differ for a reason. */
  entropyPhrase?: string;
}

export interface TournamentResult {
  readonly winner?: { dir: string; mean: number };
  readonly runnerUp?: { dir: string; mean: number };
  /** Saved but not eligible (child exit 3): artifacts exist, they just were not accepted. */
  readonly notAccepted: readonly string[];
  readonly referencedLosers: readonly string[];
  readonly scoredCount: number;
}

export const ISLANDS = [
  'restrained, precise, quietly elegant composition',
  'bold, experimental, unusual structure and palette',
  'playful, kinetic, surprising transitions',
] as const;

export const ACCEPTED_STATUS = 0;
export const GENERATED_NOT_ACCEPTED_STATUS = 3;

export function savedDirFromOutput(stdout: string): string | undefined {
  const m = /Saved: (\S+)/m.exec(stdout)?.[1]?.trim();
  return m ? m.replace(/\/source\.txt$/, '') : undefined;
}

export function runTournament(prompt: string, n: number, deps: TournamentDeps): TournamentResult {
  const eligible: string[] = [];
  const notAccepted: string[] = [];
  for (let i = 0; i < n; i++) {
    const flavored = `${prompt} — tournament variant ${i + 1}/${n}, island direction: ${ISLANDS[i % ISLANDS.length]} — variation ${Date.now()}-${i}${deps.entropyPhrase ? ` — entropy: ${deps.entropyPhrase}` : ''}`;
    const run = deps.runChild(flavored, i);
    const saved = savedDirFromOutput(run.stdout);
    if (run.status === ACCEPTED_STATUS && saved) {
      eligible.push(saved);
      console.log(`[best-of] variant ${i + 1}: saved ${saved}`);
      deps.log(`[best-of] variant ${i + 1}/${n} saved ${path.basename(saved)}`);
    } else if (run.status === GENERATED_NOT_ACCEPTED_STATUS && saved) {
      notAccepted.push(saved);
      const msg = `[best-of] variant ${i + 1}/${n} generated but NOT accepted (exit 3); kept at ${saved}, not eligible to win`;
      console.log(msg); deps.log(msg);
    } else {
      const tail = `${run.stdout}${run.stderr ?? ''}`.slice(-160).replace(/\n/g, ' ⏎ ');
      const msg = `[best-of] variant ${i + 1}/${n} FAILED (exit ${run.status}) with ${saved ? 'a' : 'no'} Saved line — output tail: ${tail}`;
      console.log(msg); deps.log(msg);
    }
  }
  const scored: Array<{ dir: string; mean: number }> = [];
  for (const dir of eligible) {
    const mean = deps.score(dir);
    if (mean === null) { console.log(`[best-of] score failed for ${path.basename(dir)}`); continue; }
    scored.push({ dir, mean });
    console.log(`[best-of] ${path.basename(dir)} mean=${mean.toFixed(2)}`);
  }
  if (!scored.length) return { notAccepted, referencedLosers: [], scoredCount: 0 };
  scored.sort((a, b) => b.mean - a.mean);
  const referencedLosers: string[] = [];
  for (const loser of scored.slice(1)) {
    // Reference, never move: the receipt for this artifact resolves its bytes at the original directory.
    try {
      fs.mkdirSync(deps.rejectDir, { recursive: true });
      fs.writeFileSync(path.join(deps.rejectDir, `${path.basename(loser.dir)}.json`),
        JSON.stringify({ artifactDirectory: loser.dir, mean: loser.mean, loserTo: scored[0].dir }, null, 2));
      referencedLosers.push(loser.dir);
    } catch (e) { deps.log(`[best-of] could not write loser reference for ${path.basename(loser.dir)}: ${String((e as Error).message).slice(0, 120)}`); }
  }
  return { winner: scored[0], runnerUp: scored[1], notAccepted, referencedLosers, scoredCount: scored.length };
}
