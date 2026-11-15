import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Wayfinder #1113 / story J5-precut (2026-09-02): the third-judge panel's two
// kilo HTTP lanes (deepseek-v4-flash, mimo-v2.5-pro) were dead — kilo balance
// negative, every call 402s — yet stayed in the Promise.allSettled, shipping
// error entries into the team map. This test pins the panel to its two live
// CLI lanes (command-code + agy) so a dead lane cannot silently come back:
// re-adding kilo here fails CI until the CEO's Sep 15 review says otherwise.
//
// Same static-structure approach as known-commands-coverage.test.ts: bin/sinter
// is a single-file dispatch surface, so the source IS the contract.
describe('third-judge panel lanes (J5-precut kilo removal)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');

  const start = source.indexOf("cmd === 'third-judge'");
  const end = source.indexOf("cmd === 'rescue'");
  it('found the third-judge block (sanity — extraction anchors exist, in order)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });
  const block = source.slice(start, end);

  it('no kilo judge remains anywhere in bin/sinter', () => {
    expect(source.match(/judgeViaKilo/g)).toBeNull();
    expect(block).not.toContain('api.kilo.ai');
  });

  it('panel enumerates exactly the two CLI lanes: command-code + agy', () => {
    const lanes = [...block.matchAll(/judgeViaCli\('([^']+)'/g)].map(m => m[1]);
    expect(lanes).toEqual(['command-code', 'agy']);
  });

  it('team result keys are exactly command_code + agy (no dead-lane error entries)', () => {
    const keys = [...block.matchAll(/\['([a-z_]+)',\s*\w+R\]/g)].map(m => m[1]);
    expect(keys).toEqual(['command_code', 'agy']);
  });

  it('removal is loud: dated removal comment + skip log line exist', () => {
    expect(block).toMatch(/REMOVED 2026-09-02/);
    expect(block).toMatch(/\[third-judge\] kilo lanes \(deepseek\/mimo\) SKIPPED — removed 2026-09-02/);
    expect(block).toMatch(/Sep 15 review/);
  });
});
