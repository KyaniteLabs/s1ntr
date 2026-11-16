import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveThinkingConfig } from '../../../src/config/RoleConfig.js';

// #1735: HYDRA sweeps every seat at medium, high and xhigh. Each level must reach the
// request as its own effort, and "none" must turn reasoning off instead of being ignored.
describe('resolveThinkingConfig reasoning levels', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['medium', 8_000],
    ['high', 16_000],
    ['xhigh', 24_000],
    ['max', 32_000],
  ] as const)('pins %s with its own budget', (level, budgetTokens) => {
    vi.stubEnv('SINTER_LLM_THINKING_EFFORT', level);
    expect(resolveThinkingConfig()).toEqual({ enabled: true, effort: level, budgetTokens });
  });

  it('turns reasoning off for none, even over a file setting', () => {
    vi.stubEnv('SINTER_LLM_THINKING_EFFORT', 'none');
    expect(resolveThinkingConfig({ enabled: true, effort: 'high' })).toEqual({ enabled: false });
  });

  it('keeps the file setting when no level is pinned', () => {
    vi.stubEnv('SINTER_LLM_THINKING_EFFORT', '');
    vi.stubEnv('LIMINAL_LLM_THINKING_EFFORT', '');
    expect(resolveThinkingConfig({ enabled: true, effort: 'medium' })).toEqual({ enabled: true, effort: 'medium' });
  });
});
