import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * COMMAND-REGISTRATION PARITY GUARD. An unregistered command falls into the
 * natural-language prompt path and GENERATES ART from the command line (a
 * real incident: `sinter rescue <dir>` burned a 276s glm call before the
 * command was registered). This test fails whenever bin/sinter dispatches a
 * command that PromptArgs does not know — the class can never silently
 * recur.
 */
describe('CLI command registration parity', () => {
  it('every dispatched bin/sinter command is in KNOWN_COMMANDS', () => {
    const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
    const bin = readFileSync(join(repoRoot, 'bin', 'sinter'), 'utf8');
    const promptArgs = readFileSync(join(repoRoot, 'src', 'cli', 'PromptArgs.ts'), 'utf8');

    const dispatched = new Set<string>();
    for (const match of bin.matchAll(/cmd === '([a-z][a-z0-9-]*)'/g)) {
      dispatched.add(match[1]);
    }
    const block = promptArgs.slice(
      promptArgs.indexOf('KNOWN_COMMANDS'),
      promptArgs.indexOf(']);', promptArgs.indexOf('KNOWN_COMMANDS')),
    );
    const known = new Set<string>();
    for (const match of block.matchAll(/'([a-z0-9:-]+)'/g)) {
      known.add(match[1]);
    }

    // 'generate/gen/g' are prompt-path commands; 'help' is handled by the flag
    const exempt = new Set(['generate', 'gen', 'g', 'help', 'live-music']);
    const missing = [...dispatched].filter(c => !known.has(c) && !exempt.has(c));
    expect(missing, `commands dispatched in bin/sinter but missing from KNOWN_COMMANDS (they fall through to art generation): ${missing.join(', ')}`).toEqual([]);
  });
});
