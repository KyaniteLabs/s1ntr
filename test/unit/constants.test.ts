import { describe, expect, it, vi } from 'vitest';

// SERVICE_DEFAULTS captures provider URLs from the environment at module load
// (LOCAL_LLM_URL / OLLAMA_URL / REASONING_URL). Clear those before the import so
// the test asserts the code's real defaults, not the host's ambient config — the
// <fleet-node> CI runner sets OLLAMA_URL, which otherwise leaks in and fails line 8.
vi.hoisted(() => {
  delete process.env.LOCAL_LLM_URL;
  delete process.env.OLLAMA_URL;
  delete process.env.REASONING_URL;
});

import { SERVICE_DEFAULTS } from '../../src/constants/index.js';
import { PROVIDER_DEFAULTS } from '../../src/config/ProviderRuntime.js';

describe('SERVICE_DEFAULTS provider compatibility values', () => {
  it('redirects legacy provider URLs to ProviderRuntime defaults', () => {
    expect(SERVICE_DEFAULTS.LOCAL_LLM_URL).toBe(PROVIDER_DEFAULTS.lmstudio.baseUrl);
    expect(SERVICE_DEFAULTS.OLLAMA_URL).toBe(PROVIDER_DEFAULTS.ollama.baseUrl);
    expect(SERVICE_DEFAULTS.MINIMAX_URL).toBe(PROVIDER_DEFAULTS.minimax.baseUrl);
  });

  it('keeps DEFAULT_MODEL as the LLMClient auto-detect sentinel', () => {
    expect(SERVICE_DEFAULTS.DEFAULT_MODEL).toBe('auto');
  });
});
