/**
 * OpenAIProvider - OpenAI, LM Studio, and any /v1/chat/completions endpoint
 *
 * Handles GPT-5, o3, o4-mini, GPT-4o, and compatible endpoints
 * like LM Studio, LocalAI, etc.
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
import { normalizeThinking } from '../ThinkingNormalizer.js';
import { parseOpenAIStream } from '../StreamParser.js';
import { createLLMHttpError, describeUnreachableEndpoint, isTransientNetworkError, LLMError } from '../errors.js';
import { recordServerCost } from '../ProviderBudgetLedger.js';

function buildOpenAIUserContent(req: ProviderRequest): unknown {
  if (!req.imageInputs || req.imageInputs.length === 0) return req.userPrompt;
  // Interleave label text so vision models (e.g. Gemini via cliproxy) know arm/frame.
  return [
    { type: 'text', text: req.userPrompt },
    ...req.imageInputs.flatMap(image => [
      ...(image.label
        ? [{ type: 'text' as const, text: `Evidence frame: ${image.label}` }]
        : []),
      {
        type: 'image_url' as const,
        image_url: {
          url: `data:${image.mimeType};base64,${image.dataBase64}`,
        },
      },
    ]),
  ];
}

/**
 * Local LFM3 (llama.cpp) renders its chat template with thinking on by default.
 * Unrequested reasoning spends the whole max_tokens budget and leaves no final
 * code, so local LFM3 calls ask for the final answer directly.
 */
function isLocalLFM3(baseUrl: string | undefined, model: string): boolean {
  if (!/lfm3/i.test(model)) return false;
  try {
    const host = new URL(baseUrl ?? '').hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * LFM3 can inline its reasoning in `content`. Keep only the final answer: the
 * text after the last closing think tag (the template may prefill the opening
 * tag). An unclosed opening tag means the model never reached an answer.
 */
function stripInlineThinking(content: string): string {
  const close = /<\/think(?:ing)?>/gi;
  let end = -1;
  for (let m = close.exec(content); m; m = close.exec(content)) end = m.index + m[0].length;
  if (end >= 0) return content.slice(end).trimStart();
  return /^\s*<think(?:ing)?>/i.test(content) ? '' : content;
}

/**
 * Streamed LFM3 content can open or close a think span in any chunk, and text
 * already shown cannot be retracted. Hold content until the stream ends, then
 * emit only the final answer (same rule as the non-stream path).
 */
async function* finalLFM3Content(events: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  let text = '';
  const flush = function* (): Generator<StreamEvent> {
    const final = stripInlineThinking(text);
    text = '';
    if (final) yield { type: 'content', content: final };
  };
  for await (const event of events) {
    if (event.type === 'content') {
      text += event.content;
      continue;
    }
    if (event.type === 'done' || event.type === 'error') yield* flush();
    yield event;
  }
  yield* flush();
}

function normalizeMessageContent(content: unknown): string {
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

function summarizeOpenAIResponse(data: unknown): string {
  if (!data || typeof data !== 'object') return 'non-object response';
  const record = data as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const rawContent = message?.content;
  const contentKind = Array.isArray(rawContent) ? 'array' : typeof rawContent;
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown';
  const reasoningContent = typeof message?.reasoning_content === 'string'
    ? message.reasoning_content.slice(0, 120)
    : typeof record.reasoning_content === 'string'
      ? record.reasoning_content.slice(0, 120)
      : '';
  return `choices=${choices.length}, finish_reason=${finishReason}, content_kind=${contentKind}, reasoning_present=${reasoningContent ? 'yes' : 'no'}, snippet=${JSON.stringify(rawContent).slice(0, 200)}`;
}

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';

  get capabilities(): ProviderCapabilities {
    return CapabilityRegistry.getCapabilities(this.config.model);
  }

  protected async generateImpl(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>> {
    try {
      const url = `${this.config.baseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      // Kimi Code API requires a coding agent User-Agent
      if (this.config.baseUrl.includes('kimi.com')) {
        headers['User-Agent'] = 'claude-code/1.0';
      }

      const maxTokensValue = req.maxTokens ?? this.config.maxTokens;
      // Never send blank system content — OpenAI-compatible gateways (Kilo) 400.
      const systemContent = (req.systemPrompt || '').trim() || 'You are a helpful assistant.';
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: buildOpenAIUserContent(req) },
        ],
        temperature: this.capabilities.temperatureFixed ?? req.temperature ?? this.config.temperature,
      };
      // Kilo gateway rejects response_format for paid Opus 5 (400 invalid_request).
      // Prompt still requests JSON; agent parser handles free-form.
      const isKiloGateway = (this.config.baseUrl || '').toLowerCase().includes('kilo.ai');
      if (req.jsonMode && this.capabilities.jsonMode && !isKiloGateway) {
        body.response_format = { type: 'json_object' };
      }
      if (maxTokensValue !== undefined) {
        body[usesMaxCompletionTokens(this.config.model) ? 'max_completion_tokens' : 'max_tokens'] = maxTokensValue;
      }

      // Reasoning effort: send dual OpenAI-compatible shapes when thinking is
      // requested AND the model is thinking-capable. The capability gate keeps
      // strict endpoints (gpt-4o et al.) from 400ing on unknown params.
      if (req.thinking?.enabled && this.capabilities.thinking) {
        const effort = req.thinking.effort || 'medium';
        body.reasoning_effort = effort;
        body.reasoning = { effort };
      } else if (!this.capabilities.thinking && this.capabilities.thinkingStyle === 'none') {
        // Moonshot/Kimi coding defaults thinking on; without an explicit disable,
        // reasoning_content can consume the entire max_tokens budget (empty content).
        // When thinking is disabled the coding API only allows temperature 0.6.
        const base = (this.config.baseUrl || '').toLowerCase();
        if (base.includes('kimi.com') || base.includes('moonshot.cn') || base.includes('moonshot.ai')) {
          body.thinking = { type: 'disabled' };
          body.temperature = 0.6;
        }
      }

      if (!req.thinking?.enabled && isLocalLFM3(this.config.baseUrl, this.config.model)) {
        body.chat_template_kwargs = { enable_thinking: false };
      }

      // Native tool calling (OpenAI function calling format)
      if (req.tools && req.tools.length > 0 && this.capabilities.toolUse) {
        body.tools = req.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
      }

      // Inject tool results from previous calls
      if (req.toolResults && req.toolResults.length > 0) {
        const messages = body.messages as Array<Record<string, unknown>>;
        for (const tr of req.toolResults) {
          messages.push({
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
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.result,
          });
        }
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
          label: 'OpenAI API error',
        }));
      }

      const data = await response.json();
      const thinking = normalizeThinking(data, 'openai');
      const thinkingText = typeof thinking.text === 'string' ? thinking.text : '';

      const choices = data.choices as Array<{
        message?: {
          content?: unknown;
          reasoning_content?: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }> | undefined;
      const choice = choices?.[0];
      const rawContent = normalizeMessageContent(choice?.message?.content);
      const content = /lfm3/i.test(this.config.model) ? stripInlineThinking(rawContent) : rawContent;

      const usage = data.usage as {
        prompt_tokens?: number;
        completion_tokens?: number;
        reasoning_tokens?: number;
        estimated_cost?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      } | undefined;
      // DeepInfra reports exact server-side USD per call; metered endpoints
      // accumulate it toward their cap (no-op for unmetered hosts).
      if (usage && typeof usage.estimated_cost === 'number') {
        recordServerCost(this.config.baseUrl, usage.estimated_cost);
      }
      const reasoningTokens =
        usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;

      // Parse native tool calls from response
      let toolCalls: import('../ProviderTypes.js').ToolCallResult[] | undefined;
      let finishReason: import('../ProviderTypes.js').ProviderResponse['finishReason'] = 'stop';

      if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
        toolCalls = choice.message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
        finishReason = 'tool_calls';
      }

      if (choice?.finish_reason === 'tool_calls') {
        finishReason = 'tool_calls';
      } else if (choice?.finish_reason === 'length') {
        finishReason = 'length';
      }

      const hasToolCalls = !!(toolCalls && toolCalls.length > 0);
      const hasContent = content.length > 0 || hasToolCalls;

      if (!hasContent) {
        return ok({
          content,
          thinking: thinking.source !== 'none' ? { ...thinking, text: thinkingText } : undefined,
          model: data.model || this.config.model,
          success: false,
          error: `OpenAI-compatible provider returned no usable content (${summarizeOpenAIResponse(data)})`,
          usage: usage ? {
            inputTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
            thinkingTokens: typeof reasoningTokens === 'number' ? reasoningTokens : undefined,
          } : undefined,
          toolCalls,
          finishReason,
        });
      }

      return ok({
        content,
        thinking: thinking.source !== 'none' ? { ...thinking, text: thinkingText } : undefined,
        model: data.model || this.config.model,
        success: hasContent,
        usage: usage ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          thinkingTokens: typeof reasoningTokens === 'number' ? reasoningTokens : undefined,
        } : undefined,
        toolCalls,
        finishReason,
      });
    } catch (error) {
      const message = describeUnreachableEndpoint(error, this.config.baseUrl)
        ?? (error instanceof Error ? error.message : 'Unknown error');
      return err(new LLMError(message, this.name, undefined, isTransientNetworkError(error), {
        model: this.config.model,
        endpoint: `${this.config.baseUrl}/chat/completions`,
      }));
    }
  }

  protected async *streamImpl(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    // Kimi Code API requires a coding agent User-Agent
    if (this.config.baseUrl.includes('kimi.com')) {
      headers['User-Agent'] = 'claude-code/1.0';
    }

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

    if (req.thinking?.enabled && this.capabilities.thinking) {
      const effort = req.thinking.effort || 'medium';
      body.reasoning_effort = effort;
      body.reasoning = { effort };
    } else if (!this.capabilities.thinking && this.capabilities.thinkingStyle === 'none') {
      const base = (this.config.baseUrl || '').toLowerCase();
      if (base.includes('kimi.com') || base.includes('moonshot.cn') || base.includes('moonshot.ai')) {
        body.thinking = { type: 'disabled' };
        body.temperature = 0.6;
      }
    }

    if (!req.thinking?.enabled && isLocalLFM3(this.config.baseUrl, this.config.model)) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    const signal = this.withTimeout(req.signal, this.config.timeout || TIMEOUT_DEFAULT_MS);

    const response = await this.limitedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      yield { type: 'error', error: `OpenAI API error ${response.status}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const events = parseOpenAIStream(response.body);
    yield* /lfm3/i.test(this.config.model) ? finalLFM3Content(events) : events;
  }
}
