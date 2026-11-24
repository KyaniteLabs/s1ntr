/**
 * QualityArchive - Persistent storage layer for high-quality outputs.
 *
 * Manages JSON file read/write for the archive, storing items with
 * metadata (domain, quality score, timestamp, behavior vector).
 *
 * Companion to ArchiveLearning - this handles the storage layer.
 */

import { promises as fs } from 'fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { Logger } from '../utils/Logger.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { withFileLock } from '../utils/fileLock.js';
import { safeJsonParse, ArchiveDataSchema } from '../security/JsonSchemas.js';
import { isCreativeLabelAdmitted, type CreativeLabelAdmission,
  type CreativeLabelUse } from './CreativeLabelAdmission.js';

/**
 * Query options for archive searches.
 */
export interface ArchiveQueryOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Minimum quality score filter */
  minQuality?: number;
  /** Minimum timestamp (ISO string) */
  since?: string;
  /** Sort by 'quality' (default) or 'recent' */
  sortBy?: 'quality' | 'recent';
}

/**
 * An archived output entry in storage.
 */
export interface ArchiveEntry {
  /** Unique identifier */
  id: string;
  /** Domain (e.g., 'p5', 'glsl', 'three', 'music') */
  domain: string;
  /** Original prompt that generated this output */
  prompt: string;
  /** The generated output (code, art, etc.) */
  output: string;
  /** Quality score (0-1) */
  qualityScore: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** ISO 8601 timestamp when created */
  createdAt: string;
  /** Number of times this example has been used */
  usedCount?: number;
  /** User rating if provided */
  userRating?: number;
  /**
   * Evaluator confidence (0–1) that produced qualityScore. 0 means the LLM
   * evaluator failed and the score is a keyword/neutral fallback. Optional for
   * back-compat: legacy entries without provenance are trusted (absence ≠ 0).
   */
  confidence?: number;
  /**
   * Evaluation failure class. 'none'/'render' are real signals; 'scorer'/'infra'/
   * 'validator'/'other' mark a degraded (fabricated) score that must NOT be
   * admitted as a quality exemplar.
   */
  failureClass?: string;
  /** Exact rendered decision envelope; absent legacy labels remain exploration-only. */
  creativeLabel?: CreativeLabelAdmission;
}

/**
 * Archive data structure as stored in JSON file.
 */
interface ArchiveData {
  archives: Record<string, ArchiveEntry[]>;
  lastUpdated: string;
}

/**
 * Configuration for QualityArchive.
 */
export interface QualityArchiveConfig {
  /** Path to archive JSON file */
  path?: string;
  /** Minimum quality threshold for adding items */
  minQuality?: number;
  /** Maximum examples to keep per domain */
  maxExamplesPerDomain?: number;
}

/**
 * QualityArchive manages persistent storage of high-quality outputs.
 *
 * - Stores items in JSON file
 * - Organizes by domain
 * - Supports querying by domain, quality, recency
 * - Handles file I/O with error recovery
 */
export class QualityArchive {
  private path: string;
  private maxExamplesPerDomain: number;
  private cache: Map<string, ArchiveEntry[]>;

  /** Default minimum quality threshold */
  static readonly DEFAULT_MIN_QUALITY = 0.65;

  /** Default max examples per domain */
  static readonly DEFAULT_MAX_EXAMPLES = 20;

  /** Default archive path */
  static readonly DEFAULT_PATH = join(homedir(), '.sinter', 'archive', 'quality_archive.json');

  /**
   * Create a new QualityArchive instance.
   * @param config - Optional configuration
   */
  constructor(config: QualityArchiveConfig = {}) {
    this.path = config.path ?? QualityArchive.DEFAULT_PATH;
    this.maxExamplesPerDomain = config.maxExamplesPerDomain ?? QualityArchive.DEFAULT_MAX_EXAMPLES;
    this.cache = QualityArchive.emptyCache();
  }

  private static emptyCache(): Map<string, ArchiveEntry[]> {
    return new Map([['p5', []], ['glsl', []], ['three', []], ['music', []]]);
  }

  private recoveryRequired = false;

  /**
   * Load archive from disk.
   * Should be called after construction to populate the cache.
   */
  async load(): Promise<void> {
    this.recoveryRequired = false;
    try {
      const data = await fs.readFile(this.path, 'utf-8');
      const archiveData = safeJsonParse(data, ArchiveDataSchema, 'QualityArchive');

      if (!archiveData) {
        this.cache = QualityArchive.emptyCache();
        // Quarantine the invalid file before starting fresh — otherwise the
        // next save() overwrites it, silently destroying every archived entry.
        const quarantinePath = `${this.path}.corrupt-${Date.now()}`;
        try {
          await fs.rename(this.path, quarantinePath);
          Logger.error(
            'QualityArchive',
            `Archive failed schema validation — original preserved at ${quarantinePath}, starting fresh`
          );
        } catch (renameError) {
          this.recoveryRequired = true;
          Logger.error(
            'QualityArchive',
            `Archive failed schema validation and quarantine rename failed (${(renameError as Error).message}) — refusing writes until recovery succeeds`
          );
        }
        return;
      }

      // Replace the cache with what is on disk (a reload drops stale entries)
      const cache = QualityArchive.emptyCache();
      for (const [domain, entries] of Object.entries(archiveData.archives)) {
        cache.set(domain, entries);
      }
      this.cache = cache;

      const total = Array.from(this.cache.values()).reduce((sum, arr) => sum + arr.length, 0);
      Logger.info('QualityArchive', `Loaded ${total} archived outputs from ${this.path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet - that's fine
        this.cache = QualityArchive.emptyCache();
        Logger.info('QualityArchive', 'Archive file not found, starting fresh');
      } else {
        this.recoveryRequired = true;
        Logger.error('QualityArchive', `Archive file corrupted or unreadable, refusing writes: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Persist the archive. Every change is already written by the method that
   * made it, so this only refreshes the cache from disk under the lock. It
   * never writes a stale cache over entries another process added.
   */
  async save(): Promise<void> {
    await this.update(() => true);
  }

  /**
   * Run one change as a cross-process transaction: take the lock, reload the
   * file, apply `change` to the fresh cache, and write it if `change` says it
   * changed something. Two writers can no longer drop each other's entries.
   */
  private async update<T>(change: () => T | false): Promise<T | false> {
    if (this.recoveryRequired) throw new Error('ARCHIVE_RECOVERY_REQUIRED');
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      return await withFileLock(`${this.path}.lock`, async () => {
        await this.load();
        if (this.recoveryRequired) throw new Error('ARCHIVE_RECOVERY_REQUIRED');
        const result = change();
        if (result === false) return false;
        const data: ArchiveData = {
          archives: Object.fromEntries(this.cache),
          lastUpdated: new Date().toISOString(),
        };
        await writeFileAtomic(this.path, JSON.stringify(data, null, 2));
        return result;
      });
    } catch (error) {
      Logger.error('QualityArchive', `Error saving archive: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Only a rendered, identity-valid, digest-bound creative label can teach.
   * Legacy and degraded records remain in the exploration archive but are not
   * silently upgraded by rank, scalar score, or missing provenance.
   */
  static isHonestEntry(entry: Pick<ArchiveEntry, 'creativeLabel'>): boolean {
    return isCreativeLabelAdmitted(entry.creativeLabel, 'few-shot');
  }

  static isTeachingEligible(entry: Pick<ArchiveEntry, 'output' | 'creativeLabel'>,
    use: CreativeLabelUse): boolean {
    return isCreativeLabelAdmitted(entry.creativeLabel, use)
      && entry.creativeLabel!.artifactDigest
        === createHash('sha256').update(entry.output).digest('hex');
  }

  /**
   * Add an entry to the archive.
   * @param entry - The entry to add
   */
  async add(entry: ArchiveEntry): Promise<void> {
    await this.update(() => this.applyAdd(entry));
  }

  private applyAdd(entry: ArchiveEntry): true {
    if (!Number.isFinite(entry.qualityScore)) {
      throw new Error(`Invalid non-finite qualityScore for archive entry "${entry.id}"`);
    }
    const domain = entry.domain;

    // Ensure domain exists in cache
    if (!this.cache.has(domain)) {
      this.cache.set(domain, []);
    }

    const entries = this.cache.get(domain)!.filter((existing) => existing.id !== entry.id);
    entries.push(entry);

    // Sort by quality (descending) and keep only the best
    entries.sort((a, b) => b.qualityScore - a.qualityScore);
    const trimmed = entries.slice(0, this.maxExamplesPerDomain);
    this.cache.set(domain, trimmed);
    return true;
  }

  /**
   * Re-score an existing entry in place (archive re-normalization).
   *
   * Stale gen-time scores freeze the displacement ratchet once the judge
   * improves: honest new scores can't beat old inflated ones. This updates the
   * entry's qualityScore through the class (never hand-edit the JSON), records
   * the prior score in metadata for auditability, restores the domain bucket's
   * sorted-by-quality invariant, and persists.
   *
   * @returns true when the entry was found and updated.
   */
  async rescoreEntry(itemId: string, freshScore: number, provenance: string): Promise<boolean> {
    if (!Number.isFinite(freshScore)) {
      throw new Error(`Invalid non-finite rescore value for archive entry "${itemId}"`);
    }
    return (await this.update(() => this.applyRescore(itemId, freshScore, provenance))) === true;
  }

  private applyRescore(itemId: string, freshScore: number, provenance: string): true | false {
    if (!Number.isFinite(freshScore)) {
      throw new Error(`Invalid non-finite rescore value for archive entry "${itemId}"`);
    }
    const clamped = Math.max(0, Math.min(1, freshScore));
    for (const [domain, entries] of this.cache.entries()) {
      const entry = entries.find((e) => e.id === itemId);
      if (!entry) continue;
      entry.metadata = {
        ...entry.metadata,
        rescore: {
          priorScore: entry.qualityScore,
          rescoredAt: new Date().toISOString(),
          provenance,
        },
      };
      entry.qualityScore = clamped;
      entries.sort((a, b) => b.qualityScore - a.qualityScore);
      this.cache.set(domain, entries);
      return true;
    }
    return false;
  }

  /**
   * Query entries by domain with filters.
   * @param domain - Domain to query
   * @param options - Query options
   * @returns Filtered and sorted entries
   */
  query(domain: string, options: ArchiveQueryOptions = {}): ArchiveEntry[] {
    let entries = [...(this.cache.get(domain) ?? [])];

    // Filter by minimum quality
    if (options.minQuality !== undefined) {
      const floor = options.minQuality;
      entries = entries.filter(e => e.qualityScore >= floor);
    }

    // Filter by recency
    if (options.since !== undefined) {
      const sinceMs = new Date(options.since).getTime();
      entries = entries.filter(e => new Date(e.createdAt).getTime() >= sinceMs);
    }

    // Sort
    const sortBy = options.sortBy ?? 'quality';
    if (sortBy === 'quality') {
      entries.sort((a, b) => b.qualityScore - a.qualityScore);
    } else if (sortBy === 'recent') {
      entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    // Apply limit before cloning so only the returned slice is copied.
    if (options.limit !== undefined) {
      entries = entries.slice(0, options.limit);
    }

    return entries.map(entry => structuredClone(entry));
  }

  /** Governed reader; ordinary query remains an exploration/history projection. */
  queryTeaching(domain: string, use: CreativeLabelUse,
    options: ArchiveQueryOptions = {}): ArchiveEntry[] {
    const eligible = this.query(domain, { ...options, limit: undefined })
      .filter(entry => QualityArchive.isTeachingEligible(entry, use));
    return options.limit !== undefined ? eligible.slice(0, options.limit) : eligible;
  }

  /**
   * Search across all domains by keywords.
   * @param query - Search query string
   * @param domain - Optional domain filter
   * @param limit - Max results (default: 10)
   * @returns Matching entries sorted by quality
   */
  search(query: string, domain?: string, limit = 10): ArchiveEntry[] {
    const queryLower = query.toLowerCase();
    const results: ArchiveEntry[] = [];

    const domainsToSearch = domain ? [domain] : Array.from(this.cache.keys());

    for (const d of domainsToSearch) {
      const entries = this.cache.get(d) ?? [];
      for (const entry of entries) {
        if (
          entry.prompt.toLowerCase().includes(queryLower) ||
          entry.output.toLowerCase().includes(queryLower)
        ) {
          results.push(entry);
        }
      }
    }

    // Sort by quality and limit
    results.sort((a, b) => b.qualityScore - a.qualityScore);
    return results.slice(0, limit);
  }

  /**
   * Record that an entry was used.
   * @param itemId - ID of the entry
   */
  async recordUsage(itemId: string): Promise<void> {
    await this.update(() => {
      const entry = this.findCached(itemId);
      if (!entry) return false;
      entry.usedCount = (entry.usedCount ?? 0) + 1;
      return true;
    });
  }

  private findCached(itemId: string): ArchiveEntry | undefined {
    for (const entries of this.cache.values()) {
      const entry = entries.find(e => e.id === itemId);
      if (entry) return entry;
    }
    return undefined;
  }

  /**
   * Add a user rating to an entry.
   * @param itemId - ID of the entry
   * @param rating - Rating value
   */
  async addUserRating(itemId: string, rating: number): Promise<void> {
    await this.update(() => {
      const entry = this.findCached(itemId);
      if (!entry) return false;
      entry.userRating = rating;
      return true;
    });
  }

  /**
   * Get archive statistics.
   * @returns Statistics object
   */
  getStats(): {
    totalOutputs: number;
    byDomain: Record<string, number>;
    avgQuality: Record<string, number>;
  } {
    const byDomain: Record<string, number> = {};
    const avgQuality: Record<string, number> = {};
    let total = 0;

    for (const [domain, entries] of this.cache) {
      const count = entries.length;
      byDomain[domain] = count;
      total += count;

      if (count > 0) {
        const sumQuality = entries.reduce((sum, e) => sum + e.qualityScore, 0);
        avgQuality[domain] = sumQuality / count;
      } else {
        avgQuality[domain] = 0;
      }
    }

    return { totalOutputs: total, byDomain, avgQuality };
  }

  /**
   * Export entries for fine-tuning.
   * @param domain - Optional domain filter
   * @param minQuality - Minimum quality threshold (default: 0.75)
   * @returns Array of training examples
   */
  exportForFinetuning(
    domain?: string,
    minQuality = 0.75
  ): Array<{
    prompt: string;
    completion: string;
    domain: string;
    qualityScore: number;
    metadata: Record<string, unknown>;
  }> {
    const trainingData: Array<{
      prompt: string;
      completion: string;
      domain: string;
      qualityScore: number;
      metadata: Record<string, unknown>;
    }> = [];

    const domainsToExport = domain ? [domain] : Array.from(this.cache.keys());

    for (const d of domainsToExport) {
      const entries = this.cache.get(d) ?? [];
      for (const entry of entries) {
        if (entry.qualityScore >= minQuality
          && QualityArchive.isTeachingEligible(entry, 'evaluator-training')) {
          trainingData.push({
            prompt: entry.prompt,
            completion: entry.output,
            domain: entry.domain,
            qualityScore: entry.qualityScore,
            metadata: entry.metadata,
          });
        }
      }
    }

    return trainingData;
  }

  /**
   * Clear all entries from the archive.
   */
  async clear(): Promise<void> {
    await this.update(() => {
      for (const domain of this.cache.keys()) {
        this.cache.set(domain, []);
      }
      return true;
    });
  }

  /**
   * Get all entries for a domain.
   * @param domain - Domain to get entries for
   * @returns All entries for the domain
   */
  getAll(domain: string): ArchiveEntry[] {
    return (this.cache.get(domain) ?? []).map(entry => structuredClone(entry));
  }

  /**
   * Get an entry by ID.
   * @param itemId - ID of the entry
   * @returns The entry if found, undefined otherwise
   */
  getById(itemId: string): ArchiveEntry | undefined {
    for (const entries of this.cache.values()) {
      const entry = entries.find(e => e.id === itemId);
      if (entry) {
        return structuredClone(entry);
      }
    }
    return undefined;
  }
}
