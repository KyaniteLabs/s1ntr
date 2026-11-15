import { CompostMill } from './CompostMill.js';
import { mergeConfig } from './defaults.js';
import type { CompostConfig } from './types.js';
import type { ProjectStore } from './ProjectStore.js';
import type { ModelRouter } from './ModelRouter.js';
import type { MetabolicEntropyEngine } from '../entropy/MetabolicEntropyEngine.js';
import type { CompostParser } from '../core/parsing/CompostParser.js';
import type { LLMClientLike } from './SemanticExtractor.js';

export interface OpenCompostMillOptions {
  llm: LLMClientLike;
  fastLLM?: LLMClientLike;
  projectStore?: ProjectStore;
  modelRouter?: ModelRouter;
  parser?: CompostParser;
  /** Explicit overrides applied on top of the compost defaults. */
  config?: Partial<CompostConfig>;
  /**
   * Soup is a long-lived background cycle. It is opt-in here because the
   * default config enables it, while most callers only need heap/seed reads
   * or a digest and have no entropy engine to power it.
   */
  enableSoup?: boolean;
  /** Required when enableSoup is true. */
  entropy?: MetabolicEntropyEngine;
}

/**
 * Build a ready CompostMill with one wiring decision.
 *
 * CompostMill throws when soup is enabled without an entropy engine, and
 * mergeConfig() enables soup by default. Callers that only digest or read
 * seeds therefore used to construct a mill that could never succeed. This
 * module makes soup explicit: it runs only when the caller asks for it and
 * supplies the engine.
 */
export function openCompostMill(options: OpenCompostMillOptions): CompostMill {
  const merged = mergeConfig(options.config);
  const soupRequested = options.enableSoup === true;
  if (soupRequested && options.entropy === undefined) {
    throw new Error('openCompostMill: enableSoup requires an entropy engine');
  }
  const soupEnabled = soupRequested;

  return new CompostMill(options.llm, {
    ...merged,
    soupEnabled,
    entropy: options.entropy,
    projectStore: options.projectStore,
    fastLLM: options.fastLLM,
    modelRouter: options.modelRouter,
    parser: options.parser,
  });
}
