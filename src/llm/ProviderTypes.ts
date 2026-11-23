/**
 * ProviderTypes - Shared types for the model-agnostic provider system
 *
 * These types define the universal contract between LLMClient and
 * individual provider implementations. Every provider adheres to
 * ProviderRequest → ProviderResponse, regardless of the underlying API.
 */

// ── Request ──

export interface ThinkingConfig {
  enabled: boolean;
  /** Anthropic: exact token count */
  budgetTokens?: number;
  /** OpenAI/Gemini/Anthropic adaptive: effort level */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultMessage {
  toolCallId: string;
  result: string;
  isError?: boolean;
  /** Original model-requested tool call, needed to continue native tool conversations. */
  toolCall?: ToolCallResult;
}

export interface ProviderImageInput {
  mimeType: string;
  dataBase64: string;
  width?: number;
  height?: number;
  label?: string;
}

export type PaidProviderCallerClass =
  | 'studio' | 'cli' | 'script' | 'retry' | 'creative' | 'domain-smoke'
  | 'assimilate' | 'dream' | 'autoresearch' | 'independent-review'
  | 'product-review' | 'recovery';

export interface PreSpendCallContext {
  slotId: string;
  purpose: 'product' | 'sol-review-bootstrap';
  callerClass: PaidProviderCallerClass;
}

export interface ProviderRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: ThinkingConfig;
  signal?: AbortSignal;
  /** Tools the LLM can call (native function calling) */
  tools?: ToolDefinition[];
  /** Tool results from previous calls (multi-turn tool use) */
  toolResults?: ToolResultMessage[];
  /** Images attached to the user prompt for multimodal-capable evaluators/providers. */
  imageInputs?: ProviderImageInput[];
  /** Ask the provider to constrain output to valid JSON (e.g. ollama format:'json'). */
  jsonMode?: boolean;
  /** Required at the shared provider boundary while a governed paid run is active. */
  preSpend?: PreSpendCallContext;
}

// ── Response ──

export interface NormalizedThinking {
  text: string;
  source:
    | 'thinking_blocks'    // Anthropic native
    | 'reasoning_content'  // DeepSeek/OpenAI/LiteLLM
    | 'think_tags'         // Local DeepSeek-R1 via Ollama
    | 'reasoning_details'  // OpenRouter
    | 'none';              // Model doesn't support thinking
  budgetUsed?: number;
}

export interface TokenUsage {
  inputTokens: number;
  /** Every generated token, thinking included. */
  outputTokens: number;
  /** The reasoning part of outputTokens, when the provider reports it. Never add it to outputTokens again. */
  thinkingTokens?: number;
}

export interface ProviderResponse {
  content: string;
  thinking?: NormalizedThinking;
  usage?: TokenUsage;
  model: string;
  success: boolean;
  error?: string;
  /** Tool calls requested by the model */
  toolCalls?: ToolCallResult[];
  /** Whether the model wants to call tools instead of generating text */
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  /** Distinct failure class, so batch tooling and the breaker can tell it from a provider fault. */
  failureClass?: 'reasoning-exhausted';
}

// ── Streaming ──

export type StreamEvent =
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; arguments: string }
  | { type: 'done'; usage?: TokenUsage }
  | { type: 'error'; error: string };

// ── Provider Config ──

export interface ProviderConfig {
  baseUrl: string;
  /** Logical provider identity when the transport uses another provider's wire format. */
  logicalProvider?: string;
  /** Caller-declared GLM coding-plan subscription seat (A005/Sol seat law). */
  glmCodingPlanSeat?: boolean;
  /** Caller-declared MiniMax Token Plan subscription seat. */
  minimaxTokenPlanSeat?: boolean;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  headers?: Record<string, string>;
}

// ── Capabilities ──

export interface ProviderCapabilities {
  thinking: boolean;
  streaming: boolean;
  jsonMode: boolean;
  toolUse: boolean;
  maxContextTokens: number;
  thinkingStyle: 'budget_tokens' | 'effort_level' | 'think_tags' | 'reasoning_content' | 'none';
  streamingStyle: 'sse' | 'json_lines' | 'tag_based';
  /** When set, the model only accepts this exact temperature (e.g. kimi-k3
   *  rejects anything but 1). Call-site and role temperatures are overridden. */
  temperatureFixed?: number;
}
