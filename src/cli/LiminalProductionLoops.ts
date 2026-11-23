/**
 * `generate --loops N`: N governed improvement loops in ONE invocation.
 *
 * Each loop is its own governed Create (own -o folder, artifact, score, critique, journal entry). Loop k+1's
 * prompt carries loop k's accepted code, rendered-frame paths and judge critique (RevisionBrief), never a fresh start.
 * A failed loop does not end the run: the next loop receives the last GOOD code plus the error text.
 * The run is resumable: a loop folder that already holds a completed Create is reused, not re-run.
 * The best loop is marked in loops-manifest.json (highest real score; ties go to the earlier loop).
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildRevisionPrompt, BLOAT_RATIO, identicalLineShare, lineGrowth, loadPriorRun, NO_OP_SHARE, type PriorRun } from '../generators/revision/RevisionBrief.js';
import { writeFileAtomicSync } from '../utils/atomicWrite.js';
import { FileLiminalProductCommandStore } from '../runtime-core/LiminalProductCommandPort.js';
import { withFileLockSync } from '../utils/fileLock.js';

export class LoopReplayIntegrityError extends Error {
  constructor(cause: unknown) {
    super(`LOOP_RECOVERY_INTEGRITY: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

function withLoopRequestLock<T>(file: string, bind: () => T): T {
  try {
    return withFileLockSync(file + '.lock', bind);
  } catch (error) {
    if (error instanceof LoopReplayIntegrityError) throw error;
    throw new LoopReplayIntegrityError(error);
  }
}

/** Only a clean miss on a replay read permits an owner-consented attempt. */
export class LoopOutcomeUnknown extends LoopReplayIntegrityError {}

export interface LoopReplayOptions {
  readonly replayOnly?: boolean;
  readonly onRetryUnknown?: (attemptId: string) => void;
}

function loopBindingFile(loopDirectory: string, attemptId: string): string {
  const outputRoot = path.resolve(loopDirectory, '..', '..');
  const slot = createHash('sha256').update(attemptId).digest('hex');
  return path.join(outputRoot, `effect-${slot}.binding.json`);
}

export async function withBoundLoopJournal<T>(loopDirectory: string, attemptId: string, key: string, stateRoot: string,
  options: LoopReplayOptions, run: (ownerRetry: string | undefined, replayOnly: boolean) => Promise<T>): Promise<T> {
  const file = loopBindingFile(loopDirectory, attemptId);
  const bind = (advance?: { from?: string }) => withLoopRequestLock(file, () => {
    const journalRoot = realpathSync(stateRoot);
    const { dev, ino } = statSync(journalRoot, { bigint: true });
    const binding = { key, journalRoot, device: String(dev), inode: String(ino) };
    if (!existsSync(file)) {
      if (options.replayOnly || advance) throw new LoopReplayIntegrityError('LOOPS_RESUME_BINDING_MISSING');
      writeFileAtomicSync(file, JSON.stringify(binding));
      return { replayOnly: false, ownerRetry: undefined };
    }
    const { ownerRetry, ...original } = JSON.parse(readFileSync(file, 'utf8'));
    if (JSON.stringify(original) !== JSON.stringify(binding)
      || (ownerRetry !== undefined && (typeof ownerRetry !== 'string' || !UUID.test(ownerRetry)))) {
      throw new LoopReplayIntegrityError('LOOPS_RESUME_EFFECT_MISMATCH');
    }
    if (advance && ownerRetry === advance.from) {
      const next = randomUUID();
      writeFileAtomicSync(file, JSON.stringify({ ...binding, ownerRetry: next }));
      return { replayOnly: false, ownerRetry: next };
    }
    return { replayOnly: true, ownerRetry: ownerRetry as string | undefined };
  });
  const active = bind();
  try {
    return await run(active.ownerRetry, active.replayOnly);
  } catch (error) {
    if (!(error instanceof LoopOutcomeUnknown) || !active.replayOnly || !options.onRetryUnknown) throw error;
    const next = bind({ from: active.ownerRetry });
    if (!next.replayOnly) {
      try { options.onRetryUnknown(next.ownerRetry!); }
      catch (error) { throw new LoopReplayIntegrityError(error); }
    }
    return run(next.ownerRetry, next.replayOnly);
  }
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const MAX_LOOPS = 12;
/** Judge noise band for best-of selection; see the measured spread in the loops report. */
export const DEFAULT_TIE_BAND = 0.03;

export interface LoopGenerateOutcome {
  /** Real score, or null when the Create was degraded/unscored. */
  readonly score: number | null;
  readonly critique: string;
  readonly providerCalls: number;
  readonly model?: string;
  readonly accepted?: boolean;
  /** In-memory prior for surfaces with no run folder (chat/TUI/GUI). Folder runs leave this unset and the module reads the folder. */
  readonly prior?: PriorRun;
  /** Opaque handle the caller gets back for the best loop. */
  readonly payload?: unknown;
  readonly draftFailure?: string;
}

interface WinningLoopAttempt {
  readonly kind: 'initial' | 'noop' | 'bloat';
  readonly promptSha256: string;
  readonly sourceSha256: string;
  readonly artifactSha256?: string;
  readonly providerCallsMaximum: number;
  readonly baseLoop: number | null;
}

export interface LoopBatchInfo {
  readonly batchIds: readonly string[];
  readonly requests: readonly { readonly customId: string; readonly batchId: string; readonly outcome: string; readonly usage: Record<string, number> | null; readonly costUsd: number }[];
  readonly costUsd: number;
}

export interface LoopRecord {
  readonly loop: number;
  readonly of: number;
  readonly status: 'ok' | 'failed' | 'resumed';
  readonly outputRoot: string;
  readonly artifactDirectory: string | null;
  readonly score: number | null;
  readonly critique: string;
  readonly providerCalls: number;
  readonly providerCallsMaximum: number;
  readonly providerCallsUnverified?: number;
  readonly revisedFrom: number | null;
  readonly carriedFromLoop: number | null;
  /** The exact request sent for this loop (sha256 + length; the text is saved as request.txt in the loop folder). */
  readonly promptSha256?: string;
  readonly winningAttempt?: WinningLoopAttempt;
  readonly promptChars?: number;
  /** Loop k+1 only: did the sent request contain loop k's code, and its critique? Measured on the sent text. */
  readonly promptCarriesPriorCode?: boolean;
  readonly promptCarriesPriorCritique?: boolean;
  /** The edit base: the best earlier loop when a later one scored lower, else the previous loop. */
  readonly editedFromLoop?: number | null;
  /** Share of the edit base's lines that survive identically in this loop's piece (null for a first draft). */
  readonly identicalLineShare?: number | null;
  /** The first reply was a no-op (> NO_OP_SHARE identical): this loop was asked again once. */
  readonly noOpRetried?: boolean;
  readonly noOpPersisted?: boolean;
  /** Size of this loop's code relative to the code it edited (non-empty lines, 1 = same size). */
  readonly lineGrowth?: number | null;
  /** The first reply grew the piece past BLOAT_RATIO: this loop was asked again once to replace, not add. */
  readonly bloatRetried?: boolean;
  readonly bloatPersisted?: boolean;
  readonly error: string | null;
  readonly best: boolean;
  readonly batch?: LoopBatchInfo;
}

export interface LoopsManifest {
  readonly schema: 's1ntr-loops/1';
  readonly requestBindingVersion?: 1;
  readonly request: string;
  readonly domain: string;
  readonly resumeKey?: string;
  readonly retryNamespace?: string;
  readonly ownerRetries?: readonly { loop: number; kind: WinningLoopAttempt['kind']; attemptId: string; previousCallsUnverified: number }[];
  readonly loops: number;
  readonly providerCallsPerLoop: number;
  readonly providerCallBudget: number;
  readonly providerCallsConsumed: number;
  readonly providerCallsUnverified?: number;
  readonly bestLoop: number | null;
  /** 'score' = highest judge score; 'last-unscored' = no numeric score exists for this surface, so the last completed loop. */
  readonly bestBasis?: 'score' | 'last-unscored';
  /** A later loop must beat the best by more than this to take over (judge noise band). */
  readonly tieBand?: number;
  readonly records: readonly LoopRecord[];
}

export interface RunLoopsInput {
  readonly request: string;
  readonly domain: string;
  readonly resumeKey?: string;
  readonly retryUnknown?: boolean | number;
  readonly attemptPrefix?: string;
  readonly retryArgs?: readonly string[];
  /** Record the request before generation so an interrupted run can only resume the same brief. */
  readonly checkpointBeforeEffects?: boolean;
  readonly loops: number;
  /** Run folder (manifest, per-loop folders, resume). Omit for in-memory loops (chat/TUI/GUI). */
  readonly outputRoot?: string;
  /** Provider-call cap for ONE loop (the old fixed 2 unless the operator set --max-provider-calls). */
  readonly providerCallsPerLoop: number;
  /** One governed Create. `prompt` is the loop's full brief; `outputRoot` is that loop's own folder. */
  readonly generateOne: (args: { prompt: string; outputRoot: string; loop: number; attemptId: string; baseLoop: number | null; baseArtifactDirectory?: string; providerCallsMaximum: number; expectedArtifactSha256?: string } & LoopReplayOptions) => Promise<LoopGenerateOutcome>;
  readonly log?: (line: string) => void;
  /** How a finished loop folder is read back on resume. Default: a Create run folder (product-projections.json). */
  readonly loadDone?: (dir: string, attempt?: WinningLoopAttempt['kind']) => PriorRun | null;
  /** Surfaces whose pieces have no numeric judge score: with no scored loop, the last completed loop is the best (manifest says so). */
  readonly lastIsBestWhenUnscored?: boolean;
  /** Judge-noise band: a loop becomes best only by scoring MORE than the current best by this much (default DEFAULT_TIE_BAND). */
  readonly tieBand?: number;
  /** Replay each recorded winner from the governed store before reusing its files. */
  readonly verifyResumedCreates?: boolean;
  /** How much of the edit base survives unchanged (0..1). Layered pieces use their most-changed layer. */
  readonly survival?: (baseSource: string, newSource: string) => number;
}

export function loopFolder(outputRoot: string, loop: number): string {
  return path.join(outputRoot, 'loops', `r${loop}`);
}

export function parseLoopsFlag(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LOOPS) throw new Error(`--loops needs an integer from 1 to ${MAX_LOOPS} (got ${String(value)})`);
  return n;
}

function tryLoadPrior(dir: string): PriorRun | null {
  try { return loadPriorRun(dir); } catch { return null; }
}

function recordLoopRequest(dir: string, kind: WinningLoopAttempt['kind'], prompt: string,
  binding?: { attemptId: string; baseLoop: number | null; providerCallsMaximum: number }): void {
  const file = path.join(dir, kind === 'initial' ? 'request.txt' : `request-${kind}-retry.txt`);
  if (!binding) {
    writeFileSync(file, prompt);
    return;
  }
  const receipt = file + '.binding.json';
  const serialized = JSON.stringify({ ...binding, promptSha256: createHash('sha256').update(prompt).digest('hex') });
  withLoopRequestLock(file, () => {
    const hasRequest = existsSync(file);
    const hasReceipt = existsSync(receipt);
    if (hasRequest && !hasReceipt) {
      throw new LoopReplayIntegrityError(`LOOPS_UNBOUND_PRIOR_REQUEST: ${path.basename(file)}`);
    }
    if ((hasRequest && readFileSync(file, 'utf8') !== prompt)
      || (hasReceipt && readFileSync(receipt, 'utf8') !== serialized)) {
      throw new LoopReplayIntegrityError(`LOOPS_RESUME_REQUEST_MISMATCH: ${path.basename(file)}`);
    }
    if (!hasReceipt) writeFileAtomicSync(receipt, serialized);
    if (!hasRequest) writeFileAtomicSync(file, prompt);
  });
}

function scrubLoopError(message: string): string {
  return message
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s'"`<>]+/gi, '[url]')
    .replace(/(["'`])(?:\/|[a-z]:[\\/]|\\\\)[^\r\n]*?\1/gi, '[path]')
    .replace(/(?<![\w./-])(?:[a-z]:[\\/]|\\\\|\/)[^\s'"`<>]*/gi, '[path]')
    .slice(0, 1500);
}

function unknownLoop(input: RunLoopsInput, loop: number): LoopReplayIntegrityError {
  const args = input.retryArgs ?? [input.domain === 'compose' ? 'compose' : 'generate',
    '--loops', String(input.loops), '-o', input.outputRoot!, '--prompt', input.request,
    ...(input.domain === 'compose' ? [] : ['--domain', input.domain]), '--max-provider-calls', String(input.providerCallsPerLoop)];
  const quote = (arg: string) => /^[a-z0-9_./=-]+$/i.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'";
  const command = ['sinter', ...args.filter((arg, i) => arg !== '--api-key' && args[i - 1] !== '--api-key'
    && !/^--retry-unknown(?:=|$)/.test(arg)), `--retry-unknown=${loop}`].map(quote).join(' ');
  return new LoopReplayIntegrityError(`Loop ${loop}/${input.loops}: the provider outcome is unknown and may already have been billed. `
    + `Completed loops are safe. Retry only this loop in place with:\n${command}`);
}

export async function runGovernedLoops(input: RunLoopsInput): Promise<{ manifest: LoopsManifest; best: LoopGenerateOutcome | null; bestLoop: number | null }> {
  if (input.outputRoot && (input.verifyResumedCreates || input.checkpointBeforeEffects)) {
    const store = new FileLiminalProductCommandStore(path.join(input.outputRoot, 'loops-manifest.json'));
    return store.withLease('governed-loops', () => runLoops(input));
  }
  return runLoops(input);
}

async function runLoops(input: RunLoopsInput) {
  if (!Number.isSafeInteger(input.providerCallsPerLoop) || input.providerCallsPerLoop < 1) {
    throw new Error('LOOP_PROVIDER_CALL_BUDGET_INVALID');
  }
  const log = input.log ?? (() => {});
  const target = typeof input.retryUnknown === 'number' ? input.retryUnknown : undefined;
  if (target !== undefined && (!Number.isSafeInteger(target) || target < 1 || target > input.loops)) {
    throw new Error('LOOPS_RETRY_TARGET_INVALID');
  }
  const records: LoopRecord[] = [];
  const outcomes = new Map<number, LoopGenerateOutcome>();
  const survive = input.survival ?? identicalLineShare;
  const completed: Array<{ loop: number; prior: PriorRun }> = [];
  let carryError: string | null = null;
  let consumed = 0;
  let unverified = 0;
  const manifestPath = input.outputRoot ? path.join(input.outputRoot, 'loops-manifest.json') : null;
  const bindBeforeEffects = input.verifyResumedCreates || input.checkpointBeforeEffects;
  const contract = { schema: 's1ntr-loops/1' as const, request: input.request,
    domain: input.domain, loops: input.loops,
    ...(bindBeforeEffects ? { requestBindingVersion: 1 as const } : {}),
    ...(input.resumeKey === undefined ? {} : { resumeKey: input.resumeKey }),
    providerCallsPerLoop: input.providerCallsPerLoop, providerCallBudget: input.providerCallsPerLoop * input.loops,
    tieBand: input.tieBand ?? DEFAULT_TIE_BAND };
  let previous = input.outputRoot ? readLoopsManifest(input.outputRoot) : null;
  const recoverFirstBinding = bindBeforeEffects && input.outputRoot && !previous?.records?.length
    && readdirSync(input.outputRoot).some(name => /^effect-.*\.binding\.json$/.test(name));
  if (!previous && bindBeforeEffects && input.outputRoot && manifestPath) {
    const folder = input.outputRoot;
    mkdirSync(folder, { recursive: true });
    previous = withLoopRequestLock(manifestPath, () => {
      const existing = readLoopsManifest(folder);
      if (existing) return existing;
      if (target && !recoverFirstBinding) throw new Error('LOOPS_RETRY_TARGET_UNBOUND');
      let namespace: string | undefined;
      if (recoverFirstBinding) {
        // Losing a namespaced manifest must never turn its bound Create into a fresh key.
        const receipt = path.join(loopFolder(folder, 1), 'request.txt.binding.json');
        if (existsSync(receipt)) {
          namespace = /^retry-([0-9a-f-]+)-loop/.exec(JSON.parse(readFileSync(receipt, 'utf8')).attemptId)?.[1];
        }
      } else if (input.retryUnknown) namespace = randomUUID();
      const initial: LoopsManifest = { ...contract, records: [], bestLoop: null, providerCallsConsumed: 0,
        ...(namespace ? { retryNamespace: namespace } : {}) };
      writeFileAtomicSync(manifestPath, JSON.stringify(initial, null, 2));
      return initial;
    });
  }
  if (previous && (previous.schema !== 's1ntr-loops/1' || !Array.isArray(previous.records))) {
    throw new Error('LOOPS_RESUME_MANIFEST_INVALID');
  }
  const seenLoops = new Set<number>();
  for (const record of previous?.records ?? []) {
    if (!record || !Number.isSafeInteger(record.loop) || record.loop < 1
      || record.loop > input.loops || seenLoops.has(record.loop)) {
      throw new Error('LOOPS_RESUME_MANIFEST_INVALID');
    }
    seenLoops.add(record.loop);
  }
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  if (previous && (previous.request !== input.request || previous.domain !== input.domain
    || previous.loops !== input.loops || previous.providerCallsPerLoop !== input.providerCallsPerLoop
    || previous.tieBand !== (input.tieBand ?? DEFAULT_TIE_BAND) || previous.resumeKey !== input.resumeKey)) {
    throw new Error('LOOPS_RESUME_REQUEST_MISMATCH: use a fresh output folder');
  }
  if (bindBeforeEffects && previous && previous.requestBindingVersion !== 1 && (input.retryUnknown || seenLoops.size < input.loops)) {
    throw new LoopReplayIntegrityError('LOOPS_UNBOUND_PRIOR_RUN: resume with its original checkout');
  }

  const retryNamespace = previous?.retryNamespace;
  if (retryNamespace !== undefined && (typeof retryNamespace !== 'string'
    || !UUID.test(retryNamespace))) {
    throw new Error('LOOPS_RESUME_MANIFEST_INVALID');
  }
  const ownerRetries = [...(previous?.ownerRetries ?? [])];
  const attemptFor = (loop: number) => `${retryNamespace ? `retry-${retryNamespace}-` : ''}loop${loop}of${input.loops}`;

  const effectAttempt = (id: string) => input.attemptPrefix ? `${input.attemptPrefix}-${id}` : id;
  const mayRetry = (loop: number) => input.retryUnknown === true || target === loop;
  const missingWinners = new Set<number>();
  const verifiedResumes = new Map<number, LoopGenerateOutcome>();
  if (input.outputRoot && input.verifyResumedCreates && previous) {
    // Check the whole recorded resume before dispatching or replacing any manifest records.
    for (const { loop, winningAttempt: winner } of previous.records) {
      if (!winner || (target !== undefined && loop > target)) continue;
      const dir = loopFolder(input.outputRoot, loop);
      if (!['initial', 'noop', 'bloat'].includes(winner.kind)
        || !Number.isSafeInteger(winner.providerCallsMaximum) || winner.providerCallsMaximum < 1
        || winner.providerCallsMaximum > input.providerCallsPerLoop) {
        throw new Error('LOOPS_REPLAY_ATTEMPT_INVALID');
      }
      const file = winner.kind === 'initial' ? 'request.txt'
        : winner.kind === 'noop' ? 'request-noop-retry.txt' : 'request-bloat-retry.txt';
      const prompt = readFileSync(path.join(dir, file), 'utf8');
      if (digest(prompt) !== winner.promptSha256) throw new Error('LOOPS_REPLAY_PROMPT_MISMATCH');
      const suffix = winner.kind === 'initial' ? '' : `-${winner.kind}`;
      let replay;
      try {
        replay = await input.generateOne({ prompt, outputRoot: dir, loop,
          attemptId: effectAttempt(attemptFor(loop) + suffix), baseLoop: winner.baseLoop,
          baseArtifactDirectory: previous.records.find(r => r.loop === winner.baseLoop)?.artifactDirectory ?? undefined,
          expectedArtifactSha256: winner.artifactSha256, providerCallsMaximum: winner.providerCallsMaximum, replayOnly: true });
      } catch (error) {
        if (!(error instanceof LoopOutcomeUnknown)) throw error;
        if (!mayRetry(loop)) throw unknownLoop(input, loop);
        missingWinners.add(loop);
        continue;
      }
      if (!replay.prior) throw new Error('LOOPS_REPLAY_VERIFIED_ARTIFACT_REQUIRED');
      if (digest(replay.prior.source) !== winner.sourceSha256
        || (winner.artifactSha256 !== undefined && replay.prior.artifactDigest !== winner.artifactSha256)) {
        throw new Error('LOOPS_RESUME_ARTIFACT_MISMATCH');
      }
      verifiedResumes.set(loop, replay);
    }
  }

  const snapshot = (): LoopsManifest => {
    // A checkpoint replaces only the processed prefix. Later receipts can still be needed after a crash.
    const pending = previous?.records.filter(r => r.loop > records.length) ?? [];
    const visible = [...records, ...pending];
    const calls = consumed + pending.reduce((total, record) => total + record.providerCalls, 0);
    const unknown = unverified + pending.reduce((total, record) => total + (record.providerCallsUnverified ?? 0), 0);
    const scored = visible.filter((r) => r.score !== null);
    const band = input.tieBand ?? DEFAULT_TIE_BAND;
    // Earlier loops win ties; a later loop takes over only by clearing the judge-noise band.
    const top = scored.reduce<LoopRecord | null>((a, r) => (a === null || (r.score as number) > (a.score as number) + band ? r : a), null);
    const unscoredLast = !top && input.lastIsBestWhenUnscored ? [...visible].reverse().find((r) => r.status !== 'failed') ?? null : null;
    const bestLoop = top ? top.loop : unscoredLast ? unscoredLast.loop : null;
    return { ...contract, ...(ownerRetries.length ? { ownerRetries } : {}), ...(retryNamespace ? { retryNamespace } : {}),
      providerCallsConsumed: calls, ...(unknown > 0 ? { providerCallsUnverified: unknown } : {}), bestLoop, ...(bestLoop !== null ? { bestBasis: top ? 'score' as const : 'last-unscored' as const } : {}),
      records: visible.map((r) => ({ ...r, best: r.loop === bestLoop })) };
  };
  const persist = () => { if (!manifestPath || !input.outputRoot) return; mkdirSync(input.outputRoot, { recursive: true }); writeFileAtomicSync(manifestPath, JSON.stringify(snapshot(), null, 2)); };

  for (let loop = 1; loop <= (target ?? input.loops); loop++) {
    const dir = input.outputRoot ? loopFolder(input.outputRoot, loop) : '';
    if (dir) mkdirSync(dir, { recursive: true });
    // Resume: a completed loop (projection + source on disk) is reused as the carry base.
    const previousRecord = previous?.records.find(record => record.loop === loop);
    const winner = missingWinners.has(loop) ? undefined : previousRecord?.winningAttempt;
    const replay = verifiedResumes.get(loop);
    const done = replay?.prior ?? (dir && winner
      ? (input.loadDone ?? tryLoadPrior)(dir, winner.kind) : null);
    if (done && winner) {
      if (!replay && (digest(done.source) !== winner.sourceSha256
        || done.artifactDigest !== winner.artifactSha256)) {
        throw new Error('LOOPS_RESUME_ARTIFACT_MISMATCH');
      }
      if (replay) outcomes.set(loop, replay);
      log(`loop ${loop}/${input.loops}: already complete in ${dir}; resuming after it`);
      completed.push({ loop, prior: done }); carryError = null;
      records.push({ loop, of: input.loops, status: previousRecord?.status === 'failed' ? 'failed' : 'resumed', outputRoot: dir, artifactDirectory: done.artifactDirectory,
        score: done.score, critique: done.critique, providerCalls: 0, providerCallsMaximum: input.providerCallsPerLoop,
        revisedFrom: previousRecord?.revisedFrom ?? null, carriedFromLoop: previousRecord?.carriedFromLoop ?? null,
        winningAttempt: { ...winner, artifactSha256: done.artifactDigest }, error: previousRecord?.error ?? null, best: false });
      persist();
      continue;
    }
    if (bindBeforeEffects && previousRecord?.status === 'failed' && !winner
      && !existsSync(loopBindingFile(dir, effectAttempt(attemptFor(loop))))) {
      // Failures before an effect was bound still supply the original rejection to the next brief.
      records.push(previousRecord);
      carryError = previousRecord.error && scrubLoopError(previousRecord.error);
      consumed += previousRecord.providerCalls;
      unverified += previousRecord.providerCallsUnverified ?? 0;
      log(`loop ${loop}/${input.loops}: keeping the checkpointed failure`);
      continue;
    }
    const band = input.tieBand ?? DEFAULT_TIE_BAND;
    const last = completed.length ? completed[completed.length - 1] : null;
    // Edit base: the BEST scored loop so far when the previous one scored lower (or went unscored), else the previous loop.
    const bestScored = completed.filter((c) => c.prior.score !== null)
      .reduce<{ loop: number; prior: PriorRun } | null>((a, c) => (a === null || (c.prior.score as number) > (a.prior.score as number) + band ? c : a), null);
    const base = bestScored && last && last.loop !== bestScored.loop && (last.prior.score === null || (last.prior.score as number) < (bestScored.prior.score as number)) ? bestScored : last;
    const lower = base && last && base.loop !== last.loop ? last : null;
    const promptFor = (why?: { noOp?: { identicalShare: number }; bloat?: { growth: number } }): string => {
      if (!base) return carryError
        ? `${input.request}\n\nRuntime rejection from loop ${loop - 1}. Correct this failure in the next draft.\n${carryError}`
        : input.request;
      const failNote = carryError
        ? `LOOP ${loop - 1} FAILED with this error (fix the cause; the code below is the last GOOD piece, from loop ${base.loop}): ${carryError}\n\n` : '';
      return buildRevisionPrompt({ request: input.request, loop, of: input.loops, priorSource: base.prior.source,
        priorScore: base.prior.score, critique: failNote + base.prior.critique, rejectionReasons: base.prior.rejectionReasons,
        frames: base.prior.frames, priorLoop: base.loop,
        ...(lower ? { lowerAttempt: { loop: lower.loop, score: lower.prior.score, critique: lower.prior.critique } } : {}),
        ...(why?.noOp ? { noOp: why.noOp } : {}), ...(why?.bloat ? { bloat: why.bloat } : {}) });
    };
    const prompt = promptFor();
    if (base) log(`loop ${loop}/${input.loops}: revising loop ${base.loop} (score ${base.prior.score === null ? 'unscored' : base.prior.score.toFixed(2)}, ${base.prior.source.length} chars, ${base.prior.frames.length} frame(s))${lower ? `; loop ${lower.loop} scored lower, its critique rides along` : ''}${carryError ? ' + error carry' : ''}`);
    else log(`loop ${loop}/${input.loops}: ${carryError ? 'fresh draft with prior error' : 'first draft'}`);
    const promptSha256 = digest(prompt);
    const sentCarry = base ? { code: prompt.includes(base.prior.source.trim().slice(0, 400)),
      critique: base.prior.critique.trim() === '' || prompt.includes(base.prior.critique.trim().slice(0, 200)) } : null;
    const attemptId = attemptFor(loop);
    const baseLoop = base ? base.loop : null;
    let calls = 0;
    let uncertain = 0;
    let winningKind: WinningLoopAttempt['kind'] = 'initial';
    let winningMaximum = input.providerCallsPerLoop;
    let winningPrompt = prompt;
    const retriedInitial = () => ownerRetries.some(retry => retry.loop === loop && retry.kind === 'initial');
    const dispatch = async (brief: string, kind: WinningLoopAttempt['kind']) => {
      const maximum = input.providerCallsPerLoop - calls - uncertain;
      const id = kind === 'initial' ? attemptId : `${attemptId}-${kind}`;
      if (dir) recordLoopRequest(dir, kind, brief, bindBeforeEffects
        ? { attemptId: id, baseLoop, providerCallsMaximum: maximum } : undefined);
      try {
        const result = await input.generateOne({ prompt: brief, outputRoot: dir, loop, attemptId: effectAttempt(id), baseLoop,
          providerCallsMaximum: maximum, baseArtifactDirectory: base?.prior.artifactDirectory,
          ...(target !== undefined || (recoverFirstBinding && loop === 1) || (bindBeforeEffects && previousRecord?.status === 'failed' && !winner)
            ? { replayOnly: true } : {}),
          ...(mayRetry(loop) ? { onRetryUnknown: (retryId: string) => {
            // A kill after the new effect must never verify it against the superseded winner.
            if (missingWinners.has(loop) && previous) previous = { ...previous, records: previous.records.filter(r => r.loop !== loop) };
            ownerRetries.push({ loop, kind, attemptId: retryId, previousCallsUnverified: maximum });
            persist();
          } } : {}) });
        if (!Number.isSafeInteger(result.providerCalls) || result.providerCalls < 0 || result.providerCalls > maximum) {
          throw new Error('LOOP_PROVIDER_CALL_ACCOUNTING_INVALID');
        }
        calls += result.providerCalls;
        return result;
      } catch (error) {
        if (error instanceof LoopOutcomeUnknown) throw unknownLoop(input, loop);
        uncertain += maximum;
        throw error;
      }
    };
    try {
      let out = await dispatch(prompt, 'initial');
      let prior = out.prior ?? (dir ? (input.loadDone ?? tryLoadPrior)(dir) : null);
      let share = base && prior ? survive(base.prior.source, prior.source) : null;
      let retried = false;
      if (base && share !== null && share > NO_OP_SHARE && !retriedInitial() && calls < input.providerCallsPerLoop) {
        retried = true;
        log(`loop ${loop}/${input.loops}: reply is ${Math.round(share * 100)}% identical to loop ${base.loop}'s code (a no-op); asking again once with that stated`);
        const again = promptFor({ noOp: { identicalShare: share } });
        try {
          const maximum = input.providerCallsPerLoop - calls;
          const second = await dispatch(again, 'noop');
          const secondPrior = second.prior ?? (dir ? (input.loadDone ?? tryLoadPrior)(dir) : null);
          if (secondPrior && !second.draftFailure) {
            winningKind = "noop"; winningPrompt = again; winningMaximum = maximum;
            out = second; prior = secondPrior; share = survive(base.prior.source, secondPrior.source); }
        } catch (error) {
          if (error instanceof LoopReplayIntegrityError) throw error;
          log(`loop ${loop}/${input.loops}: the no-op retry failed (${String((error as Error)?.message ?? error).split('\n')[0]}); keeping the first reply`);
        }
      }
      let growth = base && prior ? lineGrowth(base.prior.source, prior.source) : null;
      let bloatRetried = false;
      if (base && growth !== null && growth > BLOAT_RATIO && !retried && !retriedInitial() && calls < input.providerCallsPerLoop) {
        bloatRetried = true;
        log(`loop ${loop}/${input.loops}: reply is ${growth.toFixed(1)}x as long as loop ${base.loop}'s code (bloat); asking again once to replace, not add`);
        const again = promptFor({ bloat: { growth } });
        try {
          const maximum = input.providerCallsPerLoop - calls;
          const second = await dispatch(again, 'bloat');
          const secondPrior = second.prior ?? (dir ? (input.loadDone ?? tryLoadPrior)(dir) : null);
          if (secondPrior && !second.draftFailure) {
            winningKind = "bloat"; winningPrompt = again; winningMaximum = maximum;
            out = second; prior = secondPrior; share = survive(base.prior.source, secondPrior.source); growth = lineGrowth(base.prior.source, secondPrior.source); }
        } catch (error) {
          if (error instanceof LoopReplayIntegrityError) throw error;
          log(`loop ${loop}/${input.loops}: the bloat retry failed (${String((error as Error)?.message ?? error).split('\n')[0]}); keeping the first reply`);
        }
      }
      outcomes.set(loop, out);
      // eslint-disable-next-line require-atomic-updates
      if (prior) { completed.push({ loop, prior }); carryError = null; }
      records.push({ loop, of: input.loops, status: out.draftFailure ? 'failed' : 'ok', outputRoot: dir, artifactDirectory: prior?.artifactDirectory || null,
        score: out.score, critique: out.critique, providerCalls: calls, providerCallsMaximum: input.providerCallsPerLoop,
        ...(uncertain > 0 ? { providerCallsUnverified: uncertain } : {}),
        revisedFrom: base ? base.loop : null, carriedFromLoop: loop > 1 ? loop - 1 : null, promptSha256, promptChars: prompt.length,
        ...(prior ? { winningAttempt: { kind: winningKind, promptSha256: digest(winningPrompt),
          sourceSha256: digest(prior.source), artifactSha256: prior.artifactDigest, providerCallsMaximum: winningMaximum, baseLoop } } : {}),
        editedFromLoop: base ? base.loop : null, identicalLineShare: share, ...(retried ? { noOpRetried: true, noOpPersisted: share !== null && share > NO_OP_SHARE } : {}),
        lineGrowth: growth, ...(bloatRetried ? { bloatRetried: true, bloatPersisted: growth !== null && growth > BLOAT_RATIO } : {}),
        ...(sentCarry ? { promptCarriesPriorCode: sentCarry.code, promptCarriesPriorCritique: sentCarry.critique } : {}), error: out.draftFailure ?? null, best: false });
    } catch (error) {
      if (error instanceof LoopReplayIntegrityError) throw error;
      const msg = scrubLoopError(String((error as Error)?.message ?? error));
      // eslint-disable-next-line require-atomic-updates
      carryError = msg;
      log(`loop ${loop}/${input.loops}: FAILED (${msg.split('\n')[0]})`);
      records.push({ loop, of: input.loops, status: 'failed', outputRoot: dir, artifactDirectory: null, score: null, critique: '',
        providerCalls: calls, providerCallsMaximum: input.providerCallsPerLoop, revisedFrom: base?.loop ?? null,
        ...(uncertain > 0 ? { providerCallsUnverified: uncertain } : {}),
        carriedFromLoop: base?.loop ?? null, error: msg, best: false });
    }
    consumed += calls;
    unverified += uncertain;
    persist();
  }
  persist();
  const manifest = snapshot();
  const best = manifest.bestLoop !== null ? outcomes.get(manifest.bestLoop) ?? null : null;
  return { manifest, best, bestLoop: manifest.bestLoop };
}

export function readLoopsManifest(outputRoot: string): LoopsManifest | null {
  try {
    const value = JSON.parse(readFileSync(path.join(outputRoot, 'loops-manifest.json'), 'utf8')) as LoopsManifest | null;
    if (!value) throw new Error('LOOPS_RESUME_MANIFEST_INVALID');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LoopReplayIntegrityError(error);
  }
}
