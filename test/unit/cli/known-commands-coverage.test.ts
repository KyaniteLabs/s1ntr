import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inferNaturalLanguagePrompt } from '../../../src/cli/PromptArgs.js';

// Law 33 companion: a bin/sinter subcommand missing from KNOWN_COMMANDS is
// silently swallowed by the generate path — it becomes a natural-language art
// prompt (and can trip the product-store lease). This bit third-judge on
// 2026-08-31: the handler existed, dispatched never. This test reads the
// dispatch surface and asserts every routed command is known, so the next
// subcommand cannot ship dead.
//
// Exceptions: commands dispatched through nested handlers (src/ modules) or
// aliases whose first token differs must be listed here WITH a reason.
const INTENTIONALLY_UNLISTED: string[] = [
  // e.g. 'weird-legacy-alias' — routed elsewhere, not a top-level dispatch
];

describe('KNOWN_COMMANDS covers the bin/sinter dispatch surface', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
  // Top-level dispatch arms: if (cmd === 'x') / else if (cmd === 'x' || ...)
  const arms = new Set<string>();
  for (const m of source.matchAll(/cmd === '([a-z0-9-]+)'/g)) arms.add(m[1]);

  it('found the dispatch surface (sanity — arms exist)', () => {
    expect(arms.size).toBeGreaterThan(20);
  });

  it('every dispatched command is a known command (not an art prompt)', () => {
    const missing: string[] = [];
    for (const arm of arms) {
      if (INTENTIONALLY_UNLISTED.includes(arm)) continue;
      // A known command is never inferred as a natural-language prompt.
      if (inferNaturalLanguagePrompt(arm, []) !== null) missing.push(arm);
    }
    expect(missing).toEqual([]);
  });

  it('no dispatch pattern escapes the === extraction (adversarial-QA hole)', () => {
    // The regex above only catches `cmd === '...'`. A dispatch written as
    // cmd.startsWith('render-') or similar would ship dead invisibly — the
    // exact failure this test exists to catch. If bin/sinter ever gains such
    // a pattern, this fails and the author must either register the prefix
    // family or extend the extraction — consciously, not silently.
    const sneaky = [
      ...source.matchAll(/cmd\.startsWith\(\s*'([^']+)'/g),
      ...source.matchAll(/cmd\.match\(\s*['`]([^'`]+)/g),
    ].map(m => m[1]);
    expect(sneaky).toEqual([]);
  });
});
