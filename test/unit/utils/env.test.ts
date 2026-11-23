import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, mirrorBrandEnv } from '../../../src/utils/env.js';

describe('env utilities', () => {
  const keysToClean: string[] = [];

  function setEnv(key: string, value: string) {
    process.env[key] = value;
    keysToClean.push(key);
  }

  afterEach(() => {
    for (const key of keysToClean) {
      delete process.env[key];
    }
    keysToClean.length = 0;
  });

  describe('env()', () => {
    it('reads SINTER_ prefixed value', () => {
      setEnv('SINTER_TEST_KEY', 'sinter-value');
      expect(env('TEST_KEY')).toBe('sinter-value');
    });

    it('falls back to LIMINAL_ prefixed value', () => {
      setEnv('LIMINAL_TEST_KEY', 'liminal-value');
      expect(env('TEST_KEY')).toBe('liminal-value');
    });

    it('prefers SINTER_ over LIMINAL_', () => {
      setEnv('SINTER_TEST_KEY', 'sinter');
      setEnv('LIMINAL_TEST_KEY', 'liminal');
      expect(env('TEST_KEY')).toBe('sinter');
    });

    it('returns undefined for unset variable', () => {
      expect(env('NONEXISTENT_KEY_XYZ')).toBeUndefined();
    });
  });

  describe('mirrorBrandEnv()', () => {
    it('mirrors SINTER_ to LIMINAL_ when LIMINAL_ is unset', () => {
      setEnv('SINTER_MIRROR_TEST', 'hello');
      mirrorBrandEnv();
      expect(process.env['LIMINAL_MIRROR_TEST']).toBe('hello');
    });

    it('mirrors LIMINAL_ to SINTER_ when SINTER_ is unset', () => {
      setEnv('LIMINAL_MIRROR_TEST2', 'world');
      mirrorBrandEnv();
      expect(process.env['SINTER_MIRROR_TEST2']).toBe('world');
    });

    it('does not overwrite existing counterpart', () => {
      setEnv('SINTER_MIRROR_TEST3', 'original');
      setEnv('LIMINAL_MIRROR_TEST3', 'keep-me');
      mirrorBrandEnv();
      expect(process.env['SINTER_MIRROR_TEST3']).toBe('original');
      expect(process.env['LIMINAL_MIRROR_TEST3']).toBe('keep-me');
    });

    it('ignores non-branded env vars', () => {
      setEnv('PATH', '/usr/bin');
      const beforeSinter = process.env['SINTER_PATH'];
      mirrorBrandEnv();
      // PATH is not branded, should not create SINTER_PATH
      expect(process.env['SINTER_PATH']).toBe(beforeSinter);
    });
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('branded endpoint credentials', () => {
  it('mirrors a URL and key pair to an unused prefix', () => {
    vi.stubEnv('SINTER_GENERATOR_BASE_URL', undefined);
    vi.stubEnv('SINTER_GENERATOR_API_KEY', undefined);
    vi.stubEnv('LIMINAL_GENERATOR_BASE_URL', 'https://legacy-route.invalid/v1');
    vi.stubEnv('LIMINAL_GENERATOR_API_KEY', 'legacy-route-key');

    mirrorBrandEnv();
    expect(process.env.SINTER_GENERATOR_BASE_URL).toBe('https://legacy-route.invalid/v1');
    expect(process.env.SINTER_GENERATOR_API_KEY).toBe('legacy-route-key');
  });

  it('leaves a legacy key on its original endpoint when both prefixes are set', () => {
    vi.stubEnv('SINTER_LLM_BASE_URL', 'https://current-route.invalid/v1');
    vi.stubEnv('SINTER_LLM_API_KEY', undefined);
    vi.stubEnv('LIMINAL_LLM_BASE_URL', 'https://legacy-route.invalid/v1');
    vi.stubEnv('LIMINAL_LLM_API_KEY', 'legacy-route-key');

    mirrorBrandEnv();
    expect(process.env.SINTER_LLM_API_KEY).toBeUndefined();
    expect(process.env.LIMINAL_LLM_API_KEY).toBe('legacy-route-key');
  });
});
