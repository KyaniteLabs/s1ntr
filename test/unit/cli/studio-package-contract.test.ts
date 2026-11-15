import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('studio package-mode contract', () => {
  it('fails honestly when the installed package lacks repo-only Studio runtime files', () => {
    const cli = readFileSync('bin/sinter', 'utf8');

    expect(cli).toContain('Studio requires a repository checkout');
    expect(cli).toContain('scripts/utils/start-studio.js');
    expect(cli).toContain('gui/package.json');
  });
});
