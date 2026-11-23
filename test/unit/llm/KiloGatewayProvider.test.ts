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

  describe('reasoning exhausted (finish_reason=length, empty content)', () => {
    const exhausted = (completion = 64000) => ({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: completion },
      }),
    });
    const good = { ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'code' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 900 } }) };
    const req = (effort: 'max' | 'high' | 'medium' | 'low') => ({
      systemPrompt: 'sys', userPrompt: 'usr', maxTokens: 64000,
      thinking: { enabled: true, effort },
    });

    it('retries once one effort level lower and tells the model its budget', async () => {
      mockFetch.mockResolvedValueOnce(exhausted()).mockResolvedValueOnce(good);
      const res = await makeProvider().generate(req('max'));
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(retryBody.reasoning).toEqual({ effort: 'high' });
      expect(retryBody.messages[0].content).toContain('sys');
      expect(retryBody.messages[0].content).toContain('64000');
      expect(res.value.success).toBe(true);
      expect(res.value.content).toBe('code');
    });

    it('steps high to medium and medium to low', async () => {
      mockFetch.mockResolvedValueOnce(exhausted()).mockResolvedValueOnce(good);
      await makeProvider().generate(req('high'));
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).reasoning).toEqual({ effort: 'medium' });
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(exhausted()).mockResolvedValueOnce(good);
      await makeProvider().generate(req('medium'));
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).reasoning).toEqual({ effort: 'low' });
    });

    it('fails with a reasoning-exhausted class, finish reason and tokens when the retry is also empty', async () => {
      mockFetch.mockResolvedValueOnce(exhausted(64000)).mockResolvedValueOnce(exhausted(63000));
      const res = await makeProvider().generate(req('max'));
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(res.value.success).toBe(false);
      expect(res.value.failureClass).toBe('reasoning-exhausted');
      expect(res.value.error).toContain('reasoning-exhausted');
      expect(res.value.error).toContain('finish_reason=length');
      expect(res.value.error).toContain('64000');
      expect(res.value.error).toContain('63000');
    });

    it('does not retry at low effort, but still classifies the failure', async () => {
      mockFetch.mockResolvedValueOnce(exhausted());
      const res = await makeProvider().generate(req('low'));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.value.failureClass).toBe('reasoning-exhausted');
    });

    it('never steps down when thinking is already off', async () => {
      mockFetch.mockResolvedValueOnce(exhausted());
      const res = await makeProvider().generate({ systemPrompt: 's', userPrompt: 'u', thinking: { enabled: false } });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.value.success).toBe(false);
    });

    it('does not retry when content is present or finish reason is not length', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) });
      const res = await makeProvider().generate(req('max'));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.value.failureClass).toBeUndefined();
    });
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

  it('streams generate() so a long reasoning run gets headers at once, and rebuilds the reply', async () => {
    const sse = [
      'data: {"model":"tencent/hy4","choices":[{"delta":{"reasoning":"think "}}]}',
      'data: {"choices":[{"delta":{"content":"<html>"}}]}',
      'data: {"choices":[{"delta":{"content":"</html>"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
      'data: [DONE]',
      '',
    ].join('\n');
    mockFetch.mockResolvedValueOnce(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const result = await makeProvider({ model: 'tencent/hy4' }).generate({ systemPrompt: 'sys', userPrompt: 'usr' });
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.success).toBe(true);
    expect(value.content).toBe('<html></html>');
    expect(value.model).toBe('tencent/hy4');
    expect(value.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('keeps tool calls on the non-streamed path', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }),
    });
    await makeProvider().generate({ systemPrompt: 'sys', userPrompt: 'usr',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }] });
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sent.stream).toBeUndefined();
  });
});
