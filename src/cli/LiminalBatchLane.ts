/**
 * `generate --batch-file prompts.json --loops N --lane batch --budget-usd X`: the Anthropic Message Batches lane.
 *
 * Only the GENERATION / revision calls go to Anthropic (batch prices, half of live). Rendering, judging, repair, journals and
 * receipts are the same governed Create the live `--loops` path runs; judges are other vision models and never ride this lane.
 *
 * Wave k = every piece's loop-k generation as ONE batch. When it ends, each piece's real governed Create runs against a
 * loopback "gateway" that answers the generator's request from the batch result. A later request inside the same Create
 * (a repair or retry turn) is parked and batched with the other pieces' follow-ups. Wave k+1 carries each piece's own
 * signed source and critique from the piece's own previous Creates.
 *
 * Spend safety is in code: worst-case estimate at batch prices BEFORE every submit, refused above the cumulative cap kept
 * through ProviderBudgetLedger; actual cost settled from `usage`; nothing is submitted when the next wave cannot fit.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { resolveSinterProjectRoot } from '../fs/projectRoot.js';
import path from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import { AnthropicBatchClient, AnthropicBatchHttpError, DEFAULT_ANTHROPIC_BASE_URL, type BatchRequest, type BatchResult } from '../llm/AnthropicBatchClient.js';
import { ANTHROPIC_BATCH_PRICES_VERIFIED, batchCostUsd, batchPriceFor, worstCaseRequestUsd } from '../llm/AnthropicBatchPrices.js';
import { budgetRemainingUsd, ensureBudgetEntry, hostOf, providerBudgetPath, reserveBudget, settleBudget } from '../llm/ProviderBudgetLedger.js';
import { authorizeProviderInvocation, completeProviderInvocation } from '../llm/PreSpendInterlock.js';
import { getFallbacks } from '../config/RoleConfig.js';
import { assertRoleBoundProviderAttempt, LLMClient, withProviderAttemptLimit } from '../llm/LLMClient.js';
import { createProductionLiminalRuntime, MIN_STAGED_CREATE_PROVIDER_CALLS, twoStageJudgeEnabled } from '../runtime-core/ProductionLiminalRuntime.js';
import { assertBlenderReady } from '../render/BlenderReadiness.js';
import { HeadlessRenderer } from '../render/HeadlessRenderer.js';
import { isLiminalProductionDomain } from '../runtime-core/LiminalProductionEffects.js';
import { canonicalDomainId } from '../types/domains.js';
import { withFileLockSync } from '../utils/fileLock.js';
import { runProductionCliProviderEffect } from './LiminalProductionProviderEffect.js';
import { runProductionCliGenerate } from './LiminalProductionGenerate.js';
import { BatchLoopLedger } from './BatchLoopLedger.js';
import { LoopReplayIntegrityError, parseLoopsFlag, readLoopsManifest, type LoopBatchInfo, type LoopRecord, type LoopsManifest } from './LiminalProductionLoops.js';
import type { PriorRun } from '../generators/revision/RevisionBrief.js';

export const REAL_ANTHROPIC_HOST = 'api.anthropic.com';
export const BATCH_LANE_SCHEMA = 's1ntr-batch-lane/1';
const CACHE_CONTROL = Object.freeze({ type: 'ephemeral', ttl: '1h' });
/** Prompt overhead of a revision brief beyond the request and the prior code: critique, frame paths, error carry. */
const REVISION_OVERHEAD_TOKENS = 6000;
const IMAGE_TOKENS = 1600;
const TEST_BASE_ENV = 'SINTER_BATCH_TEST_BASE_URL';

export interface BatchPiece { readonly id: string; readonly prompt: string; readonly domain: string; readonly loops?: number; readonly reasoning?: string }

export interface BatchLaneInput {
  readonly pieces: readonly BatchPiece[];
  readonly loops: number;
  readonly outputRoot: string;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxTokens: number;
  readonly budgetUsd: number;
  readonly marginPct: number;
  readonly dryRun: boolean;
  readonly concurrency: number;
  readonly pollMs: number;
  readonly retryRounds: number;
  readonly providerCallsPerLoop: number;
  readonly attempt?: string;
  readonly teachScope?: string;
  readonly retryUnknown?: boolean;
  readonly log: (line: string) => void;
  /** Tests only. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class BatchLaneRefusal extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'BatchLaneRefusal'; }
}

// ---------------------------------------------------------------------------------------------------------- inputs

function validatePieceId(value: unknown, seen: Set<string>, index: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)
      || ['batch-lane', 'batch-lane.json'].includes(value.toLowerCase())) {
    throw new BatchLaneRefusal('BATCH_FILE_BAD_ID', `prompt #${index + 1} needs a safe piece id starting with a letter or digit`);
  }
  const key = value.toLowerCase();
  if (seen.has(key)) throw new BatchLaneRefusal('BATCH_FILE_DUPLICATE_ID', `id "${value}" appears twice`);
  seen.add(key);
  return value;
}

export function parseBatchFile(file: string): BatchPiece[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    throw new BatchLaneRefusal('BATCH_FILE_UNREADABLE', `${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { prompts?: unknown })?.prompts;
  if (!Array.isArray(list) || list.length === 0) throw new BatchLaneRefusal('BATCH_FILE_EMPTY', 'expected {"prompts":[...]} or a list with at least one prompt');
  const seen = new Set<string>();
  return list.map((item, i) => {
    const p = item as Record<string, unknown> | null;
    const id = validatePieceId(p?.id, seen, i);
    if (p === null) throw new BatchLaneRefusal('BATCH_FILE_BAD_PROMPT', 'expected a prompt entry');
    if (typeof p.prompt !== 'string' || !p.prompt.trim()) throw new BatchLaneRefusal('BATCH_FILE_BAD_PROMPT', `prompt "${id}" has no text`);
    return { id, prompt: p.prompt, domain: typeof p.domain === 'string' && p.domain ? p.domain : 'p5',
      ...(Number.isInteger(p.loops) ? { loops: p.loops as number } : {}), ...(typeof p.reasoning === 'string' ? { reasoning: p.reasoning } : {}) };
  });
}

// ----------------------------------------------------------------------------------------------------------- guards

function isLoopback(host: string): boolean { return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host); }

/** Restrict submission to the provider endpoint or an explicitly selected loopback fake. */
export function resolveAnthropicTarget(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string | null; test: boolean } {
  const baseUrl = (env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  let host = '';
  let protocol = '';
  try { const u = new URL(baseUrl); host = u.host.toLowerCase(); protocol = u.protocol; } catch { /* handled below */ }
  const test = env[TEST_BASE_ENV] === baseUrl && isLoopback(host);
  if (!test && !(host === REAL_ANTHROPIC_HOST && protocol === 'https:')) {
    throw new BatchLaneRefusal('BATCH_BASE_URL_NOT_ANTHROPIC',
      `Batch submission requires the HTTPS endpoint at ${REAL_ANTHROPIC_HOST}. Check ANTHROPIC_BASE_URL.`);
  }
  if (test) return { baseUrl, apiKey: 'batch-lane-test', test };
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  if (apiKey && !test && !apiKey.startsWith('sk-ant-')) {
    throw new BatchLaneRefusal('BATCH_KEY_NOT_ANTHROPIC', 'ANTHROPIC_API_KEY does not look like an Anthropic key (they start "sk-ant-"). Refusing to send it to Anthropic.');
  }
  return { baseUrl, apiKey, test };
}

/** A judge call must never be routed to the Anthropic key: the evaluator (and the other non-generator roles) must be some other provider. */
export async function assertJudgesNotAnthropic(apiKey: string | null, batchBaseUrl = DEFAULT_ANTHROPIC_BASE_URL): Promise<void> {
  await LLMClient.loadRoles();
  const keyDigest = apiKey ? createHash('sha256').update(apiKey).digest('hex') : null;
  for (const role of ['evaluator', 'studio', 'harness'] as const) {
    const configs = [LLMClient.getResolvedRoleConfig(role), ...getFallbacks(role, LLMClient.getRawRoleConfig())];
    for (const cfg of configs) {
      if (!cfg) continue;
      const host = hostOf(String(cfg.baseUrl ?? ''));
      const onAnthropic = host === REAL_ANTHROPIC_HOST || host === hostOf(batchBaseUrl)
        || cfg.apiKey?.startsWith('sk-ant-') === true
        || String(cfg.provider ?? '').toLowerCase() === 'anthropic'
        || (keyDigest !== null && cfg.apiKey && sha(cfg.apiKey) === keyDigest);
      if (onAnthropic) {
        throw new BatchLaneRefusal('BATCH_JUDGE_ON_ANTHROPIC',
          `the ${role} primary or fallback routes to Anthropic. Configure that role to use a different provider`);
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------------- estimation

interface RequestBody { model: string; max_tokens: number; system?: unknown; messages: Array<{ role: string; content: unknown }>; [k: string]: unknown }

function contentSize(content: unknown): { bytes: number; images: number } {
  if (typeof content === 'string') return { bytes: Buffer.byteLength(content), images: 0 };
  let bytes = 0; let images = 0;
  for (const block of Array.isArray(content) ? content : []) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'image') images++; else bytes += Buffer.byteLength(typeof b.text === 'string' ? b.text : JSON.stringify(b));
  }
  return { bytes, images };
}

/** Reserve one input token per UTF-8 byte plus estimated image and message overhead. */
export function estimateBody(body: RequestBody): { inputTokens: number; cachedPrefixTokens: number } {
  const sys = contentSize(body.system ?? '');
  let bytes = sys.bytes; let images = sys.images;
  for (const m of body.messages) { const c = contentSize(m.content); bytes += c.bytes; images += c.images; }
  return { inputTokens: bytes + images * IMAGE_TOKENS + 16 * (1 + body.messages.length), cachedPrefixTokens: sys.bytes + sys.images * IMAGE_TOKENS };
}

export function worstCaseBodyUsd(model: string, body: RequestBody, marginPct: number): number {
  const e = estimateBody(body);
  return worstCaseRequestUsd(model, { ...e, maxTokens: body.max_tokens }) * (1 + marginPct / 100);
}

/** The shared system prefix is marked cacheable with the same 1-hour block in every request. */
export function withSharedCache(body: RequestBody): RequestBody {
  if (typeof body.system === 'string' && body.system) return { ...body, system: [{ type: 'text', text: body.system, cache_control: { ...CACHE_CONTROL } }] };
  return body;
}

// ------------------------------------------------------------------------------------------------------------ state

interface StoredResult {
  customId: string; batchId: string; requestDigest: string; outcome: 'succeeded' | 'errored' | 'invalid_request' | 'expired' | 'canceled';
  message?: { content: unknown[]; stop_reason?: string | null; usage?: Record<string, number>; [k: string]: unknown };
  error?: string; usage: Record<string, number> | null; costUsd: number;
}
interface BatchJournalEntry { key: string; status: 'reserved' | 'preparing' | 'posting' | 'submitted' | 'collected'; batchId?: string; customIds: string[]; requests: Record<string, string>; results?: Record<string, string>; estUsd: number; costUsd?: number; round: number; runtimeLedger?: boolean }
interface LaneState { schema: string; reservationScope: string; planDigest: string; pieces: string[]; loops: number; model: string; batches: Record<string, BatchJournalEntry>; counter: number }

export class BatchBudgetStop extends Error {
  constructor(message: string) { super(`BATCH_BUDGET_STOP: ${message}`); this.name = 'BatchBudgetStop'; }
}

export interface BatchLaneResult {
  readonly dryRun: boolean;
  readonly estimate: LaneEstimate;
  readonly manifests: ReadonlyMap<string, LoopsManifest>;
  readonly stoppedForBudget: string | null;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  readonly batchIds: readonly string[];
  readonly summaryPath: string | null;
}

export interface LaneEstimate {
  readonly model: string; readonly pieces: number; readonly loops: number; readonly requests: number; readonly maxTokens: number; readonly marginPct: number;
  readonly perWaveUsd: readonly number[]; readonly totalUsd: number; readonly capUsd: number; readonly remainingUsd: number; readonly fits: boolean;
  readonly piecesThatFit: number; readonly wavesThatFit: number; readonly pricesVerified: string;
}

const pad = (n: number): string => String(n).padStart(3, '0');
const customIdFor = (pieceIndex: number, loop: number): string => `p${pad(pieceIndex)}l${loop}`;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// --------------------------------------------------------------------------------------------------------- the lane

export async function runBatchLane(input: BatchLaneInput): Promise<BatchLaneResult> {
  if (!path.isAbsolute(input.outputRoot)) throw new BatchLaneRefusal('BATCH_OUTPUT_NOT_ABSOLUTE', 'output root must be an absolute path');
  if (!Number.isSafeInteger(input.providerCallsPerLoop) || input.providerCallsPerLoop < 2) {
    throw new BatchLaneRefusal('BATCH_PROVIDER_CALL_LIMIT_INVALID', 'each loop needs a generation transport and an evaluator transport');
  }
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || !Number.isSafeInteger(input.concurrency)
    || input.concurrency < 1 || !Number.isSafeInteger(input.retryRounds) || input.retryRounds < 0) {
    throw new BatchLaneRefusal('BATCH_LIMIT_INVALID', 'invalid tokens, concurrency, or retry limit');
  }
  if (!Number.isFinite(input.marginPct) || input.marginPct < 0) {
    throw new BatchLaneRefusal('BATCH_MARGIN_INVALID', 'budget margin must be finite and non-negative');
  }
  if (twoStageJudgeEnabled() && input.providerCallsPerLoop < MIN_STAGED_CREATE_PROVIDER_CALLS) {
    throw new BatchLaneRefusal('LIMINAL_STAGED_TRANSPORT_CAP_TOO_LOW', 'a batch loop requires one generation and three staged judge calls');
  }
  const unsupported = input.pieces.filter(piece => !isLiminalProductionDomain(canonicalDomainId(piece.domain)));
  if (unsupported.length) {
    throw new BatchLaneRefusal('BATCH_DOMAIN_UNSUPPORTED',
      unsupported.map(piece => `${piece.id} (${piece.domain})`).join(', '));
  }
  const seen = new Set<string>();
  if (input.pieces.length === 0) throw new BatchLaneRefusal('BATCH_FILE_EMPTY', 'at least one prompt is required');
  const pieces = input.pieces.map((piece, index) => ({
    ...piece, id: validatePieceId(piece.id, seen, index), domain: canonicalDomainId(piece.domain),
  }));
  input = { ...input, pieces };
  if (pieces.some(piece => piece.domain === 'blender')) assertBlenderReady();
  if (input.dryRun) return runLockedBatchLane(input);
  mkdirSync(input.outputRoot, { recursive: true });
  const lease = path.join(input.outputRoot, '.batch-lane.lock');
  const host = os.hostname();
  // Serialize lease recovery and acquisition so two resumes cannot both claim a dead owner's run.
  withFileLockSync(lease + '.acquire', () => {
    if (existsSync(lease)) {
      const owner = JSON.parse(readFileSync(lease, 'utf8')) as { host?: string; pid?: number };
      if (owner.host !== host || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0) {
        throw new BatchLaneRefusal('BATCH_RUN_LOCKED', 'the output has a lease that requires operator reconciliation');
      }
      try {
        process.kill(owner.pid!, 0);
        throw new BatchLaneRefusal('BATCH_RUN_LOCKED', 'another process is using this batch output');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    writeAtomicSync(lease, JSON.stringify({ host, pid: process.pid }));
  });
  try {
    return await runLockedBatchLane(input);
  } finally {
    unlinkSync(lease);
  }
}

async function runLockedBatchLane(input: BatchLaneInput): Promise<BatchLaneResult> {
  const { log } = input;
  const judgeCalls = twoStageJudgeEnabled() ? MIN_STAGED_CREATE_PROVIDER_CALLS - 1 : 1;
  batchPriceFor(input.model); // refuses an unpriced model before anything else
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) throw new BatchLaneRefusal('BATCH_BUDGET_REQUIRED', '--budget-usd <dollars> is required and must be positive');
  if (input.retryUnknown) throw new BatchLaneRefusal('BATCH_RETRY_UNKNOWN', '--retry-unknown is unavailable for Batch. Reconcile any unknown submission with Anthropic before starting a new batch plan.');
  const target = resolveAnthropicTarget(process.env);
  if (!input.dryRun && !target.apiKey) throw new BatchLaneRefusal('BATCH_KEY_MISSING', 'ANTHROPIC_API_KEY is not set in the environment (the lane reads the key from env only)');
  await assertJudgesNotAnthropic(target.apiKey, target.baseUrl);

  // A dry run writes nothing under -o: its request captures live in a throwaway folder that is removed at the end.
  const laneDir = input.dryRun ? mkdtempSync(path.join(os.tmpdir(), 'sinter-batch-dry-')) : path.join(input.outputRoot, 'batch-lane');
  mkdirSync(path.join(laneDir, 'results'), { recursive: true });
  const statePath = path.join(laneDir, 'state.json');
  const ids = input.pieces.map((p) => p.id);
  const loopsOf = (p: BatchPiece): number => parseLoopsFlag(p.loops ?? input.loops);
  const maxLoops = Math.max(...input.pieces.map(loopsOf));

  const planDigest = sha(JSON.stringify({ pieces: input.pieces, model: input.model, effort: input.effort,
    maxTokens: input.maxTokens, loops: maxLoops, providerCallsPerLoop: input.providerCallsPerLoop,
    ...(twoStageJudgeEnabled() ? { stagedJudge: [process.env.SINTER_JUDGE_REASONING ?? 'high', process.env.SINTER_JUDGE_STRICTNESS ?? 'standard'] } : {}),
    attempt: input.attempt, teachScope: input.teachScope, runtimeRoot: process.env.SINTER_LIMINAL_RUNTIME_ROOT,
    home: os.homedir(), projectRoot: resolveSinterProjectRoot(), retryRounds: input.retryRounds,
    knowledgeRoot: process.env.SINTER_LIMINAL_KNOWLEDGE_ROOT,
    baseUrl: target.baseUrl, credentialDigest: target.apiKey ? sha(target.apiKey) : null }));
  let state: LaneState = { schema: BATCH_LANE_SCHEMA, reservationScope: randomUUID(), planDigest,
    pieces: ids, loops: maxLoops, model: input.model, batches: {}, counter: 0 };
  if (!input.dryRun && existsSync(statePath)) {
    const prev = JSON.parse(readFileSync(statePath, 'utf8')) as LaneState;
    if (prev.planDigest !== planDigest || !prev.reservationScope) {
      throw new BatchLaneRefusal('BATCH_RESUME_MISMATCH', `${statePath} has a different or legacy batch plan. Reconcile any existing provider spend before starting a fresh output folder`);
    }
    state = { ...prev, loops: maxLoops };
  }
  const save = (): void => writeAtomicSync(statePath, JSON.stringify(state, null, 2));
  if (!input.dryRun) save();

  const ledgerBase = target.baseUrl;
  // All local batch output roots share the same endpoint cap.
  const ledgerFile = path.join(os.homedir(), '.sinter', 'provider-budgets.json');
  const runtimeLedgerFile = providerBudgetPath();
  const marginMul = 1 + input.marginPct / 100;
  const runtimeRemaining = (): number | null => runtimeLedgerFile === ledgerFile
    ? null : budgetRemainingUsd(ledgerBase, runtimeLedgerFile);
  const remaining = (): number => Math.min(
    input.budgetUsd, budgetRemainingUsd(ledgerBase, ledgerFile) ?? Infinity, runtimeRemaining() ?? Infinity,
  );
  const settle = (entry: BatchJournalEntry, cost: number): void => {
    settleBudget(ledgerBase, entry.key, cost, ledgerFile);
    if (entry.runtimeLedger) settleBudget(ledgerBase, entry.key, cost, runtimeLedgerFile);
  };
  if (!input.dryRun) {
    ensureBudgetEntry(ledgerBase, input.budgetUsd, 'Anthropic Message Batches: art generation only', ledgerFile);
  }

  const client = !input.dryRun && target.apiKey ? new AnthropicBatchClient({ baseUrl: target.baseUrl, apiKey: target.apiKey,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}), ...(input.sleep ? { sleep: input.sleep } : {}) }) : null;

  // ---- stored results (a paid result is never paid for twice)
  let submissionStop: BatchLaneRefusal | undefined;
  const stopSubmitting = (code: string, message: string): never => {
    submissionStop ??= new BatchLaneRefusal(code, message);
    throw submissionStop;
  };
  const collectedEntries = new Map<string, BatchJournalEntry>();
  const resultFile = (customId: string): string => path.join(laneDir, 'results', `${customId}.json`);
  const readResult = (customId: string): StoredResult | null => {
    const entry = collectedEntries.get(customId);
    if (!entry) return null;
    try {
      const contents = readFileSync(resultFile(customId), 'utf8');
      if (sha(contents) === entry.results?.[customId]) return JSON.parse(contents) as StoredResult;
    } catch { /* A collected request is never posted again to reconstruct a lost cache. */ }
    throw new BatchLaneRefusal('BATCH_RESULT_INTEGRITY',
      `cached result ${customId} is missing or changed. Recover it from batch ${entry.batchId}`);
  };
  const storeResult = (result: StoredResult): string => {
    const contents = JSON.stringify(result);
    writeAtomicSync(resultFile(result.customId), contents);
    return sha(contents);
  };
  const requestDigest = (body: unknown): string => sha(JSON.stringify(body));
  const assertRequest = (result: StoredResult, body: RequestBody): void => {
    if (result.requestDigest !== requestDigest(withSharedCache(body))) {
      return stopSubmitting('BATCH_REQUEST_MISMATCH',
        `Create request ${result.customId} differs from the submitted request`);
    }
  };
  const resultsFor = (jobId: string): StoredResult[] => existsSync(path.join(laneDir, 'results'))
    ? readdirSync(path.join(laneDir, 'results')).filter((f) => f === `${jobId}.json` || f.startsWith(`${jobId}s`)).map((f) => readResult(f.replace(/\.json$/, ''))).filter((r): r is StoredResult => r !== null)
    : [];

  const settleCollected = (entry: BatchJournalEntry, results: BatchResult[], retryable: Set<string>): void => {
    const actual = new Set(results.map(row => row.custom_id));
    if (actual.size !== results.length || results.length !== entry.customIds.length
      || entry.customIds.some(id => !actual.has(id))) throw new Error('BATCH_RESULT_SET_MISMATCH');
    for (const row of results) {
      if (row.result.type !== 'succeeded') continue;
      const usage = row.result.message.usage;
      const valid = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (!usage || !valid(usage.input_tokens) || !valid(usage.output_tokens)
        || !valid(usage.cache_creation_input_tokens ?? 0) || !valid(usage.cache_read_input_tokens ?? 0)) {
        throw new Error('BATCH_RESULT_USAGE_INVALID');
      }
    }
    let cost = 0;
    const resultDigests: Record<string, string> = {};
    for (const r of results) {
      const outcome = r.result.type === 'errored'
        ? (r.result.error?.error?.type === 'invalid_request_error' || r.result.error?.type === 'invalid_request_error' ? 'invalid_request' : 'errored')
        : r.result.type;
      const message = r.result.type === 'succeeded' ? r.result.message : undefined;
      const usage = (message?.usage as Record<string, number> | undefined) ?? null;
      const costUsd = message ? batchCostUsd(input.model, usage ?? {}) : 0; // errored/expired/canceled are not billed
      cost += costUsd;
      if (outcome === 'errored' || outcome === 'expired') { retryable.add(r.custom_id); }
      const errText = r.result.type === 'errored' ? String(r.result.error?.error?.message ?? r.result.error?.message ?? 'errored').slice(0, 400) : r.result.type === 'succeeded' ? undefined : r.result.type;
      resultDigests[r.custom_id] = storeResult({ customId: r.custom_id, batchId: entry.batchId ?? '',
        requestDigest: entry.requests[r.custom_id], outcome: outcome as StoredResult['outcome'],
        ...(message ? { message: message as unknown as StoredResult['message'] } : {}), ...(errText ? { error: errText } : {}), usage, costUsd });
    }
    settle(entry, cost);
    entry.status = 'collected';
    entry.costUsd = cost;
    entry.results = resultDigests;
    save();
    for (const id of entry.customIds) collectedEntries.set(id, entry);
  };

  const collect = async (entry: BatchJournalEntry): Promise<Set<string>> => {
    if (!client || !entry.batchId) throw new Error('BATCH_COLLECT_WITHOUT_ID');
    const status = await client.waitForEnd(entry.batchId, input.pollMs, (s) => log(`batch ${entry.batchId}: ${s.processing_status} (${s.request_counts.succeeded} ok, ${s.request_counts.errored} errored, ${s.request_counts.processing} processing)`));
    void status;
    const retry = new Set<string>();
    settleCollected(entry, await client.results(entry.batchId), retry);
    return retry;
  };

  const recordSubmission = (entry: BatchJournalEntry, batchId: string): void => {
    entry.batchId = batchId;
    entry.status = 'submitted';
    save();
  };

  const attempts = new Map<string, number>();
  const rememberAttempt = (entry: BatchJournalEntry): void => {
    for (const id of entry.customIds) attempts.set(id, (attempts.get(id) ?? 0) + 1);
  };
  const attemptsForLoop = (id: string, retriesOnly = false): number => {
    const job = id.replace(/s\d+$/, '');
    let used = 0;
    for (const [request, count] of attempts) {
      if (request === job || request.startsWith(job + 's')) used += retriesOnly ? count - 1 : count;
    }
    return used;
  };
  const canRetry = (id: string): boolean => (attempts.get(id) ?? 0) <= input.retryRounds
    && attemptsForLoop(id) < input.providerCallsPerLoop - judgeCalls;

  /** Submit requests as ONE batch (plus bounded follow-up batches for errored/expired); returns each customId's final stored result. */
  const submitCollect = async (requests: BatchRequest[], label: string): Promise<Map<string, StoredResult>> => {
    const final = new Map<string, StoredResult>();
    let todo = requests.filter(request => {
      const stored = readResult(request.custom_id);
      if (stored && (!canRetry(request.custom_id) || (stored.outcome !== 'errored' && stored.outcome !== 'expired'))) {
        final.set(request.custom_id, stored);
        return false;
      }
      return true;
    });
    for (let round = 0; todo.length > 0; round++) {
      if (submissionStop) throw submissionStop;
      if (!client) throw new Error('BATCH_NO_CLIENT');
      const est = todo.reduce((a, r) => a + worstCaseBodyUsd(input.model, r.params as RequestBody, input.marginPct), 0);
      const left = remaining();
      if (est > left + 1e-9) {
        throw new BatchBudgetStop(`${label}: worst case $${est.toFixed(2)} (with ${input.marginPct}% margin) is more than the $${left.toFixed(2)} left of the $${input.budgetUsd.toFixed(2)} cap; nothing was submitted`);
      }
      const submit = client.prepareSubmission(todo);
      const key = `${state.reservationScope}:${label}-${state.counter++}`;
      const entry: BatchJournalEntry = { key, status: 'preparing', customIds: todo.map(r => r.custom_id),
        requests: Object.fromEntries(todo.map(r => [r.custom_id, requestDigest(r.params)])), estUsd: est, round,
        runtimeLedger: runtimeRemaining() !== null };
      state.batches[key] = entry;
      save();
      let callId: ReturnType<typeof authorizeProviderInvocation> | undefined;
      let submitted;
      let postStarted = false;
      try {
        reserveBudget(ledgerBase, key, est, ledgerFile, input.model);
        if (entry.runtimeLedger) reserveBudget(ledgerBase, key, est, runtimeLedgerFile, input.model);
        submitted = await submit((ordinal, post) => runProductionCliProviderEffect({
          idempotencyKey: `batch-submit:${key}:${ordinal}`,
          binding: { surface: 'anthropic-batch', planDigest, model: input.model, requests: entry.requests, ordinal },
          outputRoot: process.env.SINTER_LIMINAL_RUNTIME_ROOT || input.outputRoot,
          effect: async () => {
            assertRoleBoundProviderAttempt('generator');
            callId = authorizeProviderInvocation({ provider: 'anthropic', model: input.model, mode: 'generate',
              request: { systemPrompt: 'batch-lane', userPrompt: JSON.stringify(entry.requests), maxTokens: input.maxTokens },
              transport: { baseUrl: target.baseUrl, credentialDigest: sha(target.apiKey ?? '') } });
            entry.status = 'posting';
            save();
            postStarted = true;
            try {
              const result = await post();
              completeProviderInvocation(callId, 'success');
              return result;
            } catch (error) {
              completeProviderInvocation(callId, 'error');
              throw error;
            }
          },
        }, options => createProductionLiminalRuntime({ ...options, renderer: new HeadlessRenderer(),
          generator: new LLMClient({ role: 'generator', explicitTransportOnly: true, provider: 'anthropic',
            model: input.model, baseUrl: target.baseUrl, apiKey: target.apiKey ?? '' }) })));
      } catch (error) {
        if (!postStarted || (error instanceof AnthropicBatchHttpError && error.status >= 400
          && error.status < 500 && error.status !== 408 && error.status !== 409)) {
          settle(entry, 0);
          entry.status = 'collected';
          save();
          throw error;
        }
        return stopSubmitting('BATCH_SUBMIT_UNCERTAIN',
          `${label}: submission result is unknown. The reservation remains held pending provider reconciliation`);
      }
      let retry: Set<string>;
      try {
        recordSubmission(entry, submitted.id);
        rememberAttempt(entry);
        log(`${label}: submitted ${todo.length} request(s) as batch ${submitted.id} (reserved $${est.toFixed(2)})`);
        retry = await collect(entry);
      } catch {
        return stopSubmitting('BATCH_COLLECTION_INCOMPLETE',
          `${label}: batch ${submitted.id} could not be collected. Resume using the journal before submitting another wave`);
      }
      for (const request of todo) {
        const id = request.custom_id;
        const stored = readResult(id);
        if (stored && (!retry.has(id) || !canRetry(id))) final.set(id, stored);
      }
      todo = todo.filter(request => retry.has(request.custom_id) && canRetry(request.custom_id));
      if (todo.length) log(`${label}: ${todo.length} request(s) errored or expired; one bounded follow-up batch`);
    }
    return final;
  };

  // ---- recover batches that were submitted by an earlier run: never resubmit a wave that has an id
  if (!input.dryRun) {
    for (const entry of Object.values(state.batches)) {
      if (entry.status === 'posting' || entry.status === 'reserved') {
        throw new BatchLaneRefusal('BATCH_SUBMIT_UNCERTAIN',
          `${entry.key} has a reservation without a batch ID. Reconcile it with the provider before resuming`);
      }
      if (entry.status === 'preparing') {
        settle(entry, 0);
        entry.status = 'collected';
        save();
      }
      if (entry.batchId) rememberAttempt(entry);
      if (entry.status === 'submitted') {
        log(`resuming batch ${entry.batchId} (${entry.key}) from the journal`);
        await collect(entry);
      } else if (entry.status === 'collected' && entry.batchId) {
        for (const id of entry.customIds) collectedEntries.set(id, entry);
      }
    }
    for (const id of collectedEntries.keys()) readResult(id);
  }

  // ---- gateway: the generator's loopback endpoint
  type Reply = { status: number; json: unknown };
  const handlers = new Map<string, (body: RequestBody) => Promise<Reply>>();
  const gatewayKey = randomUUID();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const m = /^\/anthropic-batch-lane\/c\/([A-Za-z0-9_-]+)\/v1\/messages$/.exec(req.url ?? '');
    const handler = m ? handlers.get(m[1]) : undefined;
    if (req.method !== 'POST' || req.headers['x-api-key'] !== gatewayKey || !handler) {
      res.writeHead(404).end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        let reply: Reply;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody | null;
          if (!body || body.model !== input.model || !Number.isSafeInteger(body.max_tokens)
            || body.max_tokens < 1 || body.max_tokens > input.maxTokens || !Array.isArray(body.messages)) {
            throw new BatchLaneRefusal('BATCH_GATEWAY_REQUEST_INVALID', 'request is outside the configured model or token limit');
          }
          reply = await handler(body);
        } catch (error) {
          reply = error instanceof BatchLaneRefusal
            ? { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: error.message } } }
            : { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'batch gateway request failed' } } };
        }
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json));
      })();
    });
  });
  server.requestTimeout = 0; server.headersTimeout = 0; server.timeout = 0; server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (server.address() as { port: number }).port;
  // The lane's own generator talks to this loopback gateway; the SSRF guard must allow loopback for it (restored in finally).
  const priorAllowLocalhost = process.env.LIMINAL_ALLOW_LOCALHOST_LLM; process.env.LIMINAL_ALLOW_LOCALHOST_LLM = 'true';
  const restoreAllowLocalhost = (): void => { if (priorAllowLocalhost === undefined) delete process.env.LIMINAL_ALLOW_LOCALHOST_LLM; else process.env.LIMINAL_ALLOW_LOCALHOST_LLM = priorAllowLocalhost; };
  let handlerSeq = 0;
  const generatorFor = (handlerId: string, maxTokens: number): LLMClient => new LLMClient({
    role: 'generator', explicitTransportOnly: true,
    provider: 'anthropic', baseUrl: `http://127.0.0.1:${gatewayPort}/anthropic-batch-lane/c/${handlerId}`, apiKey: gatewayKey,
    model: input.model, maxTokens, timeout: 90_000_000, thinking: { enabled: true, effort: input.effort },
  });
  // Each Create owns its renderer. Concurrent Creates must not close a shared browser.
  const runtimeFor = (generator: LLMClient) => (o: { root: string; artifactRoot: string; knowledgeRoot?: string }) =>
    createProductionLiminalRuntime({ ...o, generator, stableLibraryPrompt: true, disableGenerationCheckpoints: true, renderer: new HeadlessRenderer() });

  // ---- request capture: run the real Create up to its first generator call, against a stub that refuses it
  const capture = async (piece: BatchPiece, loop: number, prompt: string): Promise<RequestBody> => {
    const id = `cap${handlerSeq++}`;
    const dir = path.join(laneDir, 'capture', `${piece.id}-l${loop}`);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    let captured: RequestBody | null = null;
    handlers.set(id, (body) => {
      captured ??= body;
      return Promise.resolve({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'batch-lane capture: request recorded, nothing sent' } } });
    });
    try {
      await runProductionCliGenerate({ prompt, domain: piece.domain, outputRoot: dir, stateRoot: dir, maxTransportAttempts: twoStageJudgeEnabled() ? MIN_STAGED_CREATE_PROVIDER_CALLS : 1, attemptId: `capture-${sha(piece.id).slice(0, 8)}-l${loop}` },
        runtimeFor(generatorFor(id, input.maxTokens))).catch(() => undefined);
    } finally { handlers.delete(id); rmSync(dir, { recursive: true, force: true }); }
    if (!captured) throw new BatchLaneRefusal('BATCH_CAPTURE_EMPTY', `piece "${piece.id}" loop ${loop}: the governed Create made no generator request and nothing was submitted`);
    return withSharedCache(captured);
  };

  // ---- straggler pool: follow-up requests inside a Create are parked, then batched together
  interface Parked { customId: string; body: RequestBody; resolve: (r: Reply) => void }
  let parked: Parked[] = []; let running = 0; let flushing = false;
  const replyFor = (s: StoredResult | undefined): Reply => {
    if (s?.outcome === 'succeeded' && s.message) return { status: 200, json: s.message };
    return { status: 400, json: { type: 'error', error: { type: 'invalid_request_error',
      message: s ? `batch ${s.outcome}: ${s.error ?? ''}` : 'batch result missing' } } };
  };
  const maybeFlush = (): void => {
    if (flushing || parked.length === 0 || parked.length < running) return;
    flushing = true;
    const group = parked; parked = [];
    void (async () => {
      try {
        const out = await submitCollect(group.map((p) => ({ custom_id: p.customId, params: p.body })), 'strag');
        for (const p of group) p.resolve(replyFor(out.get(p.customId)));
      } catch (error) {
        const reply: Reply = { status: error instanceof BatchBudgetStop ? 402 : 400,
          json: { type: 'error', error: { type: 'invalid_request_error', message: String((error as Error).message).slice(0, 300) } } };
        for (const p of group) p.resolve(reply);
      } finally { flushing = false; maybeFlush(); }
    })();
  };

  const createInput = (piece: BatchPiece, loop: number, prompt: string, outputRoot: string) => ({
    prompt, domain: piece.domain, outputRoot, maxTransportAttempts: input.providerCallsPerLoop,
    adoptReplayedArtifacts: true,
    attemptId: `batch-${state.reservationScope}-${piece.id}-l${loop}`,
    ...(input.teachScope ? { teachScope: input.teachScope } : {}),
  });
  const batchInfo = (jobId: string): LoopBatchInfo => {
    const rs = resultsFor(jobId);
    return { batchIds: [...new Set(rs.map((r) => r.batchId).filter(Boolean))], requests: rs.map((r) => ({ customId: r.customId, batchId: r.batchId, outcome: r.outcome, usage: r.usage, costUsd: r.costUsd })),
      costUsd: Math.round(rs.reduce((a, r) => a + r.costUsd, 0) * 1e6) / 1e6 };
  };

  const waveCosts: number[] = [];
  let stoppedForBudget: string | null = null;
  const allBatchIds = (): string[] => Object.values(state.batches).map((b) => b.batchId).filter((x): x is string => !!x);
  const spentNow = (): number => Object.values(state.batches).reduce((a, b) => a + (b.costUsd ?? 0), 0);

  try {
    const ledgers = input.pieces.map((piece) => {
      const outputRoot = path.join(input.outputRoot, piece.id);
      const previous = input.dryRun ? null : readLoopsManifest(outputRoot);
      return new BatchLoopLedger({ request: piece.prompt, domain: piece.domain, loops: loopsOf(piece),
        outputRoot, providerCallsPerLoop: input.providerCallsPerLoop }, previous, (line) => log(`[${piece.id}] ${line}`));
    });
    const restored = new Map<string, { record: LoopRecord; prior: PriorRun }>();
    // Verify every completed receipt before admitting a new paid wave.
    for (const [i, ledger] of ledgers.entries()) {
      for (const record of ledger.previous?.records ?? []) {
        if (record.status === 'failed') continue;
        const jobId = customIdFor(i, record.loop);
        if (readResult(jobId)?.outcome !== 'succeeded') {
          throw new LoopReplayIntegrityError('completed Batch loop has no settled generation result');
        }
        const outputRoot = ledger.dir(record.loop);
        const prompt = readFileSync(path.join(outputRoot, 'request.txt'), 'utf8');
        const replay = await runProductionCliGenerate({
          ...createInput(input.pieces[i], record.loop, prompt, outputRoot),
          replayOnly: true,
        }, runtimeFor(generatorFor('replay', input.maxTokens)));
        if (!replay.prior) throw new LoopReplayIntegrityError('completed Batch loop has no verified source');
        restored.set(jobId, { record, prior: replay.prior });
      }
    }

    // ============================================ the waves
    let planned = 0; let firstBody: RequestBody | null = null;
    const perPieceFirst: number[] = [];
    const laterWaveUsd = (loop: number, pieceIndex: number): number => {
      void loop;
      const e = estimateBody(firstBody as RequestBody);
      return worstCaseRequestUsd(input.model, { inputTokens: (perPieceFirst[pieceIndex] ?? e.inputTokens) + input.maxTokens + REVISION_OVERHEAD_TOKENS,
        cachedPrefixTokens: e.cachedPrefixTokens, maxTokens: input.maxTokens }) * marginMul;
    };
    for (let loop = 1; loop <= maxLoops; loop++) {
      const todo: Array<{ i: number; piece: BatchPiece; prompt: string; jobId: string }> = [];
      input.pieces.forEach((piece, i) => {
        const ledger = ledgers[i];
        if (loop > loopsOf(piece)) return;
        if (input.dryRun) { if (loop === 1) todo.push({ i, piece, prompt: piece.prompt, jobId: customIdFor(i, loop) }); return; }
        const jobId = customIdFor(i, loop);
        const done = restored.get(jobId);
        const outputRoot = ledger.dir(loop);
        const prompt = ledger.promptFor(loop);
        const requestFile = path.join(outputRoot, 'request.txt');
        if (existsSync(requestFile) && readFileSync(requestFile, 'utf8') !== prompt) {
          throw new LoopReplayIntegrityError(`Batch revision prompt changed for ${jobId}`);
        }
        if (done) {
          ledger.markResumed(loop, done.prior, done.record, batchInfo(jobId));
          ledger.persist();
          return;
        }
        mkdirSync(outputRoot, { recursive: true });
        writeAtomicSync(requestFile, prompt);
        todo.push({ i, piece, prompt, jobId });
      });
      if (todo.length === 0) continue;

      // ---- dry run: loop 1 is captured for real (free, loopback only); later loops are bounded from it (prior code <= max_tokens)
      if (input.dryRun) {
        let waveUsd = 0;
        for (const t of todo) {
          const body = await capture(t.piece, 1, t.prompt);
          firstBody ??= body;
          perPieceFirst[t.i] = estimateBody(body).inputTokens;
          waveUsd += worstCaseBodyUsd(input.model, body, input.marginPct);
        }
        waveCosts.push(waveUsd); planned += todo.length;
        for (let k = 2; k <= maxLoops; k++) {
          waveCosts.push(input.pieces.reduce((a, p, i) => a + (k <= loopsOf(p) ? laterWaveUsd(k, i) : 0), 0));
          planned += input.pieces.filter((p) => k <= loopsOf(p)).length;
        }
        break;
      }

      // ---- real wave
      const requests: BatchRequest[] = [];
      const toCapture = todo.filter((t) => {
        const s = readResult(t.jobId);
        return canRetry(t.jobId) && !(s && s.outcome !== 'errored' && s.outcome !== 'expired');
      });
      await runPool(toCapture, input.concurrency, async (t) => {
        const body = await capture(t.piece, loop, t.prompt);
        requests.push({ custom_id: t.jobId, params: body });
        if (loop === 1) { firstBody ??= body; perPieceFirst[t.i] = estimateBody(body).inputTokens; }
      });
      if (loop === 1 && firstBody && maxLoops > 1) {
        // The whole plan, printed before the first submit. Only wave 1 must fit now; each later wave is re-checked with its real prompts.
        const projected = [requests.reduce((a, r) => a + worstCaseBodyUsd(input.model, r.params as RequestBody, input.marginPct), 0)];
        for (let k = 2; k <= maxLoops; k++) projected.push(input.pieces.reduce((a, p, i) => a + (k <= loopsOf(p) ? laterWaveUsd(k, i) : 0), 0));
        for (const line of formatEstimate(buildEstimate(input, projected, remaining(), input.pieces.length, maxLoops, requests.length))) log(line);
      }
      requests.sort((a, b) => a.custom_id.localeCompare(b.custom_id));
      log(`wave ${loop}/${maxLoops}: ${todo.length} piece(s), ${requests.length} new generation request(s)`);
      try {
        if (requests.length) await submitCollect(requests, `w${loop}`);
      } catch (error) {
        if (error instanceof BatchBudgetStop) {
          stoppedForBudget = `before wave ${loop}: ${error.message}`;
          for (const l of ledgers) l.persist();
          break;
        }
        throw error;
      }
      waveCosts.push(todo.reduce((a, t) => a + batchInfo(t.jobId).costUsd, 0));

      // ---- render + judge exactly as the live path does, against the batch results
      await runPool(todo, input.concurrency, async (t) => {
        const ledger = ledgers[t.i];
        const primary = readResult(t.jobId);
        const extra = (): { batch: LoopBatchInfo } => ({ batch: batchInfo(t.jobId) });
        let callsUsed = () => attemptsForLoop(t.jobId);
        if (!primary || primary.outcome !== 'succeeded' || !primary.message) {
          ledger.markFailed(loop, new Error(`the batch request ${t.jobId} ended ${primary?.outcome ?? 'without a result'}${primary?.error ? `: ${primary.error}` : ''}`), callsUsed(), extra());
          ledger.persist(); return;
        }
        if (primary.message.stop_reason === 'refusal') {
          ledger.markFailed(loop, new Error(`the model refused this brief (stop_reason=refusal) in request ${t.jobId}`), callsUsed(), extra());
          ledger.persist(); return;
        }
        const handlerId = `run${handlerSeq++}`;
        let seq = 0;
        handlers.set(handlerId, async (body) => {
          if (seq >= input.providerCallsPerLoop - judgeCalls) {
            throw new BatchLaneRefusal('BATCH_TRANSPORT_CAP_EXHAUSTED', 'no generator transports remain after reserving the evaluator call');
          }
          const n = seq++;
          const customId = n === 0 ? t.jobId : `${t.jobId}s${n}`;
          const stored = n === 0 ? primary : readResult(customId);
          if (stored) assertRequest(stored, body);
          if (stored && (!canRetry(customId) || (stored.outcome !== 'errored' && stored.outcome !== 'expired'))) {
            return replyFor(stored);
          }
          if (!canRetry(customId)) throw new BatchLaneRefusal('BATCH_TRANSPORT_CAP_EXHAUSTED', 'generator budget exhausted');
          return await new Promise<Reply>((resolve) => { parked.push({ customId, body: withSharedCache(body), resolve }); maybeFlush(); });
        });
        running++;
        try {
          const { result: g, providerCallsUsed } = await withProviderAttemptLimit(
            input.providerCallsPerLoop,
            (used) => {
              callsUsed = () => Math.max(used(), attemptsForLoop(t.jobId));
              return runProductionCliGenerate(createInput(t.piece, loop, t.prompt, ledger.dir(loop)),
                runtimeFor(generatorFor(handlerId, input.maxTokens)));
            },
            () => attemptsForLoop(t.jobId, true),
          );
          const prior = g.prior;
          if (!prior) throw new LoopReplayIntegrityError('Batch Create has no verified source');
          ledger.markOk(loop, { score: prior.score, critique: prior.critique,
            providerCalls: Math.max(providerCallsUsed, g.result.attempts.consumed), prior }, extra());
        } catch (error) {
          if (error instanceof LoopReplayIntegrityError) throw error;
          ledger.markFailed(loop, error, callsUsed(), extra());
        } finally { handlers.delete(handlerId); running--; maybeFlush(); }
        ledger.persist();
      });
      if (submissionStop) throw submissionStop;
    }

    // ============================================ results
    const manifests = new Map<string, LoopsManifest>();
    input.pieces.forEach((p, i) => { if (!input.dryRun) ledgers[i].persist(); manifests.set(p.id, ledgers[i].snapshot()); });
    const remainingUsd = remaining();
    const estimate = buildEstimate(input, waveCosts, remainingUsd, input.pieces.length, maxLoops, planned);
    let summaryPath: string | null = null;
    if (!input.dryRun) {
      summaryPath = path.join(input.outputRoot, 'batch-lane.json');
      writeAtomicSync(summaryPath, JSON.stringify({ schema: BATCH_LANE_SCHEMA, model: input.model, effort: input.effort, maxTokens: input.maxTokens, pricesVerified: ANTHROPIC_BATCH_PRICES_VERIFIED,
        capUsd: input.budgetUsd, spentUsd: spentNow(), remainingUsd, stoppedForBudget, batches: Object.values(state.batches).map((b) => ({ key: b.key, batchId: b.batchId ?? null, status: b.status, requests: b.customIds.length, estUsd: b.estUsd, costUsd: b.costUsd ?? 0 })),
        cacheReadInputTokens: Object.values(readdirSync(path.join(laneDir, 'results'))).map((f) => readResult(f.replace(/\.json$/, ''))).reduce((a, r) => a + (r?.usage?.cache_read_input_tokens ?? 0), 0) }, null, 2));
    }
    return { dryRun: input.dryRun, estimate, manifests, stoppedForBudget, spentUsd: spentNow(), remainingUsd, batchIds: allBatchIds(), summaryPath };
  } finally {
    restoreAllowLocalhost();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (input.dryRun) rmSync(laneDir, { recursive: true, force: true });
  }
}

function buildEstimate(input: BatchLaneInput, perWave: number[], remainingUsd: number, pieces: number, loops: number, requests: number): LaneEstimate {
  const total = perWave.reduce((a, b) => a + b, 0);
  let acc = 0; let wavesThatFit = 0;
  for (const w of perWave) { if (acc + w <= remainingUsd + 1e-9) { acc += w; wavesThatFit++; } else break; }
  const perPiece = pieces > 0 ? total / pieces : 0;
  return { model: input.model, pieces, loops, requests, maxTokens: input.maxTokens, marginPct: input.marginPct, perWaveUsd: perWave.map((n) => Math.round(n * 100) / 100),
    totalUsd: Math.round(total * 100) / 100, capUsd: input.budgetUsd, remainingUsd: Math.round(remainingUsd * 100) / 100, fits: total <= remainingUsd + 1e-9,
    piecesThatFit: perPiece > 0 ? Math.min(pieces, Math.floor(remainingUsd / perPiece)) : pieces, wavesThatFit, pricesVerified: ANTHROPIC_BATCH_PRICES_VERIFIED };
}

export function formatEstimate(e: LaneEstimate): string[] {
  return [
    `Anthropic batch estimate (worst case, ${e.marginPct}% margin, zero cache hits; prices verified ${e.pricesVerified}; planned generation only, excludes retries, repairs and judging)`,
    `  model ${e.model}: ${e.pieces} piece(s) x ${e.loops} loop(s) = ${e.requests} request(s) at max_tokens ${e.maxTokens}`,
    ...e.perWaveUsd.map((w, i) => `  wave ${i + 1}: $${w.toFixed(2)}`),
    `  total worst case: $${e.totalUsd.toFixed(2)}   cap $${e.capUsd.toFixed(2)}   remaining of cap: $${e.remainingUsd.toFixed(2)}   => ${e.fits ? 'FITS' : 'DOES NOT FIT'}`,
    `  what fits: ${e.wavesThatFit} of ${e.perWaveUsd.length} wave(s) for every piece; or about ${e.piecesThatFit} of ${e.pieces} piece(s) at the full loop count`,
  ];
}

async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => { for (;;) { const i = next++; if (i >= items.length) return; await fn(items[i]); } };
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
