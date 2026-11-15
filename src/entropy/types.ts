export interface EntropyResult {
  /** Exact safe integer (≤ 2^53) parsed from seedHex. */
  seed: number;
  /** Exact hex digits the seed was parsed from, when derived from a hash. */
  seedHex?: string;
  phrase: string;
  quality: 'harvested' | 'degraded' | 'emergency';
  source: 'metabolic' | 'genesis' | 'fallback';
  hashChain: string[];
  /** Per-source item counts for a metabolic harvest; absent for genesis/fallback. */
  sources?: EntropySourceCounts;
}

/** How many items each harvester source actually contributed (0 = empty/unavailable). */
export interface EntropySourceCounts {
  events: number;
  heapFiles: number;
  seeds: number;
  /** 1 when telemetry reports at least one task, else 0. */
  telemetry: number;
}

export interface CompressionConfig {
  rounds?: number;
}

export interface HarvestInput {
  eventsJson: string;
  fragmentsText: string;
  telemetryJson: string;
}

export interface EntropyHarvesterDeps {
  eventStore: { getRecent(count: number): unknown[] };
  heap: { listFiles(): Promise<string[]> };
  telemetry: { getSummary(): { successRate: number; avgDurationMs: number; totalTasks: number; totalViolations: number } };
  getTopSeeds?: (n: number) => Promise<{ id: string; content: string; score: number }[]>;
}

export interface MetabolicEntropyEngineConfig extends EntropyHarvesterDeps {
  compressor?: { compress(input: string, rounds?: number): Omit<EntropyResult, 'quality' | 'source'> };
}
