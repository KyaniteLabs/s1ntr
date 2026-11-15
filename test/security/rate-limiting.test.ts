import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PreviewServer } from '../../src/render/PreviewServer.js';
import {
  exportLimiter,
  getLimiterForEndpoint,
  sandboxLimiter,
  standardLimiter,
} from '../../src/security/RateLimiter.js';

describe('Rate Limiting', () => {
  let server: PreviewServer;
  const TEST_PORT = 3460;

  beforeAll(async () => {
    server = new PreviewServer();
    await server.start(TEST_PORT);
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should include rate limit headers', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/api/gallery`);
    // First request of the suite against the default general limit (100 per 15 min).
    expect(response.headers.get('ratelimit-limit')).toBe('100');
    expect(response.headers.get('ratelimit-remaining')).toBe('99');
  });

  it('should return 429 after too many requests', async () => {
    // Make many requests quickly
    const promises = [];
    for (let i = 0; i < 150; i++) {
      promises.push(fetch(`http://localhost:${TEST_PORT}/api/gallery`));
    }
    const responses = await Promise.all(promises);

    // At least one should be rate limited
    const hasRateLimited = responses.some((r) => r.status === 429);
    expect(hasRateLimited).toBe(true);
  });

  it('should include retry-after header on 429 responses', async () => {
    // Make many requests to trigger rate limit
    const promises = [];
    for (let i = 0; i < 150; i++) {
      promises.push(fetch(`http://localhost:${TEST_PORT}/api/gallery`));
    }
    const responses = await Promise.all(promises);

    // Find a rate limited response
    const rateLimitedResponse = responses.find((r) => r.status === 429);
    expect(rateLimitedResponse?.status).toBe(429);
    const retryAfterSeconds = Number(rateLimitedResponse!.headers.get('retry-after'));
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    const body = await rateLimitedResponse!.json();
    expect(body.error).toBe('Too many requests');
    expect(body.retryAfter).toBe(`${Math.ceil(retryAfterSeconds / 60)} minutes`);
  });

  it('should return JSON error on rate limit exceeded', async () => {
    // Make many requests to trigger rate limit
    const promises = [];
    for (let i = 0; i < 150; i++) {
      promises.push(fetch(`http://localhost:${TEST_PORT}/api/gallery`));
    }
    const responses = await Promise.all(promises);

    // Find a rate limited response
    const rateLimitedResponse = responses.find((r) => r.status === 429);
    expect(rateLimitedResponse?.status).toBe(429);
    expect(rateLimitedResponse!.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await rateLimitedResponse!.json()).toEqual({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: expect.stringMatching(/^\d+ minutes$/),
    });
  });
});

describe('Rate Limiter Configuration', () => {
  it('should return export limiter for /api/export endpoint', () => {
    expect(getLimiterForEndpoint('/api/export')).toBe(exportLimiter);
  });

  it('should return sandbox limiter for /api/sandbox endpoint', () => {
    expect(getLimiterForEndpoint('/api/sandbox')).toBe(sandboxLimiter);
  });

  it('should return standard limiter for other endpoints', () => {
    expect(getLimiterForEndpoint('/api/gallery')).toBe(standardLimiter);
  });

  it('should return standard limiter for unknown endpoints', () => {
    expect(getLimiterForEndpoint('/api/unknown')).toBe(standardLimiter);
  });

  it('should apply different limiters for different endpoints', () => {
    const exportLimiter = getLimiterForEndpoint('/api/export');
    const sandboxLimiter = getLimiterForEndpoint('/api/sandbox');
    const standardLimiter = getLimiterForEndpoint('/api/gallery');
    
    expect(new Set([exportLimiter, sandboxLimiter, standardLimiter]).size).toBe(3);
  });
});
