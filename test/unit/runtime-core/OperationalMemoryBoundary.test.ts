import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileOperationalMemoryBoundary } from
  '../../../src/runtime-core/OperationalMemoryBoundary.js';

describe('operational memory boundary', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));

  it('keeps diagnostic history queryable and byte-exact across restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'operational-memory-'));
    roots.push(root);
    const file = path.join(root, 'boundary.json');
    const bytes = Buffer.from('{"version":2,"episodes":[{"status":"failed"}]}');
    const first = new FileOperationalMemoryBoundary(file);
    const record = await first.preserve(bytes, 'harness-memory-v2');
    expect(record.classification).toBe('operational-read-only');
    const resumed = new FileOperationalMemoryBoundary(file);
    expect(await resumed.readBytes(record.digest)).toEqual(bytes);
    expect(await resumed.queryDiagnostics('failed')).toHaveLength(1);
  });

  it('quarantines unknown schemas without deleting or promoting them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'operational-memory-'));
    roots.push(root);
    const boundary = new FileOperationalMemoryBoundary(path.join(root, 'boundary.json'));
    const bytes = Buffer.from('unknown raw bytes');
    const record = await boundary.preserve(bytes, 'unknown-v99');
    expect(record.classification).toBe('quarantined');
    expect(await boundary.readBytes(record.digest)).toEqual(bytes);
    expect(await boundary.queryDiagnostics('unknown')).toEqual([]);
    expect(boundary.creativeTeachingAuthority).toBe(false);
  });

  it('keeps one operational writer after cutover and projection rollback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'operational-memory-'));
    roots.push(root);
    const boundary = new FileOperationalMemoryBoundary(path.join(root, 'boundary.json'));
    await boundary.preserve(Buffer.from('{"version":2}'), 'harness-memory-v2');
    const receipt = await boundary.rollbackProjection('inspect historical bytes');
    expect(receipt.activeWriter).toBe('operational-memory-v1');
    expect(receipt.legacyWriterRestored).toBe(false);
    expect(receipt.readOnlyProjectionCount).toBe(1);
  });
});
