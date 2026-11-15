export interface OpenRouterModelAlias {
  alias: string;
  model: string;
  label: string;
}

/**
 * Aggregators run only DeepSeek V4.1 Flash 1017 or free models (operator rule,
 * 2026-11-09). Owned subscriptions (Claude, GPT/Codex, Gemini, GLM, MiniMax, Kimi,
 * Grok) run only on their official providers, never through OpenRouter.
 * Slug checked against openrouter.ai/api/v1/models on 2026-11-10; the bare
 * `deepseek-v4.1-flash` slug is the September build, not 1017.
 */
export const OPENROUTER_MODEL_CATALOG: OpenRouterModelAlias[] = [
  {
    alias: 'deepseek',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    label: 'DeepSeek V4.1 Flash 1017',
  },
];

export function resolveOpenRouterModelAlias(input?: string): OpenRouterModelAlias | null {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  return OPENROUTER_MODEL_CATALOG.find((entry) => entry.alias === normalized || entry.model.toLowerCase() === normalized) || null;
}
