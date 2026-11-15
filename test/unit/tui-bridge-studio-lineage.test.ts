import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StudioLineageError,
  StudioLineageLedger,
  STUDIO_LINEAGE_STAGES,
  migrateStudioLineageRecord,
} from '../../src/tui-bridge/StudioLineage.js';

describe('StudioLineageLedger', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function ledger() {
    const dir = await mkdtemp(join(tmpdir(), 'sinter-lineage-'));
    tempDirs.push(dir);
    const ledgerPath = join(dir, 'studio-lineage.jsonl');
    return {
      ledgerPath,
      value: new StudioLineageLedger({
        ledgerPath,
        now: () => '2026-07-30T00:00:00.000Z',
      }),
    };
  }

  it('queries one immutable lineage across every Wave 5 stage', async () => {
    const { value } = await ledger();
    await value.start({
      lineageId: 'run-1',
      sessionId: 'session-1',
      origin: 'studio',
      payload: { domain: 'p5' },
    });
    for (const stage of STUDIO_LINEAGE_STAGES.filter((item) => item !== 'origin')) {
      await value.append('run-1', {
        stage,
        status: stage === 'reaction' ? 'pending' : 'observed',
        origin: `test-${stage}`,
        trust: stage === 'reaction' ? 'owner' : 'verified-system',
        corroboration: [`receipt:${stage}`],
        payload: { stage },
      });
    }

    const trace = await value.query('run-1');
    expect(trace.lineageId).toBe('run-1');
    expect(trace.sessionId).toBe('session-1');
    expect(trace.records.map((record) => record.stage)).toEqual(STUDIO_LINEAGE_STAGES);
    expect(trace.records.every((record) => record.schemaValid)).toBe(true);
    expect(trace.records.every((record) => /^[a-f0-9]{64}$/.test(record.digest))).toBe(true);
  });

  it('redacts secrets and home paths before hashing and persistence', async () => {
    const { value } = await ledger();
    const record = await value.start({
      lineageId: 'run-secret',
      sessionId: 'session-secret',
      origin: 'studio',
      payload: {
        apiKey: 'sk-not-for-the-ledger-123456',
        authorization: 'Bearer private-token',
        artifactPath: `${process.env.HOME}/private/artifact.js`,
      },
    });

    expect(record.payload.apiKey).toBe('[REDACTED]');
    expect(record.payload.authorization).toBe('[REDACTED]');
    expect(record.payload.artifactPath).toBe('$HOME/private/artifact.js');
  });

  it('hashes the JSON-persisted shape when optional payload fields are undefined', async () => {
    const { value } = await ledger();
    await value.start({
      lineageId: 'run-optional',
      sessionId: 'session-optional',
      origin: 'studio',
    });
    await value.append('run-optional', {
      stage: 'follow-up',
      status: 'unavailable',
      origin: 'wave6-causal-package',
      trust: 'verified-system',
      payload: {
        recipeDigest: 'a'.repeat(64),
        candidateReceiptDigest: undefined,
        error: 'CAUSAL_CANDIDATE_EFFECT_INSUFFICIENT',
      },
    });

    const trace = await value.query('run-optional');
    expect(trace.records[1].payload).toEqual({
      recipeDigest: 'a'.repeat(64),
      error: 'CAUSAL_CANDIDATE_EFFECT_INSUFFICIENT',
    });
  });

  it('denies lineage reminting and appending to an unknown lineage', async () => {
    const { value } = await ledger();
    const start = {
      lineageId: 'run-fixed',
      sessionId: 'session-fixed',
      origin: 'studio',
    };
    await value.start(start);

    await expect(value.start(start)).rejects.toMatchObject<Partial<StudioLineageError>>({
      code: 'LINEAGE_REMINT_DENIED',
    });
    await expect(value.append('missing', {
      stage: 'artifact',
      status: 'observed',
      origin: 'studio-generator',
      trust: 'model-inference',
    })).rejects.toMatchObject<Partial<StudioLineageError>>({ code: 'UNKNOWN_LINEAGE' });
  });

  it('fails closed when a persisted record digest no longer matches', async () => {
    const { value, ledgerPath } = await ledger();
    const record = await value.start({
      lineageId: 'run-tampered',
      sessionId: 'session-tampered',
      origin: 'studio',
    });
    await appendFile(ledgerPath, `${JSON.stringify({
      ...record,
      recordId: 'run-tampered:0002',
      sequence: 2,
      stage: 'artifact',
    })}\n`, 'utf8');

    await expect(value.query('run-tampered')).rejects.toMatchObject<Partial<StudioLineageError>>({
      code: 'LINEAGE_DIGEST_MISMATCH',
    });
  });

  it('migrates the registered v0 shape and rejects unknown schema versions', () => {
    const migrated = migrateStudioLineageRecord({
      schemaVersion: 0,
      lineageId: 'legacy-run',
      recordId: 'legacy-run:0001',
      sequence: 1,
      sessionId: 'legacy-session',
      stage: 'origin',
      status: 'observed',
      origin: 'studio',
      trustClass: 'owner',
      tainted: false,
      createdAt: '2026-07-30T00:00:00.000Z',
      payload: { domain: 'svg' },
    });

    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.payload.migratedFromSchemaVersion).toBe(0);
    expect(() => migrateStudioLineageRecord({ schemaVersion: 99 })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_LINEAGE_SCHEMA' }),
    );
  });
});
