/**
 * K-NN novelty scoring archive.
 * Pure data structure, no external dependencies.
 */

/** Immutable identity for an archived behavior vector. */
export interface NoveltyAttribution {
  artifactId: string;
  rootId?: string;
}

export type NoveltyInsufficiency =
  | 'empty-archive'
  | 'invalid-descriptor'
  | 'missing-axis'
  | 'duplicate-artifact';

export interface NoveltyAssessment {
  /** Mean distance to k nearest neighbours; 0 when the descriptor is unusable. */
  score: number;
  /** False when the score must not be read as evidence of novelty. */
  sufficient: boolean;
  reason?: NoveltyInsufficiency;
  /** Distinct root lineages among the k nearest neighbours that carry attribution. */
  neighborRoots: number;
}

interface ArchivedBehavior {
  behavior: number[];
  artifactId?: string;
  rootId?: string;
}

export class NoveltyArchive {
  private items: number[][];
  private entries: ArchivedBehavior[];
  private capacity: number;
  private kNeighbors: number;
  /** Descriptor width fixed by the first admitted vector. */
  private dimensions: number | undefined;

  constructor(capacity?: number, kNeighbors?: number) {
    this.capacity = capacity ?? 1000;
    this.kNeighbors = kNeighbors ?? 5;
    this.items = [];
    this.entries = [];
  }

  private descriptorProblem(behavior: number[]): NoveltyInsufficiency | undefined {
    if (!Array.isArray(behavior) || behavior.length === 0
      || behavior.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      return 'invalid-descriptor';
    }
    if (this.dimensions !== undefined && behavior.length !== this.dimensions) {
      return 'missing-axis';
    }
    return undefined;
  }

  /**
   * Archive a behavior vector. Returns false (and archives nothing) when the
   * descriptor is empty/non-finite, does not match the fixed schema width, or
   * the attributed artifact is already archived.
   */
  add(behavior: number[], attribution?: NoveltyAttribution): boolean {
    if (this.descriptorProblem(behavior)) return false;
    if (attribution?.artifactId
      && this.entries.some(entry => entry.artifactId === attribution.artifactId)) {
      return false;
    }
    if (this.items.length >= this.capacity) {
      this.items.shift(); // FIFO eviction
      this.entries.shift();
    }
    this.dimensions ??= behavior.length;
    const copy = [...behavior];
    this.items.push(copy);
    this.entries.push({
      behavior: copy,
      ...(attribution?.artifactId ? { artifactId: attribution.artifactId } : {}),
      ...(attribution?.rootId ? { rootId: attribution.rootId } : {}),
    });
    return true;
  }

  /**
   * Novelty with an explicit insufficiency flag. Empty, non-finite,
   * missing-axis and already-archived inputs never read as novel.
   */
  assess(behavior: number[], attribution?: NoveltyAttribution): NoveltyAssessment {
    const problem = this.descriptorProblem(behavior);
    if (problem) return { score: 0, sufficient: false, reason: problem, neighborRoots: 0 };
    if (attribution?.artifactId
      && this.entries.some(entry => entry.artifactId === attribution.artifactId)) {
      return { score: 0, sufficient: false, reason: 'duplicate-artifact', neighborRoots: 0 };
    }
    if (this.entries.length === 0) {
      return { score: 1.0, sufficient: false, reason: 'empty-archive', neighborRoots: 0 };
    }
    const k = Math.min(this.kNeighbors, this.entries.length);
    const nearest = this.entries
      .map(entry => ({ entry, distance: this.distance(behavior, entry.behavior) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
    const score = nearest.reduce((sum, item) => sum + item.distance, 0) / k;
    const roots = new Set(nearest.flatMap(item => item.entry.rootId ? [item.entry.rootId] : []));
    return { score, sufficient: true, neighborRoots: roots.size };
  }

  /** Euclidean distance between two vectors, normalized by sqrt(dimensions) */
  private distance(a: number[], b: number[]): number {
    const dim = Math.max(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < dim; i++) {
      const ai = i < a.length ? a[i] : 0;
      const bi = i < b.length ? b[i] : 0;
      const diff = ai - bi;
      sum += diff * diff;
    }
    return Math.sqrt(sum) / Math.sqrt(dim);
  }

  /**
   * Compute novelty score for a behavior vector [0, 1].
   * Higher = more novel. Average Euclidean distance to k nearest neighbors.
   */
  noveltyScore(behavior: number[]): number {
    return this.assess(behavior).score;
  }

  /** Sparseness metric [0, 1]. Same as noveltyScore. */
  sparseness(behavior: number[]): number {
    return this.noveltyScore(behavior);
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.entries = [];
    this.dimensions = undefined;
  }

  /**
   * Retrieve the most novel examples from the archive.
   * Since items don't have content/prompts directly, this returns
   * behavior vectors with their novelty scores.
   * @param count - Number of examples to return
   * @returns Array of behavior vectors sorted by novelty (most novel first)
   */
  retrieveNovelExamples(count: number): Array<{ behavior: number[]; noveltyScore: number }> {
    if (this.items.length === 0) return [];

    // Calculate novelty score for each item relative to the rest
    const scored = this.items.map((item, index) => {
      // Compute novelty against all other items except self
      const others = this.items.filter((_, i) => i !== index);
      const k = Math.min(this.kNeighbors, others.length);
      
      let noveltyScore = 1.0;
      if (others.length > 0) {
        const distances = others.map((other) => this.distance(item, other));
        distances.sort((a, b) => a - b);
        
        let total = 0;
        for (let i = 0; i < k; i++) {
          total += distances[i];
        }
        noveltyScore = others.length > 0 ? total / k : 1.0;
      }

      return { behavior: [...item], noveltyScore };
    });

    // Sort by novelty score descending and return top count
    return scored
      .sort((a, b) => b.noveltyScore - a.noveltyScore)
      .slice(0, count);
  }

  /**
   * Retrieve novel examples that are maximally different from a reference behavior.
   * Useful for finding examples that diverge from the current generation.
   * @param referenceBehavior - Behavior vector to compare against
   * @param topK - Number of examples to return
   * @returns Array of behavior vectors most different from reference
   */
  retrieveNovelFromReference(
    referenceBehavior: number[],
    topK: number
  ): Array<{ behavior: number[]; distance: number }> {
    if (this.items.length === 0) return [];

    const scored = this.items.map((item) => ({
      behavior: [...item],
      distance: this.distance(item, referenceBehavior),
    }));

    return scored
      .sort((a, b) => b.distance - a.distance)
      .slice(0, topK);
  }
}
