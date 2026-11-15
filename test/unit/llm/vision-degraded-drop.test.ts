/**
 * Vision-degraded drop — dropping image input for a text-only model must be
 * LOUD, never silent.
 *
 * When a caller supplies images but the resolved model is not vision-capable,
 * LLMClient falls back to text-only generation (fail-soft) but MUST:
 *   - emit a degradation record on the failure channel (errorType 'degraded',
 *     '[vision-degraded]' prefix) so PatternDetector can surface it;
 *   - warn via Logger so operators see it in real time.
 *
 * A vision-capable model must keep the images untouched, and a text-only
 * model called without images must produce no degradation record.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from 'neverthrow';

const mockFailureLoggerLog = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/harness/FailureLogger.js', () => ({
  failureLogger: { log: mockFailureLoggerLog },
}));

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { LLMClient } from '../../../src/llm/LLMClient.js';
import { CapabilityRegistry } from '../../../src/llm/CapabilityRegistry.js';

const TEXT_ONLY_MODEL = 'qwen2.5-7b-instruct';
const VISION_MODEL = 'gpt-4o';

const IMAGE = {
  mimeType: 'image/png',
  dataBase64: 'ZmFrZS1wbng=',
  width: 400,
  height: 400,
  label: 'rendered-artifact',
};

function mockProvider() {
  return {
    name: 'openai',
    getModel: vi.fn(() => TEXT_ONLY_MODEL),
    getConfig: vi.fn(() => ({ model: TEXT_ONLY_MODEL, provider: 'openai', baseUrl: 'https://api.openai.com/v1' })),
    setModel: vi.fn(),
    generate: vi.fn(async () => ok({ content: 'function setup() {}', success: true })),
  };
}

function clientFor(resolvedModel: string, provider: ReturnType<typeof mockProvider>) {
  const client = new LLMClient({ model: resolvedModel, apiKey: 'fake-test-key' });
  vi.spyOn(client as never as { resolveModel: () => Promise<string> }, 'resolveModel')
    .mockResolvedValue(resolvedModel);
  vi.spyOn(client as never as { getProvider: () => Promise<unknown> }, 'getProvider')
    .mockResolvedValue(provider);
  return client;
}

describe('LLMClient — loud image drop for text-only models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CapabilityRegistry.clearOverrides();
  });

  it('emits a degradation record and warn log when images are dropped', async () => {
    const provider = mockProvider();
    const client = clientFor(TEXT_ONLY_MODEL, provider);

    const response = await client.generate('system', 'user prompt', undefined, true, [IMAGE]);

    // Fail-soft preserved: the call still succeeds, text-only.
    expect(response.success).toBe(true);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.generate.mock.calls[0]?.[0].imageInputs).toBeUndefined();

    // Loud: degradation record on the failure channel.
    expect(mockFailureLoggerLog).toHaveBeenCalledTimes(1);
    const record = mockFailureLoggerLog.mock.calls[0]?.[0];
    expect(record.errorType).toBe('degraded');
    expect(record.error).toMatch(/^\[vision-degraded\]/);
    expect(record.error).toContain(TEXT_ONLY_MODEL);
    expect(record.error).toContain('1 image input(s)');
    expect(record.model).toBe(TEXT_ONLY_MODEL);

    // Loud: operator-visible warning.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'LLMClient',
      expect.stringContaining('[vision-degraded]'),
    );
  });

  it('forwards images untouched for a vision-capable model (no degradation record)', async () => {
    const provider = mockProvider();
    const client = clientFor(VISION_MODEL, provider);

    const response = await client.generate('system', 'user prompt', undefined, true, [IMAGE]);

    expect(response.success).toBe(true);
    expect(provider.generate.mock.calls[0]?.[0].imageInputs).toEqual([IMAGE]);
    expect(mockFailureLoggerLog).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      'LLMClient',
      expect.stringContaining('[vision-degraded]'),
    );
  });

  it('retains rendered inputs for the gateway Dots preview judge', async () => {
    const provider = mockProvider();
    const client = clientFor('dots-studio/dots-3-note-preview:free', provider);
    const response = await client.generateWithImages('system', 'score artwork', [IMAGE]);

    expect(response.success).toBe(true);
    expect(provider.generate.mock.calls[0]?.[0].imageInputs).toEqual([IMAGE]);
    expect(mockFailureLoggerLog).not.toHaveBeenCalled();
    expect(CapabilityRegistry.supportsVision('dots-studio/unverified-model')).toBe(false);
  });

  it('produces no degradation record for a text-only model called without images', async () => {
    const provider = mockProvider();
    const client = clientFor(TEXT_ONLY_MODEL, provider);

    const response = await client.generate('system', 'user prompt', undefined, true);

    expect(response.success).toBe(true);
    expect(provider.generate.mock.calls[0]?.[0].imageInputs).toBeUndefined();
    expect(mockFailureLoggerLog).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      'LLMClient',
      expect.stringContaining('[vision-degraded]'),
    );
  });

  it('generateWithImages goes through the same loud-drop path', async () => {
    const provider = mockProvider();
    const client = clientFor(TEXT_ONLY_MODEL, provider);

    const response = await client.generateWithImages('system', 'user prompt', [IMAGE]);

    expect(response.success).toBe(true);
    expect(provider.generate.mock.calls[0]?.[0].imageInputs).toBeUndefined();
    expect(mockFailureLoggerLog).toHaveBeenCalledTimes(1);
    expect(mockFailureLoggerLog.mock.calls[0]?.[0].error).toMatch(/^\[vision-degraded\]/);
  });
});
