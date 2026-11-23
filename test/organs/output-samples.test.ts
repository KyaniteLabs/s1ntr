import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

// Dogfood 2026-11-19: an organ that claims all four proofs must show a captured real output.
const reg = JSON.parse(readFileSync('test/organs/registry.json', 'utf8'));
const rows: Array<[string, any]> = [...Object.entries(reg.modules), ...Object.entries(reg.files ?? {})];

describe('organ output samples', () => {
  it('every INTEGRATED row points at a non-empty, sanitized, trimmed sample', () => {
    const bad: string[] = [];
    for (const [name, e] of rows) {
      if (e.status !== 'INTEGRATED') continue;
      if (typeof e.output !== 'string' || !existsSync(e.output)) { bad.push(`${name}: no output sample`); continue; }
      const t = readFileSync(e.output, 'utf8');
      if (t.trim().length < 20) bad.push(`${name}: empty sample`);
      if (t.split('\n').length > 70) bad.push(`${name}: sample over 70 lines`);
      if (/\/home\/|\/Users\/|[\w.+-]+@[\w-]+\.[a-z]{2,}/.test(t)) bad.push(`${name}: sample leaks a path or email`);
    }
    expect(bad).toEqual([]);
  });
  it('the gate script rejects an INTEGRATED row with no sample (the rule is in check-organs.mjs)', () => {
    expect(readFileSync('scripts/check-organs.mjs', 'utf8')).toMatch(/INTEGRATED but output sample/);
  });
});
