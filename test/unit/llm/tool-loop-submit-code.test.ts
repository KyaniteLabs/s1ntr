import { describe, it, expect, vi, beforeEach } from 'vitest';

import { LLMClient } from '../../../src/llm/LLMClient.js';

describe('generateWithToolLoop — submit_code extraction', () => {
  let client: LLMClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new LLMClient({
      baseUrl: 'https://api.kimi.com/coding/v1',
      model: 'kimi-k2p5',
      apiKey: 'test-key',
    });
  });

  it('extracts code from submit_code tool call (Kimi convention)', async () => {
    const generatedCode = 'function setup() { createCanvas(400, 400); }';

    // Simulate Kimi's response: content is empty, code is in tool_call arguments
    vi.spyOn(client, 'generateWithTools' as any).mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          id: 'call_abc123',
          name: 'submit_code',
          arguments: JSON.stringify({ code: generatedCode, language: 'javascript' }),
        },
      ],
      finishReason: 'tool_calls',
      success: true,
      provenance: { provider: 'kimi', model: 'kimi-k2p5' },
    });

    const result = await client.generateWithToolLoop({
      systemPrompt: 'You are a creative coder.',
      userPrompt: 'Create a p5.js sketch',
      tools: [
        {
          name: 'validate_syntax',
          description: 'Validate code',
          parameters: { type: 'object', properties: { code: { type: 'string' } } },
        },
      ],
      toolExecutor: async () => '{"valid": true}',
      maxIterations: 3,
    });

    expect(result.content).toBe(generatedCode);
    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.toolCallsMade).toBe(1);
    expect(result.provenance).toEqual({ provider: 'kimi', model: 'kimi-k2p5' });
  });

  it('keeps provenance attached to the retained artifact candidate', async () => {
    vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: 'const artifact = true;',
        toolCalls: [{ id: 'call_1', name: 'validate_syntax', arguments: '{}' }],
        success: true,
        provenance: { provider: 'primary', model: 'artifact-model' },
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [],
        success: true,
        provenance: { provider: 'other', model: 'empty-model' },
      });

    const result = await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: async () => '{"valid":true}',
      maxIterations: 1,
    });

    expect(result.content).toBe('const artifact = true;');
    expect(result.provenance).toEqual({ provider: 'primary', model: 'artifact-model' });
  });

  it('extracts code from submit_code among multiple tool calls', async () => {
    const code = 'const x = 42;';

    vi.spyOn(client, 'generateWithTools' as any).mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          id: 'call_validate',
          name: 'validate_syntax',
          arguments: JSON.stringify({ code: 'placeholder' }),
        },
        {
          id: 'call_submit',
          name: 'submit_code',
          arguments: JSON.stringify({ code, language: 'javascript' }),
        },
      ],
      finishReason: 'tool_calls',
      success: true,
    });

    // Provide a tool executor for the non-submit_code tool
    const result = await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: async () => '{"valid": true}',
      maxIterations: 3,
    });

    expect(result.content).toBe(code);
    expect(result.success).toBe(true);
  });

  it('falls through to normal tool execution when submit_code has no code', async () => {
    vi.spyOn(client, 'generateWithTools' as any)
      // First call: submit_code with empty code → falls through to executor
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'submit_code',
            arguments: JSON.stringify({ language: 'javascript' }), // no code field
          },
        ],
        finishReason: 'tool_calls',
        success: true,
      })
      // Second call: model returns content directly
      .mockResolvedValueOnce({
        content: 'const x = 1;',
        toolCalls: [],
        finishReason: 'stop',
        success: true,
      });

    const result = await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: async () => '{"error": "Unknown tool: submit_code"}',
      maxIterations: 3,
    });

    expect(result.content).toBe('const x = 1;');
    expect(result.iterations).toBe(2);
  });

  it('falls through when submit_code arguments are malformed JSON', async () => {
    vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'submit_code',
            arguments: 'not-valid-json{',
          },
        ],
        finishReason: 'tool_calls',
        success: true,
      })
      .mockResolvedValueOnce({
        content: 'final content',
        toolCalls: [],
        finishReason: 'stop',
        success: true,
      });

    const result = await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: async () => '{"error": "Unknown tool"}',
      maxIterations: 3,
    });

    expect(result.content).toBe('final content');
  });

  it('does not intercept non-submit_code tool calls', async () => {
    const executor = vi.fn().mockResolvedValue('{"valid": true}');

    vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'validate_syntax',
            arguments: JSON.stringify({ code: 'const x = 1;' }),
          },
        ],
        finishReason: 'tool_calls',
        success: true,
      })
      .mockResolvedValueOnce({
        content: 'validated code here',
        toolCalls: [],
        finishReason: 'stop',
        success: true,
      });

    const result = await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: executor,
      maxIterations: 3,
    });

    expect(result.content).toBe('validated code here');
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('validate_syntax', { code: 'const x = 1;' });
  });

  it('preserves content returned alongside tool calls when the final provider turn is empty', async () => {
    const artifact = 'function setup() { createCanvas(400, 400); }';
    const executor = vi.fn().mockResolvedValue('{"valid":true}');

    vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: artifact,
        toolCalls: [
          {
            id: 'call_1',
            name: 'validate_syntax',
            arguments: JSON.stringify({ code: artifact }),
          },
        ],
        finishReason: 'tool_calls',
        success: true,
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        success: false,
        error: 'empty final turn',
      });

    const result = await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: executor,
      maxIterations: 1,
    });

    expect(result.content).toBe(artifact);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns validated code arguments when the final provider turn is empty', async () => {
    const artifact = 'const sketch = "ok";';

    vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'validate_syntax',
            arguments: JSON.stringify({ code: artifact }),
          },
        ],
        finishReason: 'tool_calls',
        success: true,
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        success: false,
        error: 'empty final turn',
      });

    const result = await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: async () => '{"valid":true}',
      maxIterations: 1,
    });

    expect(result.content).toBe(artifact);
    expect(result.success).toBe(true);
  });

  it('passes accumulated tool results into the forced final artifact turn', async () => {
    const artifact = 'const x = 1;';
    const spy = vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'validate_syntax',
            arguments: JSON.stringify({ code: artifact }),
          },
        ],
        finishReason: 'tool_calls',
        success: true,
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        success: false,
      });

    await client.generateWithToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [],
      toolExecutor: async () => '{"valid":true}',
      maxIterations: 1,
    });

    expect(spy.mock.calls[1][0].toolResults).toEqual([
      expect.objectContaining({
        toolCallId: 'call_1',
        result: '{"valid":true}',
        toolCall: expect.objectContaining({ name: 'validate_syntax' }),
      }),
    ]);
  });

  it('emits redacted events at the actual tool call and result boundaries', async () => {
    vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'call_1', name: 'validate_syntax', arguments: '{"code":"PRIVATE SOURCE"}' }],
        finishReason: 'tool_calls',
        success: true,
        usage: { inputTokens: 5, outputTokens: 3 },
        provenance: { provider: 'kimi', model: 'kimi-k2p5' },
      })
      .mockResolvedValueOnce({ content: 'const finalArtifact = true;', toolCalls: [], success: true });
    const events: unknown[] = [];
    const counters: unknown[] = [];

    await client.generateWithToolLoop({
      systemPrompt: 'SECRET SYSTEM',
      userPrompt: 'PRIVATE USER',
      tools: [{ name: 'validate_syntax', description: '', parameters: {} }],
      toolExecutor: async () => '{"valid":true,"source":"PRIVATE SOURCE"}',
      maxIterations: 2,
      attemptTelemetry: {
        runId: 'run', candidateId: 'candidate', attemptId: 'attempt', attemptOrdinal: 1, domain: 'p5',
        emit: (event, delta) => { events.push(event); counters.push(delta); },
      },
    });

    expect(events.map((event) => (event as { stage: string }).stage)).toEqual([
      'request', 'assistant_payload', 'tool_selection', 'tool_call', 'tool_result',
      'assistant_payload', 'extracted_artifact',
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    expect(JSON.stringify(events)).not.toContain('SECRET');
    // W8C-04 contract: counters MUST derive from signed W8C-03 quota-counter
    // deltas. With no signed ref bound (the mock provides none), the loop must
    // NOT fabricate providerCalls/quotaUnits=1.
    for (const delta of counters) {
      const record = delta as Record<string, unknown> | undefined;
      if (!record) continue;
      expect(record).not.toHaveProperty('providerCalls', 1);
      expect(record).not.toHaveProperty('quotaUnits', 1);
    }
  });

  it.each([
    ['timed out', 'timeout'],
    ['403 forbidden', 'provider_denied'],
  ] as const)('classifies %s without persisting the raw provider error', async (rawError, failureClass) => {
    vi.spyOn(client, 'generateWithTools' as any).mockResolvedValue({
      content: '', success: false, error: rawError,
    });
    const events: Array<Record<string, unknown>> = [];
    await client.generateWithToolLoop({
      systemPrompt: 'secret', userPrompt: 'private', tools: [], toolExecutor: async () => '',
      attemptTelemetry: {
        runId: 'run', candidateId: 'candidate', attemptId: 'attempt', attemptOrdinal: 1,
        emit: (event) => { events.push(event as unknown as Record<string, unknown>); },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ stage: 'failure_class', failureReason: failureClass }));
    expect(JSON.stringify(events)).not.toContain(rawError);
  });

  it('records malformed tool results at the executor boundary and missing artifact extraction', async () => {
    vi.spyOn(client, 'generateWithTools' as any)
      .mockResolvedValueOnce({
        content: '', success: true, finishReason: 'tool_calls',
        toolCalls: [{ id: 'call', name: 'validate_syntax', arguments: '{}' }],
      })
      .mockResolvedValueOnce({ content: '', success: true, finishReason: 'stop', toolCalls: [] });
    const events: Array<Record<string, unknown>> = [];
    await client.generateWithToolLoop({
      systemPrompt: 'sys', userPrompt: 'user',
      tools: [{ name: 'validate_syntax', description: '', parameters: {} }],
      toolExecutor: async () => { throw new Error('RAW PROVIDER TOOL PAYLOAD'); },
      maxIterations: 1,
      attemptTelemetry: {
        runId: 'run', candidateId: 'candidate', attemptId: 'attempt', attemptOrdinal: 1,
        emit: (event) => { events.push(event as unknown as Record<string, unknown>); },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      stage: 'failure_class', failureReason: 'malformed_tool_result', toolName: 'validate_syntax',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      stage: 'extracted_artifact', extractionOutcome: 'fail',
    }));
    expect(JSON.stringify(events)).not.toContain('RAW PROVIDER');
  });
});
