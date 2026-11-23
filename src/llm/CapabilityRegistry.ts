/**
 * CapabilityRegistry - Static model → capabilities lookup
 *
 * Zero-cost capability detection. No token burning, no API probes.
 * Uses glob-style matching against a built-in model database.
 * Config overrides take priority over static data.
 */

import type { ProviderCapabilities } from './ProviderTypes.js';

/**
 * What a model fundamentally does. 'generative' models produce tokens and sit
 * behind LLMClient. 'decision' models (e.g. Liquid AI d1-2B) never generate:
 * one forward pass answers typed questions with calibrated outputs, so they are
 * served only by DecisionModelClient and must never receive a chat prompt.
 */
export type ModelKind = 'generative' | 'decision';
export type ModelModality = 'text' | 'image' | 'video' | 'audio';

export interface ModelCapabilities extends ProviderCapabilities {
  /** Absent means 'generative' (every pre-LFM3 entry). */
  kind?: ModelKind;
  /** Accepted input modalities. Absent means text only (vision is separate, see `vision`). */
  inputModalities?: readonly ModelModality[];
  /** Produced output modalities. Absent means text. Decision models output typed answers, not modalities. */
  outputModalities?: readonly ModelModality[];
  thinkingStyle: 'budget_tokens' | 'effort_level' | 'think_tags' | 'reasoning_content' | 'none';
  streamingStyle: 'sse' | 'json_lines' | 'tag_based';
  /** Accepts image input (multimodal). Used to decide whether to send rendered
   *  screenshots to an evaluator model. Text-only models must score from code. */
  vision?: boolean;
  /** When set, the model only accepts this exact temperature (e.g. kimi-k3
   *  rejects anything but 1). Call-site and role temperatures are overridden. */
  temperatureFixed?: number;
  /**
   * On the Anthropic wire this model thinks even when the request does not ask,
   * and ignores `budget_tokens`, so only max_tokens bounds its thinking. The
   * value is the model's output ceiling; the provider sends it as max_tokens so
   * thinking cannot crowd out the answer (z.ai probe 2026-11-16: no thinking
   * field -> all 600 tokens thinking; budget 1024 -> all 3000 tokens thinking;
   * max_tokens accepted up to 131072).
   */
  uncappedThinkingMaxOutput?: number;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  thinking: false,
  streaming: true,
  jsonMode: true,
  toolUse: false,
  maxContextTokens: 4096,
  thinkingStyle: 'none',
  streamingStyle: 'sse',
  vision: false,
};

// Multimodal model families that accept image input. Kept separate from the main
// capability table so vision support is declared in one place rather than spread
// across ~30 entries. Text-only local models (qwen, deepseek, glm-5.1, llama, …)
// deliberately do not match and so never receive rendered screenshots.
const VISION_MODEL_PATTERNS: string[] = [
  'claude-*', 'gpt-5*', 'gpt-4o*', 'o3*', 'o4*',
  // GPT-6 family: gpt-6-luna, gpt-6.1-terra and gpt-6.1-sol each read a test
  // frame natively through the Hermes gateway (probe 2026-11-10).
  'gpt-6*', 'openai/gpt-6*',
  'gemini*', 'glm-5v*', 'glm-4v*', 'glm-4.1v*',
  // glm-4.6v reads images on the z.ai anthropic-compat wire — probe-verified
  // 2026-11-12 PT: an image block + text prompt returned the correct text read
  // (HTTP 200, end_turn). It is the sss-score second-eye candidate while the
  // MiniMax lanes sit behind a spend wall.
  'glm-4.6v*',
  // glm-5.3-flash is vision-capable on the z.ai anthropic-compat wire —
  // probe-verified 2026-10-08 (M-20261008-14): image blocks at
  // api.z.ai/api/anthropic/v1/messages return correct color reads
  // (red/blue AND green/orange test frames). The glm-5.3 FLAGSHIP stays
  // text-only by evidence: paas/v4 hard-rejects image content (error 1210
  // "allowed values: ['text']") and the anthropic wire delivers an image
  // the model cannot access (hedged answer, empty text). Do NOT add
  // 'glm-5.3*' — only the flash variant sees.
  'glm-5.3-flash*',
  'minimax-m3*', 'gemma4*', 'gemma3*', '*-vl*', '*-vision*', '*vl-*',
  // Kimi K3 is multimodal (and the intended harness model); K2 stays text-only.
  'kimi-k3*',
  // xAI Grok 4.x / 4.5 (Wave 4 evaluator seat) accept image input via api.x.ai.
  // Missing this made live evaluator batteries honest-gap as "not vision-capable".
  'grok*',
  // Gateway-prefixed (vendor/model) families — vision confirmed via the Kilo
  // gateway /models metadata (architecture.input_modalities includes image).
  'openai/gpt-5*', 'moonshotai/kimi-k3*',
  'google/gemini-*', 'anthropic/claude-*',
  'xai/grok*',
  // Exact free Dots preview: gateway metadata declares text and image inputs.
  'dots-studio/dots-3-note-preview:free',
  // Liquid AI LFM3 (2026-10-27): VL-2B is covered by '*-vl*'; Omni-2B and both
  // d1 decision models accept images (docs.liquid.ai/lfm/models). Leading '*'
  // admits vendor/GGUF prefixes such as 'liquidai/' or 'hf.co/LiquidAI/'.
  '*lfm3-omni*', '*d1-2b*', '*d1-omni*',
];

// Static model database — update with new model releases
const MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {
  // Anthropic
  'claude-opus-4-*':    { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 200000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },
  'claude-sonnet-4-*':  { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 200000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },
  'claude-haiku-4-*':   { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 200000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },

  // OpenAI
  'gpt-5*':             { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 400000, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'o3*':                { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'o4-mini*':           { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'gpt-4o*':            { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse' },

  // Google
  'gemini-2.5-pro*':    { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 2000000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },
  'gemini-2.5-flash*':  { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1000000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },

  // Google Gemma 4 (released April 2026, Apache 2.0)
  // All sizes support native thinking via <|channel>thought tokens and function calling.
  // Ollama handles thinking parsing server-side, exposing it as a separate field.
  'gemma-4-31b*':       { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 256000, thinkingStyle: 'think_tags', streamingStyle: 'sse' },
  'gemma-4-26b*':       { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 256000, thinkingStyle: 'think_tags', streamingStyle: 'sse' },
  'gemma-4-E4B*':       { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'think_tags', streamingStyle: 'sse' },
  'gemma-4-E2B*':       { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'think_tags', streamingStyle: 'sse' },
  'gemma4:31b*':        { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 256000, thinkingStyle: 'think_tags', streamingStyle: 'json_lines' },
  'gemma4:26b*':        { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 256000, thinkingStyle: 'think_tags', streamingStyle: 'json_lines' },
  'gemma4:E4B*':        { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'think_tags', streamingStyle: 'json_lines' },
  'gemma4:E2B*':        { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'think_tags', streamingStyle: 'json_lines' },
  'gemma4*':            { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'think_tags', streamingStyle: 'json_lines' },

  // DeepSeek
  'deepseek-r1*':       { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'think_tags', streamingStyle: 'sse' },
  'deepseek-chat*':     { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse' },

  // ZhipuAI GLM (International Coding Plan — api.z.ai)
  // GLM-5.x: 205K context, flagship reasoning models rivaling Claude Opus
  // GLM-5-Turbo: optimized for agent/coding workflows, 200K context
  'glm-5v-turbo*':      { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 200000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'glm-5.1*':           { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 205000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'glm-5-turbo*':       { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 200000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  // glm-5.3 / glm-5.3-flash on z.ai think by default and ignore budget_tokens (see uncappedThinkingMaxOutput).
  'glm-5.3*':           { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 205000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse', uncappedThinkingMaxOutput: 131_072 },
  'glm-5*':             { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 205000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'glm-4.7*':           { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 200000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'glm-4.5*':           { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'glm-4-plus*':        { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'glm-4-flash*':       { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse' },
  'glm-4*':             { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse' },
  'codegeex-4*':        { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse' },

  // Moonshot AI KimiCode (api.moonshot.ai / api.moonshot.cn / api.kimi.com/coding)
  // Coding API: temperature=1 required; disable thinking so the model fills
  // message.content (reasoning_effort burns max_tokens with empty content).
  'kimi-for-coding*':    { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 256000, thinkingStyle: 'none', streamingStyle: 'sse', temperatureFixed: 1 },
  'kimi-k2-p5*':         { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'kimi-k2*':            { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'moonshot-v1*':        { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse' },

  // MiniMax
  'minimax-m3*':        { thinking: true, streaming: true, jsonMode: true, toolUse: true,  maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },

  // Official seats (#379 + #411):
  //   harness   → kimi-k3 on cliproxyapi (bare id; moonshotai/ kept for legacy)
  //   generator / studio → gemini-3.6-flash-high on cliproxy (multimodal)
  //   evaluator → gemini-3.1-pro-low on cliproxy (multimodal)
  //   fallback  → gpt-5.6-luna on cliproxy (bare id; openai/ kept for legacy)
  //   Kilo      → anthropic/claude-opus-5 (+ free google/gemini-3.5-flash)
  //   repair    → MiniMax-M3 direct (minimax-m3* below) — lane, not a seat
  // Vision: gemini-3.6-flash-high + gemini-3.1-pro-low are multimodal per proxy
  // metadata; covered by VISION_MODEL_PATTERNS ('gemini*', 'google/gemini-*').
  'kimi-k3*':               { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'reasoning_content', streamingStyle: 'sse', temperatureFixed: 1 },
  'moonshotai/kimi-k3*':    { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'reasoning_content', streamingStyle: 'sse', temperatureFixed: 1 },
  // GPT-6 family (luna, sol, astra, 6.1-terra) on the Codex backend; listed live 2026-11-10.
  // api.openai.com rejects any temperature but the default for gpt-6.2-sol (400, probe 2026-11-18).
  'gpt-6*':                 { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1050000, thinkingStyle: 'effort_level', streamingStyle: 'sse', temperatureFixed: 1 },
  'gpt-5.6-luna*':          { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1050000, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'openai/gpt-5.6-luna*':   { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1050000, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  // Gemini 3.x via OpenAI-compatible proxy (cliproxy / AGY; effort-level thinking)
  'gemini-3.6-flash-high*': { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'gemini-3.1-pro-low*':    { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'gemini-3.6*':            { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'gemini-3.8*':            { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'gemini-3.1*':            { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'gemini-3*':              { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'google/gemini-3.6*':     { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'google/gemini-3.1*':     { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'effort_level', streamingStyle: 'sse' },
  'google/gemini-3.5-flash*': { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1048576, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'anthropic/claude-opus-5*': { thinking: true, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 1000000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },
  'minimax-m2.7*':      { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'minimax-m2.5*':      { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'minimax-text-01*':   { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },
  'minimax*':           { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse' },

  // Local (via Ollama/LM Studio)
  'qwen3.5-coder-480b': { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },
  'qwen3.5-coder-14b':  { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },
  'qwen3.5-coder-7b':   { thinking: false, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 32768, thinkingStyle: 'none', streamingStyle: 'json_lines' },
  'qwen3.5*':           { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'budget_tokens', streamingStyle: 'sse' },
  'qwen2.5*':           { thinking: false, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 32768, thinkingStyle: 'none', streamingStyle: 'json_lines' },
  'llama4-maverick*':   { thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'reasoning_content', streamingStyle: 'json_lines' },
  'llama*':             { thinking: false, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'json_lines' },
  'devstral-small*':    { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'json_lines' },
  'codestral*':         { thinking: false, streaming: true, jsonMode: true, toolUse: true, maxContextTokens: 32000, thinkingStyle: 'none', streamingStyle: 'json_lines' },

  // Liquid AI LFM3 family (released 2026-10-27; docs.liquid.ai/lfm/models).
  // Six ~2B models on one LFM3-1.7B backbone. Tool use is not documented, so
  // it stays off. The generative models always think: the chat template opens a
  // thought, llama.cpp returns it as reasoning_content, and OpenAIProvider gives
  // every LFM3 call a thought budget. Context: 256K is documented for the text
  // model and 128K for d1-2B (built on VL-2B); the other generative variants'
  // context is undocumented, so they take the conservative 128K of their sibling.
  '*lfm3-1.7b*':        { kind: 'generative', thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 256000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse', inputModalities: ['text'], outputModalities: ['text'] },
  '*lfm3-vl-2b*':       { kind: 'generative', thinking: true, streaming: true, jsonMode: true, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse', inputModalities: ['text', 'image'], outputModalities: ['text'] },
  '*lfm3-audio-2b*':    { kind: 'generative', thinking: true, streaming: true, jsonMode: false, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse', inputModalities: ['text', 'audio'], outputModalities: ['text', 'audio'] },
  '*lfm3-omni-2b*':     { kind: 'generative', thinking: true, streaming: true, jsonMode: false, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'reasoning_content', streamingStyle: 'sse', inputModalities: ['text', 'image', 'video', 'audio'], outputModalities: ['text', 'audio'] },
  // Decision models: no token generation, no streaming, no JSON mode.
  '*d1-2b*':            { kind: 'decision', thinking: false, streaming: false, jsonMode: false, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse', inputModalities: ['text', 'image', 'video'], outputModalities: [] },
  '*d1-omni-2b*':       { kind: 'decision', thinking: false, streaming: false, jsonMode: false, toolUse: false, maxContextTokens: 128000, thinkingStyle: 'none', streamingStyle: 'sse', inputModalities: ['text', 'image', 'video', 'audio'], outputModalities: [] },
};

// User overrides — populated from config
const userOverrides: Map<string, Partial<ModelCapabilities>> = new Map();

/**
 * Glob-style pattern match for model names. '*' may appear anywhere:
 * 'claude-sonnet-4-*', '*-vl*', and exact names all work.
 */
function matchesPattern(model: string, pattern: string): boolean {
  const escaped = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`).test(model.toLowerCase());
}

export class CapabilityRegistry {
  /**
   * Look up capabilities for a model.
   * Priority: user overrides > static registry > conservative defaults.
   */
  static getCapabilities(model: string): ModelCapabilities {
    // Check user overrides first
    const override = userOverrides.get(model);
    if (override) {
      return { ...DEFAULT_CAPABILITIES, ...override };
    }

    // Search static registry (most specific patterns first — longer patterns are more specific)
    const patterns = Object.keys(MODEL_CAPABILITIES).sort((a, b) => b.length - a.length);
    for (const pattern of patterns) {
      if (matchesPattern(model, pattern)) {
        return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[pattern] };
      }
    }

    // Conservative default: no thinking, basic streaming
    return { ...DEFAULT_CAPABILITIES };
  }

  /**
   * Whether a model accepts image input. A config/user override's `vision`
   * field wins; otherwise the model name is matched against the multimodal
   * families. Unknown models are treated as text-only (no image input).
   */
  static supportsVision(model: string): boolean {
    const override = userOverrides.get(model);
    if (override && typeof override.vision === 'boolean') return override.vision;
    const m = (model || '').toLowerCase();
    return VISION_MODEL_PATTERNS.some((p) => matchesPattern(m, p.toLowerCase()));
  }

  /**
   * What the model is: 'decision' models must go through DecisionModelClient,
   * everything else through LLMClient. Overrides win; unknown models are
   * generative (the historical default).
   */
  static modelKind(model: string): ModelKind {
    return CapabilityRegistry.getCapabilities(model || '').kind ?? 'generative';
  }

  static isDecisionModel(model: string): boolean {
    return CapabilityRegistry.modelKind(model) === 'decision';
  }

  /**
   * Register a user override from config.
   * Takes priority over static registry for the exact model name.
   */
  static override(model: string, caps: Partial<ModelCapabilities>): void {
    userOverrides.set(model, caps);
  }

  /**
   * Clear all user overrides (useful for testing).
   */
  static clearOverrides(): void {
    userOverrides.clear();
  }
}
