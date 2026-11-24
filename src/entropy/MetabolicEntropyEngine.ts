import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { EntropyResult, MetabolicEntropyEngineConfig } from './types.js';
import { EntropyCompressor } from './EntropyCompressor.js';
import { EntropyHarvester } from './EntropyHarvester.js';

type Compressor = NonNullable<MetabolicEntropyEngineConfig['compressor']>;

export class MetabolicEntropyEngine {
  private compressor: Compressor;
  private harvester: EntropyHarvester;
  private harvestFailureTimes: number[] = [];
  private lastResult: EntropyResult | null = null;
  /** Draws taken from lastResult's seed; resets whenever the seed changes. */
  private draws = 0;

  constructor(config: MetabolicEntropyEngineConfig) {
    this.compressor = config.compressor ?? new EntropyCompressor();
    this.harvester = new EntropyHarvester(config);
  }

  async harvest(): Promise<EntropyResult> {
    try {
      // Circuit breaker: 3 harvest failures in 60s (timestamps only; never entropy input)
      const now = Date.now();
      this.harvestFailureTimes = this.harvestFailureTimes.filter(t => now - t < 60000);
      if (this.harvestFailureTimes.length >= 3) {
        return this.setResult(this.fallback('emergency', 'fallback'));
      }

      const { input, sources } = await this.harvester.gatherWithSources();
      const compressed = this.compressor.compress(input);
      // All-empty sources hash only fixed framing text: not harvested entropy.
      const anySource = sources.events + sources.heapFiles + sources.seeds + sources.telemetry > 0;
      const result: EntropyResult = {
        ...compressed,
        quality: anySource ? 'harvested' : 'degraded',
        source: 'metabolic',
        sources,
      };
      return this.setResult(result);
    } catch {
      this.harvestFailureTimes.push(Date.now());
      try {
        return this.setResult(this.genesis());
      } catch {
        return this.setResult(this.fallback('emergency', 'fallback'));
      }
    }
  }

  /**
   * Counter-based draw from the current seed: deterministic for a given seed
   * and draw index, and successive calls advance (#1288). Before any harvest
   * the engine adopts a labelled emergency result rather than an unlabelled
   * wall-clock value.
   */
  nextFloat(): number {
    const current = this.lastResult ?? this.setResult(this.fallback('emergency', 'fallback'));
    const draw = this.draws++;
    // SplitMix64-inspired scalar mixer over (low 32 bits of seed, draw index)
    let z = ((current.seed % 0x100000000) + Math.imul(draw, 0x9e3779b9)) | 0;
    z = (z + 0x9e3779b9) | 0;
    let t = z ^ (z >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    z = t >>> 0;
    return z / 4294967296;
  }

  nextInt(max = 2147483647): number {
    return Math.floor(this.nextFloat() * max);
  }

  setGetTopSeeds(fn: (n: number) => Promise<{ id: string; content: string; score: number }[]>): void {
    this.harvester.setGetTopSeeds(fn);
  }

  private setResult(result: EntropyResult): EntropyResult {
    this.lastResult = result;
    this.draws = 0;
    return result;
  }

  private genesis(): EntropyResult {
    let raw = '';
    try {
      raw = execSync('git log --format="%H %s %ad" --date=iso --all --max-count=1000', {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
      });
    } catch {
      // Build-time fallback or package metadata
      try {
        const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
        raw = `${pkg.name ?? 'sinter'} ${pkg.version ?? '0.0.0'} ${process.hrtime.bigint()}`;
      } catch {
        raw = `${process.hrtime.bigint()}`;
      }
    }

    const compressed = this.compressor.compress(raw);
    return {
      ...compressed,
      quality: 'degraded',
      source: 'genesis',
    };
  }

  private fallback(quality: 'emergency', source: 'fallback'): EntropyResult {
    const seed = ((Date.now() ^ (process.pid || 1)) >>> 0);
    return {
      seed,
      phrase: 'ash dust null void',
      quality,
      source,
      hashChain: [],
    };
  }
}
