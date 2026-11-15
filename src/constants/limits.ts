/**
 * System-wide constants for limits, timeouts, and sizes.
 */

// Timeouts (milliseconds)
export const TIMEOUT_DEFAULT_MS = 720_000;     // 12 minutes (slow coding seats)
export const TIMEOUT_EVALUATOR_MS = 180_000;   // 3 minutes (cloud judge with vision payload; #709)
export const TIMEOUT_SHORT_MS = 120000;        // 2 minutes
export const TIMEOUT_OLLAMA_MS = 120000;       // 2 minutes

// Token limits for LLM requests
export const TOKEN_LIMIT_SMALL = 500;
export const TOKEN_LIMIT_MEDIUM = 1000;
export const TOKEN_LIMIT_LARGE = 1500;
export const TOKEN_LIMIT_XL = 2000;
export const TOKEN_LIMIT_DEFAULT = 4096;
export const TOKEN_LIMIT_OLLAMA = 8000;

// Text truncation lengths (characters)
export const TRUNCATE_SHORT = 100;
export const TRUNCATE_MEDIUM = 300;
export const TRUNCATE_LONG = 500;

// Cache limits
export const CACHE_MAX_ENTRIES = 1000;
export const CACHE_TTL_MS = 60 * 60 * 1000;    // 1 hour
