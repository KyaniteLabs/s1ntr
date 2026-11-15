import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('market readiness CLI contract', () => {
  it('routes market status through the exhaustive Wave 7 release truth', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');

    expect(source).toContain("cmd === 'market'");
    expect(source).toContain('collectWave7RepositoryReleaseTruth');
    expect(source).toContain('formatWave7RepositoryReleaseTruth');
    expect(source).not.toContain('collectRepositoryMarketReadinessStatus');
  });
});
