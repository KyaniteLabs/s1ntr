import type { LLMConfig } from '../llm/LLMClient.js';

export type RuntimeProviderKey = 'custom' | 'anthropic' | 'openai' | 'minimax' | 'glm' | 'lmstudio' | 'ollama' | 'openrouter' | 'kimi' | 'moonshot' | 'kilo';
export type ProviderStatusLabel = RuntimeProviderKey | 'llm' | 'unknown';
export type ProviderAdapterName = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'google' | 'minimax' | 'custom' | 'kilo' | 'grok-cli' | 'cli';
export type ProviderApiStyle = NonNullable<LLMConfig['apiStyle']>;
export type ProviderVisionSupport = 'yes' | 'no' | 'unknown';

export interface ProviderRuntimeDefaults {
  baseUrl: string;
  model: string;
  label: string;
  description: string;
  requiresKey: boolean;
  apiStyle: ProviderApiStyle;
  temperature: number;
  maxTokens: number;
}

export interface ProviderRuntimeSelection {
  provider: RuntimeProviderKey;
  model?: string;
  configuredBaseUrl?: string;
  configuredApiKey?: string;
  current?: {
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
  };
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface ProviderRuntime {
  provider: RuntimeProviderKey;
  statusProvider: ProviderStatusLabel;
  adapter: ProviderAdapterName;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  requiresKey: boolean;
  apiStyle: ProviderApiStyle;
  temperature: number;
  maxTokens: number;
  vision: ProviderVisionSupport;
}

export const PROVIDER_ALIASES: Record<string, RuntimeProviderKey> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  gpt: 'openai',
  custom: 'custom',
  minimax: 'minimax',
  mini: 'minimax',
  glm: 'glm',
  z: 'glm',
  lmstudio: 'lmstudio',
  lm: 'lmstudio',
  local: 'lmstudio',
  ollama: 'ollama',
  openrouter: 'openrouter',
  or: 'openrouter',
  kimi: 'kimi',
  moonshot: 'moonshot',
  kilo: 'kilo',
};

export const PROVIDER_DEFAULTS: Record<RuntimeProviderKey, ProviderRuntimeDefaults> = {
  custom: {
    baseUrl: 'http://localhost:8000/v1',
    model: 'custom-model',
    label: 'Custom',
    description: 'Custom OpenAI-compatible endpoint',
    requiresKey: true,
    apiStyle: 'openai',
    temperature: 0.7,
    maxTokens: 16384,
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
    label: 'Anthropic',
    description: 'Anthropic Claude API (native Messages API; bring your own ANTHROPIC_API_KEY)',
    requiresKey: true,
    apiStyle: 'anthropic',
    temperature: 0.7,
    maxTokens: 16384,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    label: 'OpenAI',
    description: 'OpenAI API (OpenAI-compatible chat completions)',
    requiresKey: true,
    apiStyle: 'openai',
    temperature: 0.7,
    maxTokens: 16384,
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/anthropic',
    model: 'MiniMax-M3',
    label: 'MiniMax',
    description: 'MiniMax M3 (Global Token Plan, Anthropic-compatible) — the only allowed MiniMax',
    requiresKey: true,
    apiStyle: 'anthropic',
    temperature: 0.7,
    maxTokens: 16384,
  },
  glm: {
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'GLM-5v-turbo',
    label: 'GLM',
    description: 'GLM International API (GLM-5v-turbo multimodal, Anthropic-compatible)',
    requiresKey: true,
    apiStyle: 'anthropic',
    temperature: 0.7,
    maxTokens: 16384,
  },
  lmstudio: {
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    label: 'LM Studio',
    description: 'Local LM Studio server',
    requiresKey: false,
    apiStyle: 'openai',
    temperature: 0.7,
    maxTokens: 16384,
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    label: 'Ollama',
    description: 'Local Ollama server',
    requiresKey: false,
    apiStyle: 'ollama',
    temperature: 0.7,
    maxTokens: 16384,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    label: 'OpenRouter',
    description: 'OpenRouter API (aggregator: DeepSeek V4.1 Flash 1017 or free models only)',
    requiresKey: true,
    apiStyle: 'openai',
    temperature: 0.7,
    maxTokens: 16384,
  },
  kimi: {
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'k2p5',
    label: 'Kimi Code',
    description: 'Moonshot AI Kimi Code (K2P5) for Coding Agents',
    requiresKey: true,
    apiStyle: 'openai',
    temperature: 0.7,
    maxTokens: 16384,
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.5',
    label: 'Moonshot AI (Legacy)',
    description: 'Moonshot AI Kimi API',
    requiresKey: true,
    apiStyle: 'openai',
    temperature: 0.7,
    maxTokens: 16384,
  },
  kilo: {
    baseUrl: 'https://api.kilo.ai/api/gateway',
    model: 'anthropic/claude-opus-5',
    label: 'Kilo',
    description: 'Kilo gateway (OpenRouter-style multi-model gateway; reserved for anthropic/claude-opus-5 and free models; bring your own KILO_API_KEY)',
    requiresKey: true,
    apiStyle: 'openai',
    temperature: 0.7,
    maxTokens: 16384,
  },
};

export const PROVIDER_ORDER: RuntimeProviderKey[] = [
  'anthropic',
  'minimax',
  'lmstudio',
  'ollama',
  'openai',
  'openrouter',
  'glm',
  'moonshot',
  'kimi',
  'kilo',
  'custom',
];

const PLACEHOLDER_API_KEY_PATTERNS = [
  /^YOUR[_-]/i,
  /_HERE$/i,
  /PLACEHOLDER/i,
  /CHANGE[_-]?ME/i,
  /^sk-your/i,
  /^<.*>$/,
] as const;

export function isPlaceholderApiKey(value?: string): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_API_KEY_PATTERNS.some(pattern => pattern.test(trimmed));
}

export function firstUsableApiKey(...values: Array<string | undefined>): string | undefined {
  return values.find(value => !isPlaceholderApiKey(value));
}

export function readRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
): string | undefined {
  return env[`SINTER_${key}`] ?? (env[key] || env[`LIMINAL_${key}`]);
}

export function resolveProviderAlias(value: string | undefined): RuntimeProviderKey | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? (isRuntimeProviderKey(normalized) ? normalized : undefined);
}

export function isRuntimeProviderKey(value: string): value is RuntimeProviderKey {
  return Object.hasOwn(PROVIDER_DEFAULTS, value);
}

export function providerRequiresApiKey(provider: RuntimeProviderKey | ProviderStatusLabel): boolean {
  return isRuntimeProviderKey(provider) ? PROVIDER_DEFAULTS[provider].requiresKey : false;
}

export function normalizeProviderBaseUrl(
  provider: RuntimeProviderKey,
  configuredBaseUrl?: string,
): string {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!configuredBaseUrl) return defaults.baseUrl;

  if (provider === 'glm' && (
    sameProviderEndpoint(configuredBaseUrl, 'https://api.z.ai/api/coding/paas')
    || sameProviderEndpoint(configuredBaseUrl, 'https://api.z.ai/api/coding/paas/v4')
  )) return defaults.baseUrl;
  if (provider === 'minimax' && sameProviderEndpoint(configuredBaseUrl, 'https://api.minimax.io/v1')) return defaults.baseUrl;
  return configuredBaseUrl;
}

export function sameProviderEndpoint(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  try {
    return new URL(left).href.replace(/\/+$/, '') === new URL(right).href.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.toLowerCase()).hostname;
  } catch {
    return '';
  }
}

export function detectProviderLabel(baseUrl: string, model = ''): ProviderStatusLabel {
  const lowerUrl = baseUrl.toLowerCase();
  const lowerModel = model.toLowerCase();
  const host = endpointHost(baseUrl);
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'api.openai.com') return 'openai';
  if (lowerUrl.includes('z.ai') || lowerUrl.includes('bigmodel') || lowerUrl.includes('glm') || lowerModel.includes('glm')) return 'glm';
  if (lowerUrl.includes('minimax') || lowerUrl.includes('minimaxi')) return 'minimax';
  if (lowerUrl.includes('openrouter')) return 'openrouter';
  if (lowerUrl.includes('kilo.ai')) return 'kilo';
  if (lowerUrl.includes('moonshot')) return 'moonshot';
  if (lowerUrl.includes('kimi')) return 'kimi';
  if (lowerUrl.includes(':11434') || lowerUrl.includes('ollama')) return 'ollama';
  // Cliproxy / local OpenAI-compatible proxies (e.g. :8317) are not LM Studio.
  if (lowerUrl.includes(':8317') || lowerUrl.includes('cliproxy')) return 'custom';
  if (lowerUrl.includes('localhost:1234') || lowerUrl.includes('127.0.0.1:1234')) return 'lmstudio';
  // Other loopback ports: generic llm label — only 1234 is LM Studio by convention.
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'llm';
  return baseUrl ? 'llm' : 'unknown';
}

/**
 * Map a base URL to a configured-provider menu key (a PROVIDER_DEFAULTS entry).
 *
 * Naming/config layer only: endpoints without a first-class menu entry
 * (e.g. api.anthropic.com, generativelanguage.googleapis.com) resolve to
 * 'custom' here on purpose. Wire-format routing is independent —
 * detectProviderAdapter() maps those hosts to the dedicated anthropic/google
 * adapters via ProviderFactory.createProvider().
 */
export function detectRuntimeProviderFromUrl(baseUrl: string, model = ''): RuntimeProviderKey {
  const lowerUrl = baseUrl.toLowerCase();
  const host = endpointHost(baseUrl);
  const lowerModel = model.toLowerCase();
  if (lowerUrl.includes('minimax') || lowerUrl.includes('minimaxi')) return 'minimax';
  if (lowerUrl.includes('openrouter')) return 'openrouter';
  if (lowerUrl.includes('kilo.ai')) return 'kilo';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'api.openai.com') return 'openai';
  if (lowerUrl.includes('z.ai') || lowerUrl.includes('bigmodel') || lowerUrl.includes('glm') || lowerModel.includes('glm')) return 'glm';
  if (lowerUrl.includes('api.kimi.com') || lowerUrl.includes('kimi.com')) return 'kimi';
  if (lowerUrl.includes('moonshot')) return 'moonshot';
  if (lowerUrl.includes(':11434') || lowerUrl.includes('ollama')) return 'ollama';
  if (lowerUrl.includes('localhost:1234') || lowerUrl.includes('127.0.0.1:1234')) return 'lmstudio';
  return 'custom';
}

export function detectProviderAdapter(config: { baseUrl: string; model: string }): ProviderAdapterName {
  const baseUrl = config.baseUrl.toLowerCase();
  const model = config.model.toLowerCase();

  if (baseUrl.startsWith('grok-cli:')) return 'grok-cli';
  // Subscription CLI lanes (command-code, agy, codex) — no HTTP endpoint.
  if (baseUrl.startsWith('cli://')) return 'cli';
  if (baseUrl.includes('openrouter')) return 'openrouter';
  if (baseUrl.includes('kilo.ai')) return 'kilo';
  if (baseUrl.includes('minimax') || baseUrl.includes('minimaxi')) return 'minimax';
  if (baseUrl.includes('anthropic') || baseUrl.includes('api.anthropic')) return 'anthropic';
  if (baseUrl.includes('generativelanguage') || baseUrl.includes('googleapis')) return 'google';
  // Ollama Cloud (ollama.com) is OpenAI-compatible with bearer auth — use the
  // OpenAI adapter so OLLAMA_API_KEY is sent. Local Ollama stays on 'ollama'.
  if (baseUrl.includes('ollama.com')) return 'openai';
  if (baseUrl.includes(':11434') || baseUrl.includes('ollama')) return 'ollama';
  if (baseUrl.includes('z.ai')) return 'anthropic';
  if (baseUrl.includes('bigmodel.cn')) return 'openai';
  if (baseUrl.includes('moonshot.ai') || baseUrl.includes('moonshot.cn')) return 'openai';
  if (baseUrl.includes('kimi.com')) return 'openai';
  if (endpointHost(baseUrl) === 'api.openai.com') return 'openai';
  // Local / private OpenAI-compatible proxies (Codex proxy :8317, LM Studio, etc.)
  // must stay on the openai adapter even when the model id is gemini*/claude*.
  // Model-name heuristics below only apply when the endpoint itself is unknown
  // or already vendor-native — otherwise gemini* was wrongly routed to
  // generativelanguage.googleapis.com despite an explicit localhost proxy URL.
  const host = endpointHost(baseUrl);
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || baseUrl.includes(':8317')) {
    return 'openai';
  }
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('deepseek-r1')) return 'ollama';
  return 'openai';
}

export function detectRoleProviderType(baseUrl: string, model = ''): ProviderAdapterName {
  return detectProviderAdapter({ baseUrl, model });
}

export function apiStyleForEndpoint(baseUrl: string, provider?: RuntimeProviderKey): ProviderApiStyle {
  const lowerUrl = baseUrl.toLowerCase();
  // Ollama Cloud is OpenAI-compatible; only local Ollama uses the native style.
  if (lowerUrl.includes('ollama.com')) return 'openai';
  if (lowerUrl.includes(':11434') || lowerUrl.includes('ollama')) return 'ollama';
  if (
    lowerUrl.includes('/anthropic')
    || lowerUrl.includes('api.anthropic')
  ) {
    return 'anthropic';
  }
  if (provider && PROVIDER_DEFAULTS[provider].apiStyle === 'ollama') return 'ollama';
  return 'openai';
}

export function apiKeyEnvNamesForProvider(provider: RuntimeProviderKey | ProviderStatusLabel): string[] {
  switch (provider) {
    case 'anthropic': return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
    case 'minimax': return ['MINIMAX_API_KEY'];
    case 'glm': return ['GLM_API_KEY', 'Z_AI_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
    case 'openrouter': return ['OPENROUTER_API_KEY'];
    case 'kilo': return ['KILO_API_KEY'];
    case 'kimi': return ['KIMI_API_KEY', 'MOONSHOT_API_KEY'];
    // Moonshot and Kimi have shared operator setups in the wild; keep
    // KIMI_API_KEY as a compatibility fallback for renamed moonshot configs.
    case 'moonshot': return ['MOONSHOT_API_KEY', 'KIMI_API_KEY'];
    case 'custom':
    case 'openai': return ['OPENAI_API_KEY'];
    default: return [];
  }
}

export function apiKeyEnvNamesForEndpoint(baseUrl: string, _model = ''): string[] {
  try {
    const endpoint = new URL(baseUrl);
    if (endpoint.username || endpoint.password) return [];
    const configuredProxy = process.env.CODEX_PROXY_BASE_URL
      || process.env.SINTER_CODEX_PROXY_BASE_URL || process.env.LIMINAL_CODEX_PROXY_BASE_URL;
    if (sameProviderEndpoint(baseUrl, configuredProxy)
      || ((endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1')
        && endpoint.port === '8317' && endpoint.protocol === 'http:')) return ['CODEX_PROXY_API_KEY'];
    if (endpoint.protocol !== 'https:' || endpoint.port) return [];
    switch (endpoint.hostname) {
      case 'ollama.com': return ['OLLAMA_API_KEY'];
      case 'api.x.ai': return ['XAI_API_KEY', 'GROK_API_KEY'];
      case 'api.deepinfra.com': return ['DEEPINFRA_API_KEY'];
      case 'api.xiaomimimo.com':
      case 'token-plan-sgp.xiaomimimo.com': return ['XIAOMI_API_KEY'];
      case 'generativelanguage.googleapis.com': return ['GOOGLE_API_KEY', 'GEMINI_API_KEY'];
      case 'api.moonshot.cn': return apiKeyEnvNamesForProvider('moonshot');
      case 'open.bigmodel.cn': return apiKeyEnvNamesForProvider('glm');
      case 'api.minimaxi.com': return apiKeyEnvNamesForProvider('minimax');
      default: {
        const provider = PROVIDER_ORDER.find(key => endpointHost(PROVIDER_DEFAULTS[key].baseUrl) === endpoint.hostname);
        return provider && provider !== 'custom' ? apiKeyEnvNamesForProvider(provider) : [];
      }
    }
  } catch {
    return [];
  }
}

export function selectScopedEnvApiKey(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  keyName: string,
  baseUrl: string,
  allowUnbound = false,
): string | undefined {
  const prefixes = ['SINTER_', '', 'LIMINAL_'];
  const endpointName = keyName.replace(/_API_KEY$/, '_BASE_URL');
  const hasDeclaredEndpoint = prefixes.some(prefix => Boolean(env[prefix + endpointName]));
  return firstUsableApiKey(...prefixes.map(prefix => {
    const endpoint = env[prefix + endpointName];
    return sameProviderEndpoint(endpoint, baseUrl) || (allowUnbound && !hasDeclaredEndpoint)
      ? env[prefix + keyName] : undefined;
  }));
}

export function selectRuntimeApiKey(args: {
  provider?: RuntimeProviderKey | ProviderStatusLabel;
  baseUrl: string;
  model?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  configuredApiKey?: string;
  currentApiKey?: string;
  genericFallbackKeys?: string[];
  allowUnboundGenericKey?: boolean;
  /**
   * Prefer generic Sinter keys over provider-specific keys for user-facing
   * default config. Endpoint-specific callers should keep the default false.
   */
  genericFirst?: boolean;
}): string | undefined {
  const env = args.env ?? process.env;
  const endpointKeys = apiKeyEnvNamesForEndpoint(args.baseUrl, args.model);
  const genericKeys = args.genericFallbackKeys ?? ['LLM_API_KEY'];
  const providerKeys = args.provider === 'custom'
    && sameProviderEndpoint(args.baseUrl, PROVIDER_DEFAULTS.custom.baseUrl)
    ? apiKeyEnvNamesForProvider('custom') : [];
  const providerValues = [...endpointKeys, ...providerKeys].map(key => readRuntimeEnv(env, key));
  const genericValues = genericKeys.map(key =>
    selectScopedEnvApiKey(env, key, args.baseUrl, args.allowUnboundGenericKey ?? true));
  const values = [
    args.configuredApiKey,
    args.currentApiKey,
    ...(args.genericFirst ? genericValues : providerValues),
    ...(args.genericFirst ? providerValues : genericValues),
  ];
  return firstUsableApiKey(...values);
}

export function inferProviderVisionSupport(provider: string, model: string): ProviderVisionSupport {
  const lower = `${provider} ${model}`.toLowerCase();
  if (lower.includes('glm-5v') || lower.includes('glm 5v')) return 'yes';
  // Gateway metadata (kilo /models probe): M3 and K3 accept image input even
  // though their vendor families are otherwise text-only here.
  if (lower.includes('minimax-m3') || lower.includes('kimi-k3')) return 'yes';
  if (lower.includes('glm') || lower.includes('minimax') || lower.includes('kimi') || lower.includes('moonshot')) return 'no';
  if (lower.includes('gemini') || lower.includes('gpt-5') || lower.includes('gpt-4o') || lower.includes('claude') || lower.includes('vision') || lower.includes('-vl')) return 'yes';
  return 'unknown';
}

function statusProviderFor(provider: RuntimeProviderKey, baseUrl: string, model: string): ProviderStatusLabel {
  if (provider !== 'custom') return provider;
  const detected = detectRuntimeProviderFromUrl(baseUrl, model);
  return detected === 'custom' ? 'custom' : detected;
}

export function resolveProviderRuntime(selection: ProviderRuntimeSelection): ProviderRuntime {
  const defaults = PROVIDER_DEFAULTS[selection.provider];
  const baseUrl = normalizeProviderBaseUrl(selection.provider, selection.configuredBaseUrl);
  const model = selection.model || defaults.model;
  const statusProvider = statusProviderFor(selection.provider, baseUrl, model);
  const currentMatches = selection.current?.provider === statusProvider || selection.current?.provider === selection.provider;
  const currentApiKey = currentMatches && sameProviderEndpoint(selection.current?.baseUrl, baseUrl)
    ? selection.current?.apiKey : undefined;
  const env = selection.env ?? process.env;
  const apiKey = selectRuntimeApiKey({
    provider: selection.provider,
    baseUrl,
    model,
    env,
    allowUnboundGenericKey: false,
    configuredApiKey: selection.configuredApiKey,
    currentApiKey,
  });

  return {
    provider: selection.provider,
    statusProvider,
    adapter: detectProviderAdapter({ baseUrl, model }),
    label: defaults.label,
    description: defaults.description,
    baseUrl,
    model,
    apiKey,
    requiresKey: defaults.requiresKey,
    apiStyle: apiStyleForEndpoint(baseUrl, selection.provider),
    temperature: defaults.temperature,
    maxTokens: defaults.maxTokens,
    vision: inferProviderVisionSupport(statusProvider, model),
  };
}
