import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVIDENCE_TRUST_CLASSES,
  type EvidenceTaint,
  type EvidenceTrustClass,
} from '../runtime-core/RecursiveImprovementContract.js';

export const STUDIO_LINEAGE_SCHEMA_VERSION = 1 as const;

export const STUDIO_LINEAGE_STAGES = [
  'origin',
  'artifact',
  'evaluation',
  'reaction',
  'memory',
  'compost',
  'dream',
  'hypothesis',
  'experiment',
  'review',
  'follow-up',
] as const;

export type StudioLineageStage = typeof STUDIO_LINEAGE_STAGES[number];
export type StudioLineageStatus = 'observed' | 'pending' | 'unavailable';

export interface StudioLineageRecord {
  schemaVersion: typeof STUDIO_LINEAGE_SCHEMA_VERSION;
  lineageId: string;
  recordId: string;
  sequence: number;
  sessionId: string;
  stage: StudioLineageStage;
  status: StudioLineageStatus;
  origin: string;
  trust: EvidenceTrustClass;
  digest: string;
  schemaValid: true;
  corroboration: string[];
  taint: EvidenceTaint;
  taintSources: string[];
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface StudioLineageInput {
  stage: StudioLineageStage;
  status: StudioLineageStatus;
  origin: string;
  trust: EvidenceTrustClass;
  corroboration?: string[];
  taint?: EvidenceTaint;
  taintSources?: string[];
  payload?: Record<string, unknown>;
}

export interface StudioLineageStart {
  lineageId: string;
  sessionId: string;
  origin: string;
  payload?: Record<string, unknown>;
}

export interface StudioLineageTrace {
  schemaVersion: typeof STUDIO_LINEAGE_SCHEMA_VERSION;
  lineageId: string;
  sessionId: string;
  records: StudioLineageRecord[];
}

export class StudioLineageError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StudioLineageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StudioLineageError('INVALID_LINEAGE_RECORD', `${field} must be a non-empty string`);
  }
  return value;
}

const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,})/gi;

export function redactStudioLineagePayload(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replaceAll(os.homedir(), '$HOME')
      .replace(SECRET_VALUE, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStudioLineagePayload(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactStudioLineagePayload(childValue, childKey),
      ]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? 'null' : canonical(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function recordDigest(record: Omit<StudioLineageRecord, 'digest'>): string {
  return createHash('sha256').update(canonical(record)).digest('hex');
}

function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new StudioLineageError('INVALID_LINEAGE_RECORD', `${field} is not recognized`);
  }
  return value as T;
}

export function migrateStudioLineageRecord(value: unknown): StudioLineageRecord {
  if (!isRecord(value)) {
    throw new StudioLineageError('INVALID_LINEAGE_RECORD', 'record must be an object');
  }
  if (value.schemaVersion === 0) {
    const legacyPayload = isRecord(value.payload) ? value.payload : {};
    const migrated: Omit<StudioLineageRecord, 'digest'> = {
      schemaVersion: STUDIO_LINEAGE_SCHEMA_VERSION,
      lineageId: requireString(value.lineageId, 'lineageId'),
      recordId: requireString(value.recordId, 'recordId'),
      sequence: Number(value.sequence),
      sessionId: requireString(value.sessionId, 'sessionId'),
      stage: requireMember(value.stage, STUDIO_LINEAGE_STAGES, 'stage'),
      status: requireMember(value.status, ['observed', 'pending', 'unavailable'] as const, 'status'),
      origin: requireString(value.origin, 'origin'),
      trust: requireMember(
        value.trustClass ?? value.trust ?? 'untrusted-external',
        EVIDENCE_TRUST_CLASSES,
        'trust',
      ),
      schemaValid: true as const,
      corroboration: Array.isArray(value.corroboration)
        ? value.corroboration.map((item) => requireString(item, 'corroboration'))
        : [],
      taint: requireMember(
        value.tainted === true ? 'tainted' : (value.taint ?? 'clean'),
        ['clean', 'tainted'] as const,
        'taint',
      ),
      taintSources: Array.isArray(value.taintSources)
        ? value.taintSources.map((item) => requireString(item, 'taintSources'))
        : [],
      createdAt: requireString(value.createdAt, 'createdAt'),
      payload: { ...legacyPayload, migratedFromSchemaVersion: 0 },
    };
    return migrateStudioLineageRecord({
      ...migrated,
      digest: recordDigest(migrated),
    });
  }
  if (value.schemaVersion !== STUDIO_LINEAGE_SCHEMA_VERSION) {
    throw new StudioLineageError(
      'UNSUPPORTED_LINEAGE_SCHEMA',
      `schema version ${String(value.schemaVersion)} has no registered migration`,
    );
  }
  const payload = isRecord(value.payload) ? value.payload : {};
  const record: StudioLineageRecord = {
    schemaVersion: STUDIO_LINEAGE_SCHEMA_VERSION,
    lineageId: requireString(value.lineageId, 'lineageId'),
    recordId: requireString(value.recordId, 'recordId'),
    sequence: Number(value.sequence),
    sessionId: requireString(value.sessionId, 'sessionId'),
    stage: requireMember(value.stage, STUDIO_LINEAGE_STAGES, 'stage'),
    status: requireMember(value.status, ['observed', 'pending', 'unavailable'] as const, 'status'),
    origin: requireString(value.origin, 'origin'),
    trust: requireMember(value.trust, EVIDENCE_TRUST_CLASSES, 'trust'),
    digest: requireString(value.digest, 'digest'),
    schemaValid: true,
    corroboration: Array.isArray(value.corroboration)
      ? value.corroboration.map((item) => requireString(item, 'corroboration'))
      : [],
    taint: requireMember(value.taint, ['clean', 'tainted'] as const, 'taint'),
    taintSources: Array.isArray(value.taintSources)
      ? value.taintSources.map((item) => requireString(item, 'taintSources'))
      : [],
    createdAt: requireString(value.createdAt, 'createdAt'),
    payload,
  };
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) {
    throw new StudioLineageError('INVALID_LINEAGE_RECORD', 'sequence must be a positive integer');
  }
  const { digest, ...unsigned } = record;
  if (recordDigest(unsigned) !== digest) {
    throw new StudioLineageError('LINEAGE_DIGEST_MISMATCH', `record ${record.recordId} was modified`);
  }
  return record;
}

export interface StudioLineageLedgerOptions {
  ledgerPath?: string;
  now?: () => string;
}

export class StudioLineageLedger {
  readonly ledgerPath: string;
  private readonly now: () => string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: StudioLineageLedgerOptions = {}) {
    this.ledgerPath = options.ledgerPath
      ?? process.env.SINTER_STUDIO_LINEAGE_PATH
      ?? path.join(process.cwd(), '.omx', 'lineage', 'studio-lineage.jsonl');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(input: StudioLineageStart): Promise<StudioLineageRecord> {
    return this.serial(async () => {
      const records = await this.readAll();
      if (records.some((record) => record.lineageId === input.lineageId)) {
        throw new StudioLineageError(
          'LINEAGE_REMINT_DENIED',
          `lineage ${input.lineageId} already exists`,
        );
      }
      return this.persist(input.lineageId, input.sessionId, 1, {
        stage: 'origin',
        status: 'observed',
        origin: input.origin,
        trust: 'owner',
        taint: 'clean',
        payload: input.payload,
      });
    });
  }

  async append(lineageId: string, input: StudioLineageInput): Promise<StudioLineageRecord> {
    return this.serial(async () => {
      const records = await this.readAll();
      const lineage = records.filter((record) => record.lineageId === lineageId);
      const origin = lineage.find((record) => record.stage === 'origin');
      if (!origin) {
        throw new StudioLineageError('UNKNOWN_LINEAGE', `lineage ${lineageId} was not started`);
      }
      return this.persist(lineageId, origin.sessionId, lineage.length + 1, input);
    });
  }

  async query(lineageId: string): Promise<StudioLineageTrace> {
    const records = (await this.readAll())
      .filter((record) => record.lineageId === lineageId)
      .sort((left, right) => left.sequence - right.sequence);
    if (records.length === 0) {
      throw new StudioLineageError('UNKNOWN_LINEAGE', `lineage ${lineageId} was not found`);
    }
    const sessionId = records[0].sessionId;
    if (records.some((record) => record.sessionId !== sessionId)) {
      throw new StudioLineageError(
        'LINEAGE_REMINT_DETECTED',
        `lineage ${lineageId} spans multiple sessions`,
      );
    }
    return {
      schemaVersion: STUDIO_LINEAGE_SCHEMA_VERSION,
      lineageId,
      sessionId,
      records,
    };
  }

  private async readAll(): Promise<StudioLineageRecord[]> {
    let content: string;
    try {
      content = await fs.readFile(this.ledgerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return migrateStudioLineageRecord(JSON.parse(line));
      } catch (error) {
        if (error instanceof StudioLineageError) throw error;
        throw new StudioLineageError(
          'INVALID_LINEAGE_JSON',
          `line ${index + 1} is not valid JSON`,
        );
      }
    });
  }

  private async persist(
    lineageId: string,
    sessionId: string,
    sequence: number,
    input: StudioLineageInput,
  ): Promise<StudioLineageRecord> {
    const unsigned: Omit<StudioLineageRecord, 'digest'> = {
      schemaVersion: STUDIO_LINEAGE_SCHEMA_VERSION,
      lineageId: requireString(lineageId, 'lineageId'),
      recordId: `${lineageId}:${String(sequence).padStart(4, '0')}`,
      sequence,
      sessionId: requireString(sessionId, 'sessionId'),
      stage: requireMember(input.stage, STUDIO_LINEAGE_STAGES, 'stage'),
      status: requireMember(input.status, ['observed', 'pending', 'unavailable'] as const, 'status'),
      origin: requireString(input.origin, 'origin'),
      trust: requireMember(input.trust, EVIDENCE_TRUST_CLASSES, 'trust'),
      schemaValid: true,
      corroboration: [...(input.corroboration ?? [])],
      taint: input.taint ?? 'clean',
      taintSources: [...(input.taintSources ?? [])],
      createdAt: this.now(),
      payload: redactStudioLineagePayload(input.payload ?? {}) as Record<string, unknown>,
    };
    const record = { ...unsigned, digest: recordDigest(unsigned) };
    await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await fs.appendFile(this.ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(work, work);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}
