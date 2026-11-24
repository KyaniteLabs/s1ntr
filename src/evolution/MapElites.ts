/**
 * MAP-Elites quality-diversity optimization grid.
 * Pure data structure, no external dependencies.
 *
 * Supports N-dimensional behavior descriptors.
 * Backward compatible with 2D `[number, number]` constructor args.
 * Optional embedding support: embeddings feed a cosine-diversity blend, and
 * `insertWithEmbedding` can derive a behavior vector by sampling evenly spaced
 * embedding coordinates (no PCA or learned reduction). Embeddings default OFF.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { cosineSimilarity } from '../utils/vectors.js';
import { Logger } from '../utils/Logger.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { validateExplorationDecisionAdmission,
  type ExplorationDecisionAdmission } from './ExplorationDecisionAdmission.js';

export interface MapElitesCell {
  creationId: string;
  fitness: number;
  behavior: number[];
  /** Optional embedding vector for semantic behavior characterization */
  embedding?: number[];
  /** Content for embedding-based diversity (e.g., code, description) */
  content?: string;
  /** Decision-valid evidence; absent means exploration-only. */
  admission?: ExplorationDecisionAdmission;
}

/** Options for embedding-based diversity */
export interface EmbeddingDiversityOptions {
  /** Whether to use embedding-based diversity calculation */
  useEmbeddings: boolean;
  /** Weight for embedding diversity vs behavior diversity (0-1) */
  embeddingWeight: number;
}

export class MapElites {
  private grid: Map<string, MapElitesCell>;
  private dims: number[];
  private embeddingOptions: EmbeddingDiversityOptions;
  private loadState: 'unloaded' | 'ok' | 'missing' | 'corrupt' = 'unloaded';

  constructor(
    dims?: [number, number] | number[],
    embeddingOptions?: Partial<EmbeddingDiversityOptions>
  ) {
    this.dims = dims ?? [10, 10];
    this.grid = new Map();
    this.embeddingOptions = {
      useEmbeddings: embeddingOptions?.useEmbeddings ?? false,
      embeddingWeight: embeddingOptions?.embeddingWeight ?? 0.5,
    };
  }

  /**
   * Map a behavior vector to cell coordinates, one per dimension. Each bin
   * covers an equal 1/dimSize slice of [0, 1]; b = 1 folds into the last bin.
   * The previous floor(b * (dimSize - 1)) made the last bin reachable only at
   * exactly b = 1 and widened every other bin (#1266).
   */
  private behaviorToCell(behavior: number[]): number[] {
    return this.dims.map((dimSize, i) => {
      const b = Math.max(0, Math.min(1, behavior[i] ?? 0));
      return Math.min(dimSize - 1, Math.floor(b * dimSize));
    });
  }

  /**
   * Re-key loaded cells from their stored behavior so archives saved under an
   * older binning formula do not mix coordinate systems. When two stored cells
   * land in one bin, the fitter one is kept.
   */
  private rekey(cells: Iterable<[string, MapElitesCell]>): Map<string, MapElitesCell> {
    const grid = new Map<string, MapElitesCell>();
    for (const [, cell] of cells) {
      const key = this.behaviorToCell(cell.behavior).join(',');
      const existing = grid.get(key);
      if (existing === undefined || cell.fitness > existing.fitness) grid.set(key, cell);
    }
    return grid;
  }

  /** Insert a creation. Returns true if it was added (new cell or better fitness). */
  insert(
    creationId: string,
    behavior: number[],
    fitness: number,
    embedding?: number[],
    content?: string
  ): boolean {
    return this.place(creationId, behavior, fitness, embedding, content);
  }

  /** Insert a decision-valid candidate for scoped reward or parent selection. */
  insertAdmitted(creationId: string, behavior: number[],
    admission: ExplorationDecisionAdmission, embedding?: number[], content?: string): boolean {
    validateExplorationDecisionAdmission(admission, { purpose: admission.purpose,
      artifactId: creationId, role: admission.role, domain: admission.domain });
    return this.place(creationId, behavior, admission.criterionScore,
      embedding, content, admission);
  }

  private place(creationId: string, behavior: number[], fitness: number,
    embedding?: number[], content?: string,
    admission?: ExplorationDecisionAdmission): boolean {
    if (!Number.isFinite(fitness) || !Array.isArray(behavior)
      || behavior.some(b => typeof b !== 'number' || !Number.isFinite(b))) {
      return false;
    }
    const coords = this.behaviorToCell(behavior);
    const key = coords.join(',');
    const existing = this.grid.get(key);
    // An exploratory (unadmitted) insert must never evict a decision-valid admitted cell (#1275).
    if (existing?.admission && !admission) {
      return false;
    }
    if (existing === undefined || fitness > existing.fitness) {
      this.grid.set(key, {
        creationId,
        fitness,
        behavior: [...behavior],
        embedding: embedding ? [...embedding] : undefined,
        content,
        admission: admission ? structuredClone(admission) : undefined,
      });
      return true;
    }
    return false;
  }

  /** Get cell at (x, y) — legacy 2D accessor */
  get(x: number, y: number): MapElitesCell | null {
    const cell = this.grid.get(`${x},${y}`);
    return cell ? structuredClone(cell) : null;
  }

  /**
   * Get top N elites by fitness across all cells.
   *
   * EXPLORATORY ONLY: ranks unadmitted inserts too, and a useful rank is not
   * eligibility. Decision paths must use {@link getParentElites} (#1275).
   */
  getElites(
    n: number
  ): Array<{ creationId: string; fitness: number }> {
    return Array.from(this.grid.values())
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, n)
      .map((c) => ({ creationId: c.creationId, fitness: c.fitness }));
  }

  /** Decision-valid parent candidates; exploratory rank never grants eligibility. */
  getParentElites(n: number, scope: { role: string; domain: string }): MapElitesCell[] {
    return Array.from(this.grid.values()).filter(cell => {
      if (!cell.admission) return false;
      try {
        validateExplorationDecisionAdmission(cell.admission, {
          purpose: 'parent-selection', artifactId: cell.creationId,
          role: scope.role, domain: scope.domain,
        });
        return true;
      } catch { return false; }
    }).sort((a, b) => b.fitness - a.fitness).slice(0, n)
      .map(cell => structuredClone(cell));
  }

  /** Fraction of grid cells that are occupied [0, 1] */
  coverage(): number {
    const totalCells = this.dims.reduce((acc, d) => acc * d, 1);
    return this.size() / totalCells;
  }

  /** Clear all cells */
  clear(): void {
    this.grid.clear();
  }

  /** Number of occupied cells */
  size(): number {
    return this.grid.size;
  }

  /** Get all cells as array */
  getAllCells(): MapElitesCell[] {
    return Array.from(this.grid.values(), cell => structuredClone(cell));
  }

  /** Persist grid to JSON file (atomically; refuses after a corrupt load). */
  async save(filePath: string): Promise<void> {
    if (this.loadState === 'corrupt') {
      Logger.warn('MapElites', `Refusing to overwrite ${filePath}: the previous load was corrupt and has been quarantined.`);
      return;
    }
    const data = {
      dims: this.dims,
      cells: Array.from(this.grid.entries()),
      embeddingOptions: this.embeddingOptions,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(data), { mode: 0o600 });
  }

  /** Describe why parsed archive data is not a valid persisted grid, or null if it is. */
  private static archiveSchemaError(data: unknown): string | null {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'not an object';
    const { dims, cells } = data as { dims?: unknown; cells?: unknown };
    if (!Array.isArray(dims) || dims.length === 0
      || !dims.every(d => Number.isInteger(d) && (d as number) > 0)) {
      return 'dims must be a non-empty array of positive integers';
    }
    if (!Array.isArray(cells)) return 'cells must be an array';
    for (const [i, entry] of cells.entries()) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
        return `cells[${i}] must be a [key, cell] pair`;
      }
      const cell = entry[1] as Partial<MapElitesCell> | null;
      if (typeof cell !== 'object' || cell === null
        || typeof cell.creationId !== 'string'
        || typeof cell.fitness !== 'number' || !Number.isFinite(cell.fitness)
        || !Array.isArray(cell.behavior) || !cell.behavior.every(b => typeof b === 'number' && Number.isFinite(b))) {
        return `cells[${i}] has an invalid cell (creationId, finite fitness and numeric behavior required)`;
      }
    }
    return null;
  }

  /** Load grid from JSON file; quarantine corrupt or schema-invalid state instead of starting empty over it. */
  async load(filePath: string): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      const schemaError = MapElites.archiveSchemaError(data);
      if (schemaError) throw new Error(`schema-invalid archive: ${schemaError}`);
      this.dims = data.dims;
      this.grid = this.rekey(data.cells);
      this.embeddingOptions = data.embeddingOptions ?? {
        useEmbeddings: false,
        embeddingWeight: 0.5,
      };
      this.loadState = 'ok';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.loadState = 'missing';
        return;
      }
      // Only quarantine genuinely corrupt/schema-invalid files, not transient OS I/O errors.
      const isCorruptData = error instanceof SyntaxError
        || (error instanceof Error && error.message.startsWith('schema-invalid archive:'));
      if (!isCorruptData) {
        throw error;
      }
      const quarantined = `${filePath}.corrupt.${Date.now()}`;
      await fs.rename(filePath, quarantined).catch(() => undefined);
      this.loadState = 'corrupt';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`MAP_ELITES_CORRUPT: ${filePath} (${message}); moved to ${quarantined}`);
    }
  }

  /**
   * Return a uniformly random occupied cell, or null if the grid is empty.
   *
   * EXPLORATORY ONLY: includes unadmitted inserts and is not decision-valid.
   * Never use it for parent selection or promotion; use
   * {@link getParentElites}, which enforces use-scoped admission (#1275).
   */
  getRandomElite(): MapElitesCell | null {
    if (this.grid.size === 0) return null;
    const cells = Array.from(this.grid.values());
    const idx = Math.floor(Math.random() * cells.length);
    return structuredClone(cells[idx]);
  }

  /**
   * Compute average pairwise distance between all cell behaviors.
   * Supports both traditional behavior vectors and embedding-based diversity.
   * Returns 0 if fewer than 2 cells are occupied.
   * O(n^2) — acceptable for the small grid sizes used.
   */
  getBehaviorDiversity(): number {
    const cells = this.getAllCells();
    if (cells.length < 2) return 0;

    let totalDist = 0;
    let pairCount = 0;

    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const dist = this.calculateDiversity(cells[i], cells[j]);
        totalDist += dist;
        pairCount++;
      }
    }

    return pairCount > 0 ? totalDist / pairCount : 0;
  }

  /**
   * Calculate diversity between two cells.
   * Uses embedding-based diversity if enabled and available,
   * otherwise uses traditional behavior vector distance.
   */
  private calculateDiversity(
    cellA: MapElitesCell,
    cellB: MapElitesCell
  ): number {
    const { useEmbeddings, embeddingWeight } = this.embeddingOptions;

    // Calculate traditional behavior distance
    const behaviorDist = this.behaviorDistance(
      cellA.behavior,
      cellB.behavior
    );

    // Calculate embedding-based diversity if enabled and available
    if (
      useEmbeddings &&
      embeddingWeight > 0 &&
      cellA.embedding &&
      cellB.embedding &&
      cellA.embedding.length > 0 &&
      cellB.embedding.length > 0
    ) {
      // Use cosine distance (1 - similarity) for embedding diversity
      const embeddingSimilarity = cosineSimilarity(
        cellA.embedding,
        cellB.embedding
      );
      const embeddingDist = 1 - embeddingSimilarity;

      // Weighted combination
      return (
        embeddingWeight * embeddingDist +
        (1 - embeddingWeight) * behaviorDist
      );
    }

    return behaviorDist;
  }

  /**
   * Get diverse high-quality elites using tournament selection.
   * Returns elites that are both high-fitness and behaviorally diverse.
   * Supports embedding-based diversity.
   * @param count - Number of elites to return
   * @returns Array of diverse elite cells
   */
  getDiverseElite(count: number): MapElitesCell[] {
    const cells = this.getAllCells();
    if (cells.length === 0) return [];
    if (cells.length <= count) return [...cells];

    // Sort by fitness descending for initial selection pool
    const sortedByFitness = [...cells].sort(
      (a, b) => b.fitness - a.fitness
    );

    // Take enough cells for the requested count with tournament selection
    // Each tournament uses up to 3 candidates, so we need count * 3 at minimum
    const poolSize = Math.max(
      count * 3,
      Math.ceil(sortedByFitness.length * 0.5)
    );
    const pool = sortedByFitness.slice(0, poolSize);

    const selected: MapElitesCell[] = [];
    const used = new Set<number>(); // Track indices, not creationIds

    // Tournament selection with diversity bonus
    while (selected.length < count && used.size < pool.length) {
      // Pick random candidates from pool (by index)
      const tournamentSize = Math.min(3, pool.length - used.size);
      const candidateIndices: number[] = [];

      // Get available indices
      const availableIndices = pool
        .map((_, i) => i)
        .filter((i) => !used.has(i));

      // Shuffle available indices
      for (let i = availableIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [availableIndices[i], availableIndices[j]] = [
          availableIndices[j],
          availableIndices[i],
        ];
      }

      // Take first tournamentSize indices
      for (let i = 0; i < Math.min(tournamentSize, availableIndices.length); i++) {
        candidateIndices.push(availableIndices[i]);
      }

      if (candidateIndices.length === 0) break;

      // Select winner based on fitness + diversity bonus (only winner is marked used
      // so tournament losers remain eligible for subsequent draws).
      let winnerIdx = candidateIndices[0];
      let winner = pool[winnerIdx];
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const idx of candidateIndices) {
        const candidate = pool[idx];
        // Calculate diversity bonus based on distance from already selected
        let diversityBonus = 0;
        for (const sel of selected) {
          const dist = this.calculateDiversity(candidate, sel);
          diversityBonus += dist;
        }
        diversityBonus =
          selected.length > 0 ? diversityBonus / selected.length : 0.5;

        const score = candidate.fitness * 0.7 + diversityBonus * 0.3;
        if (score > bestScore) {
          bestScore = score;
          winnerIdx = idx;
          winner = candidate;
        }
      }

      used.add(winnerIdx);
      selected.push(winner);
    }

    return selected;
  }

  /** Calculate Euclidean distance between two behavior vectors */
  private behaviorDistance(a: number[], b: number[]): number {
    const maxLen = Math.max(a.length, b.length);
    let distSq = 0;
    for (let k = 0; k < maxLen; k++) {
      const diff = (a[k] ?? 0) - (b[k] ?? 0);
      distSq += diff * diff;
    }
    const maxDist = Math.sqrt(maxLen); // Maximum possible distance
    return maxDist > 0 ? Math.sqrt(distSq) / maxDist : 0;
  }

  /**
   * Enable or disable embedding-based diversity.
   * @param enabled - Whether to use embeddings
   * @param weight - Weight for embedding diversity (0-1)
   */
  setEmbeddingOptions(
    enabled: boolean,
    weight = 0.5
  ): void {
    this.embeddingOptions = {
      useEmbeddings: enabled,
      embeddingWeight: Math.max(0, Math.min(1, weight)),
    };
  }

  /**
   * Get current embedding options.
   * @returns Current embedding options
   */
  getEmbeddingOptions(): EmbeddingDiversityOptions {
    return { ...this.embeddingOptions };
  }

  /**
   * Find elites similar to a query embedding.
   * @param queryEmbedding - Query embedding vector
   * @param topK - Number of similar elites to return
   * @returns Array of similar elites with similarity scores
   */
  findSimilarByEmbedding(
    queryEmbedding: number[],
    topK: number
  ): Array<{ cell: MapElitesCell; similarity: number }> {
    const cells = this.getAllCells().filter(
      (c) => c.embedding && c.embedding.length > 0
    );

    const scored = cells.map((cell) => ({
      cell,
      similarity: cosineSimilarity(queryEmbedding, cell.embedding!),
    }));

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /**
   * Insert with embedding-based behavior characterization.
   * Automatically extracts behavior descriptor from embedding if provided.
   * @param creationId - Unique identifier for the creation
   * @param fitness - Fitness score
   * @param embedding - Semantic embedding vector
   * @param behavior - Optional behavior vector (derived from embedding if not provided)
   * @param content - Optional content string
   * @returns True if inserted successfully
   */
  insertWithEmbedding(
    creationId: string,
    fitness: number,
    embedding: number[],
    behavior?: number[],
    content?: string
  ): boolean {
    // If no behavior vector provided, derive one by sampling evenly spaced
    // embedding coordinates (see deriveBehaviorFromEmbedding)
    const derivedBehavior =
      behavior ?? this.deriveBehaviorFromEmbedding(embedding);

    return this.insert(
      creationId,
      derivedBehavior,
      fitness,
      embedding,
      content
    );
  }

  /**
   * Derive a behavior descriptor vector from an embedding by coordinate
   * sampling: dimension i reads embedding[floor(i * len / dims)], mapped from
   * [-1, 1] to [0, 1] and clamped. This is NOT dimensionality reduction (no
   * PCA, projection, or learned model); unsampled coordinates are ignored.
   * @param embedding - Full embedding vector
   * @returns Behavior descriptor vector
   */
  private deriveBehaviorFromEmbedding(embedding: number[]): number[] {
    // Coordinate sampling at regular intervals; ignores all other coordinates.
    const targetDims = this.dims.length;
    const samples: number[] = [];

    for (let i = 0; i < targetDims; i++) {
      const idx = Math.floor((i * embedding.length) / targetDims);
      // Normalize to [0, 1] range
      const value = (embedding[idx] + 1) / 2; // Assuming embeddings are normalized to [-1, 1]
      samples.push(Math.max(0, Math.min(1, value)));
    }

    return samples;
  }
}
