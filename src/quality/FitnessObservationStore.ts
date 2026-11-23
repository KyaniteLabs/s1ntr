import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isEvaluationDegraded, isHonestFitnessScore } from '../core/fitnessHonesty.js';
import type { LoopResult } from '../core/LoopConfig.js';

export const FITNESS_OBSERVATION_SCHEMA_VERSION = 1;
export const FITNESS_OBSERVATION_PATH_ENV = 'SINTER_FITNESS_OBSERVATIONS_PATH';
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVES = 3;
const LOCK_STALE_MS = 60_000;

export type FitnessFailureClass = NonNullable<LoopResult['evaluationFailureClass']>;
export type FitnessCohort = 'control' | 'treatment';
export type FitnessScoreState = 'scored' | 'unscored';
const FITNESS_FAILURE_CLASSES = new Set<FitnessFailureClass>([
  'none',
  'render',
  'validator',
  'parse',
  'scorer',
  'infra',
  'legacy',
]);

export interface FitnessObservationInput {
  runId: string;
  episodeId?: string;
  domain: string;
  provider?: string;
  model?: string;
  sourceCode: string;
  score: number;
  confidence: number;
  failureClass: FitnessFailureClass;
  activeAdaptationIds?: string[];
  timestamp?: string;
  /** Wall time of the run that produced this observation, in ms. */
  durationMs?: number;
}

export interface FitnessObservation {
  schemaVersion: 1;
  timestamp: string;
  runId: string;
  episodeId: string | null;
  domain: string;
  provider: string | null;
  model: string | null;
  sourceFingerprint: string;
  score: number;
  confidence: number;
  failureClass: FitnessFailureClass;
  /**
   * 'unscored' when the evaluator produced no evidence (timeout, parse failure,
   * infra, zero confidence): `score` is a placeholder, not a result. Rows written
   * before this field existed omit it.
   */
  scoreState?: FitnessScoreState;
  honest: boolean;
  graduationEligible: boolean;
  activeAdaptationIds: string[];
  cohort: FitnessCohort;
  /** Wall time of the producing run in ms. Rows written before this field existed omit it. */
  durationMs?: number;
}

export interface FitnessObservationStoreOptions {
  filePath?: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  maxArchives?: number;
  lockTimeoutMs?: number;
  /** Durable producers may record once per stable run ID within the retained log. */
  uniqueRunId?: boolean;
}

export interface FitnessObservationGroup {
  count: number;
  honestCount: number;
  graduationEligibleCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** One provider/model seat's own record on one medium: evidence for the operator, never a switch. */
export interface FitnessSeatMediumStats {
  /** Observations that carry real evaluator evidence (scoreState is not 'unscored'). */
  scoredCount: number;
  meanScore: number | null;
  /** Observations whose failureClass is not 'none'. */
  failureCount: number;
  totalCount: number;
  /** Mean wall time over runs that recorded it; null when none did. */
  meanDurationMs: number | null;
}

export interface FitnessObservationReport extends FitnessObservationGroup {
  malformedCount: number;
  /** medium -> "provider/model" -> the user's own outcomes (scores, failures, wall time). */
  byMediumSeat: Record<string, Record<string, FitnessSeatMediumStats>>;
  /** medium -> seat with the highest mean score over at least `minScored` scored runs (null when none qualifies). */
  bestSeatByMedium: Record<string, string | null>;
  byDomain: Record<string, FitnessObservationGroup>;
  byModel: Record<string, FitnessObservationGroup>;
  byCohort: Record<FitnessCohort, FitnessObservationGroup>;
}

/** A seat needs this many scored runs on a medium before it is named best (evidence, not a switch). */
const MIN_SCORED_FOR_BEST = 3;

const EMPTY_GROUP = (): FitnessObservationGroup => ({
  count: 0,
  honestCount: 0,
  graduationEligibleCount: 0,
  firstSeen: null,
  lastSeen: null,
});

export function resolveFitnessObservationPath(options: FitnessObservationStoreOptions = {}): string {
  if (options.filePath) return path.resolve(options.filePath);
  const env = options.env ?? process.env;
  const configured = env[FITNESS_OBSERVATION_PATH_ENV]?.trim();
  if (configured) return path.resolve(options.cwd ?? process.cwd(), configured);
  return path.join(options.home ?? os.homedir(), '.sinter', 'quality', 'fitness-observations.jsonl');
}

function normalizeLabel(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized !== 'unknown' && normalized !== 'auto' ? normalized : null;
}

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map(id => id.trim()).filter(Boolean))].sort();
}

/** Unscored = the evaluator gave no evidence; reuses the shared degraded-evaluation rule. */
function scoreStateFor(confidence: number, failureClass: FitnessFailureClass): FitnessScoreState {
  return isEvaluationDegraded(confidence, failureClass) ? 'unscored' : 'scored';
}

export function createFitnessObservation(input: FitnessObservationInput): FitnessObservation {
  if (!input.runId.trim()) throw new Error('Fitness observation runId is required');
  if (!FITNESS_FAILURE_CLASSES.has(input.failureClass)) {
    throw new Error(`Unsupported fitness failure class: ${input.failureClass}`);
  }
  if (!Number.isFinite(input.score)) throw new Error('Fitness observation score must be finite');
  if (!Number.isFinite(input.confidence)) {
    throw new Error('Fitness observation confidence must be finite');
  }
  const provider = normalizeLabel(input.provider);
  const model = normalizeLabel(input.model);
  const activeAdaptationIds = uniqueIds(input.activeAdaptationIds);
  const honest = isHonestFitnessScore(input.confidence, input.failureClass);
  return {
    schemaVersion: FITNESS_OBSERVATION_SCHEMA_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
    runId: input.runId,
    episodeId: normalizeLabel(input.episodeId),
    domain: normalizeLabel(input.domain) ?? 'unknown',
    provider,
    model,
    sourceFingerprint: `sha256:${createHash('sha256').update(input.sourceCode).digest('hex')}`,
    score: input.score,
    confidence: input.confidence,
    failureClass: input.failureClass,
    scoreState: scoreStateFor(input.confidence, input.failureClass),
    honest,
    graduationEligible: honest && provider !== null && model !== null,
    activeAdaptationIds,
    cohort: activeAdaptationIds.length > 0 ? 'treatment' : 'control',
    ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? { durationMs: Math.round(input.durationMs) } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        throw new Error(`Timed out waiting for fitness observation lock: ${lockPath}`);
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

export async function appendFitnessObservation(
  input: FitnessObservationInput,
  options: FitnessObservationStoreOptions = {},
): Promise<{ filePath: string; observation: FitnessObservation } | null> {
  const explicitTestPath = options.filePath
    ?? (options.env ?? process.env)[FITNESS_OBSERVATION_PATH_ENV];
  if (process.env.NODE_ENV === 'test' && !explicitTestPath) return null;
  const filePath = resolveFitnessObservationPath(options);
  await mkdir(path.dirname(filePath), { recursive: true });
  const observation = createFitnessObservation(input);
  const line = `${JSON.stringify(observation)}\n`;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (maxBytes < 1 || Buffer.byteLength(line) > maxBytes) {
    throw new Error('Fitness observation exceeds the configured retention size');
  }
  const release = await acquireLock(`${filePath}.lock`, options.lockTimeoutMs ?? 5_000);
  try {
    if (options.uniqueRunId) {
      const { observations } = await readFitnessObservations(options);
      const prior = observations.find(row => row.runId === observation.runId);
      if (prior) return { filePath, observation: prior };
    }
    await rotateIfNeeded(
      filePath,
      Buffer.byteLength(line),
      maxBytes,
      options.maxArchives ?? DEFAULT_MAX_ARCHIVES,
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
  return { filePath, observation };
}

function isFitnessObservation(value: unknown): value is FitnessObservation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<FitnessObservation>;
  const episodeValid = row.episodeId === null
    || (typeof row.episodeId === 'string' && row.episodeId.length > 0);
  const providerValid = row.provider === null
    || (typeof row.provider === 'string' && row.provider.length > 0);
  const modelValid = row.model === null
    || (typeof row.model === 'string' && row.model.length > 0);
  const adaptationsValid = Array.isArray(row.activeAdaptationIds)
    && row.activeAdaptationIds.every(id => typeof id === 'string' && id.length > 0)
    && new Set(row.activeAdaptationIds).size === row.activeAdaptationIds.length;
  if (
    typeof row.confidence !== 'number'
    || !FITNESS_FAILURE_CLASSES.has(row.failureClass as FitnessFailureClass)
  ) return false;
  const honest = isHonestFitnessScore(row.confidence, row.failureClass as FitnessFailureClass);
  const eligible = honest && typeof row.provider === 'string' && typeof row.model === 'string';
  const cohort = row.activeAdaptationIds?.length ? 'treatment' : 'control';
  // Rows from before scoreState existed omit it; a present value must match the evidence.
  const scoreStateValid = row.scoreState === undefined
    || row.scoreState === scoreStateFor(row.confidence, row.failureClass as FitnessFailureClass);
  return scoreStateValid
    && row.schemaVersion === FITNESS_OBSERVATION_SCHEMA_VERSION
    && typeof row.timestamp === 'string'
    && typeof row.runId === 'string'
    && typeof row.domain === 'string'
    && typeof row.sourceFingerprint === 'string'
    && typeof row.score === 'number'
    && episodeValid
    && providerValid
    && modelValid
    && /^sha256:[a-f0-9]{64}$/.test(row.sourceFingerprint)
    && row.honest === honest
    && row.graduationEligible === eligible
    && adaptationsValid
    && (row.durationMs === undefined || (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0))
    && row.cohort === cohort;
}

async function readObservationFile(
  filePath: string,
): Promise<{ observations: FitnessObservation[]; malformedCount: number }> {
  const body = await readFile(filePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const observations: FitnessObservation[] = [];
  let malformedCount = 0;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isFitnessObservation(parsed)) observations.push(parsed);
      else malformedCount += 1;
    } catch {
      malformedCount += 1;
    }
  }
  return { observations, malformedCount };
}

export async function readFitnessObservations(
  options: FitnessObservationStoreOptions = {},
): Promise<{ observations: FitnessObservation[]; malformedCount: number }> {
  const filePath = resolveFitnessObservationPath(options);
  const maxArchives = options.maxArchives ?? DEFAULT_MAX_ARCHIVES;
  const paths: string[] = [];
  for (let index = maxArchives; index >= 1; index -= 1) {
    paths.push(`${filePath}.${index}`);
  }
  paths.push(filePath);
  const parts = await Promise.all(paths.map(readObservationFile));
  return {
    observations: parts.flatMap(part => part.observations),
    malformedCount: parts.reduce((total, part) => total + part.malformedCount, 0),
  };
}

function addToGroup(group: FitnessObservationGroup, observation: FitnessObservation): void {
  group.count += 1;
  if (observation.honest) group.honestCount += 1;
  if (observation.graduationEligible) group.graduationEligibleCount += 1;
  if (group.firstSeen === null || observation.timestamp < group.firstSeen) {
    group.firstSeen = observation.timestamp;
  }
  if (group.lastSeen === null || observation.timestamp > group.lastSeen) {
    group.lastSeen = observation.timestamp;
  }
}

function groupFor(
  groups: Record<string, FitnessObservationGroup>,
  key: string,
): FitnessObservationGroup {
  return groups[key] ?? (groups[key] = EMPTY_GROUP());
}

export function aggregateFitnessObservations(
  observations: FitnessObservation[],
  malformedCount = 0,
): FitnessObservationReport {
  const report: FitnessObservationReport = {
    ...EMPTY_GROUP(),
    malformedCount,
    byMediumSeat: {},
    bestSeatByMedium: {},
    byDomain: {},
    byModel: {},
    byCohort: { control: EMPTY_GROUP(), treatment: EMPTY_GROUP() },
  };
  const durationCounts = new Map<FitnessSeatMediumStats, number>();
  for (const observation of observations) {
    addToGroup(report, observation);
    addToGroup(groupFor(report.byDomain, observation.domain), observation);
    const lane = `${observation.provider ?? 'unattributed'}/${observation.model ?? 'unattributed'}`;
    addToGroup(groupFor(report.byModel, lane), observation);
    addToGroup(report.byCohort[observation.cohort], observation);
    const seats = report.byMediumSeat[observation.domain] ?? (report.byMediumSeat[observation.domain] = {});
    const seat = seats[lane] ?? (seats[lane] = { scoredCount: 0, meanScore: null, failureCount: 0, totalCount: 0, meanDurationMs: null });
    seat.totalCount += 1;
    if (observation.failureClass !== 'none') seat.failureCount += 1;
    if (typeof observation.durationMs === 'number') {
      const n = durationCounts.get(seat) ?? 0;
      seat.meanDurationMs = ((seat.meanDurationMs ?? 0) * n + observation.durationMs) / (n + 1);
      durationCounts.set(seat, n + 1);
    }
    if (observation.scoreState !== 'unscored') {
      seat.meanScore = ((seat.meanScore ?? 0) * seat.scoredCount + observation.score) / (seat.scoredCount + 1);
      seat.scoredCount += 1;
    }
  }
  for (const [medium, seats] of Object.entries(report.byMediumSeat)) {
    let best: string | null = null;
    for (const [lane, seat] of Object.entries(seats)) {
      if (seat.scoredCount < MIN_SCORED_FOR_BEST || seat.meanScore === null) continue;
      if (best === null || seat.meanScore > (seats[best]?.meanScore ?? -Infinity)) best = lane;
    }
    report.bestSeatByMedium[medium] = best;
  }
  return report;
}

export async function buildFitnessObservationReport(
  options: FitnessObservationStoreOptions = {},
): Promise<FitnessObservationReport> {
  const { observations, malformedCount } = await readFitnessObservations(options);
  return aggregateFitnessObservations(observations, malformedCount);
}
