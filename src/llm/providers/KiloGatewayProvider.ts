/**
 * KiloGatewayProvider - Kilo gateway (OpenRouter-style multi-model gateway)
 *
 * OpenAI-compatible chat completions at {baseUrl}/chat/completions with a
 * KILO_API_KEY bearer token (never hardcode or print it). Mirrors the
 * OpenRouter provider: unified `reasoning` parameter, OpenAI-format tool
 * calling, and multimodal image inputs as data-URL content parts.
 *
 * Health: runtime availability is enforced by LLMClient's per-provider
 * circuit breaker keyed on this provider's `name` ('kilo'); listModels()
 * is the gateway's /models metadata probe (catalog + capability metadata).
 */

import { Result, ok, err } from 'neverthrow';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderCapabilities,
  StreamEvent,
} from '../ProviderTypes.js';
import { BaseProvider, usesMaxCompletionTokens } from './BaseProvider.js';
import { CapabilityRegistry } from '../CapabilityRegistry.js';
import { TIMEOUT_DEFAULT_MS } from '../../constants/limits.js';
import { extractOpenRouterThinking } from '../ThinkingNormalizer.js';
import { parseOpenAIStream } from '../StreamParser.js';
import { createLLMHttpError, isTransientNetworkError, LLMError } from '../errors.js';

function buildOpenAIUserContent(req: ProviderRequest): unknown {
  if (!req.imageInputs || req.imageInputs.length === 0) return req.userPrompt;
  return [
    { type: 'text', text: req.userPrompt },
    ...req.imageInputs.map(image => ({
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${image.dataBase64}`,
      },
    })),
  ];
}

function normalizeKiloContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function summarizeKiloResponse(data: unknown): string {
  if (!data || typeof data !== 'object') return 'non-object response';
  const record = data as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const rawContent = message?.content;
  const contentKind = Array.isArray(rawContent) ? 'array' : typeof rawContent;
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown';
  const error = typeof record.error === 'object' ? JSON.stringify(record.error).slice(0, 200) : '';
  return `choices=${choices.length}, finish_reason=${finishReason}, content_kind=${contentKind}, error_field=${error || 'none'}, snippet=${JSON.stringify(rawContent).slice(0, 200)}`;
}

export class KiloGatewayProvider extends BaseProvider {
  readonly name = 'kilo';

  get capabilities(): ProviderCapabilities {
    return CapabilityRegistry.getCapabilities(this.config.model);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /**
   * Probe the gateway's model catalog ({baseUrl}/models). Used as the
   * metadata/health check for the gateway: a 200 with a model list means the
   * endpoint and token are good. Never logs the token or response bodies.
   */
  async listModels(): Promise<Result<Array<{ id: string }>, LLMError>> {
    const url = `${this.config.baseUrl}/models`;
    try {
      const signal = this.withTimeout(undefined, this.config.timeout || TIMEOUT_DEFAULT_MS);
      const response = await this.limitedFetch(url, { headers: this.getHeaders(), signal });
      if (!response.ok) {
        return err(await createLLMHttpError({
          provider: this.name,
          model: this.config.model,
          endpoint: url,
          response,
          label: 'Kilo gateway /models error',
        }));
      }
      const data = await response.json() as { data?: Array<{ id?: string }> };
      const models = (data.data || [])
        .filter((m): m is { id: string } => typeof m?.id === 'string')
        .map(m => ({ id: m.id }));
      return ok(models);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err(new LLMError(message, this.name, undefined, isTransientNetworkError(error), {
        model: this.config.model,
        endpoint: url,
      }));
    }
  }

  protected async generateImpl(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>> {
    try {
      const url = `${this.config.baseUrl}/chat/completions`;
      const headers = this.getHeaders();

      const maxTokensValue = req.maxTokens ?? this.config.maxTokens;
      // Kilo rejects blank system content with "system message must have content".
      const systemContent = (req.systemPrompt || '').trim() || 'You are a helpful assistant.';
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: buildOpenAIUserContent(req) },
        ],
        temperature: this.capabilities.temperatureFixed ?? req.temperature ?? this.config.temperature,
      };
      if (maxTokensValue !== undefined) {
        body[usesMaxCompletionTokens(this.config.model) ? 'max_completion_tokens' : 'max_tokens'] = maxTokensValue;
      }

      // Kilo paid Opus 5 rejects response_format (400 invalid_request_error).
      // Keep JSON-only instruction in the prompt; do not send response_format.


      // Tool definitions — OpenAI-compatible format
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
        }));
      }

      // Tool results from previous calls
      if (req.toolResults && req.toolResults.length > 0) {
        for (const tr of req.toolResults) {
          (body.messages as Array<Record<string, unknown>>).push({
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: tr.toolCallId,
              type: 'function',
              function: {
                name: tr.toolCall?.name || 'tool',
                arguments: tr.toolCall?.arguments || '{}',
              },
            }],
          });
          (body.messages as Array<Record<string, unknown>>).push({ role: 'tool', content: tr.result, tool_call_id: tr.toolCallId });
        }
      }

      // Unified reasoning parameter (OpenRouter-style, supported by the gateway)
      if (req.thinking?.enabled) {
        body.reasoning = {
          effort: req.thinking.effort || 'high',
        };
      } else if (req.thinking?.enabled === false) {
        // Explicit disable: deepseek-class seats default reasoning ON server-side
        // and burn the whole max_tokens budget on reasoning — finish_reason=length
        // with EMPTY content (probe-verified: effort "none" -> 2KB code, 0 reasoning).
        body.reasoning = { effort: 'none' };
      }

      const signal = this.withTimeout(req.signal, this.config.timeout || TIMEOUT_DEFAULT_MS);

      const response = await this.limitedFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        return err(await createLLMHttpError({
          provider: this.name,
          model: this.config.model,
          endpoint: url,
          response,
          label: 'Kilo gateway API error',
        }));
      }

      const data = await response.json();
      const thinking = extractOpenRouterThinking(data);
      const choices = data.choices as Array<{ message?: { content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }> | undefined;
      const message = choices?.[0]?.message;
      const content = normalizeKiloContent(message?.content);

      const rawToolCalls = message?.tool_calls || [];
      const toolCalls = rawToolCalls.map(tc => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
      const finishReason = toolCalls.length > 0 ? 'tool_calls' as const : 'stop' as const;

      const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

      const hasContent = content.length > 0 || toolCalls.length > 0;
      if (!hasContent) {
        return ok({
          content,
          thinking: thinking.source !== 'none' ? thinking : undefined,
          model: data.model || this.config.model,
          success: false,
          error: `Kilo gateway provider returned no usable content (${summarizeKiloResponse(data)})`,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason,
          usage: usage ? {
            inputTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
          } : undefined,
        });
      }

      return ok({
        content,
        thinking: thinking.source !== 'none' ? thinking : undefined,
        model: data.model || this.config.model,
        success: true,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        usage: usage ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
        } : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err(new LLMError(message, this.name, undefined, isTransientNetworkError(error), {
        model: this.config.model,
        endpoint: `${this.config.baseUrl}/chat/completions`,
      }));
    }
  }

  protected async *streamImpl(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers = this.getHeaders();

    const maxTokensValueStream = req.maxTokens ?? this.config.maxTokens;
    const systemContentStream = (req.systemPrompt || '').trim() || 'You are a helpful assistant.';
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: systemContentStream },
        { role: 'user', content: req.userPrompt },
      ],
      temperature: this.capabilities.temperatureFixed ?? req.temperature ?? this.config.temperature,
      stream: true,
    };
    if (maxTokensValueStream !== undefined) {
      body[usesMaxCompletionTokens(this.config.model) ? 'max_completion_tokens' : 'max_tokens'] = maxTokensValueStream;
    }

    if (req.thinking?.enabled) {
      body.reasoning = {
        effort: req.thinking.effort || 'high',
      };
    }

    const signal = this.withTimeout(req.signal, this.config.timeout || TIMEOUT_DEFAULT_MS);

    const response = await this.limitedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      yield { type: 'error', error: `Kilo gateway API error ${response.status}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    // Gateway uses standard SSE with OpenRouter-style reasoning fields
    yield* parseOpenAIStream(response.body);
  }
}
