import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildRevisionPrompt, type PriorRun } from '../generators/revision/RevisionBrief.js';
import { writeFileAtomicSync } from '../utils/atomicWrite.js';
import { DEFAULT_TIE_BAND, LoopReplayIntegrityError, loopFolder, type LoopBatchInfo, type LoopGenerateOutcome, type LoopRecord, type LoopsManifest, type RunLoopsInput } from './LiminalProductionLoops.js';

/** Records one piece while the batch lane schedules Creates for several pieces in each wave. */
export class BatchLoopLedger {
  readonly records: LoopRecord[] = [];
  #lastGood: { loop: number; prior: PriorRun } | null = null;
  #carryError: string | null = null;
  #consumed = 0;

  constructor(
    readonly input: Pick<RunLoopsInput, 'request' | 'domain' | 'loops' | 'outputRoot' | 'providerCallsPerLoop'>,
    readonly previous: LoopsManifest | null,
    readonly log: (line: string) => void,
  ) {
    if (!previous) return;
    if (previous.schema !== 's1ntr-loops/1' || previous.request !== input.request
      || previous.domain !== input.domain || previous.loops !== input.loops
      || previous.providerCallsPerLoop !== input.providerCallsPerLoop || !Array.isArray(previous.records)) {
      throw new LoopReplayIntegrityError('existing manifest does not belong to this Batch plan');
    }
    const seen = new Set<number>();
    for (const record of previous.records) {
      if (!record || !Number.isInteger(record.loop) || record.loop < 1 || record.loop > input.loops
        || seen.has(record.loop) || !['ok', 'resumed', 'failed'].includes(record.status)
        || (record.status !== 'failed' && !record.batch)) {
        throw new LoopReplayIntegrityError('invalid Batch loop manifest record');
      }
      seen.add(record.loop);
    }
  }

  /** The folder a loop writes to (and is resumed from). */
  dir(loop: number): string { return this.input.outputRoot ? loopFolder(this.input.outputRoot, loop) : ''; }

  /** A loop folder that already holds a completed Create is reused as the carry base. */
  markResumed(loop: number, done: PriorRun, previous: LoopRecord, batch: LoopBatchInfo): void {
    const dir = this.dir(loop);
    this.log(`loop ${loop}/${this.input.loops}: already complete in ${dir}; resuming after it`);
    this.#lastGood = { loop, prior: done }; this.#carryError = null;
    this.records.push({ loop, of: this.input.loops, status: 'resumed', outputRoot: dir, artifactDirectory: done.artifactDirectory,
      score: done.score, critique: done.critique, providerCalls: 0, providerCallsMaximum: this.input.providerCallsPerLoop,
      revisedFrom: previous.revisedFrom, carriedFromLoop: previous.carriedFromLoop, error: null, best: false, batch });
  }

  /** Loop k's full brief: the request on the first draft, else the revision brief carrying the last GOOD code + critique (+ any error). */
  promptFor(loop: number): string {
    const { input } = this;
    if (!this.#lastGood) { this.log(`loop ${loop}/${input.loops}: first draft`); return input.request; }
    const lastGood = this.#lastGood;
    const failNote = this.#carryError
      ? `LOOP ${loop - 1} FAILED with this error (fix the cause; the code below is the last GOOD piece, from loop ${lastGood.loop}): ${this.#carryError}\n\n` : '';
    const prompt = buildRevisionPrompt({ request: input.request, loop, of: input.loops, priorSource: lastGood.prior.source,
      priorScore: lastGood.prior.score, critique: failNote + lastGood.prior.critique,
      rejectionReasons: lastGood.prior.rejectionReasons, frames: lastGood.prior.frames });
    this.log(`loop ${loop}/${input.loops}: revising loop ${lastGood.loop} (score ${lastGood.prior.score === null ? 'unscored' : lastGood.prior.score.toFixed(2)}, ${lastGood.prior.source.length} chars, ${lastGood.prior.frames.length} frame(s))${this.#carryError ? ' + error carry' : ''}`);
    return prompt;
  }

  markOk(loop: number, out: LoopGenerateOutcome, extra: Pick<LoopRecord, 'batch'> = {}): void {
    const dir = this.dir(loop);
    this.#consumed += out.providerCalls;
    const prior = out.prior;
    const revisedFrom = this.#lastGood?.loop ?? null;
    if (prior) { this.#lastGood = { loop, prior }; this.#carryError = null; }
    this.records.push({ loop, of: this.input.loops, status: 'ok', outputRoot: dir, artifactDirectory: prior?.artifactDirectory || null,
      score: out.score, critique: out.critique, providerCalls: out.providerCalls, providerCallsMaximum: this.input.providerCallsPerLoop,
      revisedFrom, carriedFromLoop: revisedFrom, error: null, best: false, ...extra });
  }

  markFailed(loop: number, error: unknown, providerCalls: number, extra: Pick<LoopRecord, 'batch'> = {}): string {
    const msg = String((error as Error)?.message ?? error).slice(0, 1500);
    this.#carryError = msg;
    this.#consumed += providerCalls;
    this.log(`loop ${loop}/${this.input.loops}: FAILED (${msg.split('\n')[0]}); the next loop carries the last good code and this error`);
    this.records.push({ loop, of: this.input.loops, status: 'failed', outputRoot: this.dir(loop), artifactDirectory: null, score: null, critique: '',
      providerCalls, providerCallsMaximum: this.input.providerCallsPerLoop, revisedFrom: this.#lastGood?.loop ?? null,
      carriedFromLoop: this.#lastGood?.loop ?? null, error: msg, best: false, ...extra });
    return msg;
  }

  snapshot(): LoopsManifest {
    const { input } = this;
    const pending = this.previous?.records.filter(record => record.loop > this.records.length) ?? [];
    const records = [...this.records, ...pending];
    const scored = records.filter((r) => r.score !== null);
    const top = scored.reduce<LoopRecord | null>((a, r) => (a === null || (r.score as number) > (a.score as number) + DEFAULT_TIE_BAND ? r : a), null);
    const bestLoop = top ? top.loop : null;
    return { schema: 's1ntr-loops/1', request: input.request, domain: input.domain, loops: input.loops,
      providerCallsPerLoop: input.providerCallsPerLoop, providerCallBudget: input.providerCallsPerLoop * input.loops,
      providerCallsConsumed: this.#consumed, bestLoop, tieBand: DEFAULT_TIE_BAND,
      records: records.map((r) => ({ ...r, best: r.loop === bestLoop })) };
  }

  persist(): void {
    if (!this.input.outputRoot) return;
    mkdirSync(this.input.outputRoot, { recursive: true });
    writeFileAtomicSync(path.join(this.input.outputRoot, 'loops-manifest.json'), JSON.stringify(this.snapshot(), null, 2));
  }
}
