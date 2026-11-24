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
import { acquireHostSlot } from '../hostConcurrency.js';
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

/** True when targeting Z.ai's Anthropic-compatible gateway (strict [1, 131072] integer max_tokens). */
export function isZaiAnthropicHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.z.ai' || host.endsWith('.z.ai');
  } catch {
    return false;
  }
}

export const ZAI_ANTHROPIC_MAX_OUTPUT_TOKENS = 131_072;

function normalizeWireModel(model: string, baseUrl: string): string {
  if (isZaiAnthropicHost(baseUrl) && /^glm\//i.test(model)) {
    return model.replace(/^glm\//i, '');
  }
  return model;
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';

  get capabilities(): ProviderCapabilities {
    return CapabilityRegistry.getCapabilities(normalizeWireModel(this.config.model, this.config.baseUrl));
  }

  protected async generateImpl(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>> {
    try {
      const url = anthropicMessagesEndpoint(this.config.baseUrl);
      const wireModel = normalizeWireModel(this.config.model, this.config.baseUrl);
      const modelCaps = CapabilityRegistry.getCapabilities(wireModel);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (this.config.apiKey) {
        headers['x-api-key'] = this.config.apiKey;
      }

      const body: Record<string, unknown> = {
        model: wireModel,
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
      const adaptive = isAdaptiveClaude(wireModel);
      const thinkingEnabled = !adaptive && req.thinking?.enabled && this.capabilities.thinking;
      if (!thinkingEnabled && !adaptive) {
        const temp = req.temperature ?? this.config.temperature;
        if (typeof temp === 'number' && Number.isFinite(temp)) {
          body.temperature = temp;
        }
      }
      if (adaptive && req.thinking?.enabled && req.thinking.effort) body.output_config = { effort: req.thinking.effort };

      // Tool definitions — Anthropic format
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map(t => {
          const schema = (t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters))
            ? { ...(t.parameters as Record<string, unknown>) }
            : {};
          if (!('type' in schema)) schema.type = 'object';
          return {
            name: t.name,
            description: t.description,
            input_schema: schema,
          };
        });
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
      const rawBudget = thinkingEnabled ? req.thinking?.budgetTokens || DEFAULT_THINKING_BUDGET : 0;
      const budget = thinkingEnabled ? Math.max(1, Math.trunc(Number.isFinite(rawBudget) ? rawBudget : DEFAULT_THINKING_BUDGET)) : 0;
      const maxOutputCap = modelCaps.maxOutputTokens
        ?? (isZaiAnthropicHost(this.config.baseUrl) ? ZAI_ANTHROPIC_MAX_OUTPUT_TOKENS : undefined);
      body.max_tokens = anthropicWireMaxTokens(
        body.max_tokens as number,
        budget,
        modelCaps.uncappedThinkingMaxOutput,
        maxOutputCap,
      );
      if (thinkingEnabled) body.thinking = { type: 'enabled', budget_tokens: budget };

      const releaseSlot = await acquireHostSlot(url, req.signal);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
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

        data = await response.json();
      } finally {
        releaseSlot();
      }

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
    const wireModel = normalizeWireModel(this.config.model, this.config.baseUrl);
    const modelCaps = CapabilityRegistry.getCapabilities(wireModel);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }

    const body: Record<string, unknown> = {
      model: wireModel,
      max_tokens: req.maxTokens ?? this.config.maxTokens ?? 4096,
      messages: [
        { role: 'user', content: req.userPrompt },
      ],
      stream: true,
    };

    if (req.systemPrompt) {
      body.system = req.systemPrompt;
    }

    const adaptive = isAdaptiveClaude(wireModel);
    const thinkingEnabled = !adaptive && req.thinking?.enabled && this.capabilities.thinking;
    if (!thinkingEnabled && !adaptive) {
      const temp = req.temperature ?? this.config.temperature;
      if (typeof temp === 'number' && Number.isFinite(temp)) {
        body.temperature = temp;
      }
    }
    if (adaptive && req.thinking?.enabled && req.thinking.effort) body.output_config = { effort: req.thinking.effort };

    // #1652: max_tokens counts thinking + answer on this wire; keep the answer budget whole.
    const rawBudget = thinkingEnabled ? req.thinking?.budgetTokens || DEFAULT_THINKING_BUDGET : 0;
    const budget = thinkingEnabled ? Math.max(1, Math.trunc(Number.isFinite(rawBudget) ? rawBudget : DEFAULT_THINKING_BUDGET)) : 0;
    const maxOutputCap = modelCaps.maxOutputTokens
      ?? (isZaiAnthropicHost(this.config.baseUrl) ? ZAI_ANTHROPIC_MAX_OUTPUT_TOKENS : undefined);
    body.max_tokens = anthropicWireMaxTokens(
      body.max_tokens as number,
      budget,
      modelCaps.uncappedThinkingMaxOutput,
      maxOutputCap,
    );
    if (thinkingEnabled) body.thinking = { type: 'enabled', budget_tokens: budget };

    const releaseSlot = await acquireHostSlot(url, req.signal);
    try {
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
    } finally {
      releaseSlot();
    }
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
export function anthropicWireMaxTokens(
  answerTokens: number,
  thinkingBudget: number,
  uncappedThinkingMaxOutput?: number,
  maxOutputTokens?: number,
): number {
  const safeAnswer = Number.isFinite(answerTokens) && answerTokens >= 1
    ? Math.trunc(answerTokens)
    : 4096;
  const safeBudget = Number.isFinite(thinkingBudget) && thinkingBudget > 0
    ? Math.trunc(thinkingBudget)
    : 0;
  // A model that thinks unasked and ignores budget_tokens is bounded only by
  // max_tokens, so give it its whole output ceiling.
  let wire = uncappedThinkingMaxOutput && Number.isFinite(uncappedThinkingMaxOutput) && uncappedThinkingMaxOutput >= 1
    ? Math.trunc(uncappedThinkingMaxOutput)
    : safeAnswer + safeBudget;
  if (maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens >= 1) {
    wire = Math.min(wire, Math.trunc(maxOutputTokens));
  }
  return Math.max(1, wire);
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
