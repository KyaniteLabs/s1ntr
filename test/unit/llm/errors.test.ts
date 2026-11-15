import { describe, it, expect } from 'vitest';
import {
  createLLMHttpError,
  isTransientNetworkError,
  LLMAuthError,
  LLMError,
} from '../../../src/llm/errors.js';

function mockResponse(status: number, body: string, statusText = 'Error'): Response {
  return {
    status,
    statusText,
    text: async () => body,
  } as Response;
}

/**
 * createLLMHttpError must map auth failures to LLMAuthError so LLMClient
 * fallback chains engage (isFallbackableError only treats LLMAuthError as
 * fallbackable for auth — plain LLMError with status 401 was the live bug).
 */
describe('createLLMHttpError', () => {
  it('maps HTTP 401 to LLMAuthError with preserved provenance', async () => {
    const error = await createLLMHttpError({
      provider: 'minimax',
      model: 'MiniMax-M2.5',
      endpoint: 'https://api.minimax.io/v1/chat/completions',
      response: mockResponse(401, 'Invalid API key', 'Unauthorized'),
      label: 'MiniMax API error',
    });

    expect(error).toBeInstanceOf(LLMAuthError);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.name).toBe('LLMAuthError');
    expect(error.statusCode).toBe(401);
    expect(error.provider).toBe('minimax');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('401');
    expect(error.message).toContain('Invalid API key');
    expect(error.model).toBe('MiniMax-M2.5');
    expect(error.endpoint).toContain('/chat/completions');
    expect(error.responseBody).toBe('Invalid API key');
    expect(error.statusText).toBe('Unauthorized');
  });

  it('maps HTTP 403 to LLMAuthError with preserved statusCode', async () => {
    const error = await createLLMHttpError({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      response: mockResponse(403, 'Forbidden for this key', 'Forbidden'),
    });

    expect(error).toBeInstanceOf(LLMAuthError);
    expect(error.statusCode).toBe(403);
    expect(error.provider).toBe('openai');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('403');
    expect(error.message).toContain('Forbidden for this key');
  });

  it('keeps HTTP 429 as plain LLMError that is retryable', async () => {
    const error = await createLLMHttpError({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      response: mockResponse(429, 'rate limited', 'Too Many Requests'),
    });

    expect(error).toBeInstanceOf(LLMError);
    expect(error).not.toBeInstanceOf(LLMAuthError);
    expect(error.name).toBe('LLMError');
    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it('does not retry a 429 that reports an exhausted plan quota', async () => {
    const error = await createLLMHttpError({
      provider: 'minimax',
      model: 'MiniMax-M3',
      endpoint: 'https://api.minimax.io/anthropic/v1/messages',
      response: mockResponse(429, 'usage limit exceeded for your plan (2067)', 'Too Many Requests'),
    });

    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(false);
  });

  it('keeps HTTP 500 as plain LLMError that is retryable', async () => {
    const error = await createLLMHttpError({
      provider: 'anthropic',
      model: 'claude-sonnet',
      endpoint: 'https://api.anthropic.com/v1/messages',
      response: mockResponse(500, 'internal error', 'Internal Server Error'),
    });

    expect(error).toBeInstanceOf(LLMError);
    expect(error).not.toBeInstanceOf(LLMAuthError);
    expect(error.name).toBe('LLMError');
    expect(error.statusCode).toBe(500);
    expect(error.retryable).toBe(true);
  });

  it('keeps HTTP 400 as non-retryable plain LLMError', async () => {
    const error = await createLLMHttpError({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      response: mockResponse(400, 'bad request', 'Bad Request'),
    });

    expect(error).toBeInstanceOf(LLMError);
    expect(error).not.toBeInstanceOf(LLMAuthError);
    expect(error.statusCode).toBe(400);
    expect(error.retryable).toBe(false);
  });
});

/**
 * isTransientNetworkError classifies the raw error a provider's fetch throws so
 * the `retryable` flag is set accurately. The motivating bug: every provider's
 * catch block marked ANY failure `retryable: true`, including connection-level
 * "fetch failed" / ECONNREFUSED to a local endpoint that is down. RetryManager
 * then spent the backoff budget (2s+) retrying a server that wouldn't recover,
 * which pushed a fast unit test past its timeout.
 *
 * Contract: only mid-stream resets / timeouts on an established connection are
 * transient. Hard-down signals (server not listening, DNS NXDOMAIN) are not.
 */
describe('isTransientNetworkError', () => {
  describe('transient (retryable) errors', () => {
    it('classifies a mid-stream ECONNRESET as retryable', () => {
      expect(isTransientNetworkError(new TypeError('fetch failed: ECONNRESET'))).toBe(true);
    });

    it('classifies a socket hang up as retryable', () => {
      expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
    });

    it('classifies an ETIMEDOUT as retryable', () => {
      expect(isTransientNetworkError(new TypeError('fetch failed: ETIMEDOUT'))).toBe(true);
    });

    it('classifies a bare ECONNRESET (no "fetch failed" wrapper) as retryable', () => {
      expect(isTransientNetworkError(new Error('ECONNRESET'))).toBe(true);
    });
  });

  describe('hard connection failures (NOT retryable)', () => {
    it('classifies a generic "fetch failed" (server down) as non-retryable', () => {
      // This is the exact case that caused the bug: a local endpoint with
      // nothing listening surfaces as a bare TypeError "fetch failed".
      expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(false);
    });

    it('classifies ECONNREFUSED as non-retryable', () => {
      expect(isTransientNetworkError(new Error('fetch failed: ECONNREFUSED'))).toBe(false);
    });

    it('classifies ENOTFOUND (DNS NXDOMAIN) as non-retryable', () => {
      expect(isTransientNetworkError(new TypeError('fetch failed: ENOTFOUND'))).toBe(false);
    });

    it('classifies a bare ECONNREFUSED as non-retryable', () => {
      expect(isTransientNetworkError(new Error('ECONNREFUSED'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('does not retry an unmapped / unknown error (conservative default)', () => {
      expect(isTransientNetworkError(new Error('something unusual happened'))).toBe(false);
    });

    it('does not retry a non-Error thrown value', () => {
      expect(isTransientNetworkError('a string')).toBe(false);
      expect(isTransientNetworkError(undefined)).toBe(false);
      expect(isTransientNetworkError(null)).toBe(false);
    });

    it('does not retry an empty message', () => {
      expect(isTransientNetworkError(new Error(''))).toBe(false);
    });
  });

  describe('integration with LLMError.retryable', () => {
    it('the flag propagates so RetryManager only retries transient errors', () => {
      // Sanity: a connection-refused error becomes a non-retryable LLMError.
      const retryable = isTransientNetworkError(new TypeError('fetch failed'));
      const wrapped = new LLMError('fetch failed', 'anthropic', undefined, retryable);
      expect(wrapped.retryable).toBe(false);
    });
  });
});
