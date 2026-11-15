/**
 * System-agnostic telemetry event ledger (#400).
 *
 * Portable envelope (no Sinter domain imports). Persistence reuses #397
 * mechanics: JSONL append under a lock, 5MB×3 rotation, env path override,
 * NODE_ENV=test skip unless path is explicit.
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { laneForEvent } from './events.js';

export const EVENT_LEDGER_SCHEMA_VERSION = 2 as const;
export const EVENT_LEDGER_PATH_ENV = 'SINTER_EVENT_LEDGER_PATH';
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVES = 3;
const LOCK_STALE_MS = 60_000;

/**
 * Portable envelope. Field set is the cross-project contract — keep free of
 * Sinter-specific type imports so sibling tools can read the same JSONL.
 */
export interface SinterEvent {
  schemaVersion: 2;
  ts: string;
  event: string;
  model: string | null;
  provider: string | null;
  role: string | null;
  runId: string | null;
  episodeId: string | null;
  domain: string | null;
  inputHash: string | null;
  verdict: string | null;
  latencyMs: number | null;
  /** null for subscription / flat-rate routes */
  costUsd: number | null;
  evidenceRefs: string[];
  payload: Record<string, unknown>;
}

/** Input accepted by record(); ts/schemaVersion filled by the store */
export type SinterEventInput = Omit<SinterEvent, 'schemaVersion' | 'ts'> & {
  ts?: string;
  schemaVersion?: 2;
};

/** Override NODE_ENV=test skip when set to '1'/'true' (tests only). */
export const EVENT_LEDGER_FORCE_ENV = 'SINTER_EVENT_LEDGER_FORCE';

export interface EventLedgerOptions {
  /** Explicit file path (tests). Bypasses lane/day layout. */
  filePath?: string;
  /** Base directory override (or use SINTER_EVENT_LEDGER_PATH). */
  baseDir?: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  maxArchives?: number;
  lockTimeoutMs?: number;
  /** Fixed UTC day for lane/day paths (tests). Format YYYY-MM-DD. */
  day?: string;
  /**
   * Record even under NODE_ENV=test without an explicit path.
   * Prefer filePath/baseDir/SINTER_EVENT_LEDGER_PATH; this is the escape hatch.
   */
  forceInTest?: boolean;
}

export interface EventLedgerQuery {
  event?: string;
  model?: string;
  /** Filter by envelope role (e.g. harness, generator, evaluator) */
  role?: string;
  since?: string;
  limit?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Canonical JSON for hashing: recursively sort object keys, stringify.
 * Arrays keep order. Produces stable hashes across process restarts.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

/** sha256 hex digest of canonical JSON input, prefixed `sha256:` */
export function inputHash(value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return `sha256:${digest}`;
}

/**
 * Hash tool args for harness.action. Secret-like keys are redacted to a
 * constant marker before hashing so raw secrets never enter the digest path.
 */
export function hashToolArgs(args: unknown): string {
  return inputHash(redactSecrets(args));
}

/** Bounded tool-error classes only — never freeform tool prose in ledger payloads. */
export type ToolErrorClass =
  | 'string_not_found'
  | 'timeout'
  | 'rate_limit'
  | 'permission_denied'
  | 'not_found'
  | 'tool_error';

/**
 * Map a tool error string to a generic class. Used so harness.action never
 * stores raw result.error (which can embed oldString / secrets).
 */
export function classifyToolError(error: unknown): ToolErrorClass | undefined {
  if (error == null) return undefined;
  const msg = String(error).trim();
  if (!msg) return undefined;
  const lower = msg.toLowerCase();
  if (lower.includes('string not found')) return 'string_not_found';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
  if (lower.includes('rate limit')) return 'rate_limit';
  if (
    lower.includes('permission')
    || lower.includes('eacces')
    || lower.includes('eperm')
    || /\bdenied\b/.test(lower)
  ) {
    return 'permission_denied';
  }
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('no such file')) {
    return 'not_found';
  }
  return 'tool_error';
}

/**
 * Secret-like key names: compound tokens after normalizing case/dash/underscore.
 * Matches openaiApiKey, bearerToken, authHeader, client_secret, …
 */
function isSecretKeyName(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const joined = tokens.join('');
  // Contains-match after strip (apiKey, clientSecret, …)
  if (/key|token|secret|password|credential/.test(joined)) return true;
  // Whole-token auth/bearer so authHeader redacts without matching "author"
  return tokens.some(t => t === 'auth' || t === 'authorization' || t === 'bearer');
}

export function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = isSecretKeyName(key) ? '[redacted]' : redactSecrets(val);
  }
  return out;
}

export function resolveEventLedgerBaseDir(options: EventLedgerOptions = {}): string {
  if (options.baseDir) return path.resolve(options.baseDir);
  const env = options.env ?? process.env;
  const configured = env[EVENT_LEDGER_PATH_ENV]?.trim();
  if (configured) return path.resolve(options.cwd ?? process.cwd(), configured);
  return path.join(options.home ?? os.homedir(), '.sinter', 'telemetry', 'events');
}

/** Resolve the JSONL path for a lane+day (or explicit filePath). */
export function resolveEventLedgerPath(
  eventName: string,
  options: EventLedgerOptions = {},
): string {
  if (options.filePath) return path.resolve(options.filePath);
  const base = resolveEventLedgerBaseDir(options);
  const lane = laneForEvent(eventName);
  const day = options.day ?? new Date().toISOString().slice(0, 10);
  return path.join(base, lane, `${day}.jsonl`);
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createSinterEvent(input: SinterEventInput): SinterEvent {
  if (!input.event || typeof input.event !== 'string' || !input.event.trim()) {
    throw new Error('SinterEvent.event is required');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('SinterEvent.payload must be a non-null object');
  }
  if (input.latencyMs !== null && input.latencyMs !== undefined && !Number.isFinite(input.latencyMs)) {
    throw new Error('SinterEvent.latencyMs must be finite or null');
  }
  if (input.costUsd !== null && input.costUsd !== undefined && !Number.isFinite(input.costUsd)) {
    throw new Error('SinterEvent.costUsd must be finite or null');
  }
  if (!Array.isArray(input.evidenceRefs)) {
    throw new Error('SinterEvent.evidenceRefs must be an array');
  }
  if (!input.evidenceRefs.every(ref => typeof ref === 'string')) {
    throw new Error('SinterEvent.evidenceRefs must contain only strings');
  }
  if (input.inputHash !== null && input.inputHash !== undefined) {
    if (typeof input.inputHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.inputHash)) {
      throw new Error('SinterEvent.inputHash must be null or sha256:<64 hex>');
    }
  }

  return {
    schemaVersion: EVENT_LEDGER_SCHEMA_VERSION,
    ts: input.ts ?? new Date().toISOString(),
    event: input.event.trim(),
    model: normalizeNullable(input.model),
    provider: normalizeNullable(input.provider),
    role: normalizeNullable(input.role),
    runId: normalizeNullable(input.runId),
    episodeId: normalizeNullable(input.episodeId),
    domain: normalizeNullable(input.domain),
    inputHash: input.inputHash ?? null,
    verdict: normalizeNullable(input.verdict),
    latencyMs: input.latencyMs ?? null,
    costUsd: input.costUsd ?? null,
    evidenceRefs: [...input.evidenceRefs],
    payload: input.payload as Record<string, unknown>,
  };
}

export function isSinterEvent(value: unknown): value is SinterEvent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SinterEvent>;
  const nullOrString = (v: unknown): boolean =>
    v === null || (typeof v === 'string' && v.length > 0);
  const nullOrNumber = (v: unknown): boolean =>
    v === null || (typeof v === 'number' && Number.isFinite(v));
  const hashOk = row.inputHash === null
    || (typeof row.inputHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(row.inputHash));
  return row.schemaVersion === EVENT_LEDGER_SCHEMA_VERSION
    && typeof row.ts === 'string'
    && typeof row.event === 'string'
    && row.event.length > 0
    && nullOrString(row.model)
    && nullOrString(row.provider)
    && nullOrString(row.role)
    && nullOrString(row.runId)
    && nullOrString(row.episodeId)
    && nullOrString(row.domain)
    && hashOk
    && nullOrString(row.verdict)
    && nullOrNumber(row.latencyMs)
    && nullOrNumber(row.costUsd)
    && Array.isArray(row.evidenceRefs)
    && row.evidenceRefs.every(ref => typeof ref === 'string')
    && !!row.payload
    && typeof row.payload === 'object'
    && !Array.isArray(row.payload);
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      return async () => {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for event ledger lock: ${lockPath}`);
      }
      await sleep(10);
    }
  }
}

async function rotateIfNeeded(
  filePath: string,
  incomingBytes: number,
  maxBytes: number,
  maxArchives: number,
): Promise<void> {
  const active = await stat(filePath).catch(() => null);
  if (!active || active.size === 0 || active.size + incomingBytes <= maxBytes) return;
  if (maxArchives < 1) {
    await unlink(filePath);
    return;
  }
  await unlink(`${filePath}.${maxArchives}`).catch(() => undefined);
  for (let index = maxArchives - 1; index >= 1; index -= 1) {
    await rename(`${filePath}.${index}`, `${filePath}.${index + 1}`).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  await rename(filePath, `${filePath}.1`);
}

export class EventLedger {
  constructor(private readonly options: EventLedgerOptions = {}) {}

  /**
   * Validate and append one event. Fills schemaVersion + ts.
   * Fail-closed: malformed input throws; no partial write.
   */
  async record(input: SinterEventInput): Promise<{ filePath: string; event: SinterEvent } | null> {
    const env = this.options.env ?? process.env;
    const explicitTestPath = this.options.filePath
      ?? this.options.baseDir
      ?? env[EVENT_LEDGER_PATH_ENV];
    const forceInTest = this.options.forceInTest
      || env[EVENT_LEDGER_FORCE_ENV] === '1'
      || env[EVENT_LEDGER_FORCE_ENV] === 'true';
    // NODE_ENV=test skips home writes unless path/force override is set.
    if (process.env.NODE_ENV === 'test' && !explicitTestPath && !forceInTest) return null;

    const event = createSinterEvent(input);
    const filePath = resolveEventLedgerPath(event.event, this.options);
    await mkdir(path.dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(event)}\n`;
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (maxBytes < 1 || Buffer.byteLength(line) > maxBytes) {
      throw new Error('Event ledger entry exceeds the configured retention size');
    }
    const release = await acquireLock(`${filePath}.lock`, this.options.lockTimeoutMs ?? 5_000);
    try {
      await rotateIfNeeded(
        filePath,
        Buffer.byteLength(line),
        maxBytes,
        this.options.maxArchives ?? DEFAULT_MAX_ARCHIVES,
      );
      const handle = await open(filePath, 'a');
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      await release();
    }
    return { filePath, event };
  }
}

/** Module-level convenience using process env / default home. */
const defaultLedger = new EventLedger();

export async function recordEvent(
  input: SinterEventInput,
  options?: EventLedgerOptions,
): Promise<{ filePath: string; event: SinterEvent } | null> {
  if (options) return new EventLedger(options).record(input);
  return defaultLedger.record(input);
}

async function readEventFile(
  filePath: string,
): Promise<{ events: SinterEvent[]; malformedCount: number }> {
  const body = await readFile(filePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const events: SinterEvent[] = [];
  let malformedCount = 0;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSinterEvent(parsed)) events.push(parsed);
      else malformedCount += 1;
    } catch {
      malformedCount += 1;
    }
  }
  return { events, malformedCount };
}

/**
 * Read ledger events from a single file (and its rotation archives).
 */
export async function readEventsFromFile(
  filePath: string,
  options: { maxArchives?: number } = {},
): Promise<{ events: SinterEvent[]; malformedCount: number }> {
  const maxArchives = options.maxArchives ?? DEFAULT_MAX_ARCHIVES;
  const paths: string[] = [];
  for (let index = maxArchives; index >= 1; index -= 1) {
    paths.push(`${filePath}.${index}`);
  }
  paths.push(filePath);
  const parts = await Promise.all(paths.map(readEventFile));
  return {
    events: parts.flatMap(part => part.events),
    malformedCount: parts.reduce((total, part) => total + part.malformedCount, 0),
  };
}

/**
 * Walk a ledger base directory for all lane/day JSONL files (+ archives).
 */
export async function readEventsFromBaseDir(
  baseDir: string,
  options: { maxArchives?: number } = {},
): Promise<{ events: SinterEvent[]; malformedCount: number }> {
  const maxArchives = options.maxArchives ?? DEFAULT_MAX_ARCHIVES;
  const events: SinterEvent[] = [];
  let malformedCount = 0;

  const lanes = await readdir(baseDir, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });

  for (const lane of lanes) {
    if (!lane.isDirectory()) {
      if (lane.isFile() && lane.name.endsWith('.jsonl') && !/\.\d+$/.test(lane.name)) {
        const part = await readEventsFromFile(path.join(baseDir, lane.name), { maxArchives });
        events.push(...part.events);
        malformedCount += part.malformedCount;
      }
      continue;
    }
    const laneDir = path.join(baseDir, lane.name);
    const files = await readdir(laneDir).catch(() => [] as string[]);
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      // Active files are YYYY-MM-DD.jsonl; archives are YYYY-MM-DD.jsonl.N
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || name === 'events.jsonl') {
        const part = await readEventsFromFile(path.join(laneDir, name), { maxArchives });
        events.push(...part.events);
        malformedCount += part.malformedCount;
      }
    }
  }

  return { events, malformedCount };
}

/**
 * Lift a FitnessObservation v1 row into a generation.scored SinterEvent envelope
 * so legacy #397 files are queryable alongside the new ledger.
 * Routes through createSinterEvent + isSinterEvent so invalid lifts never leak.
 */
export function fitnessObservationAsEvent(row: Record<string, unknown>): SinterEvent | null {
  if (row.schemaVersion !== 1) return null;
  if (typeof row.timestamp !== 'string' || typeof row.runId !== 'string') return null;
  if (typeof row.domain !== 'string' || typeof row.score !== 'number') return null;

  const fingerprint = typeof row.sourceFingerprint === 'string' ? row.sourceFingerprint : null;
  const inputHash = fingerprint && /^sha256:[a-f0-9]{64}$/.test(fingerprint)
    ? fingerprint
    : null;

  try {
    const lifted = createSinterEvent({
      ts: row.timestamp,
      event: 'generation.scored',
      model: typeof row.model === 'string' ? row.model : null,
      provider: typeof row.provider === 'string' ? row.provider : null,
      role: 'generator',
      runId: row.runId,
      episodeId: typeof row.episodeId === 'string' ? row.episodeId : null,
      domain: row.domain,
      inputHash,
      verdict: typeof row.honest === 'boolean' ? (row.honest ? 'honest' : 'degraded') : null,
      latencyMs: null,
      costUsd: null,
      evidenceRefs: [],
      payload: row,
    });
    return isSinterEvent(lifted) ? lifted : null;
  } catch {
    return null;
  }
}

export function filterEvents(
  events: SinterEvent[],
  query: EventLedgerQuery = {},
): SinterEvent[] {
  let filtered = events;
  if (query.event) {
    const needle = query.event;
    filtered = filtered.filter(e => e.event === needle || e.event.startsWith(`${needle}.`));
  }
  if (query.model) {
    const model = query.model;
    filtered = filtered.filter(e => e.model === model);
  }
  if (query.role) {
    const role = query.role;
    filtered = filtered.filter(e => e.role === role);
  }
  if (query.since) {
    const since = query.since;
    filtered = filtered.filter(e => e.ts >= since);
  }
  filtered = [...filtered].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (query.limit !== undefined && query.limit >= 0) {
    filtered = filtered.slice(0, query.limit);
  }
  return filtered;
}

/**
 * Query the event ledger and, when present, legacy #397 fitness observation files
 * (lifted as generation.scored payloads).
 */
export async function queryEventLedger(
  query: EventLedgerQuery = {},
  options: EventLedgerOptions & {
    fitnessPath?: string;
    includeLegacyFitness?: boolean;
  } = {},
): Promise<{ events: SinterEvent[]; malformedCount: number }> {
  let events: SinterEvent[] = [];
  let malformedCount = 0;

  if (options.filePath) {
    const part = await readEventsFromFile(options.filePath, {
      maxArchives: options.maxArchives,
    });
    events = part.events;
    malformedCount += part.malformedCount;
  } else {
    const base = resolveEventLedgerBaseDir(options);
    const part = await readEventsFromBaseDir(base, { maxArchives: options.maxArchives });
    events = part.events;
    malformedCount += part.malformedCount;
  }

  const includeLegacy = options.includeLegacyFitness !== false;
  if (includeLegacy) {
    try {
      const { readFitnessObservations } = await import(
        '../quality/FitnessObservationStore.js'
      );
      const fitnessOpts = options.fitnessPath
        ? { filePath: options.fitnessPath }
        : {};
      const shouldRead = options.fitnessPath
        || process.env.NODE_ENV !== 'test'
        || process.env.SINTER_FITNESS_OBSERVATIONS_PATH;
      if (shouldRead) {
        const legacy = await readFitnessObservations(fitnessOpts);
        malformedCount += legacy.malformedCount;
        for (const obs of legacy.observations) {
          const lifted = fitnessObservationAsEvent(obs as unknown as Record<string, unknown>);
          // Fail-closed: only return schema-valid SinterEvents from legacy lift.
          if (lifted && isSinterEvent(lifted)) events.push(lifted);
        }
      }
    } catch {
      // Fitness store unavailable — ledger-only query still works.
    }
  }

  return {
    events: filterEvents(events, query),
    malformedCount,
  };
}
