/**
 * Centralized service defaults and constants
 *
 * All hardcoded URLs and ports are defined here for easy configuration.
 */

import { PROVIDER_DEFAULTS } from '../config/ProviderRuntime.js';
import { VENDOR_ASSETS } from '../utils/vendorAssets.js';

export const SERVICE_DEFAULTS = {
  /** Preview server port for live sketch viewing */
  PREVIEW_PORT: 3456,
  /** LM Studio / local LLM API base URL */
  LOCAL_LLM_URL: process.env.LOCAL_LLM_URL || PROVIDER_DEFAULTS.lmstudio.baseUrl,
  /** Ollama API base URL */
  OLLAMA_URL: process.env.OLLAMA_URL || PROVIDER_DEFAULTS.ollama.baseUrl,
  /** Reasoning service base URL */
  REASONING_URL: process.env.REASONING_URL || 'http://localhost:8000',
  /** MiniMax M2.7 cloud API base URL (Anthropic-compatible endpoint) */
  MINIMAX_URL: PROVIDER_DEFAULTS.minimax.baseUrl,
  /** p5.js vendored version */
  P5_VERSION: '1.9.0',
  /** Three.js vendored version */
  THREE_VERSION: '0.160.0',
  /** Auto-detect sentinel for local LLMClient fallback, not a provider default model */
  DEFAULT_MODEL: 'auto',
} as const;

/** p5.js vendor path — locally hosted (vendor/, issue #924), no CDN fallback */
export const P5_CDN = VENDOR_ASSETS.p5;
/** p5.sound vendor path */
export const P5_SOUND_CDN = VENDOR_ASSETS.p5Sound;
/** Three.js module vendor path */
export const THREE_CDN = VENDOR_ASSETS.threeModule;
