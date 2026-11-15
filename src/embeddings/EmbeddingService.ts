/**
 * EmbeddingService - Text-to-vector embedding interface.
 * Uses local embeddings via @xenova/transformers (Sentence-BERT), or
 * OpenAI text-embedding-ada-002 when `useLocal` is false. There is no
 * automatic fallback: if local initialization fails, embed() rejects with
 * that error instead of silently substituting the OpenAI provider.
 */

import { createHash } from 'node:crypto';
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import { Logger } from '../utils/Logger.js';
import { authorizeProviderInvocation, completeProviderInvocation } from '../llm/PreSpendInterlock.js';

/** Configuration for embedding service */
export interface EmbeddingConfig {
  /** Model to use for local embeddings */
  localModel?: string;
  /** OpenAI API key; used only when `useLocal` is false (not a fallback) */
  openAIApiKey?: string;
  /** OpenAI embedding model */
  openAIModel?: string;
  /** Maximum text length to embed */
  maxLength?: number;
  /** Whether to use local embeddings (default: true) */
  useLocal?: boolean;
  /** Model revision for local weights (default: 'main'); part of the cache identity */
  localRevision?: string;
  /** Maximum cached embeddings; least-recently-used entries are evicted (default: 10000) */
  maxCacheSize?: number;
}

/** Embedding result with metadata */
export interface EmbeddingResult {
  /** The embedding vector */
  vector: number[];
  /** Model used for embedding */
  model: string;
  /** Dimension of the embedding */
  dimension: number;
  /** Whether the embedding was cached */
  cached: boolean;
  /** Immutable record of what produced this vector (#1272) */
  descriptor: EmbeddingDescriptor;
}

/** Provenance of an embedding: provider, weights revision and input truncation. */
export interface EmbeddingDescriptor {
  provider: 'local' | 'openai';
  model: string;
  /** Local weights revision; undefined for remote providers */
  revision?: string;
  /** Character cap applied before embedding */
  maxLength: number;
  /** Characters in the caller's input */
  inputChars: number;
  /** True when the input was cut to maxLength characters */
  truncated: boolean;
}

type TransformersModule = typeof import('@xenova/transformers');

let transformersModulePromise: Promise<TransformersModule> | null = null;

async function loadTransformers(): Promise<TransformersModule> {
  // @xenova/transformers loads native optional image dependencies on import.
  // Keep that out of ordinary CLI startup unless local embeddings are used.
  transformersModulePromise ??= import('@xenova/transformers');
  return transformersModulePromise;
}

/**
 * Service for generating text embeddings.
 * Uses local Sentence-BERT models via @xenova/transformers, or OpenAI
 * when `useLocal` is false. Local failures are reported, never substituted.
 */
export class EmbeddingService {
  private config: Required<EmbeddingConfig>;
  private localPipeline: FeatureExtractionPipeline | null = null;
  private cache: Map<string, EmbeddingResult> = new Map();
  private initialized = false;
  private observedDimension: number | undefined;
  private initPromise: Promise<void> | null = null;

  // Default to all-MiniLM-L6-v2 - good balance of speed and quality
  private static readonly DEFAULT_LOCAL_MODEL =
    'Xenova/all-MiniLM-L6-v2';
  private static readonly DEFAULT_OPENAI_MODEL =
    'text-embedding-ada-002';
  private static readonly DEFAULT_MAX_LENGTH = 512;
  private static readonly DEFAULT_MAX_CACHE_SIZE = 10_000;
  private static readonly KNOWN_DIMENSIONS: Readonly<Record<string, number>> = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'text-embedding-ada-002': 1536,
  };
  // Bound parallel embeddings in embedBatch so a large input doesn't issue
  // unbounded concurrent inference calls.
  private static readonly DEFAULT_BATCH_CONCURRENCY = 8;

  constructor(config: EmbeddingConfig = {}) {
    this.config = {
      localModel:
        config.localModel ?? EmbeddingService.DEFAULT_LOCAL_MODEL,
      openAIApiKey: config.openAIApiKey ?? '',
      openAIModel:
        config.openAIModel ?? EmbeddingService.DEFAULT_OPENAI_MODEL,
      maxLength: config.maxLength ?? EmbeddingService.DEFAULT_MAX_LENGTH,
      useLocal: config.useLocal ?? true,
      localRevision: config.localRevision ?? 'main',
      maxCacheSize: Math.max(0, Math.floor(
        config.maxCacheSize ?? EmbeddingService.DEFAULT_MAX_CACHE_SIZE,
      )),
    };
  }

  /**
   * Initialize the embedding pipeline.
   * Must be called before embed() if lazy initialization is disabled.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Prevent concurrent initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      if (this.config.useLocal) {
        Logger.info(
          'EmbeddingService',
          `Loading local model: ${this.config.localModel}`
        );
        const { pipeline } = await loadTransformers();
        this.localPipeline = await pipeline(
          'feature-extraction',
          this.config.localModel,
          {
            revision: this.config.localRevision,
            quantized: true, // Use quantized model for faster inference
          }
        );
        Logger.info(
          'EmbeddingService',
          'Local embedding model loaded successfully'
        );
      }
      this.initialized = true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      Logger.error(
        'EmbeddingService',
        `Failed to initialize local model: ${message}`
      );
      // Clear initPromise so initialization can be retried
      this.initPromise = null;
      throw error;
    }
  }

  /**
   * Generate embedding for a text string.
   * @param text - Text to embed
   * @param useCache - Whether to use caching (default: true)
   * @returns Embedding vector
   */
  async embed(
    text: string,
    useCache = true
  ): Promise<EmbeddingResult> {
    // Check cache first
    const cacheKey = this.getCacheKey(text);
    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        // Refresh recency so eviction is least-recently-used.
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return { ...cached, cached: true };
      }
    }

    // Ensure initialization
    if (!this.initialized) {
      await this.initialize();
    }

    // Truncate text if needed
    const truncatedText = this.truncateText(text);

    let result: EmbeddingResult;

    // Try local embeddings first
    if (this.config.useLocal && this.localPipeline) {
      result = await this.embedLocal(truncatedText);
    } else if (this.config.openAIApiKey) {
      result = await this.embedOpenAI(truncatedText);
    } else {
      throw new Error(
        'No embedding provider available. ' +
          'Enable local embeddings or provide OpenAI API key.'
      );
    }
    result.descriptor = Object.freeze({
      ...result.descriptor,
      maxLength: this.config.maxLength,
      inputChars: text.length,
      truncated: truncatedText.length < text.length,
    });
    if (this.observedDimension !== undefined && this.observedDimension !== result.dimension) {
      throw new Error(
        `Embedding dimension drift: expected ${this.observedDimension}, got ${result.dimension}`,
      );
    }
    this.observedDimension = result.dimension;

    // Cache the result
    if (useCache && this.config.maxCacheSize > 0) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, { ...result, cached: false });
      while (this.cache.size > this.config.maxCacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }

    return result;
  }

  /**
   * Generate embeddings for multiple texts in batch.
   *
   * Texts are processed in bounded-concurrency chunks (Promise.all per chunk)
   * so a large input no longer blocks on a fully serial loop, while still
   * capping the number of in-flight inference calls. Order is preserved.
   *
   * @param texts - Array of texts to embed
   * @param concurrency - Max embeddings computed in parallel per chunk (default 8)
   * @returns Array of embedding results, in the same order as `texts`
   */
  async embedBatch(
    texts: string[],
    concurrency = EmbeddingService.DEFAULT_BATCH_CONCURRENCY,
  ): Promise<EmbeddingResult[]> {
    // Ensure initialization once, before fanning out, so concurrent embed()
    // calls don't each race on doInitialize().
    if (!this.initialized) {
      await this.initialize();
    }

    const batchSize = Math.max(1, concurrency);
    const results: EmbeddingResult[] = new Array(texts.length);

    for (let start = 0; start < texts.length; start += batchSize) {
      const chunk = texts.slice(start, start + batchSize);
      const chunkResults = await Promise.all(
        chunk.map((text) => this.embed(text)),
      );
      for (let i = 0; i < chunkResults.length; i++) {
        results[start + i] = chunkResults[i];
      }
    }

    return results;
  }

  private async embedLocal(text: string): Promise<EmbeddingResult> {
    if (!this.localPipeline) {
      throw new Error('Local pipeline not initialized');
    }

    const output = await this.localPipeline(text, {
      pooling: 'mean',
      normalize: true,
    });

    // Extract vector from Tensor output
    const vector = Array.from(output.data as Float32Array).map((v) =>
      Number(v)
    );

    return {
      vector,
      model: this.config.localModel,
      dimension: vector.length,
      cached: false,
      descriptor: {
        provider: 'local', model: this.config.localModel, revision: this.config.localRevision,
        maxLength: this.config.maxLength, inputChars: text.length, truncated: false,
      },
    };
  }

  private async embedOpenAI(text: string): Promise<EmbeddingResult> {
    const callId = authorizeProviderInvocation({
      provider: 'openai',
      model: this.config.openAIModel,
      request: { systemPrompt: 'Generate a text embedding.', userPrompt: text },
    });
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.openAIApiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: this.config.openAIModel,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        completeProviderInvocation(callId, 'error');
        throw new Error(`OpenAI API error: ${error}`);
      }

      const data = await response.json();
      const vector = data.data[0].embedding as number[];
      completeProviderInvocation(callId, 'success', {
        inputTokens: Number(data.usage?.prompt_tokens ?? 0), outputTokens: 0,
      });

      return {
        vector, model: this.config.openAIModel, dimension: vector.length, cached: false,
        descriptor: {
          provider: 'openai', model: this.config.openAIModel,
          maxLength: this.config.maxLength, inputChars: text.length, truncated: false,
        },
      };
    } catch (error) {
      const pending = callId;
      try { completeProviderInvocation(pending, 'error'); } catch { /* already completed */ }
      throw error;
    }
  }

  private truncateText(text: string): string {
    // Simple truncation by character count
    // More sophisticated truncation could use tokenization
    if (text.length <= this.config.maxLength) {
      return text;
    }
    return text.slice(0, this.config.maxLength);
  }

  /**
   * Content + model/config identity. A 32-bit text-only hash collided across
   * texts and let a vector from one model/revision/truncation serve another.
   */
  private getCacheKey(text: string): string {
    const identity = this.config.useLocal
      ? { provider: 'local', model: this.config.localModel, revision: this.config.localRevision }
      : { provider: 'openai', model: this.config.openAIModel };
    return createHash('sha256')
      .update(JSON.stringify({ ...identity, maxLength: this.config.maxLength, text }))
      .digest('hex');
  }

  /**
   * Get the dimension of embeddings produced by this service.
   * Requires initialization first.
   * @returns Embedding dimension
   */
  getDimension(): number {
    if (this.observedDimension !== undefined) return this.observedDimension;
    // Before any vector is observed, only the default models have a known
    // dimension. Guessing for a configured model would misreport it (#1271).
    const model = this.config.useLocal ? this.config.localModel : this.config.openAIModel;
    const known = EmbeddingService.KNOWN_DIMENSIONS[model];
    if (known === undefined) {
      throw new Error(`Embedding dimension for model '${model}' is unknown until an embedding is produced`);
    }
    return known;
  }

  /**
   * Clear the embedding cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   * @returns Cache size and hit rate info
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxCacheSize,
    };
  }
}

/** Singleton instance for global use */
let globalEmbeddingService: EmbeddingService | null = null;

/**
 * Get or create the global embedding service instance.
 * @param config - Optional configuration
 * @returns Global embedding service
 */
export function getGlobalEmbeddingService(
  config?: EmbeddingConfig
): EmbeddingService {
  if (!globalEmbeddingService) {
    globalEmbeddingService = new EmbeddingService(config);
  }
  return globalEmbeddingService;
}

/**
 * Reset the global embedding service instance.
 * Useful for testing.
 */
export function resetGlobalEmbeddingService(): void {
  globalEmbeddingService = null;
}
