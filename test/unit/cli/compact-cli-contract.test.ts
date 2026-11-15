import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('compact CLI contract', () => {
  const readCli = () => readFileSync(join(process.cwd(), 'bin', 'sinter'), 'utf8');

  it('advertises compact with dry-run default and execute flag', () => {
    const cli = readCli();
    expect(cli).toContain("compact [--execute] [--root <path>]  Reclaim ~/.sinter state (dry-run default)");
  });

  it('routes compact through SinterCompact dry-run/execute seam', () => {
    const cli = readCli();
    const start = cli.indexOf("else if (cmd === 'compact')");
    expect(start).toBeGreaterThan(0);
    const end = cli.indexOf("else if (cmd === 'preferences')", start);
    const block = cli.slice(start, end);
    expect(block).toContain("runSinterCompact");
    expect(block).toContain("formatCompactReport");
    expect(block).toContain('flags.execute');
    expect(block).toContain("import('../dist/cli/SinterCompact.js')");
  });
});
