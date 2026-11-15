/**
 * Extracted from TuiBridgeService.ts: shared constants.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import type { CortexConfig } from '../../cortex/types.js';

/** Max UTF-16 code units of prior-artifact code injected into revision generation prompts. */
export const PRIOR_ARTIFACT_EXCERPT_MAX_CHARS = 5000;

/** Default Gardener configuration */
export const GARDENER_CONFIG = {
    mode: 'co-create' as const,
    totalBudget: 100,
    stagnationWindow: 10,
    explorationFraction: 0.3,
    replayRatio: 0.4,
    maxConsecutiveReplay: 3,
    maxArchiveTasks: 10,
    replayBiasStrength: 0.7,
    minTasteScore: 0.5,
  };

/** Default Cortex configuration */
export const CORTEX_CONFIG: CortexConfig = {
    loopIntervalMs: 30000,   // 30s tick
    maxConsecutiveFailures: 5,
    budgetActionsLimit: 10,
    budgetTokenLimit: 50000,
    autonomyLevel: 'assist',
  };

/** Interval in ms for cortex snapshot broadcasts (default: 5s) */
export const CORTEX_BROADCAST_INTERVAL_MS = 5000;

export const ACTION_CHECKPOINT_TTL_MS = 2 * 60 * 1_000;

export const ARTIST_REVIEW_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;
