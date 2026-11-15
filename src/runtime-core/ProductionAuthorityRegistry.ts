import { createHash } from 'node:crypto';
import type { ProductionAuthorityPath } from './authority/types.js';
import { productionAuthorityInventory } from './authority/index.js';

export type {
  ProductionAuthorityDisposition,
  ProductionAuthorityKind,
  ProductionAuthorityPath,
} from './authority/types.js';
export { productionAuthorityInventory };

export interface ProductionAuthoritySealReceipt {
  readonly schema: 'sinter.production-authority-seal';
  readonly schemaVersion: 1;
  readonly status: 'sealed';
  readonly locatorCount: number;
  readonly inventoryDigest: string;
}

export interface OrganismMigrationReceipt {
  readonly schema: 'sinter.organism-migration-census';
  readonly schemaVersion: 1;
  readonly status: 'cutover-complete';
  readonly migratedTickets: readonly string[];
  readonly inventoryDigest: string;
}

const ORGANISM_MIGRATIONS = Object.freeze([
  '#798', '#799', '#800', '#801', '#802', '#803', '#804',
]);

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export class ProductionAuthorityRegistry {
  readonly #rows: readonly ProductionAuthorityPath[];
  readonly #byLocator: ReadonlyMap<string, ProductionAuthorityPath>;

  constructor(rows: readonly ProductionAuthorityPath[]) {
    const byLocator = new Map<string, ProductionAuthorityPath>();
    for (const row of rows) {
      if (row.disposition === 'migration-pending' && !row.migrationOwner) {
        throw new Error(`MIGRATION_OWNER_REQUIRED:${row.locator}`);
      }
      if (byLocator.has(row.locator)) {
        throw new Error(`MULTIPLY_OWNED_PRODUCTION_AUTHORITY_PATH:${row.locator}`);
      }
      if ((row.owner === 'legacy-role-bound-transport'
        && row.disposition !== 'quarantined-history')
        || (row.owner === 'operator-exploration-boundary'
          && row.disposition !== 'exploration-only')) {
        throw new Error(`PRODUCTION_AUTHORITY_DISPOSITION_MISLABELED:${row.locator}`);
      }
      byLocator.set(row.locator, Object.freeze({ ...row }));
    }
    this.#rows = Object.freeze([...byLocator.values()]);
    this.#byLocator = byLocator;
  }

  resolve(locator: string): ProductionAuthorityPath {
    const row = this.#byLocator.get(locator);
    if (!row) throw new Error(`UNREGISTERED_PRODUCTION_AUTHORITY_PATH:${locator}`);
    return row;
  }

  enforceProductionEntrypoints(reachableLocators: readonly string[]): void {
    for (const locator of new Set(reachableLocators)) {
      const row = this.resolve(locator);
      if (row.disposition === 'quarantined-history'
        || row.disposition === 'exploration-only') {
        throw new Error(`PRODUCTION_ENTRY_AUTHORITY_FORBIDDEN:${locator}`);
      }
    }
  }

  seal(reachableLocators: readonly string[]): ProductionAuthoritySealReceipt {
    const reachable = new Set(reachableLocators);
    for (const locator of reachable) this.resolve(locator);
    if (reachable.size !== this.#rows.length
      || this.#rows.some(row => !reachable.has(row.locator))) {
      throw new Error('INCOMPLETE_PRODUCTION_AUTHORITY_REACHABILITY');
    }
    return Object.freeze({
      schema: 'sinter.production-authority-seal', schemaVersion: 1,
      status: 'sealed', locatorCount: reachable.size,
      inventoryDigest: sha256(this.#rows),
    });
  }

  sealOrganismMigration(): OrganismMigrationReceipt {
    const unfinished = this.#rows.filter(row => row.disposition === 'migration-pending');
    if (unfinished.length) throw new Error(`ORGANISM_MIGRATION_INCOMPLETE:${unfinished[0].locator}`);
    return Object.freeze({ schema: 'sinter.organism-migration-census', schemaVersion: 1,
      status: 'cutover-complete', migratedTickets: ORGANISM_MIGRATIONS,
      inventoryDigest: sha256(this.#rows) });
  }
}

export function bootstrapProductionAuthorityRegistry(
  reachableLocators: readonly string[] = productionAuthorityInventory.map(row => row.locator),
): Readonly<{ registry: ProductionAuthorityRegistry; receipt: ProductionAuthoritySealReceipt;
  migration: OrganismMigrationReceipt }> {
  const registry = new ProductionAuthorityRegistry(productionAuthorityInventory);
  return Object.freeze({ registry, receipt: registry.seal(reachableLocators),
    migration: registry.sealOrganismMigration() });
}

export function enforceProductionAuthorityEntrypoints(
  reachableLocators: readonly string[],
): void {
  new ProductionAuthorityRegistry(productionAuthorityInventory)
    .enforceProductionEntrypoints(reachableLocators);
}
