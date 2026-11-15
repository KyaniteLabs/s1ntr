import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Wave 7 shared organism CLI contract', () => {
  it('uses the same persisted owner-reaction state as Studio', () => {
    const cli = fs.readFileSync(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
    const studio = fs.readFileSync(path.join(process.cwd(), 'gui', 'server.js'), 'utf8');
    expect(cli).toContain("cmd === 'organism'");
    expect(cli).toContain('organismStatePath()');
    expect(cli).toContain('source: \'cli\'');
    expect(studio).toContain('SINTER_ORGANISM_STATE_PATH');
    expect(studio).toContain('owner-reactions.json');
  });
});
