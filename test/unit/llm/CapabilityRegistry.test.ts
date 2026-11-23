import { describe, it, expect, beforeEach } from 'vitest';

import { CapabilityRegistry } from '../../../src/llm/CapabilityRegistry.js';

describe('CapabilityRegistry', () => {
  beforeEach(() => {
    CapabilityRegistry.clearOverrides();
  });

  describe('known models return correct capabilities', () => {
    it('claude-sonnet-4-20250514 has thinking, budget_tokens, 200K context', () => {
      const caps = CapabilityRegistry.getCapabilities('claude-sonnet-4-20250514');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('budget_tokens');
      expect(caps.maxContextTokens).toBe(200_000);
      expect(caps.streaming).toBe(true);
      expect(caps.jsonMode).toBe(true);
      expect(caps.toolUse).toBe(true);
      expect(caps.streamingStyle).toBe('sse');
    });

    it('gpt-5 has thinking, effort_level, 400K context', () => {
      const caps = CapabilityRegistry.getCapabilities('gpt-5');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('effort_level');
      expect(caps.maxContextTokens).toBe(400_000);
      expect(caps.streaming).toBe(true);
      expect(caps.toolUse).toBe(true);
    });

    it('gpt-4o has no thinking', () => {
      const caps = CapabilityRegistry.getCapabilities('gpt-4o');

      expect(caps.thinking).toBe(false);
      expect(caps.thinkingStyle).toBe('none');
    });

    it('gemini-2.5-pro has thinking, budget_tokens, 2M context', () => {
      const caps = CapabilityRegistry.getCapabilities('gemini-2.5-pro');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('budget_tokens');
      expect(caps.maxContextTokens).toBe(2_000_000);
    });

    it('deepseek-r1 has thinking with think_tags', () => {
      const caps = CapabilityRegistry.getCapabilities('deepseek-r1');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('think_tags');
    });

    it('qwen3.5-coder-14b has thinking', () => {
      const caps = CapabilityRegistry.getCapabilities('qwen3.5-coder-14b');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('budget_tokens');
      expect(caps.maxContextTokens).toBe(128_000);
    });

    it('gemma-4-31b-it has thinking, 256K context, think_tags', () => {
      const caps = CapabilityRegistry.getCapabilities('gemma-4-31b-it');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('think_tags');
      expect(caps.maxContextTokens).toBe(256_000);
      expect(caps.streamingStyle).toBe('sse');
    });

    it('gemma4:E4B (Ollama naming) has thinking, 128K context', () => {
      const caps = CapabilityRegistry.getCapabilities('gemma4:E4B');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('think_tags');
      expect(caps.maxContextTokens).toBe(128_000);
      expect(caps.streamingStyle).toBe('json_lines');
    });
  });

  it('pins gpt-6 temperature to 1, the only value api.openai.com accepts', () => {
    expect(CapabilityRegistry.getCapabilities('gpt-6.2-sol').temperatureFixed).toBe(1);
    expect(CapabilityRegistry.getCapabilities('gpt-4o').temperatureFixed).toBeUndefined();
  });

  describe('glob pattern matching', () => {
    it('claude-sonnet-4-* matches claude-sonnet-4-20250514', () => {
      const caps = CapabilityRegistry.getCapabilities('claude-sonnet-4-20250514');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('budget_tokens');
    });

    it('gpt-5* matches gpt-5-turbo', () => {
      const caps = CapabilityRegistry.getCapabilities('gpt-5-turbo');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('effort_level');
    });

    it('gpt-5* matches gpt-5.1', () => {
      const caps = CapabilityRegistry.getCapabilities('gpt-5.1');

      expect(caps.thinking).toBe(true);
      expect(caps.maxContextTokens).toBe(400_000);
    });

    it('gpt-5* matches gpt-5 (exact prefix)', () => {
      const caps = CapabilityRegistry.getCapabilities('gpt-5');

      expect(caps.thinking).toBe(true);
    });

    it('exact match works for non-wildcard patterns', () => {
      // qwen3.5-coder-14b is an exact (non-wildcard) pattern
      const caps = CapabilityRegistry.getCapabilities('qwen3.5-coder-14b');

      expect(caps.thinking).toBe(true);
      expect(caps.maxContextTokens).toBe(128_000);
    });

    it('more-specific pattern takes priority over less-specific wildcard', () => {
      // qwen3.5-coder-7b is exact match (no thinking), qwen3.5* is wildcard (thinking)
      // The longer pattern should win
      const caps7b = CapabilityRegistry.getCapabilities('qwen3.5-coder-7b');
      expect(caps7b.thinking).toBe(false);

      const capsWildcard = CapabilityRegistry.getCapabilities('qwen3.5-something-else');
      expect(capsWildcard.thinking).toBe(true);
    });
  });

  describe('user overrides take priority', () => {
    it('override sets capabilities for a model', () => {
      CapabilityRegistry.override('my-model', { thinking: true });

      const caps = CapabilityRegistry.getCapabilities('my-model');

      expect(caps.thinking).toBe(true);
    });

    it('override merges with defaults for unspecified fields', () => {
      CapabilityRegistry.override('my-model', { thinking: true });

      const caps = CapabilityRegistry.getCapabilities('my-model');

      expect(caps.thinking).toBe(true);
      expect(caps.streaming).toBe(true); // from DEFAULT_CAPABILITIES
      expect(caps.jsonMode).toBe(true); // from DEFAULT_CAPABILITIES
    });

    it('override takes priority over static registry', () => {
      // gpt-4o normally has thinking: false
      CapabilityRegistry.override('gpt-4o', { thinking: true, thinkingStyle: 'budget_tokens' });

      const caps = CapabilityRegistry.getCapabilities('gpt-4o');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('budget_tokens');
    });

    it('clearOverrides removes all overrides', () => {
      CapabilityRegistry.override('my-model', { thinking: true });
      CapabilityRegistry.clearOverrides();

      const caps = CapabilityRegistry.getCapabilities('my-model');

      // Should fall back to defaults (no match in static registry)
      expect(caps.thinking).toBe(false);
    });

    it('override can set maxContextTokens', () => {
      CapabilityRegistry.override('my-model', { maxContextTokens: 999_999 });

      const caps = CapabilityRegistry.getCapabilities('my-model');

      expect(caps.maxContextTokens).toBe(999_999);
    });
  });

  describe('unknown models return conservative defaults', () => {
    it('returns default capabilities for completely unknown model', () => {
      const caps = CapabilityRegistry.getCapabilities('unknown-model-xyz');

      expect(caps.thinking).toBe(false);
      expect(caps.streaming).toBe(true);
      expect(caps.jsonMode).toBe(true);
      expect(caps.toolUse).toBe(false);
      expect(caps.maxContextTokens).toBe(4096);
      expect(caps.thinkingStyle).toBe('none');
      expect(caps.streamingStyle).toBe('sse');
    });

    it('returns a new object each call (no shared references)', () => {
      const caps1 = CapabilityRegistry.getCapabilities('unknown-model-xyz');
      const caps2 = CapabilityRegistry.getCapabilities('unknown-model-xyz');

      expect(caps1).toEqual(caps2);
      expect(caps1).not.toBe(caps2);
    });
  });

  describe('priority order: overrides > static registry > defaults', () => {
    it('override wins over static registry for a known model', () => {
      // claude-sonnet-4-20250514 normally has maxContextTokens: 200000
      CapabilityRegistry.override('claude-sonnet-4-20250514', { maxContextTokens: 500_000 });

      const caps = CapabilityRegistry.getCapabilities('claude-sonnet-4-20250514');

      // Override merges with DEFAULT_CAPABILITIES, not the static registry entry.
      // So thinking falls back to the default (false), not the static registry (true).
      expect(caps.maxContextTokens).toBe(500_000);
      expect(caps.thinking).toBe(false); // from DEFAULT_CAPABILITIES, override didn't specify
    });

    it('static registry wins over defaults for a matched model', () => {
      const caps = CapabilityRegistry.getCapabilities('gpt-4o');

      // Static registry says 128000, defaults say 4096
      expect(caps.maxContextTokens).toBe(128_000);
    });

    it('after clearing override, static registry applies again', () => {
      CapabilityRegistry.override('gpt-4o', { maxContextTokens: 999_999 });
      expect(CapabilityRegistry.getCapabilities('gpt-4o').maxContextTokens).toBe(999_999);

      CapabilityRegistry.clearOverrides();
      expect(CapabilityRegistry.getCapabilities('gpt-4o').maxContextTokens).toBe(128_000);
    });

    it('unknown model with override still gets defaults for unspecified fields', () => {
      CapabilityRegistry.override('brand-new-model', { thinking: true, thinkingStyle: 'think_tags' });

      const caps = CapabilityRegistry.getCapabilities('brand-new-model');

      expect(caps.thinking).toBe(true);
      expect(caps.thinkingStyle).toBe('think_tags');
      expect(caps.streaming).toBe(true); // from defaults
      expect(caps.jsonMode).toBe(true); // from defaults
      expect(caps.maxContextTokens).toBe(4096); // from defaults
    });
  });

  describe('supportsVision', () => {
    it('returns true for known multimodal families', () => {
      for (const m of [
        'glm-5v-turbo',
        'MiniMax-M3',
        'claude-opus-4-1',
        'gpt-5.4',
        'gemini-2.5-flash',
        'gemma4:12b',
        // Wave 4 evaluator seat — must accept rendered screenshots
        'grok-4.5',
        'grok-4',
        'xai/grok-4.5',
        // M-20261008-14 probe evidence: glm-5.3-flash reads images correctly
        // on the z.ai anthropic-compat wire (red/blue AND green/orange frames)
        'glm-5.3-flash',
        'glm-5.3-flash-high',
        // 2026-11-12 probe: glm-4.6v read an image block correctly on the
        // z.ai anthropic wire (HTTP 200, end_turn).
        'glm-4.6v',
      ]) {
        expect(CapabilityRegistry.supportsVision(m)).toBe(true);
      }
    });

    it('returns false for text-only models (local open-source incl. the NUCBOX route)', () => {
      for (const m of ['qwen3.6-35b-a3b-mtp', 'qwen2.5-coder:14b', 'glm-5.1', 'deepseek-r1', 'llama3.2', 'unknown-model']) {
        expect(CapabilityRegistry.supportsVision(m)).toBe(false);
      }
    });

    it('GPT-6 models see images (probe 2026-11-10: luna, terra, sol each described a test image)', () => {
      expect(CapabilityRegistry.supportsVision('gpt-6-luna')).toBe(true);
      expect(CapabilityRegistry.supportsVision('gpt-6.1-terra')).toBe(true);
      expect(CapabilityRegistry.supportsVision('openai/gpt-6.1-sol')).toBe(true);
      expect(CapabilityRegistry.supportsVision('deepseek-v4.1-flash-1017')).toBe(false);
    });

    it('glm-5.3 FLAGSHIP stays text-only (probe: paas/v4 error 1210, anthropic image inaccessible)', () => {
      // M-20261008-14: only the flash variant is vision-capable. Marking the
      // flagship vision would send pixels it cannot see and re-create the
      // silent text-only judging class this probe closed.
      expect(CapabilityRegistry.supportsVision('glm-5.3')).toBe(false);
      expect(CapabilityRegistry.supportsVision('glm-5.3-turbo')).toBe(false);
    });

    it('matches wildcards in the middle of a vision pattern', () => {
      expect(CapabilityRegistry.supportsVision('qwen2.5-vl-72b')).toBe(true);
      expect(CapabilityRegistry.supportsVision('acme-vision-1')).toBe(true);
      expect(CapabilityRegistry.supportsVision('acme-vl-2')).toBe(true);
    });

    it('honors a config override of the vision flag', () => {
      CapabilityRegistry.override('qwen3.6-35b-a3b-mtp', { vision: true });
      expect(CapabilityRegistry.supportsVision('qwen3.6-35b-a3b-mtp')).toBe(true);
      CapabilityRegistry.override('glm-5v-turbo', { vision: false });
      expect(CapabilityRegistry.supportsVision('glm-5v-turbo')).toBe(false);
    });
  });

  describe('model kinds (LFM3 family)', () => {
    it.each([
      ['LiquidAI/LFM3-1.7B', 'generative', ['text'], ['text'], 256_000],
      ['LiquidAI/LFM3-VL-2B', 'generative', ['text', 'image'], ['text'], 128_000],
      ['LiquidAI/LFM3-Audio-2B', 'generative', ['text', 'audio'], ['text', 'audio'], 128_000],
      ['LiquidAI/LFM3-Omni-2B', 'generative', ['text', 'image', 'video', 'audio'], ['text', 'audio'], 128_000],
      ['LiquidAI/d1-2B', 'decision', ['text', 'image', 'video'], [], 128_000],
      ['LiquidAI/d1-Omni-2B', 'decision', ['text', 'image', 'video', 'audio'], [], 128_000],
    ])('%s is %s with its modalities', (model, kind, input, output, context) => {
      const caps = CapabilityRegistry.getCapabilities(model);
      expect(CapabilityRegistry.modelKind(model)).toBe(kind);
      expect(CapabilityRegistry.isDecisionModel(model)).toBe(kind === 'decision');
      expect(caps.inputModalities).toEqual(input);
      expect(caps.outputModalities).toEqual(output);
      expect(caps.maxContextTokens).toBe(context);
    });

    it('decision models never stream or emit JSON text', () => {
      const caps = CapabilityRegistry.getCapabilities('d1-2b-q8_0.gguf');
      expect(caps.streaming).toBe(false);
      expect(caps.jsonMode).toBe(false);
    });

    it('vision covers image-capable LFM3 and d1 models only', () => {
      expect(CapabilityRegistry.supportsVision('LiquidAI/d1-2B')).toBe(true);
      expect(CapabilityRegistry.supportsVision('LiquidAI/LFM3-Omni-2B')).toBe(true);
      expect(CapabilityRegistry.supportsVision('LiquidAI/LFM3-1.7B')).toBe(false);
    });

    it('unknown models default to generative', () => {
      expect(CapabilityRegistry.modelKind('totally-unknown-model')).toBe('generative');
      expect(CapabilityRegistry.isDecisionModel('')).toBe(false);
    });
  });
});
