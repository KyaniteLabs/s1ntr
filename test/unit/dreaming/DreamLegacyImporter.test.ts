import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DreamLegacyImporter } from '../../../src/dreaming/research/DreamLegacyImporter.js';
import { DreamResearchJournal } from '../../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchService } from '../../../src/dreaming/research/DreamResearchService.js';

describe('DreamLegacyImporter', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));

  it('preserves original bytes and labels known history non-admissible', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-import-')); roots.push(root);
    const source = path.join(root, 'queue.json');
    await writeFile(source, '{"version":1,"tasks":[]}');
    const service = new DreamResearchService(new DreamResearchJournal(path.join(root, 'db.sqlite')),
      { assertActive: () => undefined });
    const receipt = new DreamLegacyImporter(service).importFile(source, 'queue-v1');
    expect(receipt.classification).toBe('historical-non-admissible');
    const imported = service.events(receipt.aggregateId).find(event =>
      event.type === 'historical-imported');
    expect(Buffer.from(imported!.payload.originalBase64 as string, 'base64').toString())
      .toBe('{"version":1,"tasks":[]}');
  });

  it('fails closed on unknown schemas', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-import-')); roots.push(root);
    const source = path.join(root, 'unknown.json'); await writeFile(source, '{}');
    const service = new DreamResearchService(new DreamResearchJournal(path.join(root, 'db.sqlite')),
      { assertActive: () => undefined });
    expect(() => new DreamLegacyImporter(service).importFile(source, 'queue-v99'))
      .toThrow('DREAM_LEGACY_SCHEMA_UNKNOWN');
  });
});
