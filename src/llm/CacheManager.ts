/**
 * CacheManager - LLM response caching with LRU eviction
 *
 * Features:
 * - Key = hash of (system prompt + user prompt + scope). The scope names the
 *   provider, endpoint, model and call options, so the same prompts sent to a
 *   different model or with a different token cap never share an answer.
 * - TTL = 1 hour default
 * - Max = 1000 entries default
 * - LRU eviction when full
 *
 * Note: Cache operations are synchronous. In Node.js single-threaded event loop,
 * Map operations (get, set, delete) are atomic relative to other JavaScript
 * execution. Concurrent async operations interleave but each operation completes
 * before the next begins.
 */

export interface CacheOptions {
  enabled?: boolean;
  ttlMs?: number;
  maxEntries?: number;
}

import { createHash } from 'node:crypto';
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from '../constants/limits.js';

interface CacheEntry {
  value: string;
  timestamp: number;
}

function hashKey(system: string | null | undefined, user: string | null | undefined, scope = ''): string {
  return createHash('sha256').update(JSON.stringify([system ?? '', user ?? '', scope])).digest('hex');
}

const DEFAULT_CACHE_OPTIONS: Required<CacheOptions> = {
  enabled: true,
  ttlMs: CACHE_TTL_MS,
  maxEntries: CACHE_MAX_ENTRIES,
};

export class CacheManager {
  private cache = new Map<string, CacheEntry>();
  private options: Required<CacheOptions>;

  constructor(options?: CacheOptions) {
    this.options = { ...DEFAULT_CACHE_OPTIONS, ...options };
  }

  get(system: string | null | undefined, user: string | null | undefined, scope = ''): string | null {
    if (!this.options.enabled) return null;
    if (system == null || user == null) return null;

    const key = hashKey(system, user, scope);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.options.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // LRU: move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(system: string | null | undefined, user: string | null | undefined, value: string | null | undefined, scope = ''): void {
    if (!this.options.enabled) return;
    if (system == null || user == null || value == null) return;

    const key = hashKey(system, user, scope);

    // Overwriting an existing key never evicts an unrelated entry (#1423 bug 34);
    // delete first so the rewrite moves to the newest slot.
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.options.maxEntries) {
      // Evict oldest if at capacity
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }
}
