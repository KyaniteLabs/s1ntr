import { describe, it, expect } from 'vitest';
import {
  LUNA_MODEL_ID,
  CURRENT_LUNA_MODEL_ID,
  LUNA_ALIASES,
  resolveExecutorAlias,
  buildExecutorIdentity,
  isLunaIdentity,
  isKnownResponseModelAlias,
} from '../../../src/identity/canonicalAlias.js';

describe('canonical alias resolver', () => {
  it('exposes the canonical Luna model id', () => {
    expect(LUNA_MODEL_ID).toBe('gpt-5.6-luna');
  });

  it('resolves every documented Luna alias to the canonical id', () => {
    for (const alias of LUNA_ALIASES) {
      const result = resolveExecutorAlias(alias);
      expect(result.ok).toBe(true);
      expect(result.isLuna).toBe(true);
      expect(result.canonicalModel).toBe(LUNA_MODEL_ID);
    }
  });

  it('keeps the current Luna distinct from historical Luna and harness-ineligible', () => {
    for (const alias of [CURRENT_LUNA_MODEL_ID, `openai/${CURRENT_LUNA_MODEL_ID}`]) {
      const result = resolveExecutorAlias(alias);
      expect(result).toMatchObject({ ok: true, isLuna: true, canonicalModel: CURRENT_LUNA_MODEL_ID });
      expect(isLunaIdentity({ provider: 'openai', model: alias })).toBe(true);
    }
    expect(resolveExecutorAlias(LUNA_MODEL_ID).canonicalModel).toBe(LUNA_MODEL_ID);
    expect(resolveExecutorAlias(`${CURRENT_LUNA_MODEL_ID}-evil`).isLuna).toBe(false);
  });

  it('resolves bare openai/gpt-5.1 to a non-Luna canonical identity', () => {
    const result = resolveExecutorAlias('gpt-5.1');
    expect(result.ok).toBe(true);
    expect(result.isLuna).toBe(false);
    expect(result.canonicalProvider).toBe('openai');
    expect(result.canonicalModel).toBe('gpt-5.1');
  });

  it('resolves the Grok model family through the OpenAI-compatible transport', () => {
    const result = resolveExecutorAlias('grok-test-model');
    const transportHinted = resolveExecutorAlias('grok-4.5', { providerHint: 'grok-cli' });
    expect(result.ok).toBe(true);
    expect(result.canonicalProvider).toBe('openai');
    expect(transportHinted).toMatchObject({ ok: true, canonicalProvider: 'openai', canonicalModel: 'grok-4.5' });
    expect(buildExecutorIdentity('grok-test-model', 'high')).toEqual({ provider: 'openai', model: 'grok-test-model', effort: 'high', alias: 'grok-test-model' });
  });

  it('resolves provider-qualified claude alias', () => {
    const result = resolveExecutorAlias('anthropic/claude-opus-4-1');
    expect(result.ok).toBe(true);
    expect(result.canonicalProvider).toBe('anthropic');
    expect(result.canonicalModel).toBe('claude-opus-4-1');
  });

  it('does not substring-match Luna (evil-twin attack)', () => {
    // The security property is "no substring guessing": an attacker cannot
    // slip Luna past the resolver using a Luna-prefixed string. The resolver
    // detects the openai provider family but does NOT report the alias as
    // Luna — the eligibility policy then sees a non-Luna identity, and the
    // host registry would refuse to sign a reservation for an unrecognized
    // model anyway.
    const result = resolveExecutorAlias('gpt-5.6-luna-evil-twin');
    expect(result.isLuna).toBe(false);
    expect(result.canonicalModel).not.toBe(LUNA_MODEL_ID);
  });

  it('fails closed on an unrecognized provider token', () => {
    const result = resolveExecutorAlias('nonsense/garbage');
    expect(result.ok).toBe(false);
    expect(result.canonicalProvider).toBe('unknown');
  });

  it('recognizes the authorized DeepInfra DeepSeek ID before provider splitting', () => {
    const alias = 'deepseek-ai/DeepSeek-V4-Flash-0731';
    expect(resolveExecutorAlias(alias, { providerHint: 'openai' })).toMatchObject({
      ok: true, canonicalProvider: 'openai', canonicalModel: alias.toLowerCase(),
    });
    expect(buildExecutorIdentity(alias, 'high', { providerHint: 'openai' })).toMatchObject({
      provider: 'openai', model: alias.toLowerCase(), alias,
    });
    expect(resolveExecutorAlias('deepseek-ai/unrecognized-model').ok).toBe(false);
    expect(resolveExecutorAlias(alias + '-evil-twin').ok).toBe(false);
    expect(resolveExecutorAlias('deepseek-v4-flash:cloud').canonicalProvider).toBe('ollama');
  });

  it('names a llama.cpp model by its .gguf file stem and maps LFM3 to the local provider', () => {
    expect(resolveExecutorAlias('/srv/models/lfm3/LFM3-1.7B-Q4_K_M.gguf')).toMatchObject({
      ok: true, canonicalProvider: 'lmstudio', canonicalModel: 'lfm3-1.7b-q4_k_m', isLuna: false,
    });
    expect(resolveExecutorAlias('lfm3').canonicalProvider).toBe('lmstudio');
  });

  it('keeps an unrecognized .gguf file unknown', () => {
    const result = resolveExecutorAlias('/srv/models/mystery-model.gguf');
    expect(result.ok).toBe(false);
    expect(result.canonicalProvider).toBe('unknown');
  });

  it('treats empty alias as unknown', () => {
    const result = resolveExecutorAlias('');
    expect(result.ok).toBe(false);
  });

  it('recognizes only the verified Dots gateway ID without admitting its namespace', () => {
    const alias = 'dots-studio/dots-3-note-preview:free';
    expect(resolveExecutorAlias(alias)).toMatchObject({
      ok: true, canonicalProvider: 'openai', canonicalModel: alias, isLuna: false,
    });
    for (const rejected of [alias + '-evil-twin', 'dots-studio/unregistered-model',
      'dots-studio/gpt-6-luna', 'dots-studio/gpt-5.6-luna']) {
      expect(resolveExecutorAlias(rejected).ok).toBe(false);
    }
  });

  it('buildExecutorIdentity returns null on unknown alias', () => {
    expect(buildExecutorIdentity('not-a-real-model', 'high')).toBeNull();
  });

  it('buildExecutorIdentity stamps the alias for audit', () => {
    const identity = buildExecutorIdentity('openai/gpt-5.6-luna', 'max');
    expect(identity!.model).toBe(LUNA_MODEL_ID);
    expect(identity!.alias).toBe('openai/gpt-5.6-luna');
    expect(identity!.effort).toBe('max');
  });

  it('isLunaIdentity detects Luna across aliases', () => {
    expect(isLunaIdentity({ provider: 'openai', model: LUNA_MODEL_ID })).toBe(true);
    expect(isLunaIdentity({ provider: 'openai', model: 'gpt-5.1' })).toBe(false);
    expect(isLunaIdentity({ provider: 'openai', model: 'openai/gpt-5.6-luna' })).toBe(true);
  });

  it('accepts the exact cliproxy Gemini effort response alias', () => {
    expect(isKnownResponseModelAlias(
      { provider: 'openai', model: 'gemini-3.6-flash-high' },
      { provider: 'openai', model: 'gemini-3.6-flash' },
    )).toBe(true);
  });

  it('resolves the DeepSeek tour-rotation generator through the Ollama family', () => {
    const result = resolveExecutorAlias('deepseek-v4-flash', { providerHint: 'ollama' });
    expect(result.ok).toBe(true);
    expect(result.isLuna).toBe(false);
    expect(result.canonicalProvider).toBe('ollama');
    expect(result.canonicalModel).toBe('deepseek-v4-flash');
    expect(buildExecutorIdentity('deepseek-v4-flash', 'low', { providerHint: 'ollama' }))
      .toEqual({ provider: 'ollama', model: 'deepseek-v4-flash', effort: 'low', alias: 'deepseek-v4-flash' });
  });

  it('rejects reverse, provider-changing, and unknown response aliases', () => {
    expect(isKnownResponseModelAlias(
      { provider: 'openai', model: 'gemini-3.6-flash' },
      { provider: 'openai', model: 'gemini-3.6-flash-high' },
    )).toBe(false);
    expect(isKnownResponseModelAlias(
      { provider: 'google', model: 'gemini-3.6-flash-high' },
      { provider: 'openai', model: 'gemini-3.6-flash' },
    )).toBe(false);
    expect(isKnownResponseModelAlias(
      { provider: 'openai', model: 'gemini-3.6-flash-high' },
      { provider: 'openai', model: 'gemini-3-flash' },
    )).toBe(false);
  });

  it('canonicalizes vendor-prefixed gateway qwen ids to the same identity as the bare L8 seat', () => {
    const prefixed = buildExecutorIdentity('qwen/qwen3.8-27b', 'high');
    const bare = buildExecutorIdentity('qwen3.8-27b', 'high');
    expect(prefixed).toMatchObject({ provider: 'openai', model: 'qwen3.8-27b' });
    expect(bare).toMatchObject({ provider: 'openai', model: 'qwen3.8-27b' });
    expect(prefixed!.provider).toBe('openai');
    expect(prefixed!.model).toBe('qwen3.8-27b');
    expect(prefixed!.provider).toBe(bare!.provider);
    expect(prefixed!.model).toBe(bare!.model);
  });
});

describe('kilo gateway vendor-prefix echo aliases (fleet seats 2026-08-29)', () => {
  it('accepts a one-segment vendor prefix echo: deepseek-v4-flash -> deepseek/deepseek-v4-flash', () => {
    expect(isKnownResponseModelAlias(
      { provider: 'openai', model: 'deepseek-v4-flash' },
      { provider: 'openai', model: 'deepseek/deepseek-v4-flash' },
    )).toBe(true);
  });

  it('accepts hy3 -> tencent/hy3', () => {
    expect(isKnownResponseModelAlias(
      { provider: 'openai', model: 'hy3' },
      { provider: 'openai', model: 'tencent/hy3' },
    )).toBe(true);
  });

  it('still rejects a different model or cross-provider echo', () => {
    expect(isKnownResponseModelAlias(
      { provider: 'openai', model: 'deepseek-v4-flash' },
      { provider: 'openai', model: 'deepseek/deepseek-v4.1' },
    )).toBe(false);
    expect(isKnownResponseModelAlias(
      { provider: 'openai', model: 'hy3' },
      { provider: 'anthropic', model: 'tencent/hy3' },
    )).toBe(false);
  });
});

describe('provider hints that name no model family (#1748)', () => {
  // A custom seat is an OpenAI-compatible endpoint S1NTR has no named entry
  // for; RoleConfig hints it as 'unknown'. The model id must decide.
  for (const hint of ['custom', 'cli', 'unknown']) {
    it(`a '${hint}' hint keeps a known model's family`, () => {
      expect(buildExecutorIdentity('tencent/hy4-flash:free', 'high', { providerHint: hint }))
        .toMatchObject({ provider: 'openai' });
    });

    it(`a '${hint}' hint still fails closed on an unknown model`, () => {
      expect(buildExecutorIdentity('totally-made-up-model-9', 'high', { providerHint: hint })).toBeNull();
    });
  }

  it('a named hint still overrides detection', () => {
    expect(buildExecutorIdentity('tencent/hy4-flash:free', 'high', { providerHint: 'kilo' }))
      .toMatchObject({ provider: 'kilo' });
  });
});
