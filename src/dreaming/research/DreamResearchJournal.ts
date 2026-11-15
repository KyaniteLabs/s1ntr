import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppendDreamResearchEvent, DreamResearchEvent } from './DreamResearchTypes.js';
import { reduceDreamResearch } from './DreamResearchReducer.js';
import type { DreamResearchSnapshot } from './DreamResearchTypes.js';

const ZERO_DIGEST = '0'.repeat(64);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

interface EventRow {
  aggregate_id: string;
  revision: number;
  command_id: string;
  event_type: DreamResearchEvent['type'];
  payload_json: string;
  previous_digest: string;
  event_digest: string;
  created_at: string;
}

export class DreamResearchJournal {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_research_events (
      aggregate_id TEXT NOT NULL, revision INTEGER NOT NULL,
      command_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL, previous_digest TEXT NOT NULL,
      event_digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      PRIMARY KEY (aggregate_id, revision));
      CREATE TABLE IF NOT EXISTS dream_research_projections (
        aggregate_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dream_research_outbox (
        event_digest TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL,
        revision INTEGER NOT NULL, published_at TEXT);
      CREATE TABLE IF NOT EXISTS dream_operation_results (
        operation_id TEXT PRIMARY KEY, response_json TEXT NOT NULL,
        response_digest TEXT NOT NULL);`);
  }

  append(input: AppendDreamResearchEvent): DreamResearchEvent {
    return this.db.transaction(() => {
      const existing = this.byCommand(input.commandId);
      if (existing) {
        if (existing.aggregateId !== input.aggregateId || existing.type !== input.type
          || canonical(existing.payload) !== canonical(input.payload)) {
          throw new Error('DREAM_JOURNAL_COMMAND_CONFLICT');
        }
        return existing;
      }
      const latest = this.latest(input.aggregateId);
      const revision = latest?.revision ?? 0;
      if (revision !== input.expectedRevision) {
        throw new Error('DREAM_JOURNAL_REVISION_CONFLICT');
      }
      const previousDigest = latest?.eventDigest ?? ZERO_DIGEST;
      const createdAt = new Date().toISOString();
      const body = { aggregateId: input.aggregateId, revision: revision + 1,
        commandId: input.commandId, type: input.type, payload: input.payload,
        previousDigest, createdAt };
      const event: DreamResearchEvent = Object.freeze({ ...body, eventDigest: digest(body) });
      this.db.prepare(`INSERT INTO dream_research_events
        (aggregate_id, revision, command_id, event_type, payload_json,
         previous_digest, event_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.aggregateId, event.revision, event.commandId, event.type,
        canonical(event.payload), event.previousDigest, event.eventDigest, event.createdAt,
      );
      this.rebuildProjection(input.aggregateId);
      this.db.prepare(`INSERT OR IGNORE INTO dream_research_outbox
        (event_digest, aggregate_id, revision) VALUES (?, ?, ?)`)
        .run(event.eventDigest, event.aggregateId, event.revision);
      return event;
    })();
  }

  events(aggregateId: string): DreamResearchEvent[] {
    const rows = this.db.prepare(`SELECT * FROM dream_research_events
      WHERE aggregate_id = ? ORDER BY revision ASC`).all(aggregateId) as EventRow[];
    const events = rows.map(row => this.fromRow(row));
    for (let index = 0; index < events.length; index++) {
      const expected = index === 0 ? ZERO_DIGEST : events[index - 1].eventDigest;
      if (events[index].previousDigest !== expected) {
        throw new Error('DREAM_JOURNAL_CHAIN_INVALID');
      }
    }
    return events;
  }

  latest(aggregateId: string): DreamResearchEvent | null {
    const row = this.db.prepare(`SELECT * FROM dream_research_events
      WHERE aggregate_id = ? ORDER BY revision DESC LIMIT 1`).get(aggregateId) as EventRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  byCommand(commandId: string): DreamResearchEvent | null {
    const row = this.db.prepare(`SELECT * FROM dream_research_events
      WHERE command_id = ?`).get(commandId) as EventRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  aggregates(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT aggregate_id
      FROM dream_research_events ORDER BY aggregate_id`).all() as Array<{ aggregate_id: string }>;
    return rows.map(row => row.aggregate_id);
  }

  projection(aggregateId: string): DreamResearchSnapshot {
    const row = this.db.prepare(`SELECT snapshot_json, snapshot_digest
      FROM dream_research_projections WHERE aggregate_id = ?`).get(aggregateId) as
      { snapshot_json: string; snapshot_digest: string } | undefined;
    if (row && digest(JSON.parse(row.snapshot_json)) === row.snapshot_digest) {
      return Object.freeze(JSON.parse(row.snapshot_json) as DreamResearchSnapshot);
    }
    return this.rebuildProjection(aggregateId);
  }

  pendingOutbox(): Array<{ eventDigest: string; aggregateId: string; revision: number }> {
    const rows = this.db.prepare(`SELECT event_digest, aggregate_id, revision
      FROM dream_research_outbox WHERE published_at IS NULL ORDER BY rowid`).all() as
      Array<{ event_digest: string; aggregate_id: string; revision: number }>;
    return rows.map(row => ({ eventDigest: row.event_digest,
      aggregateId: row.aggregate_id, revision: row.revision }));
  }

  markPublished(eventDigest: string): void {
    this.db.prepare(`UPDATE dream_research_outbox SET published_at = ?
      WHERE event_digest = ?`).run(new Date().toISOString(), eventDigest);
  }

  persistOperationResult(operationId: string, response: unknown): string {
    const responseJson = canonical(response);
    const responseDigest = digest(JSON.parse(responseJson));
    this.db.prepare(`INSERT INTO dream_operation_results
      (operation_id, response_json, response_digest) VALUES (?, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING`).run(operationId, responseJson, responseDigest);
    const stored = this.db.prepare(`SELECT response_json, response_digest
      FROM dream_operation_results WHERE operation_id = ?`).get(operationId) as
      { response_json: string; response_digest: string };
    if (stored.response_digest !== responseDigest || stored.response_json !== responseJson) {
      throw new Error('DREAM_OPERATION_RESULT_CONFLICT');
    }
    return responseDigest;
  }

  /** Atomically persists an effect result and its terminal event for restart replay. */
  completeOperation(input: Omit<AppendDreamResearchEvent, 'type' | 'payload'> & {
    operationId: string; response: unknown }): string {
    return this.db.transaction(() => {
      const responseDigest = this.persistOperationResult(input.operationId, input.response);
      this.append({ aggregateId: input.aggregateId, expectedRevision: input.expectedRevision,
        commandId: input.commandId, type: 'operation-completed',
        payload: { operationId: input.operationId, responseDigest } });
      return responseDigest;
    })();
  }

  operationResult<T>(operationId: string, expectedDigest: string): T {
    const stored = this.db.prepare(`SELECT response_json, response_digest
      FROM dream_operation_results WHERE operation_id = ?`).get(operationId) as
      { response_json: string; response_digest: string } | undefined;
    if (!stored || stored.response_digest !== expectedDigest
      || digest(JSON.parse(stored.response_json)) !== expectedDigest) {
      throw new Error('DREAM_OPERATION_RESULT_INVALID');
    }
    return JSON.parse(stored.response_json) as T;
  }

  close(): void {
    this.db.close();
  }

  private rebuildProjection(aggregateId: string): DreamResearchSnapshot {
    const snapshot = reduceDreamResearch(this.events(aggregateId));
    const json = canonical(snapshot);
    this.db.prepare(`INSERT INTO dream_research_projections
      (aggregate_id, revision, snapshot_json, snapshot_digest) VALUES (?, ?, ?, ?)
      ON CONFLICT(aggregate_id) DO UPDATE SET revision=excluded.revision,
      snapshot_json=excluded.snapshot_json, snapshot_digest=excluded.snapshot_digest`)
      .run(aggregateId, snapshot.revision, json, digest(snapshot));
    return Object.freeze(snapshot);
  }

  private fromRow(row: EventRow): DreamResearchEvent {
    const event: DreamResearchEvent = Object.freeze({
      aggregateId: row.aggregate_id, revision: row.revision,
      commandId: row.command_id, type: row.event_type,
      payload: Object.freeze(JSON.parse(row.payload_json) as Record<string, unknown>),
      previousDigest: row.previous_digest, eventDigest: row.event_digest,
      createdAt: row.created_at,
    });
    const { eventDigest: _eventDigest, ...body } = event;
    if (digest(body) !== event.eventDigest) throw new Error('DREAM_JOURNAL_DIGEST_INVALID');
    return event;
  }
}
