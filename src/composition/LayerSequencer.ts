/**
 * LayerSequencer - Sequential layer generation with context passing.
 *
 * Generates layers in sequence, passing context from earlier to later layers.
 * Supports parallel generation where safe, optimal ordering, and rollback on failure.
 */

import type { TierBasedGenerator } from '../generators/TierBasedGenerator.js';
import { DomainType, Layer } from './types.js';

/** Error thrown when generation is aborted */
export class AbortError extends Error {
  constructor(message = 'Generation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** One layer to generate through a governed generator. */
export interface GovernedLayerRequest {
  readonly domain: DomainType;
  /** This layer's own prompt (from `layerPrompts`, else the shared base prompt). */
  readonly prompt: string;
  /** Position of this layer in the `domains` argument (not the generation order). */
  readonly index: number;
  /** Layers already generated, in generation order. */
  readonly context: readonly Layer[];
  readonly signal?: AbortSignal;
}

/** Generates one layer through a governed path (e.g. CompositionOrchestrator.generateGovernedLayer). */
export type GovernedLayerGenerator = (request: GovernedLayerRequest) => Promise<Layer>;

/** Options for LayerSequencer */
export interface LayerSequencerOptions {
  /** Map of domain types to their generators */
  generators: Map<DomainType, TierBasedGenerator>;

  /**
   * Per-layer prompts, aligned with the `domains` argument. A missing entry falls back to the base
   * prompt, so the original one-prompt call keeps working.
   */
  layerPrompts?: readonly string[];

  /**
   * Governed generator used instead of `generators`. It owns provider governance, vendor inlining
   * inputs and the seam guard; the sequencer only orders, passes context and collects failures.
   */
  generate?: GovernedLayerGenerator;

  /** Append "Context from previous layers" to each prompt (default: true; the layered build turns it off, its prompts carry the shared contract). */
  passContext?: boolean;

  /** Progress callback - called when each layer completes */
  onProgress?: (completed: number, total: number) => void;

  /** Whether to continue on error (default: true) */
  continueOnError: boolean;

  /** Whether to rollback all layers on any error (default: false) */
  rollbackOnError: boolean;

  /** Whether to optimize generation order (base layers first) (default: true) */
  optimizeOrder: boolean;

  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/** Result of a sequencer operation */
export interface SequencerResult {
  /** Successfully generated layers */
  layers: Layer[];

  /** Errors that occurred during generation */
  errors: Array<{ domain: DomainType; error: Error; index?: number }>;

  /** Indices (into the `domains` argument) in the order layers were attempted. */
  generationOrder?: number[];
}

/** A task for parallel generation */
interface ParallelTask {
  /** Domain type to generate */
  domain: DomainType;

  /** Prompt for generation */
  prompt: string;
}

/** Domain categories for ordering optimization */
const DOMAIN_CATEGORIES: Record<string, number> = {
  // Base visual layers (render first)
  p5: 1,
  three: 1,
  shader: 1,
  ascii: 1,

  // Audio layers (can work in parallel with visual)
  tone: 2,
  strudel: 2,

  // Video/effects layers (render after base)
  hydra: 3,
  revideo: 3,

  // Text/content layers (usually on top)
  html: 4,
  textgen: 4,
  kinetic: 4,

  // Hybrid-path domains
  glsl: 1,
  nbe: 1,
  svg: 2,
  custom: 3,
};

/**
 * LayerSequencer manages sequential layer generation with context passing.
 */
export class LayerSequencer {
  private abortController?: AbortController;

  /**
   * Generate layers sequentially, passing context from earlier to later layers.
   *
   * @param prompt - Base prompt for generation
   * @param domains - Ordered list of domain types to generate
   * @param options - Sequencer options
   * @returns Result with layers and any errors
   */
  async generateLayers(
    prompt: string,
    domains: DomainType[],
    options: Partial<LayerSequencerOptions> = {}
  ): Promise<SequencerResult> {
    const opts = this.normalizeOptions(options);
    const result: SequencerResult = { layers: [], errors: [] };

    // Handle empty domains
    if (domains.length === 0) {
      return result;
    }

    // Check for abort before starting
    if (opts.signal?.aborted) {
      result.errors.push({
        domain: domains[0],
        error: new AbortError(),
      });
      return result;
    }

    // Pair each domain with its input index and prompt, then order (stable sort keeps ties in input order)
    const entries = domains.map((domain, index) => ({
      domain, index, prompt: opts.layerPrompts?.[index] ?? prompt,
    }));
    const orderedEntries = opts.optimizeOrder
      ? [...entries].sort((a, b) => (DOMAIN_CATEGORIES[a.domain] || 99) - (DOMAIN_CATEGORIES[b.domain] || 99))
      : entries;
    const orderedDomains = orderedEntries.map((e) => e.domain);
    result.generationOrder = [];

    // Track context from previous layers
    const context: Layer[] = [];

    for (let i = 0; i < orderedDomains.length; i++) {
      const domain = orderedDomains[i];
      const entry = orderedEntries[i];
      result.generationOrder.push(entry.index);

      // Check for abort before processing
      if (opts.signal?.aborted) {
        result.errors.push({
          domain,
          error: new AbortError(),
        });

        // Rollback if configured
        if (opts.rollbackOnError) {
          return { layers: [], errors: result.errors };
        }

        if (!opts.continueOnError) {
          break;
        }
        continue;
      }

      try {
        let layer: Layer;
        if (opts.generate) {
          const generate = opts.generate;
          const governedPrompt = opts.passContext === false ? entry.prompt : this.enhancePrompt(entry.prompt, context);
          layer = await this.generateWithAbort(
            () => generate({ domain, prompt: governedPrompt, index: entry.index, context: [...context], signal: opts.signal }),
            opts.signal
          );
        } else {
          // Get generator for this domain
          const generator = opts.generators.get(domain);
          if (!generator) {
            throw new Error(`No generator registered for domain: ${domain}`);
          }

          // Enhance prompt with context from previous layers
          const enhancedPrompt = opts.passContext === false ? entry.prompt : this.enhancePrompt(entry.prompt, context);

          // Generate layer with abort support
          layer = await this.generateWithAbort(
            () => generator.generateLayer(enhancedPrompt),
            opts.signal
          );
        }

        // Validate layer
        if (!this.isValidLayer(layer)) {
          throw new Error(`Generator for ${domain} returned invalid layer`);
        }

        // Add to results and context
        result.layers.push(layer);
        context.push(layer);

        // Report progress
        opts.onProgress?.(result.layers.length, orderedDomains.length);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        result.errors.push({ domain, error: err, index: entry.index });

        // Rollback if configured
        if (opts.rollbackOnError) {
          return { layers: [], errors: result.errors };
        }

        // Stop if not continuing on error
        if (!opts.continueOnError) {
          break;
        }
      }
    }

    return result;
  }

  /**
   * Generate multiple layers in parallel.
   * Use this when domains have no dependencies on each other.
   *
   * @param tasks - Array of generation tasks
   * @param options - Sequencer options
   * @returns Result with layers and any errors
   */
  async generateParallel(
    tasks: ParallelTask[],
    options: Partial<LayerSequencerOptions> = {}
  ): Promise<SequencerResult> {
    const opts = this.normalizeOptions(options);
    const result: SequencerResult = { layers: [], errors: [] };

    if (tasks.length === 0) {
      return result;
    }

    // Check for abort before starting
    if (opts.signal?.aborted) {
      return {
        layers: [],
        errors: tasks.map((t) => ({
          domain: t.domain,
          error: new AbortError(),
        })),
      };
    }

    // Track completed count for progress
    let completedCount = 0;
    const reportProgress = () => {
      completedCount++;
      opts.onProgress?.(completedCount, tasks.length);
    };

    // Create promises for all tasks
    const promises = tasks.map(async (task) => {
      // Check for abort
      if (opts.signal?.aborted) {
        return {
          success: false as const,
          domain: task.domain,
          error: new AbortError(),
        };
      }

      const generator = opts.generators.get(task.domain);
      if (!generator) {
        reportProgress();
        return {
          success: false as const,
          domain: task.domain,
          error: new Error(`No generator registered for domain: ${task.domain}`),
        };
      }

      try {
        const layer = await generator.generateLayer(task.prompt);

        if (!this.isValidLayer(layer)) {
          throw new Error(`Generator for ${task.domain} returned invalid layer`);
        }

        reportProgress();
        return { success: true as const, layer };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        reportProgress();
        return { success: false as const, domain: task.domain, error: err };
      }
    });

    // Wait for all to complete
    const results = await Promise.all(promises);

    // Collect results
    for (const r of results) {
      if (r.success) {
        result.layers.push(r.layer);
      } else {
        result.errors.push({
          domain: r.domain as DomainType,
          error: r.error,
        });
      }
    }

    // Rollback if any errors and configured to do so
    if (opts.rollbackOnError && result.errors.length > 0) {
      return { layers: [], errors: result.errors };
    }

    return result;
  }

  /**
   * Abort any ongoing generation.
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Wrap a promise with abort support.
   * Rejects with AbortError if signal is aborted.
   */
  private generateWithAbort<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }

      // Set up abort listener
      const abortHandler = () => {
        reject(new AbortError());
      };

      signal?.addEventListener('abort', abortHandler, { once: true });

      // Execute the function
      fn()
        .then((result) => {
          signal?.removeEventListener('abort', abortHandler);
          resolve(result);
        })
        .catch((error) => {
          signal?.removeEventListener('abort', abortHandler);
          reject(error);
        });
    });
  }

  /**
   * Normalize options with defaults.
   */
  private normalizeOptions(
    options: Partial<LayerSequencerOptions>
  ): LayerSequencerOptions {
    return {
      generators: options.generators || new Map(),
      layerPrompts: options.layerPrompts,
      generate: options.generate,
      passContext: options.passContext,
      onProgress: options.onProgress,
      continueOnError: options.continueOnError ?? true,
      rollbackOnError: options.rollbackOnError ?? false,
      optimizeOrder: options.optimizeOrder ?? true,
      signal: options.signal,
    };
  }

  /**
   * Enhance a prompt with context from previous layers.
   */
  private enhancePrompt(basePrompt: string, contextLayers: Layer[]): string {
    if (contextLayers.length === 0) {
      return basePrompt;
    }

    const contextParts: string[] = [];

    for (const layer of contextLayers) {
      const summary = this.summarizeLayer(layer);
      contextParts.push(`[${layer.type}]: ${summary}`);
    }

    return `${basePrompt}

Context from previous layers:
${contextParts.join('\n')}`;
  }

  /**
   * Create a summary of a layer for context enhancement.
   */
  private summarizeLayer(layer: Layer): string {
    // Use first line of code or first 100 chars as summary
    const codeSummary = layer.code
      .split('\n')
      .find((line: string) => line.trim().length > 0);

    return codeSummary?.slice(0, 100) || 'No code summary available';
  }

  /**
   * Optimize domain order for optimal generation.
   * Base visual layers first, then audio, then effects.
   */
  orderDomains(domains: DomainType[]): DomainType[] {
    return this.optimizeDomainOrder(domains);
  }

  private optimizeDomainOrder(domains: DomainType[]): DomainType[] {
    return [...domains].sort((a, b) => {
      const priorityA = DOMAIN_CATEGORIES[a] || 99;
      const priorityB = DOMAIN_CATEGORIES[b] || 99;
      return priorityA - priorityB;
    });
  }

  /**
   * Validate that a layer has all required fields.
   */
  private isValidLayer(layer: unknown): layer is Layer {
    if (!layer || typeof layer !== 'object') {
      return false;
    }

    const l = layer as Record<string, unknown>;

    return (
      typeof l.id === 'string' &&
      typeof l.type === 'string' &&
      typeof l.code === 'string' &&
      typeof l.config === 'object' &&
      l.config !== null &&
      typeof l.metadata === 'object' &&
      l.metadata !== null &&
      typeof l.enabled === 'boolean' &&
      typeof l.locked === 'boolean'
    );
  }
}
