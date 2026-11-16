import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KiloGatewayProvider } from '../../../src/llm/providers/KiloGatewayProvider.js';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../../src/llm/CapabilityRegistry.js', () => ({
  CapabilityRegistry: {
    getCapabilities: () => ({
      thinking: true, streaming: true, jsonMode: true,
      toolUse: true, maxContextTokens: 1048576,
      thinkingStyle: 'reasoning_content', streamingStyle: 'sse',
    }),
  },
}));

vi.mock('../../../src/llm/ThinkingNormalizer.js', () => ({
  extractOpenRouterThinking: () => ({ text: '', source: 'none' }),
}));

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new KiloGatewayProvider({
    baseUrl: 'https://api.kilo.ai/api/gateway',
    apiKey: 'test-key',
    model: 'minimax/minimax-m3',
    ...overrides,
  });
}

beforeEach(() => mockFetch.mockReset());

describe('KiloGatewayProvider', () => {
  it('has name "kilo" and sends a bearer Authorization header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        model: 'minimax/minimax-m3',
      }),
    });
    const provider = makeProvider();
    expect(provider.name).toBe('kilo');
    expect(provider.capabilities.streaming).toBe(true);

    await provider.generate({ systemPrompt: 'sys', userPrompt: 'usr' });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.kilo.ai/api/gateway/chat/completions');
    expect(options.headers['Authorization']).toBe('Bearer test-key');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('omits Authorization header when apiKey is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
    });
    const provider = makeProvider({ apiKey: '' });
    await provider.generate({ systemPrompt: 'sys', userPrompt: 'usr' });
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Authorization']).toBeUndefined();
  });

  it('generate returns content and usage from API response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'response text' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'openai/gpt-5.6-luna',
      }),
    });
    const provider = makeProvider({ model: 'openai/gpt-5.6-luna' });
    const res = await provider.generate({ systemPrompt: 'sys', userPrompt: 'usr' });
    expect(res.isOk()).toBe(true);
    expect(res.value.success).toBe(true);
    expect(res.value.content).toBe('response text');
    expect(res.value.usage?.inputTokens).toBe(10);
    expect(res.value.usage?.outputTokens).toBe(5);
  });

  it.each([
    ['length', 'length'], ['stop', 'stop'], [undefined, 'stop'],
  ])('reports native finish_reason %s as finishReason %s (#1643)', async (native, expected) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'function draw(){ ellipse(' }, finish_reason: native }] }),
    });
    const res = await makeProvider().generate({ systemPrompt: 'sys', userPrompt: 'usr' });
    expect(res.isOk()).toBe(true);
    expect(res.value.finishReason).toBe(expected);
  });

  it('sends image inputs as OpenAI multimodal content parts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
    });
    const provider = makeProvider();
    await provider.generate({
      systemPrompt: 'sys',
      userPrompt: 'Judge this render',
      imageInputs: [{ mimeType: 'image/png', dataBase64: 'abc123', width: 1, height: 1 }],
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'Judge this render' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('includes the unified reasoning parameter when thinking is enabled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'reasoned' } }] }),
    });
    const provider = makeProvider({ model: 'moonshotai/kimi-k3' });
    await provider.generate({
      systemPrompt: 'sys', userPrompt: 'usr',
      thinking: { enabled: true, effort: 'high' },
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('does not send response_format on Kilo (Opus 5 rejects json_object wire format)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"tool":"complete"}' } }],
      }),
    });
    const provider = makeProvider();
    await provider.generate({
      systemPrompt: 'sys',
      userPrompt: 'What is your next tool call? Respond with JSON only.',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // F19: Kilo paid Opus 5 400s on response_format; prompt still asks for JSON.
    expect(body.response_format).toBeUndefined();
  });

  it('returns error provenance on API failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { message: 'bad token' } }),
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'bad token' } })),
    });
    const provider = makeProvider();
    const res = await provider.generate({ systemPrompt: 'sys', userPrompt: 'usr' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.provider).toBe('kilo');
      expect(res.error.statusCode).toBe(401);
    }
  });

  it('returns success=false with a diagnostic error when content is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      }),
    });
    const provider = makeProvider();
    const res = await provider.generate({ systemPrompt: 'sys', userPrompt: 'usr' });
    expect(res.isOk()).toBe(true);
    expect(res.value.success).toBe(false);
    expect(res.value.error).toContain('Kilo gateway provider returned no usable content');
  });

  it('listModels probes the gateway catalog with the bearer token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [{ id: 'minimax/minimax-m3' }, { id: 'openai/gpt-5.6-luna' }],
      }),
    });
    const provider = makeProvider();
    const res = await provider.listModels();
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      expect(res.value.map(m => m.id)).toEqual(['minimax/minimax-m3', 'openai/gpt-5.6-luna']);
    }
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.kilo.ai/api/gateway/models');
    expect(options.headers['Authorization']).toBe('Bearer test-key');
  });

  it('listModels returns an error on non-OK responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
    });
    const provider = makeProvider();
    const res = await provider.listModels();
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.statusCode).toBe(403);
    }
  });
});
