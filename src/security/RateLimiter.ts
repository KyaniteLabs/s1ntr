/**
 * Rate limiting configuration for Sinter API endpoints
 */

import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '../utils/Logger.js';
import { logRateLimitViolation } from './SecurityLogger.js';

/**
 * Safe parseInt with validation for NaN and reasonable ranges
 */
function safeParseInt(value: string, min: number, max: number, fallback: number): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    Logger.warn('RateLimiter', `Invalid parseInt result for value "${value}", using fallback ${fallback}`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    Logger.warn('RateLimiter', `Parsed value ${parsed} outside range [${min}, ${max}], using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

// Parse environment variables with defaults
const getWindowMs = (envVar: string, defaultMinutes: number): number => {
  const val = process.env[envVar];
  if (!val) return defaultMinutes * 60 * 1000;
  // Allow range: 1 minute to 24 hours
  const minutes = safeParseInt(val, 1, 1440, defaultMinutes);
  return minutes * 60 * 1000;
};

const getMaxRequests = (envVar: string, defaultMax: number): number => {
  const val = process.env[envVar];
  if (!val) return defaultMax;
  // Allow range: 1 to 10000 requests
  return safeParseInt(val, 1, 10000, defaultMax);
};

/**
 * Log rate limit violations for monitoring
 */
const logRateLimitHit = (req: Request, limit?: number, windowMs?: number): void => {
  Logger.warn('RateLimiter', `Rate limit exceeded for IP: ${req.ip || 'unknown'}`, {
    path: req.path,
    method: req.method,
    userAgent: req.get('user-agent'),
    timestamp: new Date().toISOString(),
  });
  
  // Log to security monitoring
  logRateLimitViolation(req.path, {
    ip: req.ip || undefined,
    details: { method: req.method, limit, windowMs }
  });
};

/**
 * Standard API rate limiter
 * Default: 100 requests per 15 minutes per IP
 */
export const standardLimiter = rateLimit({
  windowMs: getWindowMs('LIMINAL_RATE_LIMIT_WINDOW_MINUTES', 15),
  max: getMaxRequests('LIMINAL_RATE_LIMIT_GENERAL', 100),
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    error: 'Too many requests, please try again later.',
    retryAfter: 'Wait a few minutes before retrying.',
  },
  handler: (req: Request, res: Response) => {
    const limit = getMaxRequests('LIMINAL_RATE_LIMIT_GENERAL', 100);
    const windowMs = getWindowMs('LIMINAL_RATE_LIMIT_WINDOW_MINUTES', 15);
    logRateLimitHit(req, limit, windowMs);
    res.status(429).json({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: Math.ceil((res.getHeader('Retry-After') as number) / 60) + ' minutes',
    });
  },
  skip: (req: Request) => {
    // Skip rate limiting for health checks in development
    if (process.env.NODE_ENV === 'development' && req.path === '/api/status') {
      return true;
    }
    return false;
  },
});

/**
 * Strict rate limiter for resource-intensive operations (exports)
 * Default: 10 requests per hour per IP
 */
export const exportLimiter = rateLimit({
  windowMs: getWindowMs('LIMINAL_RATE_LIMIT_EXPORT_WINDOW_MINUTES', 60),
  max: getMaxRequests('LIMINAL_RATE_LIMIT_EXPORT', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Export rate limit exceeded.',
    message: 'Export operations are limited to prevent resource exhaustion.',
  },
  handler: (req: Request, res: Response) => {
    const limit = getMaxRequests('LIMINAL_RATE_LIMIT_EXPORT', 10);
    const windowMs = getWindowMs('LIMINAL_RATE_LIMIT_EXPORT_WINDOW_MINUTES', 60);
    logRateLimitHit(req, limit, windowMs);
    res.status(429).json({
      error: 'Export rate limit exceeded',
      message: 'Export operations are limited to prevent resource exhaustion. Please try again later.',
      retryAfter: Math.ceil((res.getHeader('Retry-After') as number) / 60) + ' minutes',
    });
  },
});

/**
 * Medium rate limiter for sandbox operations
 * Default: 30 requests per 15 minutes per IP
 */
export const sandboxLimiter = rateLimit({
  windowMs: getWindowMs('LIMINAL_RATE_LIMIT_SANDBOX_WINDOW_MINUTES', 15),
  max: getMaxRequests('LIMINAL_RATE_LIMIT_SANDBOX', 30),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const limit = getMaxRequests('LIMINAL_RATE_LIMIT_SANDBOX', 30);
    const windowMs = getWindowMs('LIMINAL_RATE_LIMIT_SANDBOX_WINDOW_MINUTES', 15);
    logRateLimitHit(req, limit, windowMs);
    res.status(429).json({
      error: 'Sandbox rate limit exceeded',
      message: 'Sandbox operations are rate limited. Please try again later.',
      retryAfter: Math.ceil((res.getHeader('Retry-After') as number) / 60) + ' minutes',
    });
  },
});

/**
 * Get appropriate limiter for endpoint
 */
export function getLimiterForEndpoint(endpoint: string) {
  if (endpoint.includes('/export')) {
    return exportLimiter;
  }
  if (endpoint.includes('/sandbox')) {
    return sandboxLimiter;
  }
  return standardLimiter;
}

// ── Framework-free limiter used by the TUI bridge (moved from TuiBridgeServer so there is one implementation) ──
export interface IpRateState {
  hits: number[];
}

export interface IpRateConfig {
  windowMs: number;
  max: number;
  /** 429 body fields, mirroring the original express-rate-limit handlers. */
  error: string;
  message: string;
}

/**
 * Env parsing mirroring the original `src/security/RateLimiter.ts` factory:
 * window values are minutes clamped to [1, 1440], max values are requests
 * clamped to [1, 10000]; anything unparseable falls back to the default.
 */
export function rateLimitEnvMinutes(envVar: string, defaultMinutes: number): number {
  const val = process.env[envVar];
  if (!val) return defaultMinutes;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 1440) return defaultMinutes;
  return parsed;
}

export function rateLimitEnvMax(envVar: string, defaultMax: number): number {
  const val = process.env[envVar];
  if (!val) return defaultMax;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 10000) return defaultMax;
  return parsed;
}

/**
 * Minimal in-memory IP-keyed rate limiter that mirrors the original
 * `express-rate-limit` thresholds (standard/export/sandbox) without pulling
 * Express into the bridge. Sliding window, `RateLimit-*` headers on every
 * response, and a 429 with the original JSON body shape (`error`, `message`,
 * `retryAfter`) when the window is exceeded.
 */
export class IpRateLimiter {
  private static readonly MAX_TRACKED_KEYS = 10_000;
  private readonly states = new Map<string, IpRateState>();
  private readonly label: string;
  private readonly config: IpRateConfig;
  constructor(label: string, config: IpRateConfig) {
    this.label = label;
    this.config = config;
  }
  private pruneStale(cutoff: number): void {
    for (const [k, s] of this.states) {
      if (s.hits.length === 0 || s.hits[s.hits.length - 1] <= cutoff) {
        this.states.delete(k);
      }
    }
    while (this.states.size >= IpRateLimiter.MAX_TRACKED_KEYS) {
      const oldestKey = this.states.keys().next().value;
      if (oldestKey === undefined) break;
      this.states.delete(oldestKey);
    }
  }
  consume(req: IncomingMessage, res: ServerResponse): boolean {
    const key = (req.socket?.remoteAddress ?? 'unknown') + ':' + this.label;
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= IpRateLimiter.MAX_TRACKED_KEYS) {
        this.pruneStale(cutoff);
      }
      state = { hits: [] };
      this.states.set(key, state);
    } else {
      // Refresh recency for LRU eviction.
      this.states.delete(key);
      this.states.set(key, state);
    }
    state.hits = state.hits.filter((t) => t > cutoff);
    const remainingAfter = Math.max(0, this.config.max - state.hits.length - 1);
    // Sliding window: the limit frees up when the oldest hit in the window
    // expires, so report the real reset rather than a fresh full window.
    const resetSeconds = state.hits.length > 0
      ? Math.max(1, Math.ceil((state.hits[0] + this.config.windowMs - now) / 1000))
      : Math.ceil(this.config.windowMs / 1000);
    res.setHeader('RateLimit-Limit', String(this.config.max));
    res.setHeader('RateLimit-Remaining', String(remainingAfter));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (state.hits.length >= this.config.max) {
      Logger.warn('RateLimiter', `Rate limit exceeded for IP: ${req.socket?.remoteAddress ?? 'unknown'}`, {
        path: req.url,
        method: req.method,
        limit: this.config.max,
        windowMs: this.config.windowMs,
      });
      logRateLimitViolation(req.url ?? 'unknown', {
        ip: req.socket?.remoteAddress ?? undefined,
        details: { method: req.method, limit: this.config.max, windowMs: this.config.windowMs },
      });
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(resetSeconds) });
      res.end(JSON.stringify({
        error: this.config.error,
        message: this.config.message,
        retryAfter: Math.ceil(resetSeconds / 60) + ' minutes',
      }));
      return false;
    }
    state.hits.push(now);
    return true;
  }
}
