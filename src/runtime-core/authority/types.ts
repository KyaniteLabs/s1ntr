export type ProductionAuthorityKind =
  | 'provider' | 'renderer' | 'evaluator' | 'review-writer' | 'journal'
  | 'archive' | 'memory' | 'compost' | 'evolution' | 'routing'
  | 'activation' | 'source-change' | 'assimilation' | 'plugin'
  | 'scheduler' | 'product-surface' | 'projection' | 'research-control'
  | 'doctrine' | 'classification';

export type ProductionAuthorityDisposition =
  | 'authoritative' | 'proposal-only' | 'exploration-only'
  | 'projection-only' | 'quarantined-history' | 'migration-pending';

export interface ProductionAuthorityPath {
  readonly locator: string;
  readonly kind: ProductionAuthorityKind;
  readonly owner: string;
  readonly disposition: ProductionAuthorityDisposition;
  readonly migrationOwner?: `#${number}`;
}

export const authorityRow = (
  locator: string, kind: ProductionAuthorityKind, owner: string,
  disposition: ProductionAuthorityDisposition, migrationOwner?: `#${number}`,
): ProductionAuthorityPath => Object.freeze({ locator, kind, owner, disposition, migrationOwner });
