import {
  apiKeyEnvNamesForEndpoint as runtimeApiKeyEnvNamesForEndpoint,
  readRuntimeEnv,
  selectScopedEnvApiKey,
  selectRuntimeApiKey,
} from './ProviderRuntime.js';

export function apiKeyEnvNamesForEndpoint(baseUrl: string, model = ''): string[] {
  return runtimeApiKeyEnvNamesForEndpoint(baseUrl, model);
}

export function selectApiKeyForEndpoint(
  baseUrl: string,
  model: string | undefined,
  genericFallbackKeys: string[] = [],
  allowUnboundGenericKey = false,
): string | undefined {
  return selectRuntimeApiKey({
    baseUrl,
    model,
    genericFallbackKeys,
    allowUnboundGenericKey,
  });
}

export function selectRoleApiKeyForEndpoint(
  role: 'generator' | 'evaluator' | 'harness' | 'studio',
  baseUrl: string,
  model: string | undefined,
  allowUnboundRoleKey = true,
): string | undefined {
  const roleKey = selectScopedEnvApiKey(process.env, `${role.toUpperCase()}_API_KEY`, baseUrl, allowUnboundRoleKey);
  const compatibleHarnessKey = role === 'studio'
    ? selectScopedEnvApiKey(process.env, 'HARNESS_API_KEY', baseUrl) : undefined;
  return roleKey || compatibleHarnessKey
    || selectApiKeyForEndpoint(baseUrl, model, role === 'generator' ? ['LLM_API_KEY'] : []);
}

export function readProviderEnvKey(key: string): string | undefined {
  return readRuntimeEnv(process.env, key);
}
