import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';
import { describeUnreachableEndpoint, isTransientNetworkError } from '../../../src/llm/errors.js';

// A port that was just bound and released: nothing is listening on it.
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('unreachable model endpoint', () => {
  it('names the server and keeps the fallback-matching words when nothing listens', async () => {
    const port = await closedPort();
    const provider = new OpenAIProvider({
      provider: 'lmstudio',
      model: 'local-model',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'local',
      timeout: 5_000,
    });

    const result = await provider.generate({ systemPrompt: 's', userPrompt: 'u', maxTokens: 8 });

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toBe(
      `Could not reach the model server at 127.0.0.1:${port}. Is it running? (fetch failed: ECONNREFUSED)`,
    );
    // Not retryable, same as before: the server is down, not flaky.
    expect(result._unsafeUnwrapErr().retryable).toBe(false);
  });

  it('leaves other errors alone', () => {
    expect(describeUnreachableEndpoint(new Error('OpenAI API error 500'), 'http://127.0.0.1:1/v1')).toBe(null);
    expect(describeUnreachableEndpoint('fetch failed', 'http://127.0.0.1:1/v1')).toBe(null);
    expect(describeUnreachableEndpoint(new TypeError('fetch failed'), undefined)).toBe(null);
  });

  it('falls back to the raw base URL when it does not parse', () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(describeUnreachableEndpoint(error, 'not a url')).toBe(
      'Could not reach the model server at not a url. Is it running? (fetch failed: ENOTFOUND)',
    );
    expect(isTransientNetworkError(error)).toBe(false);
  });
});
