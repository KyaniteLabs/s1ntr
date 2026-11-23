/**
 * LineageTracker — Phase 13E
 *
 * Tracks parent refs, seed/params, remix lineage, and provenance for every
 * creative run. Persists through SinterFS for replay and branching.
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/Logger.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import type { LineageRecord, Provenance } from './types.js';

export interface LineageTrackerConfig {
  /** Directory for lineage records (default: ~/.sinter/lineage/) */
  lineageDir?: string;
}

const DEFAULT_LINEAGE_DIR = join(homedir(), '.sinter', 'lineage');

export class LineageTracker {
  private readonly lineageDir: string;
  private cache: Map<string, LineageRecord> = new Map();
  private loaded = false;
  /** Lineage files that could not be read as a record (not silently dropped). */
  private corruptFiles: string[] = [];

  constructor(config: LineageTrackerConfig = {}) {
    this.lineageDir = config.lineageDir ?? DEFAULT_LINEAGE_DIR;
  }

  /**
   * Record a new lineage entry for an artifact.
   * Called by creative runs after generation/remix/branch/dream.
   */
  async record(params: {
    artifactId?: string;
    parentIds?: string[];
    provenance: Provenance;
    seed?: string;
    runParams?: Record<string, unknown>;
    runId?: string;
    createdAt?: string;
  }): Promise<LineageRecord> {
    await this.ensureLoaded();

    const record: LineageRecord = {
      artifactId: params.artifactId ?? randomUUID(),
      parentIds: params.parentIds ?? [],
      provenance: params.provenance,
      seed: params.seed,
      params: params.runParams,
      runId: params.runId,
      createdAt: params.createdAt ?? new Date().toISOString(),
    };

    this.cache.set(record.artifactId, record);
    await this.persist(record);

    Logger.info('LineageTracker', `Recorded ${record.provenance} for ${record.artifactId} (parents: ${record.parentIds.length})`);
    return record;
  }

  /**
   * Get the lineage record for an artifact.
   */
  async get(artifactId: string): Promise<LineageRecord | undefined> {
    await this.ensureLoaded();
    return this.cache.get(artifactId);
  }

  /**
   * Get the full ancestry chain for an artifact (breadth-first traversal).
   */
  async getAncestry(artifactId: string, maxDepth = 10): Promise<LineageRecord[]> {
    await this.ensureLoaded();

    const ancestry: LineageRecord[] = [];
    const visited = new Set<string>();
    const queue: string[] = [artifactId];
    let depth = 0;

    while (queue.length > 0 && depth < maxDepth) {
      const batchSize = queue.length;
      for (let i = 0; i < batchSize; i++) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);

        const record = this.cache.get(id);
        if (!record) continue;

        ancestry.push(record);
        for (const parentId of record.parentIds) {
          if (!visited.has(parentId)) {
            queue.push(parentId);
          }
        }
      }
      depth++;
    }

    return ancestry;
  }

  /**
   * Get all descendants of an artifact (reverse lookup).
   */
  async getDescendants(artifactId: string): Promise<LineageRecord[]> {
    await this.ensureLoaded();

    const children = new Map<string, LineageRecord[]>();
    for (const record of this.cache.values()) {
      for (const parentId of new Set(record.parentIds)) {
        const list = children.get(parentId) ?? [];
        list.push(record);
        children.set(parentId, list);
      }
    }

    // Iterative BFS with a visited set: a cyclic lineage terminates, and the
    // start artifact is never reported as its own descendant.
    const descendants: LineageRecord[] = [];
    const visited = new Set<string>([artifactId]);
    const queue: string[] = [artifactId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const child of children.get(id) ?? []) {
        if (visited.has(child.artifactId)) continue;
        visited.add(child.artifactId);
        descendants.push(child);
        queue.push(child.artifactId);
      }
    }
    return descendants;
  }

  /**
   * Get the depth of an artifact in the lineage DAG (0 = root/fresh): the
   * longest parent path, not the number of ancestors (a diamond does not
   * inflate depth). A parent with no loaded record counts as one hop to an
   * unknown root. Edges that close a cycle are ignored.
   */
  async getDepth(artifactId: string): Promise<number> {
    await this.ensureLoaded();
    return this.longestPath(artifactId, new Map(), new Set());
  }

  private longestPath(id: string, memo: Map<string, number>, onPath: Set<string>): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const record = this.cache.get(id);
    if (!record) return 0;
    onPath.add(id);
    let depth = 0;
    for (const parentId of record.parentIds) {
      if (onPath.has(parentId)) continue; // cycle edge
      depth = Math.max(depth, 1 + this.longestPath(parentId, memo, onPath));
    }
    onPath.delete(id);
    memo.set(id, depth);
    return depth;
  }

  /**
   * Integrity faults in the loaded lineage: unreadable record files and
   * parent IDs that reference no loaded record.
   */
  async getIntegrityFaults(): Promise<{ corruptFiles: string[]; danglingParents: Array<{ artifactId: string; parentId: string }> }> {
    await this.ensureLoaded();
    const danglingParents: Array<{ artifactId: string; parentId: string }> = [];
    for (const record of this.cache.values()) {
      for (const parentId of record.parentIds) {
        if (!this.cache.has(parentId)) danglingParents.push({ artifactId: record.artifactId, parentId });
      }
    }
    return { corruptFiles: [...this.corruptFiles], danglingParents };
  }

  /**
   * Export all lineage records for a session or run.
   */
  async exportForRun(runId: string): Promise<LineageRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.cache.values()).filter(r => r.runId === runId);
  }

  /**
   * Get statistics about the lineage graph.
   */
  async getStats(): Promise<{
    totalRecords: number;
    byProvenance: Record<Provenance, number>;
    maxDepth: number;
    avgParents: number;
    rootCount: number;
    corruptFiles: number;
    danglingParents: number;
  }> {
    await this.ensureLoaded();

    const records = Array.from(this.cache.values());
    const byProvenance: Record<Provenance, number> = {
      'fresh-generation': 0,
      'remix': 0,
      'compost-promotion': 0,
      'dream-recombination': 0,
      'branch': 0,
      'mutation': 0,
      'perturbation-probe': 0,
    };

    let totalParents = 0;
    let rootCount = 0;

    for (const r of records) {
      byProvenance[r.provenance] = (byProvenance[r.provenance] ?? 0) + 1;
      totalParents += r.parentIds.length;
      if (r.parentIds.length === 0) rootCount++;
    }

    return {
      totalRecords: records.length,
      byProvenance,
      maxDepth: records.length > 0 ? Math.max(...await Promise.all(records.map(r => this.getDepth(r.artifactId)))) : 0,
      avgParents: records.length > 0 ? totalParents / records.length : 0,
      rootCount,
      corruptFiles: this.corruptFiles.length,
      danglingParents: (await this.getIntegrityFaults()).danglingParents.length,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const files = await fs.readdir(this.lineageDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await fs.readFile(join(this.lineageDir, file), 'utf-8');
          const record = JSON.parse(data) as Partial<LineageRecord> | null;
          if (!record || typeof record.artifactId !== 'string' || !Array.isArray(record.parentIds)
            || !record.parentIds.every(p => typeof p === 'string')) {
            throw new Error('not a lineage record');
          }
          this.cache.set(record.artifactId, record as LineageRecord);
        } catch {
          this.corruptFiles.push(file);
        }
      }
      if (this.corruptFiles.length > 0) {
        Logger.warn('LineageTracker', `Skipped ${this.corruptFiles.length} unreadable lineage record(s): ${this.corruptFiles.join(', ')}`);
      }
      Logger.info('LineageTracker', `Loaded ${this.cache.size} lineage records`);
    } catch {
      // Directory doesn't exist yet — will be created on first persist
    }
  }

  private async persist(record: LineageRecord): Promise<void> {
    const filePath = join(this.lineageDir, `${record.artifactId}.json`);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(record, null, 2));
  }
}
