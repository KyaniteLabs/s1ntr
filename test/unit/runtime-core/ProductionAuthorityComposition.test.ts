import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { productionAuthorityInventory } from '../../../src/runtime-core/ProductionAuthorityRegistry.js';
import { controlAuthorityRows } from '../../../src/runtime-core/authority/control.js';
import { learningAuthorityRows } from '../../../src/runtime-core/authority/learning.js';
import { providerAuthorityRows } from '../../../src/runtime-core/authority/provider.js';
import { renderAuthorityRows } from '../../../src/runtime-core/authority/render.js';
import { reviewAuthorityRows } from '../../../src/runtime-core/authority/review.js';
import { surfaceAuthorityRows } from '../../../src/runtime-core/authority/surface.js';

interface BaselineRow { locator: string; kind: string; owner: string; disposition: string }

const baseline: BaselineRow[] = JSON.parse(readFileSync(
  path.resolve(import.meta.dirname, '../../fixtures/production-authority-baseline-2026-11-14.json'), 'utf8'));

describe('production authority inventory composition', () => {
  it('keeps the 119 rows that existed before the per-area split, unchanged', () => {
    expect(baseline).toHaveLength(119);
    const byLocator = new Map(productionAuthorityInventory.map(row => [row.locator, row]));
    for (const old of baseline) {
      expect(byLocator.get(old.locator), old.locator).toMatchObject(old);
    }
    expect(productionAuthorityInventory.length).toBeGreaterThanOrEqual(baseline.length);
  });

  it('composes every area file exactly once with no duplicate locators', () => {
    const areas = [providerAuthorityRows, renderAuthorityRows, reviewAuthorityRows,
      learningAuthorityRows, controlAuthorityRows, surfaceAuthorityRows];
    const total = areas.reduce((sum, rows) => sum + rows.length, 0);
    expect(productionAuthorityInventory).toHaveLength(total);
    expect(new Set(productionAuthorityInventory.map(row => row.locator)).size).toBe(total);
    for (const rows of areas) expect(rows.length).toBeGreaterThan(0);
  });
});
