/**
 * MemoryBudget — Budget-gated pruning for bounded memory growth.
 *
 * Every memory store in the intuition system has a finite capacity.
 * MemoryBudget provides a unified pruning coordinator that:
 *
 *   1. Tracks item counts across all stores
 *   2. Ranks items by composite value (retention * quality * recency)
 *   3. Prunes least-valuable items when a store exceeds its budget
 *   4. Reports memory health metrics
 *
 * This is NOT a store itself — it's a coordinator that operates on
 * external stores (ThompsonSampler, IntuitionCache, DomainPrototype,
 * CreativeWorldModel, MemoryConsolidator patterns).
 *
 * Usage:
 *   const budget = new MemoryBudget(forgettingCurve, { ... });
 *   budget.registerStore('cache', { getSize, prune });
 *   budget.enforce(); // Prune all stores to budget
 *
 * @module intuition/MemoryBudget
 */

import { ForgettingCurve, type DecayableItem } from './ForgettingCurve.js';
import { Logger } from '../utils/Logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A store item with the identity MemoryBudget uses to request its eviction. */
export interface BudgetItem extends DecayableItem {
  /** Store-local identity passed back to `evict`. */
  id: string;
}

/** A prunable store that MemoryBudget can manage. */
export interface PrunableStore {
  /** Current number of items in the store */
  getSize(): number;
  /** Every item in the store, with ids, for value ranking */
  getItems(): BudgetItem[];
  /**
   * Delete exactly the given items (lowest value first).
   * @returns the ids actually deleted
   */
  evict(ids: readonly string[]): readonly string[];
}

/** What one enforcement chose and what the store actually did. */
export interface EvictionReceipt {
  store: string;
  sizeBefore: number;
  sizeAfter: number;
  threshold: number;
  /** Ids the budget ranked lowest and asked the store to delete. */
  chosen: string[];
  /** Ids the store reports it deleted. */
  evicted: string[];
  /** Chosen ids the store did not delete. */
  missed: string[];
  /** Deleted ids the budget never chose. */
  unexpected: string[];
  /** True when the store is still above its threshold after eviction. */
  overThreshold: boolean;
}

/** Budget configuration for a single store. */
export interface StoreBudget {
  /** Maximum items this store should retain */
  maxSize: number;
  /** Target utilization (0-1). Pruning starts when size > maxSize * targetUtilization. Default: 0.9 */
  targetUtilization?: number;
}

/** MemoryBudget configuration. */
export interface MemoryBudgetConfig {
  /** Budgets per store name */
  storeBudgets: Record<string, StoreBudget>;
  /** Whether to log pruning actions. Default: true */
  verbose?: boolean;
}

/** Health report for a single store. */
export interface StoreHealth {
  /** Store name */
  name: string;
  /** Current item count */
  size: number;
  /** Budget limit */
  budget: number;
  /** Utilization ratio (0-1+, >1 means over budget) */
  utilization: number;
  /** Number of items pruned in last enforcement */
  pruned: number;
  /** Whether this store is healthy (utilization <= 1) */
  isHealthy: boolean;
}

/** Overall memory health report. */
export interface MemoryHealthReport {
  /** Per-store health */
  stores: StoreHealth[];
  /** Total items across all stores */
  totalItems: number;
  /** Total budget across all stores */
  totalBudget: number;
  /** Overall utilization */
  overallUtilization: number;
  /** Whether all stores are within budget */
  isHealthy: boolean;
  /** Timestamp of this report */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// MemoryBudget
// ---------------------------------------------------------------------------

export class MemoryBudget {
  private readonly stores = new Map<string, { store: PrunableStore; budget: Required<StoreBudget> }>();
  private readonly curve: ForgettingCurve;
  private readonly config: { verbose: boolean };
  private lastPruneCounts = new Map<string, number>();
  private lastReceipts = new Map<string, EvictionReceipt>();

  constructor(curve: ForgettingCurve, config?: Omit<MemoryBudgetConfig, 'storeBudgets'>) {
    this.curve = curve;
    this.config = { verbose: config?.verbose ?? true };
  }

  // ---------------------------------------------------------------------------
  // Store registration
  // ---------------------------------------------------------------------------

  /**
   * Register a prunable store with its budget.
   */
  registerStore(name: string, store: PrunableStore, budget: StoreBudget): void {
    this.stores.set(name, {
      store,
      budget: {
        maxSize: budget.maxSize,
        targetUtilization: budget.targetUtilization ?? 0.9,
      },
    });
    Logger.info('MemoryBudget', `Registered store "${name}" with budget ${budget.maxSize}`);
  }

  /** Unregister a store. */
  unregisterStore(name: string): void {
    this.stores.delete(name);
    this.lastPruneCounts.delete(name);
    this.lastReceipts.delete(name);
  }

  // ---------------------------------------------------------------------------
  // Enforcement
  // ---------------------------------------------------------------------------

  /**
   * Enforce budgets across all registered stores.
   * Prunes lowest-value items from any store that exceeds its budget.
   *
   * @returns Total items pruned across all stores
   */
  enforce(): number {
    let totalPruned = 0;
    for (const name of this.stores.keys()) {
      totalPruned += this.enforceStore(name);
    }
    return totalPruned;
  }

  /**
   * Enforce budget for a specific store only.
   * Ranks the store's items, asks it to evict exactly the lowest-value ids,
   * and records a receipt comparing chosen ids with deleted ids.
   *
   * @returns Number of items actually deleted
   */
  enforceStore(name: string): number {
    const entry = this.stores.get(name);
    if (!entry) return 0;

    const { store, budget } = entry;
    const sizeBefore = store.getSize();
    const threshold = Math.floor(budget.maxSize * budget.targetUtilization);

    if (sizeBefore <= threshold) {
      this.lastPruneCounts.set(name, 0);
      this.lastReceipts.delete(name);
      return 0;
    }

    // rankByValue sorts best-first; take the worst `excess`, worst first.
    const ranked = this.curve.rankByValue(store.getItems());
    const excess = sizeBefore - threshold;
    const chosen = ranked.slice(-excess).reverse().map(({ item }) => item.id);
    const evicted = chosen.length > 0 ? [...store.evict(chosen)] : [];
    const sizeAfter = store.getSize();

    const chosenSet = new Set(chosen);
    const evictedSet = new Set(evicted);
    const receipt: EvictionReceipt = {
      store: name,
      sizeBefore,
      sizeAfter,
      threshold,
      chosen,
      evicted,
      missed: chosen.filter(id => !evictedSet.has(id)),
      unexpected: evicted.filter(id => !chosenSet.has(id)),
      overThreshold: sizeAfter > threshold,
    };
    this.lastReceipts.set(name, receipt);
    this.lastPruneCounts.set(name, evicted.length);

    if (receipt.missed.length > 0 || receipt.unexpected.length > 0 || receipt.overThreshold) {
      Logger.warn('MemoryBudget',
        `Store "${name}" eviction diverged: chose ${chosen.length}, evicted ${evicted.length}, ` +
        `missed ${receipt.missed.length}, unexpected ${receipt.unexpected.length}, ` +
        `size ${sizeBefore} → ${sizeAfter} (threshold ${threshold})`);
    } else if (this.config.verbose && evicted.length > 0) {
      Logger.info('MemoryBudget',
        `Pruned ${evicted.length} items from "${name}" (${sizeBefore} → ${sizeAfter}, budget: ${budget.maxSize})`);
    }

    return evicted.length;
  }

  /** Receipt from the most recent enforcement that had to evict, or null. */
  getLastReceipt(name: string): EvictionReceipt | null {
    return this.lastReceipts.get(name) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Health reporting
  // ---------------------------------------------------------------------------

  /**
   * Get a health report for all registered stores.
   */
  getHealthReport(): MemoryHealthReport {
    const storeHealths: StoreHealth[] = [];
    let totalItems = 0;
    let totalBudget = 0;

    for (const [name, { store, budget }] of this.stores) {
      const size = store.getSize();
      const utilization = size / budget.maxSize;
      const pruned = this.lastPruneCounts.get(name) ?? 0;

      storeHealths.push({
        name,
        size,
        budget: budget.maxSize,
        utilization,
        pruned,
        isHealthy: utilization <= 1,
      });

      totalItems += size;
      totalBudget += budget.maxSize;
    }

    const overallUtilization = totalBudget > 0 ? totalItems / totalBudget : 0;
    const isHealthy = storeHealths.every(s => s.isHealthy);

    return {
      stores: storeHealths,
      totalItems,
      totalBudget,
      overallUtilization,
      isHealthy,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get the number of registered stores.
   */
  get storeCount(): number {
    return this.stores.size;
  }

  /**
   * Get total items across all stores.
   */
  get totalItems(): number {
    let total = 0;
    for (const { store } of this.stores.values()) {
      total += store.getSize();
    }
    return total;
  }

  /**
   * Get budget for a specific store.
   */
  getStoreBudget(name: string): StoreBudget | null {
    const entry = this.stores.get(name);
    return entry ? { maxSize: entry.budget.maxSize, targetUtilization: entry.budget.targetUtilization } : null;
  }

  /** Reset all prune counts. */
  reset(): void {
    this.lastPruneCounts.clear();
    this.lastReceipts.clear();
  }
}
