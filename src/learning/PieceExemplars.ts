/**
 * PieceExemplars - the ONE channel that carries earlier accepted pieces into the next governed brief.
 *
 * Writer: the governed finisher (GovernedProjectRecord) saves one SeedArchive record per accepted piece, beside the
 * gallery iteration that holds its code. Reader: this module, called from the generation spine. No new store.
 *
 * Owner rule (2026-11-19): owner-liked pieces first, then the top-scored accepted pieces of the same medium; never a
 * down-voted piece; never a piece from the frozen holdout; a small fixed number (2) chosen for variety, not similarity;
 * passed as "what worked and why" (technique words plus the judge's and the owner's praise), never as code to copy,
 * so later pieces do not converge on one earlier piece.
 *
 * Votes and the holdout are read from the learning dirs the other organs already write (`source-votes.jsonl`,
 * `holdout-files.txt`, `holdout-prompts.txt`). Wall votes use published HTML hashes with original-source aliases.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SeedArchive, type SeedData } from '../gallery/SeedArchive.js';
import { extractColorsFromCode } from '../aesthetic/ColorExtractor.js';

export const PIECE_EXEMPLAR_COUNT = 2;
const PIECE_KIND = 'accepted-piece';
const MAX_PRAISE_CHARS = 240;

/** Where accepted-piece records live: under the project's `.sinter`, beside the learning dir. */
export function pieceArchiveDir(projectRoot: string): string {
  return path.join(projectRoot, '.sinter', 'seed-archive');
}

/** Learning dirs the votes and the holdout are read from (same candidates as taste evidence). */
export function learningDirs(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const artHome = env.S1NTR_ART_HOME ?? path.join(env.HOME ?? os.homedir(), 's1ntr-art');
  return [path.join(projectRoot, '.sinter', 'learning'), path.join(artHome, 'learning')];
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Tag { readonly id: string; readonly phrase: string; readonly test: RegExp }

/** Technique words, found by pattern in the source; the words, never the code, reach the brief. */
const TECHNIQUES: readonly Tag[] = [
  { id: 'trails', phrase: 'a translucent clear each frame leaves motion trails', test: /fillStyle\s*=\s*['"`]rgba\([^)]*0?\.\d+\)['"`][\s\S]{0,60}fillRect/ },
  { id: 'hue', phrase: 'hue cycled by element index and time', test: /hsla?\(/ },
  { id: 'orbit', phrase: 'sine and cosine drive orbiting motion', test: /Math\.(?:sin|cos)[\s\S]{0,400}Math\.(?:sin|cos)|Math\.(?:sin|cos)[\s\S]{0,400}requestAnimationFrame/ },
  { id: 'layers', phrase: 'many layered elements built in a loop', test: /for\s*\(\s*(?:let|var|const)\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\d{2,}/ },
  { id: 'shader', phrase: 'a fragment shader computes colour per pixel', test: /gl_FragColor|precision\s+(?:high|medium|low)p|void\s+main\s*\(/ },
  { id: 'audio', phrase: 'Web Audio synthesis shapes the sound', test: /AudioContext|createOscillator/ },
  { id: 'noise', phrase: 'a noise field gives organic variation', test: /\bnoise\s*\(|perlin|simplex/i },
  { id: 'three', phrase: 'a three.js scene with depth and lighting', test: /THREE\.|from\s+['"]three['"]/ },
  { id: 'svg', phrase: 'SVG vector shapes composed with deliberate layout', test: /<svg[\s>]/i },
  { id: 'canvas', phrase: 'canvas 2D drawing', test: /getContext\(\s*['"]2d['"]\s*\)/ },
  { id: 'loop', phrase: 'a continuous animation loop', test: /requestAnimationFrame/ },
];

export function techniqueTags(source: string): Array<{ id: string; phrase: string }> {
  return TECHNIQUES.filter(t => t.test.test(source)).slice(0, 4).map(t => ({ id: t.id, phrase: t.phrase }));
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').replace(/["<>`]/g, '').trim().slice(0, max);

export interface AcceptedPieceInput {
  readonly name: string;
  readonly domain: string;
  readonly score: number;
  readonly prompt: string;
  readonly promptId?: string;
  readonly source: string;
  readonly playableSha256?: string;
  readonly artifactDigest?: string;
  readonly judgeReasoning?: string;
  readonly at: string;
}

/** The piece's measured palette in words (hex literals found in its source, via the aesthetic ColorExtractor). */
export function measuredPalette(source: string): string {
  const found = extractColorsFromCode(source);
  if (found.colors.every(c => c.count === 1 && c.hex === '#000000') && !/#[0-9a-f]{3,6}\b/i.test(source)) return '';
  return `${found.palette.slice(0, 4).map(c => c.hex).join(', ')} (${found.harmony})`;
}

/** Saves the accepted-piece record next to the gallery iteration. Words only; the code stays in the gallery. */
export async function recordAcceptedPiece(projectRoot: string, piece: AcceptedPieceInput): Promise<void> {
  const tags = techniqueTags(piece.source);
  const palette = measuredPalette(piece.source);
  await new SeedArchive(pieceArchiveDir(projectRoot)).saveSeed(piece.name, {
    kind: PIECE_KIND, domain: piece.domain, score: piece.score, promptSha256: sha256Hex(piece.prompt),
    promptId: piece.promptId ?? null, ...(piece.playableSha256 ? { playableSha256: piece.playableSha256 } : {}),
    sourceSha256: sha256Hex(piece.source), ...(piece.artifactDigest ? { artifactDigest: piece.artifactDigest } : {}),
    techniques: tags.map(t => t.id), technique: tags.map(t => t.phrase).join('; '),
    ...(palette ? { palette } : {}),
    ...(piece.judgeReasoning ? { praise: oneLine(piece.judgeReasoning, MAX_PRAISE_CHARS) } : {}),
    at: piece.at,
  });
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  try { return readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean); } catch { return []; }
}

interface OwnerVote { readonly vote: 'up' | 'down'; readonly at: string }

/** Latest owner vote per published hash or original-source alias across the learning dirs. */
export function readOwnerVotes(dirs: readonly string[]): Map<string, OwnerVote> {
  const latest = new Map<string, OwnerVote>();
  for (const dir of dirs) {
    for (const file of ['source-votes.jsonl', 'owner-downvotes.jsonl']) {
      for (const line of readLines(path.join(dir, file))) {
        let row: { source_sha256?: unknown; original_source_sha256?: unknown; vote?: unknown; at?: unknown };
        try { row = JSON.parse(line) as typeof row; } catch { continue; }
        if (typeof row.source_sha256 !== 'string' || (row.vote !== 'up' && row.vote !== 'down')) continue;
        const at = typeof row.at === 'string' ? row.at : '';
        for (const sha of [row.source_sha256, row.original_source_sha256]) {
          if (typeof sha !== 'string' || !sha) continue;
          const prior = latest.get(sha);
          if (!prior || at >= prior.at) latest.set(sha, { vote: row.vote, at });
        }
      }
    }
  }
  return latest;
}

export function readHoldout(dirs: readonly string[]): { files: Set<string>; prompts: Set<string> } {
  const files = new Set<string>(); const prompts = new Set<string>();
  for (const dir of dirs) {
    for (const l of readLines(path.join(dir, 'holdout-files.txt'))) files.add(l);
    for (const l of readLines(path.join(dir, 'holdout-prompts.txt'))) prompts.add(l);
  }
  return { files, prompts };
}

export interface PieceExemplar { readonly name: string; readonly score: number; readonly liked: boolean;
  readonly technique: string; readonly tags: readonly string[]; readonly palette?: string; readonly praise?: string }

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Chooses the exemplars: liked first, then by score, skipping down-votes and holdout, greedy on technique variety. */
export function selectPieceExemplars(seeds: readonly SeedData[], domain: string,
  votes: ReadonlyMap<string, OwnerVote>, holdout: { files: ReadonlySet<string>; prompts: ReadonlySet<string> },
  count = PIECE_EXEMPLAR_COUNT): PieceExemplar[] {
  const pool = seeds.filter(s => s.kind === PIECE_KIND && s.domain === domain
    && typeof s.score === 'number' && Number.isFinite(s.score) && asString(s.sourceSha256))
    .flatMap(s => {
      const sha = asString(s.sourceSha256);
      const playable = asString(s.playableSha256);
      const sourceVote = votes.get(sha);
      const playableVote = votes.get(playable);
      const vote = playableVote && (!sourceVote || playableVote.at >= sourceVote.at) ? playableVote : sourceVote;
      if (vote?.vote === 'down') return [];
      if ([sha, playable, asString(s.artifactDigest)].some(hash => holdout.files.has(hash))) return [];
      // Older records lack a prompt ID. With a frozen prompt holdout, their eligibility cannot be verified.
      if ((s.promptId === undefined && holdout.prompts.size > 0) || holdout.prompts.has(asString(s.promptId))) return [];
      return [{ seed: s, liked: vote?.vote === 'up', score: s.score as number,
        tags: Array.isArray(s.techniques) ? (s.techniques as unknown[]).map(String) : [] }];
    })
    .sort((a, b) => Number(b.liked) - Number(a.liked) || b.score - a.score || asString(a.seed.seed).localeCompare(asString(b.seed.seed)));
  const chosen: typeof pool = [];
  while (chosen.length < count && pool.length > 0) {
    // Variety: the candidate sharing the fewest technique tags with those already chosen wins; the pool order
    // (liked, then score) breaks ties, so the first pick is always the best-ranked piece.
    const overlap = (c: typeof pool[number]): number => chosen.reduce((n, o) => n + c.tags.filter(t => o.tags.includes(t)).length, 0);
    let best = 0;
    for (let i = 1; i < pool.length; i++) if (overlap(pool[i]) < overlap(pool[best])) best = i;
    chosen.push(pool.splice(best, 1)[0]);
  }
  return chosen.map(c => ({ name: asString(c.seed.seed), score: c.score, liked: c.liked, tags: c.tags,
    technique: asString(c.seed.technique) || 'no technique recorded',
    ...(asString(c.seed.palette) ? { palette: asString(c.seed.palette) } : {}),
    ...(asString(c.seed.praise) ? { praise: asString(c.seed.praise) } : {}) }));
}

export function renderPieceExemplars(exemplars: readonly PieceExemplar[]): string {
  if (exemplars.length === 0) return '';
  const lines = exemplars.map((e, i) => `${i + 1}. ${e.liked ? 'The owner liked this one. ' : ''}Judge score ${e.score.toFixed(2)}. `
    + `Technique that worked: ${e.technique}.${e.palette ? ` Measured palette: ${e.palette}.` : ''}`);
  return 'Earlier pieces of yours that worked for this kind of work (what worked and why). Take the idea, never the piece: '
    + 'make something new and different for the request below.\n' + lines.join('\n');
}

/** Load only this domain's accepted pieces for the next brief. */
export async function loadPieceExemplars(domain: string, projectRoot: string,
  env: NodeJS.ProcessEnv = process.env): Promise<PieceExemplar[]> {
  const seeds = await new SeedArchive(pieceArchiveDir(projectRoot)).listSeeds(domain + '-');
  if (seeds.length === 0) return [];
  const dirs = learningDirs(projectRoot, env);
  return selectPieceExemplars(seeds, domain, readOwnerVotes(dirs), readHoldout(dirs));
}
