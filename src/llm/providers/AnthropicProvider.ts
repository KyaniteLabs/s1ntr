/**
 * AnthropicProvider - Claude Messages API (/v1/messages)
 *
 * Handles Claude Opus 4, Sonnet 4, Haiku 4 with extended thinking.
 * Key difference: Anthropic is STATELESS — client must store
 * thinking_blocks for multi-turn conversations.
 */

import { Result, ok, err } from 'neverthrow';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderCapabilities,
  StreamEvent,
  NormalizedThinking,
} from '../ProviderTypes.js';
import { BaseProvider } from './BaseProvider.js';
import { CapabilityRegistry } from '../CapabilityRegistry.js';
import { TIMEOUT_DEFAULT_MS } from '../../constants/limits.js';
import { extractAnthropicThinking } from '../ThinkingNormalizer.js';
import { parseAnthropicStream } from '../StreamParser.js';
import { createLLMHttpError, isTransientNetworkError, LLMError } from '../errors.js';

function buildAnthropicUserContent(req: ProviderRequest): unknown {
  if (!req.imageInputs || req.imageInputs.length === 0) return req.userPrompt;
  return [
    { type: 'text', text: req.userPrompt },
    ...req.imageInputs.map(image => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: image.dataBase64,
      },
    })),
  ];
}

export function anthropicMessagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(trimmed)) return trimmed;
  if (/\/messages$/i.test(trimmed)) return `${trimmed.replace(/\/messages$/i, '')}/v1/messages`;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

/**
 * Claude 5.x (opus/sonnet/haiku/fable): the API rejects temperature/top_p/top_k and budget_tokens; thinking is adaptive
 * (the param is omitted) and depth is output_config.effort. Older models keep the legacy wire.
 */
export function isAdaptiveClaude(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable)-5(-|$)/i.test(model);
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';

  get capabilities(): ProviderCapabilities {
    return CapabilityRegistry.getCapabilities(this.config.model);
  }

  protected async generateImpl(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>> {
    try {
      const url = anthropicMessagesEndpoint(this.config.baseUrl);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (this.config.apiKey) {
        headers['x-api-key'] = this.config.apiKey;
      }

      const body: Record<string, unknown> = {
        model: this.config.model,
        max_tokens: req.maxTokens ?? this.config.maxTokens ?? 4096,
        messages: [
          { role: 'user', content: buildAnthropicUserContent(req) },
        ],
      };

      // System prompt goes as top-level field
      if (req.systemPrompt) {
        body.system = req.systemPrompt;
      }

      // Temperature (omit for thinking-enabled requests — Anthropic restriction)
      const adaptive = isAdaptiveClaude(this.config.model);
      const thinkingEnabled = !adaptive && req.thinking?.enabled && this.capabilities.thinking;
      if (!thinkingEnabled && !adaptive) {
        body.temperature = req.temperature ?? this.config.temperature;
      }
      if (adaptive && req.thinking?.enabled && req.thinking.effort) body.output_config = { effort: req.thinking.effort };

      // Tool definitions — Anthropic format
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Record<string, unknown>,
        }));
      }

      // Tool results from previous calls
      if (req.toolResults && req.toolResults.length > 0) {
        const toolContent: Array<{ type: string; tool_use_id: string; content: string }> = req.toolResults.map(tr => ({
          type: 'tool_result',
          tool_use_id: tr.toolCallId,
          content: tr.result,
        }));
        (body.messages as Array<{ role: string; content: unknown }>).push({
          role: 'assistant',
          content: req.toolResults.map(tr => ({
            type: 'tool_use' as const,
            id: tr.toolCallId,
            name: tr.toolCall?.name || 'tool',
            input: this.parseToolInput(tr.toolCall?.arguments),
          })),
        });
        (body.messages as Array<{ role: string; content: unknown }>).push({
          role: 'user',
          content: toolContent,
        });
      }

      // Extended thinking
      // #1652: max_tokens counts thinking + answer on this wire; keep the answer budget whole.
      const budget = thinkingEnabled ? req.thinking?.budgetTokens || DEFAULT_THINKING_BUDGET : 0;
      body.max_tokens = anthropicWireMaxTokens(body.max_tokens as number, budget,
        CapabilityRegistry.getCapabilities(this.config.model).uncappedThinkingMaxOutput);
      if (thinkingEnabled) body.thinking = { type: 'enabled', budget_tokens: budget };

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
          label: 'Anthropic API error',
        }));
      }

      const data = await response.json();

      // Extract thinking from content blocks
      const thinking: NormalizedThinking | undefined = extractAnthropicThinking(data);
      const contentBlocks = data.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> | undefined;
      const textBlocks = contentBlocks?.filter(b => b.type === 'text') || [];
      const content = textBlocks.map(b => b.text || '').join('');

      // Extract tool_use blocks
      const toolUseBlocks = contentBlocks?.filter(b => b.type === 'tool_use') || [];
      const toolCalls = toolUseBlocks.map(b => ({
        id: b.id || '',
        name: b.name || '',
        arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input || {}),
      }));
      const stopReason = typeof data.stop_reason === 'string' ? data.stop_reason : 'none';
      const finishReason = toolCalls.length > 0 ? 'tool_calls' as const
        : (stopReason === 'max_tokens' ? 'length' as const : 'stop' as const);

      const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const refused = stopReason === 'refusal';
      const success = !refused && (content.length > 0 || toolCalls.length > 0);

      return ok({
        content,
        thinking: thinking?.source !== 'none' ? thinking : undefined,
        model: data.model || this.config.model,
        success,
        // An empty reply must say why, or callers can only report "unsuccessful
        // response" (#1597). A thinking model that hits max_tokens mid-thought
        // returns no text block at all.
        error: success ? undefined : refused ? 'Provider refused the request (stop_reason=refusal); no content was used' : emptyReplyReason(stopReason, usage?.output_tokens,
          contentBlocks?.map(b => b.type) ?? []),
        usage: usage ? {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
        } : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return err(new LLMError(message, this.name, undefined, isTransientNetworkError(error), {
        model: this.config.model,
        endpoint: anthropicMessagesEndpoint(this.config.baseUrl),
      }));
    }
  }

  private parseToolInput(raw?: string): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  protected async *streamImpl(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const url = anthropicMessagesEndpoint(this.config.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: req.maxTokens ?? this.config.maxTokens ?? 4096,
      messages: [
        { role: 'user', content: req.userPrompt },
      ],
      stream: true,
    };

    if (req.systemPrompt) {
      body.system = req.systemPrompt;
    }

    const adaptive = isAdaptiveClaude(this.config.model);
    const thinkingEnabled = !adaptive && req.thinking?.enabled && this.capabilities.thinking;
    if (!thinkingEnabled && !adaptive) {
      body.temperature = req.temperature ?? this.config.temperature;
    }
    if (adaptive && req.thinking?.enabled && req.thinking.effort) body.output_config = { effort: req.thinking.effort };

    // #1652: max_tokens counts thinking + answer on this wire; keep the answer budget whole.
    const budget = thinkingEnabled ? req.thinking?.budgetTokens || DEFAULT_THINKING_BUDGET : 0;
    body.max_tokens = anthropicWireMaxTokens(body.max_tokens as number, budget,
      CapabilityRegistry.getCapabilities(this.config.model).uncappedThinkingMaxOutput);
    if (thinkingEnabled) body.thinking = { type: 'enabled', budget_tokens: budget };

    const signal = this.withTimeout(req.signal, this.config.timeout || TIMEOUT_DEFAULT_MS);

    const response = await this.limitedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      yield { type: 'error', error: `Anthropic API error ${response.status}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    yield* parseAnthropicStream(response.body);
  }
}

/** Extended-thinking budget when the request names none. */
const DEFAULT_THINKING_BUDGET = 8000;

/**
 * #1652: on the Anthropic messages wire, max_tokens counts thinking AND text.
 * Callers pass maxTokens as the answer budget, so a thinking budget at or above
 * it left no room for text (GLM 5.3 on z.ai spent all 4096 tokens thinking).
 * The wire cap is the answer budget plus the thinking budget.
 */
export function anthropicWireMaxTokens(answerTokens: number, thinkingBudget: number,
  uncappedThinkingMaxOutput?: number): number {
  // A model that thinks unasked and ignores budget_tokens is bounded only by
  // max_tokens, so give it its whole output ceiling.
  if (uncappedThinkingMaxOutput) return uncappedThinkingMaxOutput;
  return answerTokens + thinkingBudget;
}

/** Explain an Anthropic-format reply that carried no text and no tool call. */
export function emptyReplyReason(stopReason: string, outputTokens: number | undefined,
  blockTypes: readonly string[]): string {
  const blocks = blockTypes.length > 0 ? [...new Set(blockTypes)].join('+') : 'none';
  const hint = stopReason === 'max_tokens'
    ? '; the output budget ran out before any text, so raise maxTokens or lower the thinking budget'
    : '';
  return `Provider returned no text (stop_reason=${stopReason}, output_tokens=${outputTokens ?? 'unknown'}, `
    + `content blocks=${blocks})${hint}`;
}
