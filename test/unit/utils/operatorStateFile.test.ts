import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileActivatedKnowledgeStore } from '../../../src/dreaming/research/DreamKnowledgeActivation.js';
import { FileLiminalProductCommandStore } from '../../../src/runtime-core/LiminalProductCommandPort.js';
import { FileLiminalOperationJournal } from '../../../src/runtime-core/LiminalCommandFilePersistence.js';
import { OperatorStateFileCorruptError, parseOperatorStateFile } from '../../../src/utils/operatorStateFile.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function corrupt(name: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opstate-'));
  roots.push(root);
  const file = path.join(root, name);
  writeFileSync(file, '{ truncated');
  return file;
}

describe('operator-owned state files fail with a typed error naming the file', () => {
  it('parseOperatorStateFile names the file and the remedy', () => {
    expect(parseOperatorStateFile('/x/y.json', '{"a":1}')).toEqual({ a: 1 });
    let caught: unknown;
    try { parseOperatorStateFile('/x/y.json', '{ nope'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OperatorStateFileCorruptError);
    expect((caught as Error).message).toContain('/x/y.json');
    expect((caught as Error).message).toMatch(/Restore it from a backup/);
  });
  it('knowledge store', () => {
    const file = corrupt('activated-knowledge.json');
    expect(() => new FileActivatedKnowledgeStore(file).latestActive('visual')).toThrow(file);
  });
  it('product projections store', async () => {
    const file = corrupt('product-projections.json');
    await expect(new FileLiminalProductCommandStore(file).read('k')).rejects.toMatchObject({
      code: 'OPERATOR_STATE_FILE_CORRUPT', cause: expect.any(OperatorStateFileCorruptError), message: expect.stringContaining(file),
    });
  });
  it('operation journal', async () => {
    const file = corrupt('operation-journal.json');
    const journal = new FileLiminalOperationJournal(file);
    await expect(journal.readAdmission('k')).rejects.toThrow(/OPERATOR_STATE_FILE_CORRUPT/);
  });
});
