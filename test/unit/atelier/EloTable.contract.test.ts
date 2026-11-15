import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EloTable, hasScoreContract, SPU_SCORING_CONTRACT } from '../../../src/atelier/EloTable.js';

const contract = { scoreScale: 10 as const, scoringContract: SPU_SCORING_CONTRACT };

describe('EloTable scoring-contract mode', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('does not inherit legacy ratings and archives replaced state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elo-contract-')); dirs.push(dir);
    const tablePath = join(dir, 'elo.json');
    const original = JSON.stringify({
      legacy: { rating: 1888, games: 99, lastPlayed: '2026-01-01T00:00:00Z' },
      untouched: { rating: 1700, games: 6, lastPlayed: '2026-01-01T00:00:00Z' },
    });
    writeFileSync(tablePath, original);

    const table = new EloTable(tablePath, { contract });
    expect(table.rating('legacy')).toBe(1000);
    expect(table.games('legacy')).toBe(0);
    table.record('legacy', 'fresh');

    const rows = JSON.parse(readFileSync(tablePath, 'utf8'));
    expect(rows.legacy).toMatchObject({ rating: 1012, games: 1, ...contract });
    expect(rows.fresh).toMatchObject({ rating: 988, games: 1, ...contract });
    expect(rows.untouched.rating).toBe(1700);
    const archive = readdirSync(dir).find(name => name.startsWith('elo.json.archive-'));
    expect(archive).toMatch(/^elo\.json\.archive-/);
    expect(readFileSync(join(dir, archive!), 'utf8')).toBe(original);
  });

  it('uses trusted ratings and excludes legacy entries from the ladder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elo-trusted-')); dirs.push(dir);
    const tablePath = join(dir, 'elo.json');
    writeFileSync(tablePath, JSON.stringify({
      trusted: { rating: 1200, games: 5, lastPlayed: '', ...contract },
      legacy: { rating: 1900, games: 50, lastPlayed: '' },
    }));
    const table = new EloTable(tablePath, { contract });
    expect(table.rating('trusted')).toBe(1200);
    expect(table.ladder(5).map(row => row.id)).toEqual(['trusted']);
    table.record('trusted', 'new');
    expect(JSON.parse(readFileSync(tablePath, 'utf8')).trusted.games).toBe(6);
  });

  it('requires the exact contract marker', () => {
    expect(hasScoreContract(contract)).toBe(true);
    expect(hasScoreContract({ scoreScale: 9, scoringContract: SPU_SCORING_CONTRACT })).toBe(false);
    expect(hasScoreContract({ scoreScale: 10, scoringContract: 'old' })).toBe(false);
  });
});
