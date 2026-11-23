/**
 * F20: updateConfig reads a snapshot, merges and atomically renames. Atomic rename stops torn JSON but
 * not last-writer loss: two writers that both read before either writes drop one writer's change.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { updateConfig } from '../../../src/config/ConfigLoader.js';

describe('F20: concurrent updateConfig on one file', () => {
  it('keeps every writer\'s disjoint change and leaves no lock behind', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfg-conc-'));
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ providers: { keep: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'untouched' } } }));
    try {
      const writers = Array.from({ length: 12 }, (_, i) =>
        updateConfig({ providers: { [`p${i}`]: { baseUrl: `http://127.0.0.1:${2000 + i}/v1`, model: `m${i}` } } }, file));
      const results = await Promise.all(writers);
      expect(results.every((r) => r.isOk())).toBe(true);
      const disk = JSON.parse(readFileSync(file, 'utf8'));
      for (let i = 0; i < 12; i++) expect(disk.providers[`p${i}`]?.model).toBe(`m${i}`);
      expect(disk.providers.keep.apiKey).toBe('untouched');
      expect(existsSync(`${file}.lock`)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
