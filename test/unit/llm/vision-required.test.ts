/**
 * requireVision: a caller that cannot be answered without pixels (a blind pixel evaluator) must
 * get a typed error naming the model and role, never a text-only guess. Default callers keep the
 * loud degrade covered by vision-degraded-drop.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from 'neverthrow';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { LLMVisionRequiredError } from '../../../src/llm/errors.js';
import { CapabilityRegistry } from '../../../src/llm/CapabilityRegistry.js';

const IMAGE = { mimeType: 'image/png', dataBase64: 'ZmFrZS1wbng=', width: 4, height: 4, label: 'frame' };

function clientFor(model: string) {
  const provider = {
    name: 'openai',
    getModel: vi.fn(() => model),
    getConfig: vi.fn(() => ({ model, provider: 'openai', baseUrl: 'https://api.openai.com/v1' })),
    setModel: vi.fn(),
    generate: vi.fn(async () => ok({ content: '{}', success: true })),
  };
  const client = new LLMClient({ model, apiKey: 'fake-test-key' });
  vi.spyOn(client as never as { resolveModel: () => Promise<string> }, 'resolveModel').mockResolvedValue(model);
  vi.spyOn(client as never as { getProvider: () => Promise<unknown> }, 'getProvider').mockResolvedValue(provider);
  return { client, provider };
}

describe('LLMClient requireVision', () => {
  beforeEach(() => CapabilityRegistry.clearOverrides());

  it('throws a typed error naming model and role (role stays unset here: a role-bound client needs host authority) before any provider call', async () => {
    const { client, provider } = clientFor('qwen2.5-7b-instruct');
    const call = client.generate('s', 'u', undefined, true, [IMAGE], { requireVision: true });
    await expect(call).rejects.toBeInstanceOf(LLMVisionRequiredError);
    await expect(call).rejects.toMatchObject({ model: 'qwen2.5-7b-instruct', imageCount: 1 });
    await expect(call).rejects.toThrow(/qwen2\.5-7b-instruct.*role unset.*1 image/);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('forwards images untouched for a vision model', async () => {
    const { client, provider } = clientFor('gpt-4o');
    await client.generate('s', 'u', undefined, true, [IMAGE], { requireVision: true });
    expect(provider.generate.mock.calls[0]?.[0].imageInputs).toEqual([IMAGE]);
  });

  it('does not fire when the request carries no images', async () => {
    const { client, provider } = clientFor('qwen2.5-7b-instruct');
    await client.generate('s', 'u', undefined, true, undefined, { requireVision: true });
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
});
