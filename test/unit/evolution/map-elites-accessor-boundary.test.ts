/**
 * #1275: MapElites.getElites / getRandomElite are exploratory and bypass
 * use-scoped admission. Only getParentElites is decision-authorized, so the
 * unfiltered accessors must not be reachable from production source.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MapElites } from '../../../src/evolution/MapElites.js';
import type { ExplorationDecisionAdmission } from '../../../src/evolution/ExplorationDecisionAdmission.js';

const SRC = join(__dirname, '../../../src');
const OWNER = 'evolution/MapElites.ts';
const UNFILTERED = /\.(getElites|getRandomElite)\s*\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('MapElites unfiltered accessors stay off production paths (#1275)', () => {
  it('no src file outside MapElites calls getElites() or getRandomElite()', () => {
    const offenders = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((rel) => rel !== OWNER)
      .filter((rel) => UNFILTERED.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('an unadmitted high-fitness insert is ranked by getElites but excluded from getParentElites', () => {
    const map = new MapElites([4, 4]);
    expect(map.insert('exploratory', [0.9, 0.9], 0.99)).toBe(true);
    expect(map.getElites(5).map((e) => e.creationId)).toEqual(['exploratory']);
    expect(map.getParentElites(5, { role: 'generator', domain: 'p5' })).toEqual([]);
  });

  it('a forged admission object does not make a cell parent-eligible', () => {
    const map = new MapElites([4, 4]);
    const forged = { purpose: 'parent-selection', criterionScore: 0.9, role: 'generator', domain: 'p5' } as unknown as ExplorationDecisionAdmission;
    expect(() => map.insertAdmitted('forged', [0.1, 0.1], forged)).toThrow();
    expect(map.getParentElites(5, { role: 'generator', domain: 'p5' })).toEqual([]);
  });
});
