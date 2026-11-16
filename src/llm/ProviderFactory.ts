/**
 * ProviderFactory - Creates provider instances from configuration
 *
 * Maps provider identifiers to concrete BaseProvider subclasses.
 * Single entry point for all provider instantiation.
 */

import type { ProviderConfig } from './ProviderTypes.js';
import { detectProviderAdapter } from '../config/ProviderRuntime.js';
import { BaseProvider } from './providers/BaseProvider.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { AnthropicProvider, anthropicMessagesEndpoint } from './providers/AnthropicProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { GoogleProvider } from './providers/GoogleProvider.js';
import { MiniMaxProvider } from './providers/MiniMaxProvider.js';
import { KiloGatewayProvider } from './providers/KiloGatewayProvider.js';
import { GrokCliProvider } from './providers/GrokCliProvider.js';
import { CliProvider } from './providers/CliProvider.js';

export type ProviderName = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'google' | 'minimax' | 'custom' | 'kilo' | 'grok-cli' | 'cli';

/**
 * Detect provider from baseUrl or config hints.
 */
export function detectProvider(config: ProviderConfig): ProviderName {
  return detectProviderAdapter(config);
}

/** The URL the adapter createProvider picks for this config posts to; error records and receipts name this one. */
export function transportEndpoint(config: { baseUrl: string; model: string }): string {
  const { baseUrl } = config;
  switch (detectProvider(config)) {
    case 'grok-cli':
    case 'cli':
      return baseUrl;
    case 'anthropic':
      return anthropicMessagesEndpoint(baseUrl);
    case 'google': {
      const trimmed = baseUrl.replace(/\/+$/, '');
      const base = trimmed.includes('generativelanguage') ? trimmed : 'https://generativelanguage.googleapis.com';
      return `${base}/v1beta/models/${config.model}:generateContent`;
    }
    case 'ollama':
      return baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/api/generate`;
    case 'minimax':
      return baseUrl.toLowerCase().includes('/anthropic') ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
    default:
      return `${baseUrl}/chat/completions`;
  }
}

/**
 * Create a provider instance from config.
 * Auto-detects provider from baseUrl if not explicitly specified.
 */
export function createProvider(
  config: ProviderConfig,
  providerHint?: ProviderName,
): BaseProvider {
  const providerName = providerHint || detectProvider(config);

  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    case 'google':
      return new GoogleProvider(config);
    case 'minimax':
      return new MiniMaxProvider(config);
    case 'kilo':
      return new KiloGatewayProvider(config);
    case 'grok-cli':
      return new GrokCliProvider(config);
    case 'cli':
      return new CliProvider(config);
    case 'openai':
    case 'custom':
    default:
      return new OpenAIProvider(config);
  }
}
