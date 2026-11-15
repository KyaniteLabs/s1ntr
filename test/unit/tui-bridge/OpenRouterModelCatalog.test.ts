import { describe, it, expect } from 'vitest';
import {
  resolveOpenRouterModelAlias,
  OPENROUTER_MODEL_CATALOG,
} from '../../../src/tui-bridge/OpenRouterModelCatalog.js';
import { PROVIDER_DEFAULTS } from '../../../src/config/ProviderRuntime.js';

// Operator rule (2026-11-09): aggregators serve only DeepSeek V4.1 Flash 1017 or free models.
const AGGREGATOR_ALLOWED = (model: string) =>
  model === 'deepseek/deepseek-v4.1-flash-1017' || model.endsWith(':free');

describe('OpenRouterModelCatalog', () => {
  it('offers only aggregator-allowed models', () => {
    expect(OPENROUTER_MODEL_CATALOG.map((e) => e.model).filter((m) => !AGGREGATOR_ALLOWED(m))).toEqual([]);
  });

  it('defaults the OpenRouter provider to an aggregator-allowed model', () => {
    expect(AGGREGATOR_ALLOWED(PROVIDER_DEFAULTS.openrouter.model)).toBe(true);
  });

  it('never routes an owned subscription (Claude, GPT, Gemini, GLM, MiniMax, Kimi, Grok) through OpenRouter', () => {
    const owned = /^(anthropic|openai|google|z-ai|minimax|minimaxai|moonshotai|x-ai|xai)\//;
    expect(OPENROUTER_MODEL_CATALOG.filter((e) => owned.test(e.model))).toEqual([]);
  });

  it('resolves the deepseek alias to the 1017 build, not the September bare slug', () => {
    expect(resolveOpenRouterModelAlias('deepseek')).toEqual({
      alias: 'deepseek',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      label: 'DeepSeek V4.1 Flash 1017',
    });
    expect(resolveOpenRouterModelAlias('deepseek/deepseek-v4.1-flash')).toBeNull();
  });

  it('resolves by full model name, case-insensitive, trimmed', () => {
    expect(resolveOpenRouterModelAlias('  DeepSeek/DeepSeek-V4.1-Flash-1017 ')?.alias).toBe('deepseek');
    expect(resolveOpenRouterModelAlias('DEEPSEEK')?.alias).toBe('deepseek');
  });

  it('returns null for undefined, empty, retired and unknown input', () => {
    expect(resolveOpenRouterModelAlias(undefined)).toBeNull();
    expect(resolveOpenRouterModelAlias('')).toBeNull();
    expect(resolveOpenRouterModelAlias('claude')).toBeNull();
    expect(resolveOpenRouterModelAlias('nonexistent-model')).toBeNull();
  });
});
