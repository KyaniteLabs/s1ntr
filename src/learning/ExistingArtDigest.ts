/** Inventory finished runs and replay only verified Create evidence into project stores. */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFitnessObservationPath } from '../quality/FitnessObservationStore.js';
import { LiminalCommandService, bootstrapProductionReceiptAuthority,
  type LiminalCommandResult, type LiminalReceiptAuthority } from '../runtime-core/LiminalCommandService.js';
import { FileLiminalArtifactStore, FileLiminalOperationJournal } from '../runtime-core/LiminalCommandFilePersistence.js';
import { isGovernedAccepted, recordGovernedOutcome } from '../cli/GovernedProjectRecord.js';

export type DigestPieceVote = 'up' | 'down';

export interface DigestPiece {
  readonly key: string;
  readonly root: string;
  readonly runDir: string;
  readonly seat: string;
  readonly id: string;
  readonly promptId: string;
  readonly domain: string;
  readonly model: string | null;
  /** ISO finish time from the manifest ('' when unknown: such pieces sort last). */
  readonly finishedUtc: string;
  readonly artifactDir: string | null;
  readonly sourcePath: string | null;
  readonly sourceSha: string | null;
  readonly hasRender: boolean;
  readonly hasScore: boolean;
  readonly score: number | null;
  readonly accepted: boolean;
  readonly result: LiminalCommandResult | null;
  readonly verifiedSource?: string;
  readonly createKey: string | null;
  readonly vote: DigestPieceVote | null;
  readonly voteAt: string | null;
  readonly held: boolean;
}

export const PASS1_ORGANS = ['corpus', 'fitness', 'archive', 'lineage', 'gallery', 'trend', 'champion', 'rejects', 'compost'] as const;
export const REBUILD_ORGANS = ['source-votes', 'motifs', 'taste-profile', 'owner-downvotes'] as const;
export const PASS2_ORGANS = ['compost-add'] as const;
export type DigestOrgan = typeof PASS1_ORGANS[number] | typeof REBUILD_ORGANS[number] | typeof PASS2_ORGANS[number];

export interface DigestOptions {
  readonly roots: readonly string[];
  /** Where project stores go (`.sinter`, `.omx/atelier`, `compost/heap` live under it). */
  readonly projectRoot: string;
  /** Home for `~/.sinter` (fitness observations, failures). */
  readonly home: string;
  /** Learning dir: corpus.jsonl, votes, motifs, profile, holdout files, digest receipts. */
  readonly learningDir: string;
  readonly likesFile?: string;
  readonly wallDir?: string;
  /** Shared journal for batch output directories. */
  readonly stateRoot?: string;
  readonly holdoutPrompts?: string;
  readonly holdoutFiles?: string;
  /** Freeze this percentage of pieces (by source digest) as the holdout when no holdout files exist yet. */
  readonly freezeHoldoutPercent?: number;
  readonly dryRun: boolean;
  readonly withModelCalls: boolean;
  readonly skipPython: boolean;
  readonly limit?: number;
  readonly now?: () => string;
  readonly log?: (line: string) => void;
}

export interface OrganCount { wouldWrite: number; written: number; alreadyDone: number; notApplicable: number; failed: number }
export interface RootStats {
  readonly root: string; pieces: number; withCode: number; withRender: number; withScore: number; accepted: number;
  liked: number; disliked: number; held: number; first: string; last: string;
}
export interface DigestReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly pieces: number;
  readonly duplicatesDropped: number;
  readonly dateRange: { first: string; last: string };
  readonly roots: RootStats[];
  readonly holdout: { prompts: number; files: number; heldPieces: number; frozenNow: number; state: 'frozen' | 'unfrozen' };
  readonly organs: Record<string, OrganCount>;
  readonly notes: string[];
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const readJson = (file: string): unknown => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const lines = (file: string): string[] => { try { return readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean); } catch { return []; } };
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function holdoutLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'work', 'artifacts', 'compost', '.omx', '.sinter']);
const MAX_DEPTH = 6;

/** Run folders under a root: any folder holding manifest.json (batch layout `<root>/<seat>/<piece>/manifest.json`). Symlinks are not followed. */
export function findRunDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (existsSync(path.join(dir, 'manifest.json'))) { out.push(dir); return; }
    if (depth >= MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out.sort();
}

interface LikeRow { seat?: string; id?: string; uid?: string; vote?: string; liked?: boolean; at?: string }
/** Owner votes from one or more comma-separated jsonl logs ({seat,id,vote:'up'|'down'} or the older {seat,id,liked:bool}); the latest `at` per piece wins. */
export function loadLikes(files: string | undefined): Map<string, { vote: DigestPieceVote; at: string }> {
  const last = new Map<string, { vote: DigestPieceVote; at: string }>();
  for (const file of (files ?? '').split(',').map(f => f.trim()).filter(Boolean)) {
    for (const l of lines(file)) {
      let r: LikeRow; try { r = JSON.parse(l) as LikeRow; } catch { continue; }
      const vote: DigestPieceVote | null = r.vote === 'up' || r.vote === 'down' ? r.vote : typeof r.liked === 'boolean' ? (r.liked ? 'up' : 'down') : null;
      if (!r.seat || !r.id || !vote) continue;
      const key = `${r.seat}/${r.id}`; const at = r.at ?? ''; const prior = last.get(key);
      if (!prior || prior.at <= at) last.set(key, { vote, at });
    }
  }
  return last;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readPiece(root: string, runDir: string, likes: Map<string, { vote: DigestPieceVote; at: string }>, holdout: { prompts: Set<string>; files: Set<string> }): DigestPiece | null {
  const man = readJson(path.join(runDir, 'manifest.json')) as Record<string, unknown> | null;
  if (!man || typeof man !== 'object') return null;
  const id = path.basename(runDir);
  const seat = String(man.model_key ?? path.basename(path.dirname(runDir)));
  const finishedUtc = typeof man.finished_utc === 'string' ? man.finished_utc : '';
  const artifactsDir = path.join(runDir, 'artifacts');
  let artifactDir: string | null = null; let sourcePath: string | null = null;
  try {
    const subs = readdirSync(artifactsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    for (const sub of subs) { const sp = path.join(artifactsDir, sub, 'source.txt'); if (existsSync(sp) && inside(realpathSync(runDir), realpathSync(sp))) { artifactDir = path.join(artifactsDir, sub); sourcePath = sp; } }
  } catch { /* no artifacts folder */ }
  let sourceSha: string | null = null;
  if (sourcePath) {
    try { sourceSha = sha256(readFileSync(sourcePath)); } catch { sourcePath = null; }
  }
  const hasRender = !!artifactDir && ['late-frame.png', 'playable.html', 'early-frame.png'].some(f => existsSync(path.join(artifactDir!, f)));
  let result: LiminalCommandResult | null = null; let createKey: string | null = null;
  const proj = readJson(path.join(runDir, 'product-projections.json')) as Record<string, { kind?: string; result?: LiminalCommandResult }> | null;
  if (proj && typeof proj === 'object') {
    for (const [k, v] of Object.entries(proj)) if (v?.kind === 'create' && v.result?.evaluation) { result = v.result; createKey = k; }
  }
  const ev = result?.evaluation as Record<string, unknown> | undefined;
  const score = ev && isNumber(ev.score) && ev.scoreState !== 'unscored' ? ev.score : null;
  const accepted = false;
  const promptId = String(man.prompt_id ?? id);
  const vote = likes.get(`${seat}/${id}`) ?? null;
  const artifactDigest = result?.receipt?.artifactDigest ?? null;
  const held = holdout.prompts.has(promptId) || (!!sourceSha && holdout.files.has(sourceSha)) || (!!artifactDigest && holdout.files.has(artifactDigest));
  return { key: sha256(`${seat}/${id}|${finishedUtc}|${sourceSha ?? ''}`).slice(0, 20), root, runDir, seat, id, promptId,
    domain: String(man.domain ?? result?.domain ?? 'unknown'), model: typeof man.model === 'string' ? man.model : null, finishedUtc,
    artifactDir, sourcePath, sourceSha, hasRender, hasScore: score !== null, score, accepted, result, createKey,
    vote: vote?.vote ?? null, voteAt: vote?.at ?? null, held };
}

export function discoverPieces(opts: Pick<DigestOptions, 'roots' | 'wallDir' | 'likesFile' | 'learningDir' | 'holdoutPrompts' | 'holdoutFiles'>): { pieces: DigestPiece[]; duplicates: number; holdout: { prompts: Set<string>; files: Set<string> } } {
  const likes = loadLikes(opts.likesFile);
  const holdout = { prompts: new Set(holdoutLines(opts.holdoutPrompts ?? path.join(opts.learningDir, 'holdout-prompts.txt'))),
    files: new Set(holdoutLines(opts.holdoutFiles ?? path.join(opts.learningDir, 'holdout-files.txt'))) };
  const byKey = new Map<string, DigestPiece>(); let duplicates = 0;
  for (const root of opts.roots) {
    for (const runDir of findRunDirs(root)) {
      const p = readPiece(root, runDir, likes, holdout);
      if (!p) continue;
      const prior = byKey.get(p.key);
      if (prior) { duplicates += 1; continue; }
      byKey.set(p.key, p);
    }
  }
  // Wall-only pieces: the wall holds code for pieces no scanned run folder has (other hosts, later batches). They carry code, date and
  // owner vote but no governed result, so they feed the corpus and the owner-vote organs only.
  const wallHtml = opts.wallDir ? path.join(opts.wallDir, 'index.html') : '';
  if (opts.wallDir && existsSync(wallHtml)) {
    const seen = new Set([...byKey.values()].map(p => p.sourceSha).filter(Boolean));
    let entries: Array<Record<string, unknown>> = [];
    try { entries = JSON.parse((/<script[^>]*id="data"[^>]*>([\s\S]*?)<\/script>/.exec(readFileSync(wallHtml, 'utf8')) ?? [])[1] ?? '[]') as Array<Record<string, unknown>>; } catch { /* wall unreadable: runs only */ }
    for (const e of entries) {
      const hsrc = typeof e.hsrc === 'string' ? e.hsrc : ''; const file = hsrc ? path.join(opts.wallDir, hsrc) : '';
      if (!file || !existsSync(file)) continue;
      const resolvedFile = realpathSync(file);
      if (!inside(realpathSync(opts.wallDir), resolvedFile)) continue;
      const sourceSha = sha256(readFileSync(resolvedFile));
      if (seen.has(sourceSha)) continue;
      seen.add(sourceSha);
      const seat = String(e.key ?? e.seat ?? 'wall'); const id = String(e.id ?? e.uid ?? path.basename(hsrc));
      const vote = likes.get(`${seat}/${id}`) ?? null;
      const promptId = String(e.rid ?? id);
      const finishedUtc = typeof e.finished === 'string' ? e.finished : typeof e.batch_date === 'string' ? `${e.batch_date}T00:00:00Z` : '';
      byKey.set(`wall:${sourceSha}`, { key: sha256(`wall/${String(e.uid ?? id)}|${sourceSha}`).slice(0, 20), root: opts.wallDir, runDir: file, seat, id, promptId,
        domain: String(e.domain ?? 'unknown'), model: typeof e.model === 'string' ? e.model : null, finishedUtc, artifactDir: null, sourcePath: file, sourceSha,
        hasRender: false, hasScore: false, score: null, accepted: false, result: null, createKey: null, vote: vote?.vote ?? null, voteAt: vote?.at ?? null,
        held: holdout.prompts.has(promptId) || holdout.files.has(sourceSha) });
    }
  }
  // Creation-date order: the learning follows the timeline. Unknown dates sort last, ties break on the stable key.
  const pieces = [...byKey.values()].sort((a, b) => {
    const da = a.finishedUtc || '9999'; const db = b.finishedUtc || '9999';
    return da < db ? -1 : da > db ? 1 : a.key < b.key ? -1 : 1;
  });
  return { pieces, duplicates, holdout };
}

/** Deterministic holdout slice: a piece is held when its source digest hashes into the first `percent` of 100 buckets. */
export function inFrozenSlice(sourceSha: string, percent: number): boolean {
  return parseInt(sha256(`holdout:${sourceSha}`).slice(0, 8), 16) % 100 < percent;
}

class Receipts {
  private readonly done = new Set<string>();
  constructor(private readonly file: string, private readonly target: string) {
    for (const line of lines(file)) {
      try {
        const row = JSON.parse(line) as { key: string; organ: string; target?: string };
        if (row.organ === 'corpus' || row.target === target) this.done.add(`${row.key}|${row.organ}`);
      } catch { /* torn tail row: the destination recorder is idempotent */ }
    }
  }
  has(key: string, organ: string): boolean { return this.done.has(`${key}|${organ}`); }
  add(key: string, organ: string, runId: string, at: string): void {
    appendFileSync(this.file, JSON.stringify({ key, organ, target: this.target, run: runId, at }) + '\n');
    this.done.add(`${key}|${organ}`);
  }
  doneSteps(key: string): Set<string> { return new Set(PASS1_ORGANS.filter(organ => this.has(key, organ))); }
}

const emptyCount = (): OrganCount => ({ wouldWrite: 0, written: 0, alreadyDone: 0, notApplicable: 0, failed: 0 });

function statsFor(pieces: DigestPiece[], roots: readonly string[]): RootStats[] {
  return roots.map(root => {
    const ps = pieces.filter(p => p.root === root);
    const dates = ps.map(p => p.finishedUtc).filter(Boolean).sort();
    return { root, pieces: ps.length, withCode: ps.filter(p => p.sourcePath).length, withRender: ps.filter(p => p.hasRender).length,
      withScore: ps.filter(p => p.hasScore).length, accepted: ps.filter(p => p.accepted).length,
      liked: ps.filter(p => p.vote === 'up').length, disliked: ps.filter(p => p.vote === 'down').length, held: ps.filter(p => p.held).length,
      first: dates[0] ?? '', last: dates[dates.length - 1] ?? '' };
  });
}

/** The run projection is an index. The signed operation journal authorizes the write. */
async function verifyPiece(piece: DigestPiece, opts: DigestOptions, heldFiles: Set<string>,
  authority: LiminalReceiptAuthority | undefined): Promise<DigestPiece> {
  if (!authority || piece.held || !piece.createKey || !piece.artifactDir || !piece.sourceSha) return piece;
  const localJournal = path.join(piece.runDir, 'operation-journal.json');
  const journal = existsSync(localJournal) ? localJournal
    : opts.stateRoot && path.join(opts.stateRoot, 'operation-journal.json');
  if (!journal || !existsSync(journal)) return piece;
  const unavailable = (): Promise<never> => Promise.reject(new Error('DIGEST_REQUIRES_EXISTING_CREATE'));
  const reader = new LiminalCommandService({ authority,
    artifacts: new FileLiminalArtifactStore(path.join(piece.runDir, 'artifacts')),
    journal: new FileLiminalOperationJournal(journal),
    effects: { generate: unavailable, render: unavailable, evaluate: unavailable },
  });
  try {
    const result = await reader.readVerifiedResult(piece.createKey);
    const artifact = await reader.readVerifiedArtifact(result);
    const signedDir = path.join(piece.runDir, 'artifacts', sha256(result.operationId));
    if (piece.artifactDir !== signedDir || sha256(artifact.source) !== piece.sourceSha) return piece;
    return { ...piece, result, domain: result.domain, score: result.evaluation.score,
      accepted: isGovernedAccepted(result.evaluation),
      held: heldFiles.has(result.receipt.artifactDigest), verifiedSource: artifact.source };
  } catch {
    return piece;
  }
}

function takeLock(dir: string): () => void {
  const lock = path.join(dir, 'lock');
  const descriptor = openSync(lock, 'wx');
  try { writeFileSync(descriptor, String(process.pid)); } finally { closeSync(descriptor); }
  return () => unlinkSync(lock);
}

function canonicalDestination(candidate: string): string {
  const absolute = path.resolve(candidate);
  try { lstatSync(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(canonicalDestination(path.dirname(absolute)), path.basename(absolute));
  }
  return realpathSync(absolute);
}

function assertLocalWriteTree(directory: string): void {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing: symlink inside writable digest store ${child}`);
    if (entry.isDirectory()) assertLocalWriteTree(child);
  }
}

export async function runDigest(opts: DigestOptions): Promise<DigestReport> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? ((): string => new Date().toISOString());
  const runId = `digest-${now().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const notes: string[] = [];
  const digestDir = path.join(opts.learningDir, 'digest');
  const receiptsFile = path.join(digestDir, 'receipts.jsonl');
  const corpusFile = path.join(digestDir, 'inventory.jsonl');
  const holdoutFile = opts.holdoutFiles ?? path.join(opts.learningDir, 'holdout-files.txt');
  const fitnessFile = resolveFitnessObservationPath({ home: opts.home });
  const project = canonicalDestination(opts.projectRoot);
  const home = canonicalDestination(opts.home);
  const target = sha256(JSON.stringify([project, home, canonicalDestination(fitnessFile)]));
  if (!opts.dryRun) {
    const roots = [...opts.roots, ...(opts.wallDir ? [opts.wallDir] : [])].map(canonicalDestination);
    const sinter = path.join(project, '.sinter');
    const atelier = path.join(project, '.omx', 'atelier');
    const writeTrees = [path.join(sinter, 'governed-records'), path.join(sinter, 'refs'),
      path.join(sinter, 'objects'), path.join(project, 'gallery'),
      path.join(atelier, 'rejects', 'code'), path.join(home, '.sinter', 'failures'),
      path.join(home, '.sinter', 'lineage')];
    const destinations = [project, home, opts.learningDir, digestDir, receiptsFile, corpusFile, holdoutFile, fitnessFile,
      path.join(digestDir, 'lock'), sinter, atelier, path.join(atelier, 'lessons', 'trend.jsonl'),
      ...['project.sinter', 'project.sinter-wal', 'project.sinter-shm'].map(file => path.join(sinter, file)),
      ...writeTrees];
    for (const store of destinations) {
      const resolved = canonicalDestination(store);
      if (roots.some(root => inside(root, resolved))) {
        throw new Error(`refusing: write destination ${store} resolves inside scanned art`);
      }
    }
    for (const store of writeTrees) assertLocalWriteTree(store);
  }
  const { pieces: found, duplicates, holdout } = discoverPieces(opts);
  let pieces = opts.limit ? found.slice(0, opts.limit) : found;
  const holdoutExists = existsSync(holdoutFile)
    || existsSync(opts.holdoutPrompts ?? path.join(opts.learningDir, 'holdout-prompts.txt'));
  let frozenNow = 0;
  if (!holdoutExists && opts.freezeHoldoutPercent && opts.freezeHoldoutPercent > 0) {
    const shas = pieces.filter(p => p.sourceSha && inFrozenSlice(p.sourceSha, opts.freezeHoldoutPercent!)).map(p => p.sourceSha!);
    frozenNow = new Set(shas).size;
    for (const s of shas) holdout.files.add(s);
    pieces = pieces.map(p => (p.sourceSha && holdout.files.has(p.sourceSha) ? { ...p, held: true } : p));
    notes.push(`holdout: ${opts.dryRun ? 'would freeze' : 'froze'} ${frozenNow} source digests (${opts.freezeHoldoutPercent}% slice)`);
  }
  const unfrozen = !holdoutExists && frozenNow === 0;
  if (unfrozen) notes.push('HOLDOUT-UNFROZEN: no holdout files; nothing is excluded from training (pass --freeze-holdout-percent N to freeze a slice first)');

  const keyFile = path.join(os.homedir(), '.sinter', 'authority', 'liminal-command-receipt.key');
  const authority = existsSync(keyFile)
    ? await bootstrapProductionReceiptAuthority(keyFile, { readOnly: true }) : undefined;
  if (holdout.prompts.size > 0) {
    notes.push('Historical replay paused: prompt IDs are unsigned. Use a source or artifact digest holdout file for signed replay.');
  } else {
    const verifiedPieces = [];
    for (const piece of pieces) {
      verifiedPieces.push(await verifyPiece(piece, opts, holdout.files, authority));
    }
    pieces = verifiedPieces;
  }
  const organs: Record<string, OrganCount> = {};
  for (const o of [...PASS1_ORGANS, ...REBUILD_ORGANS, ...(opts.withModelCalls ? PASS2_ORGANS : [])]) organs[o] = emptyCount();
  if (opts.withModelCalls) {
    organs['compost-add'] = { ...emptyCount(), notApplicable: pieces.length };
    notes.push('Model-assisted replay is unavailable for historical Create receipts. Learning requires a separate signed owner admission.');
  }
  const report = (): DigestReport => ({ runId, dryRun: opts.dryRun, pieces: pieces.length, duplicatesDropped: duplicates,
    dateRange: { first: pieces.map(p => p.finishedUtc).filter(Boolean).sort()[0] ?? '', last: pieces.map(p => p.finishedUtc).filter(Boolean).sort().pop() ?? '' },
    roots: statsFor(pieces, opts.wallDir ? [...opts.roots, opts.wallDir] : opts.roots), holdout: { prompts: holdout.prompts.size, files: holdout.files.size, heldPieces: pieces.filter(p => p.held).length, frozenNow, state: unfrozen ? 'unfrozen' : 'frozen' },
    organs, notes });

  if (!opts.dryRun) mkdirSync(digestDir, { recursive: true });
  const release = opts.dryRun ? () => undefined : takeLock(digestDir);
  try {
    if (!opts.dryRun && !holdoutExists && opts.freezeHoldoutPercent && opts.freezeHoldoutPercent > 0) {
      mkdirSync(path.dirname(holdoutFile), { recursive: true });
      writeFileSync(holdoutFile, [...holdout.files].sort().join('\n') + '\n', { flag: 'wx' });
    }
    const receipts = new Receipts(receiptsFile, target);
    const existing = new Set(lines(corpusFile).flatMap(line => {
      try { return [JSON.parse(line).digest_key]; } catch { return []; }
    }));
    for (const p of pieces) {
      const at = now();
      // corpus row (same schema learn_after_batch.py writes; holdout rows are kept, flagged, and never trained on)
      const tally = (organ: string, applicable: boolean): 'todo' | 'skip' => {
        const c = organs[organ];
        if (!applicable) { c.notApplicable += 1; return 'skip'; }
        if (receipts.has(p.key, organ)) { c.alreadyDone += 1; return 'skip'; }
        return 'todo';
      };
      if (tally('corpus', true) === 'todo') {
        if (opts.dryRun) organs.corpus.wouldWrite += 1;
        else {
          const ev = p.verifiedSource !== undefined ? p.result?.evaluation : undefined;
          const row = { digest_key: p.key, run_dir: p.runDir, finished_utc: p.finishedUtc || null, model_key: p.seat, model: p.model, prompt_id: p.promptId, domain: p.domain,
            source_path: p.sourcePath ?? undefined, source_sha256: p.sourceSha ?? undefined, score: p.score ?? undefined, degraded: ev?.degraded,
            failure_class: ev?.failureClass, admission_eligible: p.accepted, rejection_reasons: ev?.rejectionReasons,
            artifact_digest: ev ? p.result?.receipt?.artifactDigest : undefined, create_key: ev ? p.createKey : undefined,
            holdout: p.held, digested_by: runId };
          mkdirSync(opts.learningDir, { recursive: true });
          if (!existing.has(p.key)) {
            appendFileSync(corpusFile, JSON.stringify(row) + '\n');
            existing.add(p.key);
          }
          receipts.add(p.key, 'corpus', runId, at); organs.corpus.written += 1;
        }
      }
      // organs that record into the project stores via the one governed finisher
      const recordable = !!p.result && !!p.artifactDir && p.verifiedSource !== undefined && !p.held;
      const expected: string[] = p.accepted ? ['fitness', 'archive', 'lineage', 'gallery', 'trend', 'champion'] : ['fitness', 'rejects'];
      for (const organ of PASS1_ORGANS) if (organ !== 'corpus' && !expected.includes(organ)) { organs[organ].notApplicable += 1; }
      const pending = expected.filter(o => tally(o, recordable) === 'todo');
      if (!recordable || !pending.length) continue;
      if (opts.dryRun) { for (const o of pending) organs[o].wouldWrite += 1; continue; }
      const outcome = await recordGovernedOutcome({ projectRoot: project, home, prompt: p.promptId, domain: p.domain,
        promptId: p.promptId, artifactDirectory: p.artifactDir, result: p.result, verifiedSource: p.verifiedSource,
        at: p.finishedUtc || at, skip: receipts.doneSteps(p.key) });
      for (const name of outcome.recorded) if (pending.includes(name)) { receipts.add(p.key, name, runId, at); organs[name].written += 1; }
      for (const name of pending) {
        if (outcome.alreadyRecorded.includes(name)) {
          receipts.add(p.key, name, runId, at);
          organs[name].alreadyDone += 1;
        } else if (!outcome.recorded.includes(name)) {
          organs[name].failed += 1;
        }
      }
      for (const f of outcome.failed) log(`FAIL ${p.seat}/${p.id}: ${f}`);
    }

    for (const organ of REBUILD_ORGANS) organs[organ].notApplicable += 1;
    notes.push('Wall votes are inventory only. Owner feedback enters through signed intake.');


  } finally { release(); }
  return report();
}

export function storeSizes(dirs: Record<string, string>): Record<string, { files: number; bytes: number }> {
  const out: Record<string, { files: number; bytes: number }> = {};
  for (const [name, dir] of Object.entries(dirs)) {
    let files = 0; let bytes = 0;
    const walk = (d: string): void => {
      let es: import('node:fs').Dirent[] = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { files += 1; try { bytes += statSync(f).size; } catch { /* vanished */ } } }
    };
    walk(dir); out[name] = { files, bytes };
  }
  return out;
}
