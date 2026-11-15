/**
 * CompostMill — main orchestrator for the compost digestion pipeline.
 * Wires together: CompostHeap → Extractors → CompostShredder → CollisionEngine → FragmentScorer → SeedBank → DigestGenerator
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CompostConfig, CompostFragment, DigestFailure, DigestResult, DigestStats, ExtractionResult, MillStatus } from './types.js';
import { mergeConfig } from './defaults.js';
import { CompostHeap } from './CompostHeap.js';
import { MetadataExtractor } from './MetadataExtractor.js';
import { RawByteProcessor } from './RawByteProcessor.js';
import { SemanticExtractor, isExtractionFallback } from './SemanticExtractor.js';
import { CompostShredder } from './CompostShredder.js';
import { CollisionEngine } from './CollisionEngine.js';
import { FragmentScorer } from './FragmentScorer.js';
import { Logger } from '../utils/Logger.js';
import { SeedBank } from './SeedBank.js';
import { DigestGenerator } from './DigestGenerator.js';
import { CompostSoup } from './CompostSoup.js';
import type { Seed } from './types.js';
import { RetryManager } from '../llm/RetryManager.js';
import { eventBus, EventTypes } from '../core/EventBus.js';
import type { LLMClientLike } from './SemanticExtractor.js';
import { ModelRouter } from './ModelRouter.js';
import { CompostParser } from '../core/parsing/CompostParser.js';
import type { LIRToken } from '../core/lir/types.js';
import type { ProjectStore } from './ProjectStore.js';
import { MetabolicEntropyEngine } from '../entropy/MetabolicEntropyEngine.js';
import { MotifIndexer } from './MotifIndexer.js';
import type { MotifIndexResult } from './MotifIndexer.js';
import { CompostRehydrator } from './CompostRehydrator.js';
import type { RehydratedCandidate } from './CompostRehydrator.js';
import { compostContentDigest, deriveCompostProvenance,
  normalizeCompostProvenance } from './CompostProvenance.js';

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export class CompostMill {
  private config: CompostConfig;
  private heap: CompostHeap;
  private semanticExtractor: SemanticExtractor;
  private collisionEngine: CollisionEngine;
  private fragmentScorer: FragmentScorer;
  private seedBank: SeedBank;
  private digestGenerator: DigestGenerator;
  private soup: CompostSoup | null = null;
  private llm: LLMClientLike;
  /** Fast local LLM for high-volume tasks (extraction, scoring). Falls back to main llm. */
  private fastLLM: LLMClientLike;
  /** Optional model router for dual-model architecture */
  private modelRouter?: ModelRouter;
  /** Optional project store for event-sourced history tracking. */
  private projectStore?: ProjectStore;
  private entropy?: MetabolicEntropyEngine;
  private motifIndexer: MotifIndexer;
  private rehydrator: CompostRehydrator;
  private lastMotifIndex: MotifIndexResult | null = null;
  private lastRehydratedCandidates: RehydratedCandidate[] = [];

  constructor(
    llm: LLMClientLike,
    overrides?: Partial<CompostConfig> & {
      soupStatePath?: string;
      fastLLM?: LLMClientLike;
      parser?: CompostParser;
      modelRouter?: ModelRouter;
      projectStore?: ProjectStore;
      entropy?: MetabolicEntropyEngine;
    },
  ) {
    const config = mergeConfig(overrides as Partial<CompostConfig>);
    this.config = config;
    this.llm = llm;
    this.fastLLM = overrides?.fastLLM ?? llm;
    this.modelRouter = overrides?.modelRouter;
    this.projectStore = overrides?.projectStore;
    this.entropy = overrides?.entropy;

    this.heap = new CompostHeap(config);
    // Auto-create CompostParser when LIR is enabled and no parser was provided
    const parser = overrides?.parser ?? (config.lirEnabled ? new CompostParser(config.digestDir) : undefined);

    // Use specialized routing if ModelRouter is available
    const extractionLLM = this.modelRouter ?? this.fastLLM;
    const collisionLLM = this.modelRouter ?? llm;
    const scoringLLM = this.modelRouter ?? this.fastLLM;
    const soupLLM = this.modelRouter ?? llm;
    const digestLLM = this.modelRouter ?? llm;

    this.semanticExtractor = new SemanticExtractor(config, extractionLLM, parser);
    this.collisionEngine = new CollisionEngine(config, collisionLLM);
    this.fragmentScorer = new FragmentScorer(config, scoringLLM);
    this.seedBank = new SeedBank(config);
    this.digestGenerator = new DigestGenerator(config, digestLLM);

    if (config.soupEnabled) {
      if (!this.entropy) {
        throw new Error('CompostMill: entropy engine is required when soup is enabled');
      }
      this.soup = new CompostSoup(config, soupLLM, this.entropy);
    }

    this.entropy?.setGetTopSeeds(this.getTopSeeds.bind(this));

    this.motifIndexer = new MotifIndexer();
    this.rehydrator = new CompostRehydrator();
  }

  /** Set the CompostParser for LIR extraction (allows post-construction injection). */
  setParser(parser: CompostParser): void {
    this.semanticExtractor.setParser(parser);
  }

  /** Set the ModelRouter for dual-model routing (allows post-construction injection). */
  setModelRouter(router: ModelRouter): void {
    this.modelRouter = router;
    // Note: Re-initializing components would require access to internal parser
    // For now, the router is used for new LLM calls. Components retain their original LLM client.
    // To fully switch to router, re-create CompostMill with the modelRouter override.
  }

  /** Add files or directories to the heap. */
  async add(inputPaths: string[]): Promise<void> {
    const addedPaths: string[] = [];
    let totalBytes = 0;

    for (const inputPath of inputPaths) {
      let stat: import('node:fs').Stats | null = null;
      try {
        stat = await fs.stat(inputPath);
      } catch (err) {
        Logger.warn('CompostMill', `Cannot access ${inputPath}:`, err instanceof Error ? err.message : err);
        continue;
      }

      if (stat.isDirectory()) {
        const paths = await this.heap.addDirectory(inputPath);
        addedPaths.push(...paths);
        totalBytes += stat.size;
      } else {
        await this.heap.addFile(inputPath);
        addedPaths.push(inputPath);
        totalBytes += stat.size;
      }
    }

    // Record the heap_add event
    this.projectStore?.recordHeapAdd(addedPaths, totalBytes);
  }

  /** Run the full digestion pipeline. */
  async digest(): Promise<DigestResult> {
    const startTime = Date.now();

    eventBus.emit(EventTypes.PROCESS_START, 'CompostMill', { process: 'compost-digest' });

    // Get all heap files
    const heapFiles = await this.heap.listFiles();
    if (heapFiles.length === 0) {
      const emptyStats: DigestStats = {
        filesProcessed: 0,
        totalBytes: 0,
        domains: [],
        fragmentCount: 0,
        collisionCount: 0,
        seedsPromoted: 0,
        soupCycles: 0,
        durationMs: 0,
      };
      return { stats: emptyStats, seeds: [], digestPath: '' };
    }

    // Record digest_start event
    const fullPaths = heapFiles.map(f => path.join(this.config.heapDir, f));
    this.projectStore?.recordDigestStart(fullPaths);

    // Stage 2: Extract
    eventBus.emit(EventTypes.COMPOST_STAGE, 'CompostMill', { stage: 'extract', message: `Extracting ${fullPaths.length} files...` });
    Logger.info('CompostMill', `Extracting ${fullPaths.length} files...`);
    const { results: extractionResults, failures: extractionFailures } = await this.extractAll(fullPaths);
    if (extractionFailures.length > 0) {
      Logger.warn('CompostMill', `Extraction failed for ${extractionFailures.length} file(s); retaining them in the heap: ${extractionFailures.map(f => f.filePath).join(', ')}`);
    }
    eventBus.emit(EventTypes.COMPOST_STAGE, 'CompostMill', { stage: 'extract-done', message: `Extracted ${extractionResults.length}/${fullPaths.length} files` });
    Logger.info('CompostMill', `Extracted ${extractionResults.length}/${fullPaths.length} files`);

    // Stage 3: Shred
    // Build LIR lookup map (filePath → LIRToken[]) for seed attachment
    const lirMap = new Map<string, LIRToken[]>();
    for (const result of extractionResults) {
      if (result.lir && result.lir.length > 0) {
        lirMap.set(result.filePath, result.lir);
      }
    }
    const allFragments = CompostShredder.shredAll(extractionResults).map(fragment => ({
      ...fragment,
      provenance: fragment.provenance ?? normalizeCompostProvenance(fragment),
    }));
    eventBus.emit(EventTypes.COMPOST_STAGE, 'CompostMill', { stage: 'shred', message: `Shredded into ${allFragments.length} fragments` });
    Logger.info('CompostMill', `Shredded into ${allFragments.length} fragments`);

    // Stage 4: Mix (Collisions)
    eventBus.emit(EventTypes.COMPOST_STAGE, 'CompostMill', { stage: 'collide', message: 'Running collisions...' });
    Logger.info('CompostMill', 'Running collisions...');
    const collisionResults = await this.collisionEngine.runAll(allFragments);
    eventBus.emit(EventTypes.COMPOST_STAGE, 'CompostMill', { stage: 'collide-done', message: `${collisionResults.length} collisions merged` });
    Logger.info('CompostMill', `${collisionResults.length} collisions merged`);

    // Stage 5: Mine (Score + Promote) — parallel with concurrency limit
    eventBus.emit(EventTypes.COMPOST_STAGE, 'CompostMill', { stage: 'score', message: `Scoring ${allFragments.length} fragments...` });
    Logger.info('CompostMill', `Scoring ${allFragments.length} fragments...`);
    const promotedSeeds: Seed[] = [];
    // Every computed score (promoted or not) so motif indexing and rehydration
    // see the just-computed scores rather than the shredder's unscored copies.
    const computedScores = new Map<string, number>();
    // Extraction fallbacks (metadata/error stubs) are diagnostics, never seed material.
    const promotableFragments = allFragments.filter(f => !isExtractionFallback(f.content));
    const fallbackFragmentCount = allFragments.length - promotableFragments.length;
    if (fallbackFragmentCount > 0) {
      Logger.warn('CompostMill', `Excluded ${fallbackFragmentCount} extraction-fallback fragments from promotion`);
    }
    const scored = await RetryManager.mapSettled(
      promotableFragments,
      async (frag) => {
        const scoreResult = await this.fragmentScorer.score(frag);
        computedScores.set(frag.id, scoreResult.total);
        const fragWithScore = { ...frag, score: scoreResult.total };
        const promote = await this.fragmentScorer.shouldPromote(fragWithScore, scoreResult);
        return promote ? fragWithScore : null;
      },
      8, // scoring concurrency (local LLM)
    );
    const scoringFailures: DigestFailure[] = [];
    scored.forEach((entry, i) => {
      if (entry.status === 'rejected') {
        scoringFailures.push({ filePath: allFragments[i].source, stage: 'score', error: errorMessage(entry.reason) });
      }
    });
    for (const entry of scored) {
      if (entry.status === 'fulfilled' && entry.value) {
        const frag = entry.value as CompostFragment;
        promotedSeeds.push({
          id: frag.id,
          content: frag.content,
          score: frag.score ?? 0,
          source: {
            fragments: [frag.id],
            collisionType: 'heuristic',
            domains: [frag.domain],
          },
          promotedAt: new Date().toISOString(),
          usedBy: [],
          useCount: 0,
          lir: lirMap.get(frag.source)?.[0],
          provenance: deriveCompostProvenance([frag]),
        });
      }
    }
    eventBus.emit(EventTypes.COMPOST_STAGE, 'CompostMill', { stage: 'promote', message: `Promoted ${promotedSeeds.length} seeds from scoring` });
    Logger.info('CompostMill', `Promoted ${promotedSeeds.length} seeds from scoring`);

    // Phase 15: Motif indexing and rehydration
    // Fragments whose scoring failed keep their prior score (or 0).
    const scoredFragments = allFragments.map(f => ({ ...f, score: computedScores.get(f.id) ?? f.score ?? 0 }));
    this.lastMotifIndex = this.motifIndexer.index(scoredFragments);
    Logger.info('CompostMill', `Indexed ${this.lastMotifIndex.uniqueCount} motifs (top: ${this.lastMotifIndex.topPattern ?? 'none'})`);

    const rehydratable = this.rehydrator.findRehydratable(scoredFragments);
    if (rehydratable.length > 0) {
      this.lastRehydratedCandidates = this.rehydrator.rehydrate(rehydratable);
      Logger.info('CompostMill', `Rehydrated ${this.lastRehydratedCandidates.length} candidates from ${rehydratable.length} fragments`);
    } else {
      this.lastRehydratedCandidates = [];
    }

    // Promote collision results too (score them first)
    // Placeholder collisions (no real LLM merge) are diagnostics, never seed material.
    const realCollisions = collisionResults.filter(collision => !collision.placeholder);
    const placeholderCollisionCount = collisionResults.length - realCollisions.length;
    if (placeholderCollisionCount > 0) {
      Logger.warn('CompostMill', `Excluded ${placeholderCollisionCount} placeholder collisions from promotion`);
    }
    const collisionFragments: CompostFragment[] = realCollisions.map(collision => ({
      id: `collision-${collision.fragmentA.id}-${collision.fragmentB.id}`,
      source: `collision:${collision.fragmentA.id}+${collision.fragmentB.id}`,
      domain: 'cross-domain',
      layer: 'semantic' as const,
      content: collision.mergedContent,
      score: 0,
      metadata: {
        fileType: 'collision',
        timestamp: new Date().toISOString(),
        hash: compostContentDigest(collision.mergedContent),
        size: collision.mergedContent.length,
        extractedAt: new Date().toISOString(),
      },
      tags: [collision.fragmentA.domain, collision.fragmentB.domain, `collision:${collision.strategy}`],
      provenance: deriveCompostProvenance([collision.fragmentA, collision.fragmentB]),
    }));

    const scoredCollisions = await RetryManager.mapSettled(
      collisionFragments,
      async (frag) => {
        const scoreResult = await this.fragmentScorer.score(frag);
        const fragWithScore = { ...frag, score: scoreResult.total };
        const promote = await this.fragmentScorer.shouldPromote(fragWithScore, scoreResult);
        return promote ? fragWithScore : null;
      },
      5, // collision scoring concurrency (primary LLM, longer creative prompts)
    );
    for (const entry of scoredCollisions) {
      if (entry.status === 'fulfilled' && entry.value) {
        const frag = entry.value as CompostFragment;
        const collision = realCollisions.find(
          c => `collision-${c.fragmentA.id}-${c.fragmentB.id}` === frag.id
        );
        promotedSeeds.push({
          id: frag.id,
          content: frag.content,
          score: frag.score ?? 0,
          source: {
            fragments: collision ? [collision.fragmentA.id, collision.fragmentB.id] : [],
            collisionType: collision?.strategy ?? 'unknown',
            domains: collision ? [collision.fragmentA.domain, collision.fragmentB.domain] : ['unknown'],
          },
          promotedAt: new Date().toISOString(),
          usedBy: [],
          useCount: 0,
          provenance: deriveCompostProvenance([frag]),
        });
      }
    }

    // Save promoted seeds
    for (const seed of promotedSeeds) {
      await this.seedBank.add(seed);
      this.projectStore?.recordSeedPromotion(seed);
    }

    // Collect stats
    const domains = [...new Set(allFragments.map(f => f.domain))];
    const stats: DigestStats = {
      filesProcessed: fullPaths.length,
      totalBytes: extractionResults.reduce((sum, r) => sum + r.rawBytes.size, 0),
      domains,
      fragmentCount: allFragments.length,
      collisionCount: collisionResults.length,
      seedsPromoted: promotedSeeds.length,
      soupCycles: 0,
      durationMs: Date.now() - startTime,
      failures: [...extractionFailures, ...scoringFailures],
      retainedInHeap: extractionFailures.map(f => path.relative(this.config.heapDir, f.filePath)),
    };

    // Stage 6: Digest
    const soupHighlights = collisionResults
      .slice(0, 5)
      .map(c => `[${c.strategy}] ${c.fragmentA.domain} + ${c.fragmentB.domain}: ${c.mergedContent.slice(0, 80)}...`);

    const digestPath = await this.digestGenerator.save(stats, promotedSeeds, soupHighlights);

    // Stage 7: Prune (clear heap)
    const seedsBeforePrune = await this.seedBank.count();
    // Inputs whose extraction failed produced nothing; keep them in the heap
    // so they are retried (and visible) instead of being silently discarded.
    await this.heap.purge(stats.retainedInHeap);
    await this.seedBank.pruneOld();
    const seedsAfterPrune = await this.seedBank.count();
    if (seedsBeforePrune > seedsAfterPrune) {
      this.projectStore?.recordSeedPrune(seedsBeforePrune - seedsAfterPrune, this.config.nuggetRetentionDays);
    }

    // Record digest_end event
    this.projectStore?.recordDigestEnd(stats, promotedSeeds);

    // Harvest entropy from this digest cycle
    if (this.entropy) {
      const entropyResult = await this.entropy.harvest();
      if (entropyResult.source === 'fallback') {
        this.projectStore?.recordEntropyFallback?.(entropyResult);
      } else {
        this.projectStore?.recordEntropyHarvest?.(entropyResult);
      }
    }

    // Save a snapshot of the current state
    const allSeeds = await this.seedBank.getAll();
    this.projectStore?.saveSnapshot(allSeeds, 0);

    eventBus.emit(EventTypes.PROCESS_END, 'CompostMill', { process: 'compost-digest', success: true, durationMs: Date.now() - startTime, filesProcessed: stats.filesProcessed, fragmentCount: stats.fragmentCount, seedsPromoted: stats.seedsPromoted });

    return { stats, seeds: promotedSeeds, digestPath };
  }

  /** Extract all files through the three layers, throttled to avoid rate limits. */
  private async extractAll(filePaths: string[]): Promise<{ results: ExtractionResult[]; failures: DigestFailure[] }> {
    const results: ExtractionResult[] = [];
    const failures: DigestFailure[] = [];
    const settled = await RetryManager.mapSettled(
      filePaths,
      async (filePath) => {
        const metadata = await MetadataExtractor.extract(filePath);
        const rawBytes = await RawByteProcessor.process(filePath);
        const semantic = await this.semanticExtractor.extract(filePath);
        const lir = await this.semanticExtractor.extractLIR(filePath);
        return { filePath, semantic, metadata, rawBytes, lir: lir ?? undefined };
      },
      8, // max 8 concurrent extractions (local LLM sweet spot for 9B model)
    );

    settled.forEach((entry, i) => {
      if (entry.status === 'fulfilled') {
        results.push(entry.value as ExtractionResult);
      } else {
        failures.push({ filePath: filePaths[i], stage: 'extract', error: errorMessage(entry.reason) });
      }
    });
    return { results, failures };
  }

  /** Start the soup loop, feeding it seeds from the seed bank as fragments. */
  async startSoup(): Promise<void> {
    if (!this.soup) {
      if (!this.entropy) {
        throw new Error('CompostMill: entropy engine is required when soup is enabled');
      }
      this.soup = new CompostSoup(this.config, this.llm, this.entropy);
    }
    // Record soup_start event
    this.projectStore?.recordSoupStart(this.config.soupPopulationSize);
    // Load seeds from the seed bank and convert to fragments for the soup
    const seeds = await this.seedBank.getAll();
    const soupRunId = `soup:${new Date().toISOString()}`;
    await this.seedBank.recordReuse(seeds.map(s => s.id), 'retrieved', soupRunId);
    await this.seedBank.recordReuse(seeds.map(s => s.id), 'injected', soupRunId);
    const fragments: CompostFragment[] = seeds.map(seed => ({
      id: seed.id,
      source: `seed:${seed.id}`,
      domain: seed.source.domains[0] ?? 'unknown',
      layer: 'semantic' as const,
      content: seed.content,
      score: seed.score,
      metadata: {
        fileType: 'seed',
        timestamp: seed.promotedAt,
        hash: compostContentDigest(seed.content),
        size: seed.content.length,
        extractedAt: seed.promotedAt,
      },
      tags: [...seed.source.domains, 'seed'],
      provenance: seed.provenance,
    }));
    await this.soup.run(fragments);
  }

  /** Stop the soup loop. */
  stopSoup(): void {
    this.soup?.stop();
    this.projectStore?.recordSoupStop(0, 0);
  }

  /** Get the ProjectStore for event history access (CLI commands). */
  getProjectStore(): ProjectStore | undefined {
    return this.projectStore;
  }

  /** Get current heap file paths. */
  async getHeapFiles(): Promise<string[]> {
    return this.heap.listFiles();
  }

  /** List all seeds sorted by score. */
  /** Seed reuse funnel metric (#1301); reuse is not a quality score. */
  async seedReuseMetrics(): ReturnType<SeedBank['reuseMetrics']> {
    return this.seedBank.reuseMetrics();
  }

  async listSeeds(): Promise<Seed[]> {
    return this.seedBank.getAll();
  }

  /** Get top N seeds by score. */
  async getTopSeeds(n: number): Promise<Seed[]> {
    return this.seedBank.getTop(n);
  }

  /** Get seed count. */
  async getSeedCount(): Promise<number> {
    return this.seedBank.count();
  }

  /** Exploration projections do not grant generation teaching. */
  getGenerationMaterials(_domainHint?: string, _topK = 5): Promise<import('./types.js').GenerationMaterials> {
    const seeds: Seed[] = [];
    return Promise.resolve({ seeds, dna: [], seedCount: 0, dnaCount: 0 });
  }

  /** Get current mill status. */
  async statusAsync(): Promise<MillStatus> {
    const [heapSize, heapFiles, seedCount] = await Promise.all([
      this.heap.getHeapSize(),
      this.heap.listFiles(),
      this.seedBank.count(),
    ]);
    return {
      heapSize,
      heapFileCount: heapFiles.length,
      seedCount,
      soupRunning: this.soup?.isRunning() ?? false,
      soupGeneration: 0,
      lastDigestAt: null,
    };
  }

  /** Check if auto-digestion should trigger. */
  async shouldAutoDigest(): Promise<boolean> {
    return this.heap.isOverCapacity();
  }

  /** Get the last motif index result from digest. */
  getMotifIndex(): MotifIndexResult | null {
    return this.lastMotifIndex;
  }

  /** Get rehydrated candidates from last digest. */
  getRehydratedCandidates(): RehydratedCandidate[] {
    return this.lastRehydratedCandidates;
  }
}
