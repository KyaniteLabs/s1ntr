import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGoldenCandidates } from '../../../src/release/GoldenCandidates.js';

describe('loadGoldenCandidates', () => {
  it('maps files to case ids by stem, rejects missing, empty and absent dirs', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
    try {
      fs.writeFileSync(path.join(d, 'a.html'), '<p>a</p>'); fs.writeFileSync(path.join(d, 'b'), '  ');
      const suite = { name: 's', createdAt: '', cases: ['a', 'b', 'c'].map(id => ({ id, prompt: id, domain: 'html', minScore: 0.1, tags: [] })) };
      expect(() => loadGoldenCandidates(suite, d)).toThrow(/b \(empty file b\), c/);
      expect(loadGoldenCandidates({ ...suite, cases: [suite.cases[0]] }, d).get('a')?.code).toBe('<p>a</p>');
      expect(() => loadGoldenCandidates(suite, path.join(d, 'nope'))).toThrow(/GOLDEN_CANDIDATES_DIR_MISSING/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
