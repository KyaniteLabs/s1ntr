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
 *
 * Diversity (#1855): each take gets a distinct seed direction (framing, structure, palette), and the ranking penalises
 * a take that looks like one already ranked above it. The winner is still the best-scoring take; the runner-up is the
 * best take that does not look like the winner. Takes without a readable frame fall back to plain score order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeImagePixels } from '../render/DecodedImageVisibility.js';
import {
  TAKE_VARIANT_MARKER,
  buildTakeSeedDirective,
  computeVisualFingerprint,
  selectDiverseTakes,
  type VisualFingerprint,
} from '../evaluation/VisualDiversity.js';

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
  /** Visual fingerprint of a saved take, or null when it has no readable frame. Defaults to {@link fingerprintArtifactDir}. */
  fingerprint?(dir: string): Promise<VisualFingerprint | null> | VisualFingerprint | null;
}

export interface RankedTake {
  readonly dir: string;
  readonly mean: number;
  /** Score lost for looking like a take ranked above it (0..1 scale); 0 when diversity ranking did not run. */
  readonly diversityPenalty: number;
}

export interface TournamentResult {
  readonly winner?: RankedTake;
  readonly runnerUp?: RankedTake;
  /** True when every scored take had a fingerprint and the ranking penalised look-alikes. */
  readonly diversityRanked: boolean;
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

/** sss ensemble axes are 0.00-10.00; diversity penalties work on a 0..1 score. */
export const SSS_SCORE_MAX = 10;
/** Frames a saved take may carry, in preference order. */
export const TAKE_FRAME_NAMES = ['late-frame.png', 'early-frame.png'] as const;

export const ACCEPTED_STATUS = 0;
export const GENERATED_NOT_ACCEPTED_STATUS = 3;

export function savedDirFromOutput(stdout: string): string | undefined {
  const m = /Saved: (\S+)/m.exec(stdout)?.[1]?.trim();
  return m ? m.replace(/\/source\.txt$/, '') : undefined;
}

/** Fingerprint the first readable frame in a saved take's directory; null when none decodes. */
export async function fingerprintArtifactDir(dir: string): Promise<VisualFingerprint | null> {
  for (const name of TAKE_FRAME_NAMES) {
    try {
      const frame = await fs.promises.readFile(path.join(dir, name));
      return computeVisualFingerprint(await decodeImagePixels(frame));
    } catch {
      // missing or undecodable frame: try the next one
    }
  }
  return null;
}

/**
 * Order scored takes best-first. With a fingerprint for every take, a take that looks like one ranked above it is
 * penalised (MMR, #1855); otherwise plain score order. The top take is the same either way.
 */
export function rankTakes(
  scored: ReadonlyArray<{ dir: string; mean: number }>,
  fingerprints: ReadonlyMap<string, VisualFingerprint>,
): { ranked: RankedTake[]; diversityRanked: boolean } {
  const all = scored.every(t => fingerprints.has(t.dir));
  if (!all || scored.length < 2) {
    const ranked = [...scored].sort((a, b) => b.mean - a.mean).map(t => ({ ...t, diversityPenalty: 0 }));
    return { ranked, diversityRanked: false };
  }
  const candidates = scored.map(t => ({
    id: t.dir, mean: t.mean, score: t.mean / SSS_SCORE_MAX, fingerprint: fingerprints.get(t.dir) as VisualFingerprint,
  }));
  const ranked = selectDiverseTakes(candidates, candidates.length)
    .map(t => ({ dir: t.id, mean: t.mean, diversityPenalty: t.diversityPenalty }));
  return { ranked, diversityRanked: true };
}

export async function runTournament(prompt: string, n: number, deps: TournamentDeps): Promise<TournamentResult> {
  const eligible: string[] = [];
  const notAccepted: string[] = [];
  for (let i = 0; i < n; i++) {
    // One line: the seed directive gives each take its own framing, structure and palette (#1855).
    const seed = buildTakeSeedDirective(prompt, i).replace(/\s*\n\s*/g, ' ');
    const flavored = `${prompt}${TAKE_VARIANT_MARKER}${i + 1}/${n}, island direction: ${ISLANDS[i % ISLANDS.length]} — ${seed} — variation ${Date.now()}-${i}${deps.entropyPhrase ? ` — entropy: ${deps.entropyPhrase}` : ''}`;
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
  if (!scored.length) return { notAccepted, referencedLosers: [], scoredCount: 0, diversityRanked: false };
  const fingerprintOf = deps.fingerprint ?? fingerprintArtifactDir;
  const fingerprints = new Map<string, VisualFingerprint>();
  for (const { dir } of scored) {
    const fp = await fingerprintOf(dir);
    if (fp) fingerprints.set(dir, fp);
  }
  const { ranked, diversityRanked } = rankTakes(scored, fingerprints);
  if (!diversityRanked && scored.length > 1) {
    deps.log(`[best-of] diversity ranking skipped: ${fingerprints.size}/${scored.length} takes had a readable frame`);
  }
  for (const t of ranked) {
    if (t.diversityPenalty > 0) deps.log(`[best-of] ${path.basename(t.dir)} looks like a higher take; diversity penalty ${t.diversityPenalty.toFixed(3)}`);
  }
  const referencedLosers: string[] = [];
  for (const loser of ranked.slice(1)) {
    // Reference, never move: the receipt for this artifact resolves its bytes at the original directory.
    try {
      fs.mkdirSync(deps.rejectDir, { recursive: true });
      fs.writeFileSync(path.join(deps.rejectDir, `${path.basename(loser.dir)}.json`),
        JSON.stringify({ artifactDirectory: loser.dir, mean: loser.mean, diversityPenalty: loser.diversityPenalty, loserTo: ranked[0].dir }, null, 2));
      referencedLosers.push(loser.dir);
    } catch (e) { deps.log(`[best-of] could not write loser reference for ${path.basename(loser.dir)}: ${String((e as Error).message).slice(0, 120)}`); }
  }
  return { winner: ranked[0], runnerUp: ranked[1], diversityRanked, notAccepted, referencedLosers, scoredCount: scored.length };
}
