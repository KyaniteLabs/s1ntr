import { describe, expect, it, vi } from 'vitest';
import { LLMDreamEvaluator } from '../../../src/runtime-core/ProductionDreamHostAdapters.js';

const fakeClient = (model: string) => ({
  getConfig: () => ({ provider: 'kilo', model, baseUrl: `https://${model}.example` }),
  generate: vi.fn(),
});

describe('LLMDreamEvaluator vision gate', () => {
  it('refuses a text-only model at construction, before any provider call', () => {
    const client = fakeClient('deepseek/deepseek-v4.1-flash-1017');
    expect(() => new LLMDreamEvaluator(client as never))
      .toThrow('DREAM_EVALUATOR_VISION_REQUIRED');
    expect(client.generate).not.toHaveBeenCalled();
  });

  it('accepts a vision-capable model', () => {
    const client = fakeClient('glm-5.3-flash');
    expect(new LLMDreamEvaluator(client as never).identity.identityDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('LLMDreamEvaluator verdict contract', () => {
  const comparison = { schema: 'sinter.dream-anonymous-comparison', policyDigest: 'p',
    criteria: ['visual-depth'], arms: [] } as never;
  const frame = { mimeType: 'image/png', dataBase64: 'AA==' };
  const reply = (criterion: string) => ({ success: true, code: JSON.stringify({ outcome: 'keeper',
    uncertainty: 0.2, criteria: [{ criterion, direction: 'improved' }] }) });

  it('requires pixels on the call and names the real criterion ids in the reply schema', async () => {
    const client = { ...fakeClient('glm-5.3-flash'), generate: vi.fn().mockResolvedValue(reply('visual-depth')) };
    await new LLMDreamEvaluator(client as never).compare({ ...(comparison as object),
      arms: [{ evidence: { pixelFrames: [frame] } }] } as never);
    const [, user, , , images, opts] = client.generate.mock.calls[0];
    expect(images).toEqual([frame]);
    expect(opts).toMatchObject({ requireVision: true });
    expect(user).toContain('"criterion":"visual-depth"');
    expect(user).not.toContain('"criterion":"id"');
  });

  it('rejects a criterion outside the comparison, naming it', async () => {
    const client = { ...fakeClient('glm-5.3-flash'), generate: vi.fn().mockResolvedValue(reply('id')) };
    await expect(new LLMDreamEvaluator(client as never).compare({ ...(comparison as object),
      arms: [{ evidence: { pixelFrames: [frame] } }] } as never))
      .rejects.toThrow('DREAM_CRITERION_VERDICT_INVALID:unknown-criterion:id');
  });
});

describe('dream provider JSON replies', () => {
  it('a reply that is not JSON fails with its head attached, so the failure is diagnosable', async () => {
    const { LLMDreamTransferProducer } = await import('../../../src/runtime-core/ProductionDreamHostAdapters.js');
    const client = { generate: vi.fn().mockResolvedValue({ success: true,
      code: '{\n    id: "t1", source: "<html></html>"\n}' }) };
    await expect(new LLMDreamTransferProducer(client as never).produce({ holdout: 'h',
      contextDigest: 'c', findingDigest: null }))
      .rejects.toThrow(/DREAM_PROVIDER_RESPONSE_UNPARSEABLE:.*id: "t1"/s);
  });
});
