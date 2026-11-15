import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProductionCliCompose }
  from '../../../src/cli/LiminalProductionCompose.js';

describe('governed CLI compose — transport authority', () => {
  it('rejects non-absolute output root', async () => {
    const delegate = { composeFromPrompt: vi.fn() };
    await expect(runProductionCliCompose(
      { prompt: 'test', outputRoot: 'relative/path' }, delegate))
      .rejects.toThrow('GOVERNED_COMPOSE_OUTPUT_ROOT_NOT_ABSOLUTE');
  });

  it('bootstraps production runtime and wraps compose in runResearchProviderEffect', async () => {
    const root = path.resolve('/tmp/liminal-compose-test');
    const compositionResult = { html: '<html></html>', title: 'test',
      successCount: 1, layers: [] } as never;
    const close = vi.fn(async () => undefined);
    const runResearchProviderEffect = vi.fn(async (input: {
      effect: () => Promise<unknown>;
    }) => input.effect());
    const factory = vi.fn(async () => ({
      root,
      identities: { generator: 'test-provider/test-model' },
      port: { runResearchProviderEffect },
      close,
    }) as never);
    const composeFromPrompt = vi.fn(async () => compositionResult);
    const delegate = { composeFromPrompt };

    const result = await runProductionCliCompose(
      { prompt: 'aurora over mountains', outputRoot: root },
      delegate,
      factory,
    );

    // Runtime bootstrapped with the output root
    expect(factory).toHaveBeenCalledWith({ root });
    // Port.runResearchProviderEffect established the transport authority grant
    expect(runResearchProviderEffect).toHaveBeenCalledTimes(1);
    const grantCall = runResearchProviderEffect.mock.calls[0][0];
    expect(grantCall.role).toBe('generator');
    expect(grantCall.identity).toBe('test-provider/test-model');
    expect(grantCall.binding).toEqual({ prompt: 'aurora over mountains', surface: 'cli-compose' });
    expect(grantCall.idempotencyKey).toMatch(/^production-compose:[a-f0-9]{64}$/);
    // Delegate.composeFromPrompt was invoked inside the grant scope
    expect(composeFromPrompt).toHaveBeenCalledTimes(1);
    // Result returned
    expect(result.result).toBe(compositionResult);
    // Runtime closed
    expect(close).toHaveBeenCalledOnce();
  });

  it('passes a generator-role LLMClient so decomposePrompt inherits the grant scope', async () => {
    const root = path.resolve('/tmp/liminal-compose-test-2');
    const compositionResult = { html: '<html></html>', title: 'test',
      successCount: 0, layers: [] } as never;
    const close = vi.fn(async () => undefined);
    const runResearchProviderEffect = vi.fn(async (input: {
      effect: () => Promise<unknown>;
    }) => input.effect());
    const factory = vi.fn(async () => ({
      root,
      identities: { generator: 'test-provider/test-model' },
      port: { runResearchProviderEffect },
      close,
    }) as never);

    let capturedLlmRole: string | undefined;
    const composeFromPrompt = vi.fn(async (
      _prompt: string, llm: { role?: string }) => {
      capturedLlmRole = (llm as { role?: string }).role;
      return compositionResult;
    });
    const delegate = { composeFromPrompt };

    await runProductionCliCompose(
      { prompt: 'deep sea creatures', outputRoot: root },
      delegate,
      factory,
    );

    expect(capturedLlmRole).toBe('generator');
  });
});
