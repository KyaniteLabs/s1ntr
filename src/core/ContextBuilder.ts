/**
 * ContextBuilder - Build context for injection into prompts
 *
 * This context changes each iteration, providing the "world that changes"
 * while the prompt stays the same.
 *
 * Extracted from RalphLoop.ts (buildContextForInjection).
 * Now with semantic similarity for seed retrieval.
 */

import { ContextAccumulation } from './ContextAccumulation.js';
import type { IterationContext } from './LoopConfig.js';
import { createHash } from 'node:crypto';
import { MapElites } from '../evolution/MapElites.js';
import { NoveltyArchive } from '../evolution/NoveltyArchive.js';
import { SeedBank } from '../compost/SeedBank.js';
import type { EmbeddedSeed } from '../compost/SeedBank.js';
// Seed type is now imported from SeedBank.js as EmbeddedSeed
import { EmbeddingService } from '../embeddings/EmbeddingService.js';
import { cosineSimilarity } from '../utils/vectors.js';

/**
 * Archive sources for enriching generation context
 */
export interface ArchiveSources {
  mapElites?: MapElites;
  noveltyArchive?: NoveltyArchive;
  seedBank?: SeedBank;
  /** Optional embedding service for semantic similarity */
  embeddingService?: EmbeddingService;
}

/**
 * Archive retrieval options
 */
export interface ArchiveRetrievalOptions {
  /** Number of diverse elites to retrieve from MapElites */
  diverseEliteCount?: number;
  /** Number of novel examples to retrieve from NoveltyArchive */
  novelExampleCount?: number;
  /** Number of relevant seeds to retrieve from SeedBank */
  relevantSeedCount?: number;
  /** Whether to use semantic similarity for seed retrieval (default: true) */
  useSemanticSearch?: boolean;
  /** Minimum similarity threshold for semantic search (0-1) */
  similarityThreshold?: number;
}

/**
 * Build context for injection into prompt
 */
export function buildContextForInjection(
  iteration: number,
  options: {
    seedCode?: string;
    seedTemplate?: string;
    maxContextLength?: number;
    lastKIterations?: number;
    visualMappingParams?: Record<string, any>;
    maxIterations?: number;
  },
  _prompt?: string,
  _loadedPrompt?: string,
  previousCode?: string,
  archives?: ArchiveSources,
  archiveOptions?: ArchiveRetrievalOptions
): string {
  let history = ContextAccumulation.getHistory();

  if (
    options.lastKIterations != null &&
    options.lastKIterations > 0 &&
    history.length > options.lastKIterations
  ) {
    history = history.slice(-options.lastKIterations);
  }

  let base: string;
  if (history.length === 0) {
    base = `Iteration: ${iteration}\nNo previous context available.`;
  } else {
    const contextParts: string[] = [
      `Current iteration: ${iteration} of ${options.maxIterations ?? 5}`,
    ];
    contextParts.push(`\nPrevious iterations: ${history.length}`);

    // Add cache-defeating elements to ensure fresh LLM output each iteration
    contextParts.push(`\nTimestamp: ${Date.now()}`);
    contextParts.push(
      `Random seed: ${Math.random().toString(36).substring(2, 10)}`
    );

    const mostRecent = history[history.length - 1];
    contextParts.push(`\nLast iteration (${mostRecent.iteration}):`);
    contextParts.push(`- Quality score: ${mostRecent.evaluation.score.toFixed(2)}`);
    contextParts.push(`- Code length: ${mostRecent.code.length} characters`);

    if (
      mostRecent.evaluation.issues &&
      mostRecent.evaluation.issues.length > 0
    ) {
      contextParts.push(
        `- Issues to address: ${mostRecent.evaluation.issues.join(', ')}`
      );
    }

    // Add hash of previous code to defeat LLM caching
    const codeToHash = previousCode || mostRecent.code;
    const codeHash = createHash('sha256')
      .update(codeToHash)
      .digest('hex')
      .substring(0, 16);
    contextParts.push(`- Previous output hash: ${codeHash}`);

    const codeSnippet = mostRecent.code.substring(0, 500);
    if (codeSnippet.length > 0) {
      contextParts.push(`\nPrevious code (first 500 chars):\n${codeSnippet}`);
    }

    if (history.length > 1) {
      const scores = history.map((h: IterationContext) => h.evaluation.score);
      const avgScore =
        scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
      const improving = scores[scores.length - 1] > scores[0];
      contextParts.push(`\nQuality trend:`);
      contextParts.push(`- Average score: ${avgScore.toFixed(2)}`);
      contextParts.push(`- Trend: ${improving ? 'Improving' : 'Declining'}`);
    }

    base = contextParts.join('\n');
  }

  let context = base;
  if (
    iteration === 1 &&
    (options.seedCode != null || options.seedTemplate != null)
  ) {
    const seed = options.seedCode ?? options.seedTemplate ?? '';
    context =
      "Here is the seed/template; improve it toward the user's goal.\nSeed:\n" +
      seed +
      '\n\n' +
      context;
  }

  // Append audio-derived visual parameters if provided
  if (options.visualMappingParams) {
    const vp = options.visualMappingParams;
    context += '\n\nAudio-derived visual parameters:\n';
    if (vp.palette) {
      context +=
        '  Palette: hues=' +
        JSON.stringify(vp.palette.hues) +
        ', saturations=' +
        JSON.stringify(vp.palette.saturations) +
        ', lightness=' +
        JSON.stringify(vp.palette.lightness) +
        '\n';
    }
    if (vp.motion) {
      context +=
        '  Motion: speed=' +
        vp.motion.speed +
        ', turbulence=' +
        vp.motion.turbulence +
        ', rhythm=' +
        vp.motion.rhythm +
        '\n';
    }
    if (vp.form) {
      context +=
        '  Form: complexity=' +
        vp.form.complexity +
        ', sharpness=' +
        vp.form.sharpness +
        ', scale=' +
        vp.form.scale +
        '\n';
    }
    if (vp.dynamics) {
      context += '  Dynamics: energy=' + vp.dynamics.energy + '\n';
    }
    if (vp.composition) {
      context +=
        '  Composition: focalWeight=' +
        vp.composition.focalWeight +
        ', balance=' +
        vp.composition.balance +
        '\n';
    }
  }

  // Append archived examples if archives are provided
  const archiveContext = buildArchiveContext(archives, archiveOptions);
  if (archiveContext) {
    context += '\n\n' + archiveContext;
  }

  if (
    options.maxContextLength != null &&
    options.maxContextLength > 0 &&
    context.length > options.maxContextLength
  ) {
    context = context.slice(-options.maxContextLength);
  }

  return context;
}

/**
 * Build context section from archive sources.
 * Retrieves diverse elites, novel examples, and relevant seeds.
 */
function buildArchiveContext(
  archives?: ArchiveSources,
  _options?: ArchiveRetrievalOptions
): string | null {
  if (!archives) return null;

  const parts: string[] = [];

  // MAP-Elites rank is exploration telemetry, never Create-time teaching.

  // Novelty vectors are retained for exploration, never used as creative instruction.

  // SeedBank retrieval is handled separately via injectSeedBankContext()
  // (async seed bank ops are injected after initial context assembly)

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Format seeds for inclusion in context.
 */
export function formatSeedsForContext(seeds: EmbeddedSeed[]): string {
  if (seeds.length === 0) return '';

  const parts: string[] = ['Relevant seeds from archive:'];
  seeds.forEach((seed, idx) => {
    const preview =
      seed.content.length > 100
        ? seed.content.substring(0, 100) + '...'
        : seed.content;
    const similarity = seed.embedding
      ? `(Embedding: ${seed.embeddingModel ?? 'unknown'})`
      : '';
    parts.push(
      `  ${idx + 1}. "${preview}" (Score: ${seed.score.toFixed(1)}, Domains: ${seed.source.domains.join(', ')}) ${similarity}`
    );
  });

  return parts.join('\n');
}

/**
 * Preserve the Promise API while excluding exploration seeds from teaching.
 */
export function retrieveSeedBankContext(
  seedBank: SeedBank | undefined,
  _prompt: string,
  topK: number,
  _options?: {
    useSemanticSearch?: boolean;
    similarityThreshold?: number;
    embeddingService?: EmbeddingService;
  }
): Promise<string> {
  return new Promise(resolve => {
    if (!seedBank || topK <= 0) return resolve('');
    // Activated Dream knowledge is compiled elsewhere; rank, relevance,
    // and embeddings cannot grant teaching.
    resolve('');
  });
}

/**
 * Find seeds similar to a given embedding.
 * @param seedBank - The seed bank to search
 * @param queryEmbedding - Query embedding vector
 * @param topK - Number of similar seeds to return
 * @returns Array of similar seeds with similarity scores
 */
export async function findSimilarSeedsByEmbedding(
  seedBank: SeedBank,
  queryEmbedding: number[],
  topK: number
): Promise<Array<{ seed: EmbeddedSeed; similarity: number }>> {
  const allSeeds = await seedBank.getAll();

  const scored = allSeeds
    .filter((s) => s.embedding && s.embedding.length > 0)
    .map((seed) => ({
      seed,
      similarity: cosineSimilarity(queryEmbedding, seed.embedding!),
    }));

  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}
