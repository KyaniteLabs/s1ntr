import { describe, it, expect, vi, beforeEach } from 'vitest';
import { err } from 'neverthrow';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { LLMError } from '../../../src/llm/errors.js';
import { createProvider, transportEndpoint } from '../../../src/llm/ProviderFactory.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

const CONFIGS = [
  { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3' },
  { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3-pro' },
  { baseUrl: 'http://localhost:11434', model: 'llama3' },
  { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
  { baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M2.7' },
  { baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2.7' },
  { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4.1-flash' },
  { baseUrl: 'https://api.kilo.ai/api/gateway', model: 'deepseek/deepseek-v4.1-flash' },
  { baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5' },
  { baseUrl: 'http://localhost:11434/v1/', model: 'llama3' },
  { baseUrl: 'https://api.z.ai/api/anthropic/', model: 'glm-5.3' },
  { baseUrl: 'https://generativelanguage.googleapis.com/', model: 'gemini-3-pro' },
  { baseUrl: 'https://example.com', model: 'gemini-3-pro' },
  { baseUrl: 'https://api.minimax.io/Anthropic', model: 'MiniMax-M2.7' },
];

describe('transportEndpoint', () => {
  beforeEach(() => mockFetch.mockReset());

  it.each(CONFIGS)('names the URL the $baseUrl adapter actually fetches', async (config) => {
    mockFetch.mockResolvedValue(new Response('{"error":"refused"}', { status: 500 }));
    const provider = createProvider({ ...config, apiKey: 'test-key', maxTokens: 64, timeout: 5_000 });

    await provider.generate({ systemPrompt: 's', userPrompt: 'u', maxTokens: 64 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetched = String(mockFetch.mock.calls[0][0]).split('?')[0];
    expect(transportEndpoint(config)).toBe(fetched);
  });
});

describe('LLMClient failure provenance before transport', () => {
  it('reports the z.ai Messages endpoint for a GLM seat, not a /chat/completions path that does not exist', async () => {
    const client = new LLMClient({ baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3', apiKey: 'fake-test-key' });
    const refused = new LLMError('Harness executor blocked before transport: metered funding evidence missing', 'glm', undefined, false,
      { model: 'glm-5.3' });
    vi.spyOn(client as any, 'resolveModel').mockResolvedValue('glm-5.3');
    vi.spyOn(client as any, 'getProvider').mockResolvedValue({
      name: 'anthropic',
      getModel: vi.fn(() => 'glm-5.3'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3' })),
      generate: vi.fn(async () => err(refused)),
    });

    const response = await client.complete({ systemPrompt: 'system', prompt: 'hello' });

    expect(response.success).toBe(false);
    expect(response.endpoint).toBe('https://api.z.ai/api/anthropic/v1/messages');
  });
});
