/**
 * TierBasedGenerator - Base class for model-aware generators
 * 
 * Uses ModelTier detection to adapt prompts based on capability:
 * - FLAGSHIP: Concise prompts, XML tags, lots of context
 * - MEDIUM: Detailed instructions
 * - LOCAL: Explicit, few-shot examples
 * - TINY: Minimal, direct
 */

import { LLMClient, LLMConfig, LLMResponse } from '../llm/LLMClient.js';
import { PromptBuilder } from '../llm/PromptBuilder.js';
import { detectModelTier, trimContext, type ModelTier } from '../llm/ModelTier.js';
import { harnessMemory, type AdaptationRecord } from '../harness/HarnessMemory.js';
import { metaHarness } from '../harness/MetaHarnessIntegration.js';
import { GenerationError } from '../errors/GenerationError.js';
import { Layer, createLayer, DomainType, LayerRole } from '../composition/types.js';
import { Logger } from '../utils/Logger.js';
import { getEffectiveConfig } from '../config/ConfigLoader.js';
import { isFatalRoleConfigError, loadRoleConfig } from '../config/RoleConfig.js';
import { GENERATOR_TOOLS, createGeneratorToolExecutor } from '../harness/tools/generator-tools.js';
import { GeneratorHarnessTools } from './GeneratorHarnessTools.js';
import { MetabolicEntropyEngine } from '../entropy/MetabolicEntropyEngine.js';
import {
  buildGenerationAttemptEventV1,
  type GenerationAttemptCounterDelta,
  type GenerationAttemptEventV1,
  type GenerationAttemptFailureReason,
  type GenerationAttemptTelemetryContext,
} from '../telemetry/generationAttemptEvent.js';
import { GenerationAttemptLedger } from '../runtime-core/generationAttemptSink.js';
import { EmptyArtifactFailure, type EmptyArtifactMetadata } from '../runtime-core/emptyArtifactFailure.js';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../identity/hostAdapterRegistry.js';
import type { ExecutorAttestationRef } from '../identity/harnessTransportGuard.js';

/**
 * Sum signed `durationMs` across the refs produced for one logical provider
 * turn. Returns `undefined` when no signed receipt exists so the caller does
 * not stamp a fabricated wall-clock value (#717 / W8C-04).
 */
function signedDurationMs(refs: readonly ExecutorAttestationRef[] | undefined): number | undefined {
  if (!refs || refs.length === 0) return undefined;
  return refs.reduce((sum, ref) => sum + ref.durationMs, 0);
}


export interface TierBasedGeneratorOptions {
  signal?: AbortSignal;
  bypassCache?: boolean;
  contextBudget?: number;
  /** Caller's per-call generation token cap. Honored as given (Kimi keeps its 8192 minimum). */
  maxTokens?: number;
  /** Generator-owned minimum budget, used only when the caller set no cap. The config budget still wins when larger. */
  maxTokensFloor?: number;
  /** Disable generic generator tool loop for non-code domains that validate directly. */
  useGeneratorTools?: boolean;
  /** Layer role hint — influences prompt and created Layer config */
  layerRole?: LayerRole;
  /** Whether this layer should render with a transparent background */
  transparentBackground?: boolean;
  /** Coordinator-owned durable attempt and graph-wide recovery seams. */
  attemptTelemetry?: GenerationAttemptTelemetryContext;
  attemptLedger?: GenerationAttemptLedger;
  /** Let the composition graph reserve and execute recovery as a separate provider stage. */
  coordinatorManagedRecovery?: boolean;
}

export interface GeneratorFitnessMetadata {
  provider?: string;
  model?: string;
  activeAdaptationIds: string[];
}

export abstract class TierBasedGenerator {
  protected llm: LLMClient;
  protected promptBuilder: PromptBuilder;
  protected tier: ModelTier;
  protected domain: string;
  /** Harness tools for bounded domain-contract sampling and failure-guided repair */
  protected harnessTools: GeneratorHarnessTools;
  private _configNeedsResolution: boolean;
  private _configResolutionPromise: Promise<void> | null = null;
  private lastFitnessMetadata: GeneratorFitnessMetadata = { activeAdaptationIds: [] };

  constructor(
    domain: string,
    llmOrConfig?: LLMClient | Partial<LLMConfig>,
    entropy?: MetabolicEntropyEngine
  ) {
    this.domain = domain;
    this._configNeedsResolution = false;

    if (llmOrConfig instanceof LLMClient) {
      this.llm = llmOrConfig;
    } else if (llmOrConfig && (llmOrConfig.baseUrl || llmOrConfig.apiKey || llmOrConfig.model)) {
      // Caller provided partial config with meaningful values
      this.llm = new LLMClient({ ...llmOrConfig, role: 'generator' });
    } else {
      // No config provided -- create placeholder and resolve lazily on first generate
      this.llm = new LLMClient({ role: 'generator' });
      this._configNeedsResolution = true;
    }

    this.tier = detectModelTier(this.llm.getConfig());
    this.promptBuilder = new PromptBuilder(this.llm.getConfig());
    this.harnessTools = new GeneratorHarnessTools(
      entropy ? { entropySource: entropy } : { seededRandom: Math.random }
    );
  }

  /**
   * Resolve LLM config from getEffectiveConfig() if no explicit config was provided.
   * Called lazily on first generation to ensure providers like MiniMax (from
   * ~/.sinter/config.json) are properly wired without requiring env vars.
   * Uses a promise to prevent race conditions during concurrent calls.
   */
  private async resolveConfigIfNeeded(): Promise<void> {
    if (!this._configNeedsResolution) return;
    
    // Race-safe lazy initialization: only first caller creates the promise
    if (!this._configResolutionPromise) {
      this._configResolutionPromise = this.doResolveConfig();
    }
    
    return this._configResolutionPromise;
  }
  
  private async doResolveConfig(): Promise<void> {
    // Resolve the GENERATOR ROLE explicitly. Previously this used
    // getEffectiveConfig() (the default provider) and passed its baseUrl/model/
    // apiKey into the client — which override `role: 'generator'` in the LLMClient
    // constructor, so a per-role generator model was silently ignored and
    // generation always used the default provider.
    let gen;
    try {
      const roles = await loadRoleConfig(process.cwd());
      gen = roles.generator;
    } catch (err) {
      if (isFatalRoleConfigError(err)) throw err;
      Logger.warn('TierBasedGenerator', 'Role config load failed, falling back to effective config:', err);
      const config = await getEffectiveConfig(undefined, process.cwd());
      gen = config?.baseUrl ? { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, temperature: undefined } : undefined;
    }
    if (gen?.baseUrl || gen?.apiKey) {
      this.llm = new LLMClient({
        provider: gen.provider,
        baseUrl: gen.baseUrl,
        model: gen.model,
        apiKey: gen.apiKey,
        temperature: gen.temperature,
        thinking: gen.thinking,
        role: 'generator',
      });
      this.tier = detectModelTier(this.llm.getConfig());
      this.promptBuilder = new PromptBuilder(this.llm.getConfig());
    }
    this._configNeedsResolution = false;
  }

  async generate(prompt: string, options?: TierBasedGeneratorOptions): Promise<string> {
    const response = await this.generateInternal(prompt, options);
    return response.code;
  }

  getLastFitnessMetadata(): GeneratorFitnessMetadata {
    return {
      ...this.lastFitnessMetadata,
      activeAdaptationIds: [...this.lastFitnessMetadata.activeAdaptationIds],
    };
  }

  protected captureFitnessMetadata(
    response: LLMResponse,
    activeAdaptationIds: string[] = [],
  ): void {
    this.lastFitnessMetadata = {
      provider: response.provenance?.provider,
      model: response.provenance?.model ?? this.llm.getConfig().model,
      activeAdaptationIds: [...activeAdaptationIds],
    };
  }

  /**
   * Generate with full telemetry — returns the complete LLMResponse
   * including reasoning traces, thinking source, quality scores, and
   * detected patterns. Use this for campaign/telemetry flows that need
   * more than just the generated code.
   */
  async generateFull(prompt: string, options?: TierBasedGeneratorOptions): Promise<LLMResponse> {
    return this.generateInternal(prompt, options);
  }

  /**
   * Generate a Layer with full metadata.
   * This is the preferred method for layer-based composition.
   */
  async generateLayer(prompt: string, options?: TierBasedGeneratorOptions): Promise<Layer> {
    const response = await this.generateInternal(prompt, options);

    return createLayer(
      this.domain as DomainType,
      response.code,
      prompt,
      {
        generator: this.constructor.name,
        model: this.llm.getConfig().model || 'unknown',
        generatedAt: new Date().toISOString(),
        thinking: response.thinking,
        recoveredFromThinking: response.recoveredFromThinking,
        validation: { passed: true },
      },
      {
        role: options?.layerRole,
        transparentBackground: options?.transparentBackground,
      }
    );
  }

  /**
   * Internal generation method that returns full LLMResponse.
   */
  private async generateInternal(
    prompt: string,
    options?: TierBasedGeneratorOptions
  ): Promise<LLMResponse> {
    // Resolve LLM config lazily on first generation call
    await this.resolveConfigIfNeeded();

    try {
      return await this.runAttemptStages(prompt, options);
    } catch (err) {
      await this.emitStage(options?.attemptTelemetry, 'terminal', {
        recoveryDecision: 'terminal_failure',
      });
      throw err;
    }
  }

  /** Project baseUrl → provider family for ranking without log parsing. */
  private providerFamilyFromBaseUrl(baseUrl?: string): string {
    const lower = (baseUrl || '').toLowerCase();
    if (!lower) return 'unknown';
    if (lower.includes('localhost:1234') || lower.includes('127.0.0.1:1234')) return 'lmstudio';
    if (lower.includes('localhost:11434') || lower.includes('127.0.0.1:11434')) return 'ollama';
    if (lower.includes('kilo')) return 'kilo';
    if (lower.includes('openai')) return 'openai';
    if (lower.includes('anthropic')) return 'anthropic';
    if (lower.includes('moonshotai')) return 'moonshotai';
    return 'provider';
  }

  private async emitStage(
    attempt: GenerationAttemptTelemetryContext | undefined,
    stage: 'request' | 'tool_selection' | 'assistant_payload' | 'extracted_artifact' | 'validation' | 'failure_class' | 'recovery_decision' | 'terminal',
    partial: Partial<GenerationAttemptEventV1> = {},
    counters?: GenerationAttemptCounterDelta,
    attestations?: readonly ExecutorAttestationRef[],
  ): Promise<void> {
    if (!attempt) return;
    await attempt.emit(buildGenerationAttemptEventV1({
      runId: attempt.runId,
      candidateId: attempt.candidateId,
      attemptId: attempt.attemptId,
      attemptOrdinal: attempt.attemptOrdinal,
      stage,
      domain: attempt.domain ?? this.domain,
      recoveryOfAttemptId: attempt.recoveryOfAttemptId,
      executorReservationDigest: attempt.executorReservationDigest,
      ...(partial as object),
    }), counters, attestations);
  }

  private async runAttemptStages(
    prompt: string,
    options?: TierBasedGeneratorOptions
  ): Promise<LLMResponse> {
    // Resolve LLM config lazily on first generation call (idempotent)
    await this.resolveConfigIfNeeded();

    // Ensure LLM is properly initialized
    if (!this.llm) {
      throw new GenerationError(`${this.constructor.name}: LLM not initialized`, this.domain);
    }

    // Ensure promptBuilder is properly initialized
    if (!this.promptBuilder) {
      throw new GenerationError(`${this.constructor.name}: PromptBuilder not initialized`, this.domain);
    }

    if (!LLMClient.isConfigured()) {
      throw new GenerationError(`${this.constructor.name}: No LLM configured`, this.domain);
    }

    // 1. Load context from markdown files and memory
    const activeAdaptations = this.getRecentAdaptations();
    const context = await PromptBuilder.loadContext(this.domain, prompt, {
      recentAdaptations: activeAdaptations.map(adaptation => adaptation.description),
      userPreferences: this.getUserPreferences(),
    });

    // 2. Apply token budget
    const budget = options?.contextBudget || this.getDefaultBudget();
    if (context.domainDocs) {
      context.domainDocs = trimContext(context.domainDocs, Math.floor(budget * 0.3));
    }

    // 3. Build tier-appropriate prompt
    const builtPrompt = this.promptBuilder.build(context);

    // 4. Gather domain harness hints (skeleton + API + hardening)
    //    These are additive rails — the model gets better context without static fallback.
    const harnessCtx = this.harnessTools.prepare(this.domain);
    const harnessHint = this.buildHarnessHint(harnessCtx);

    Logger.info('TierBasedGenerator', `Using ${this.tier} tier (${budget} token budget)`);

    // 5. Generate with tool support (validate_syntax, check_imports)
    // Never send empty system content — Kilo/OpenAI reject "system message must have content"
    // (W4 product finding: K3 generator battery empty-artifact under tiny-tier empty system).
    // Apply the non-empty fallback to ALL tiers: tiny intentionally builds system:'',
    // and medium/flagship can still produce blank system if prompt assembly fails.
    const domainSystemFallback =
      `You generate complete runnable ${this.domain} code only. Output code only, no markdown fences.`;
    // L9 dual mandate (CEO law 2026-08-26): every model run also looks for
    // improvements around it. Appended to every generator system prompt; the
    // trailing line is parseable telemetry (no effect on mission output).
    const dualMandateClause = '\n\nDUAL MANDATE (standing): Besides your primary task,'
      + ' note up to two concrete improvements you observed about the system, prompts, tools,'
      + ' or process around this task. End your response with a line exactly:'
      + ' IMPROVE: <one short observation or NONE>';
    const assembledSystem = this.tier === 'tiny'
      ? (builtPrompt.system || '')
      : `${builtPrompt.system || ''}${harnessHint ? `\n\n${harnessHint}` : ''}${dualMandateClause}`;
    const systemPrompt = (assembledSystem.trim().length > 0
      ? assembledSystem
      : domainSystemFallback) + dualMandateClause;
    const userPrompt = this.tier === 'tiny'
      ? (builtPrompt.combined || builtPrompt.user)
      : builtPrompt.user;

    // K3 via Kilo frequently returns empty content from the native tool loop
    // (W4 empty-artifact dogfood). Skip tools for that family unless the caller
    // explicitly opts in; keep tools as the default for other models.
    const modelId = (this.llm.getConfig().model || '').toLowerCase();
    // Kimi coding/k3 family: skip the tool loop (empty-artifact dogfood) and
    // keep a minimum craft budget for reasoning + code.
    const isKimiCodingFamily = modelId.includes('kimi-k3')
      || modelId.includes('kimi-for-coding')
      || modelId.includes('kimi-k2');
    // K3 reasoning can consume a 4k output budget before the runnable artifact
    // finishes. Wave 4 live dogfood established 8k as the minimum craft budget.
    // An explicit caller cap is a ceiling. Without one, the larger of the
    // generator floor and the config budget applies, so a small generator
    // default never truncates a large-budget model (2689230e1).
    const configuredMaxTokens = options?.maxTokens
      ?? Math.max(options?.maxTokensFloor ?? 0, this.llm.getConfig().maxTokens ?? 0);
    const generationMaxTokens = isKimiCodingFamily
      ? Math.max(configuredMaxTokens, 8192)
      : configuredMaxTokens;
    const useTools = options?.useGeneratorTools === true
      ? true
      : options?.useGeneratorTools === false
        ? false
        : !isKimiCodingFamily;
    let response: LLMResponse;
    let recoverySucceeded = false;
    let primaryFailureReason: GenerationAttemptFailureReason = 'empty-artifact';
    let standaloneRecoveryConsumed = false;
    const reserveRecovery = async () => {
      if (options?.attemptLedger && options.attemptTelemetry) {
        return options.attemptLedger.reserveRecovery({
          runId: options.attemptTelemetry.runId,
          candidateId: options.attemptTelemetry.candidateId,
          failedAttemptId: options.attemptTelemetry.attemptId,
          domain: this.domain,
        });
      }
      if (standaloneRecoveryConsumed) {
        return { granted: false as const, consumedByAttemptId: 'standalone-primary' };
      }
      standaloneRecoveryConsumed = true;
      const attemptId = `standalone-recovery-${randomUUID()}`;
      return {
        granted: true as const,
        context: {
          runId: 'standalone-run',
          candidateId: 'standalone-candidate',
          attemptId,
          attemptOrdinal: 2,
          domain: this.domain,
          recoveryOfAttemptId: 'standalone-primary',
          emit: () => undefined,
        } satisfies GenerationAttemptTelemetryContext,
      };
    };
    if (!useTools) {
      await this.emitStage(options?.attemptTelemetry, 'request');
      await this.emitStage(options?.attemptTelemetry, 'tool_selection', { toolName: 'no_tools_direct' });
      const direct = await this.llm.complete({
        systemPrompt,
        prompt: userPrompt,
        maxTokens: generationMaxTokens,
        temperature: this.llm.getConfig().temperature,
        signal: options?.signal,
      });
      await this.emitStage(options?.attemptTelemetry, 'assistant_payload', {
        payloadByteLength: Buffer.byteLength(direct.text ?? '', 'utf8'),
        payloadDigest: direct.text ? sha256Hex(direct.text) : undefined,
        durationMs: signedDurationMs(direct.executorAttestations),
        resolvedExecutor: direct.provenance?.model,
        providerFamily: direct.provenance?.provider,
      }, this.signedCounterDelta(direct.executorAttestations, direct.usage), direct.executorAttestations);
      await this.emitStage(options?.attemptTelemetry, 'extracted_artifact', {
        extractionOutcome: direct.text.trim() ? 'pass' : 'fail',
      });
      response = {
        code: this.normalizeGeneratedContent(TierBasedGenerator.stripImproveTrailer(direct.text)),
        success: direct.success,
        error: direct.error,
        provenance: direct.provenance,
      };
      if (!response.code.trim() && direct.text.trim()) primaryFailureReason = 'extraction_failed';
      if (!direct.success && /tim(?:e|ed)\s*out|abort/i.test(direct.error ?? '')) primaryFailureReason = 'timeout';
      if (!direct.success && /denied|forbidden|unauthori[sz]ed|payment|quota/i.test(direct.error ?? '')) primaryFailureReason = 'provider_denied';
    } else {
      const toolResult = await this.llm.generateWithToolLoop({
        systemPrompt,
        userPrompt,
        tools: GENERATOR_TOOLS,
        toolExecutor: createGeneratorToolExecutor(this.domain),
        maxIterations: 3,
        maxTokens: generationMaxTokens,
        signal: options?.signal,
        attemptTelemetry: options?.attemptTelemetry,
      });

      response = {
        code: this.normalizeGeneratedContent(TierBasedGenerator.stripImproveTrailer(toolResult.content)),
        success: toolResult.success,
        error: toolResult.error,
        thinking: this.extractToolThinking(toolResult),
        provenance: toolResult.provenance,
      };
      if (!response.code.trim()) {
        primaryFailureReason = toolResult.content.trim()
          ? 'extraction_failed'
          : toolResult.toolCallsMade > 0
            ? 'tool_call_without_artifact'
            : 'empty-artifact';
        if (!toolResult.success && /tim(?:e|ed)\s*out|abort/i.test(toolResult.error ?? '')) primaryFailureReason = 'timeout';
        if (!toolResult.success && /denied|forbidden|unauthori[sz]ed|payment|quota/i.test(toolResult.error ?? '')) primaryFailureReason = 'provider_denied';
      }
    }

    if (!response.code || response.code.trim() === '') {
      if (response.error) {
        Logger.warn('TierBasedGenerator', `${this.domain} primary generation failed: ${response.error}`);
      }
      await this.emitStage(options?.attemptTelemetry, 'failure_class', {
        failureReason: primaryFailureReason,
      });
      if (options?.coordinatorManagedRecovery) {
        throw this.emptyArtifactFailure(response.error, useTools, options?.attemptTelemetry?.attemptId, primaryFailureReason);
      }
      const recovery = await reserveRecovery();
      if (!recovery.granted) {
        await this.emitStage(options?.attemptTelemetry, 'failure_class', { failureReason: 'recovery_exhausted' });
        throw this.emptyArtifactFailure(response.error, useTools, options?.attemptTelemetry?.attemptId, primaryFailureReason);
      }
      await this.emitStage(options?.attemptTelemetry, 'recovery_decision', {
        recoveryDecision: 'recovered_no_tools',
        recoveredByAttemptId: recovery.context.attemptId,
      });
      const directAttempt = await this.retryWithoutGeneratorTools(
        prompt,
        systemPrompt,
        userPrompt,
        options?.signal,
        generationMaxTokens,
        recovery.context,
      );
      if (directAttempt.response) {
        await this.emitStage(recovery.context, 'terminal', { recoveryDecision: 'recovered_no_tools' });
        response = directAttempt.response;
        recoverySucceeded = true;
      } else {
        await this.emitStage(recovery.context, 'failure_class', { failureReason: 'empty-artifact' });
        throw this.emptyArtifactFailure(directAttempt.error ?? response.error, useTools, recovery.context.attemptId, primaryFailureReason);
      }
    }

    // Post-generation validation: check for minimum viable code
    const strippedCode = response.code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (strippedCode.length < 10) {
      await this.emitStage(options?.attemptTelemetry, 'validation', { validationOutcome: 'fail' });
      await this.emitStage(options?.attemptTelemetry, 'failure_class', { failureReason: 'validation_failed' });
      throw new GenerationError(
        `${this.constructor.name}: Generated code is too short (${strippedCode.length} chars)`,
        this.domain,
        { codeLength: strippedCode.length }
      );
    }

    // 6. Domain-specific validation (async to support compile checks in subclasses)
    const validated = await this.validateForGeneration(response.code);
    await this.emitStage(options?.attemptTelemetry, 'validation', {
      validationOutcome: validated.valid ? 'pass' : 'fail',
    });
    if (!validated.valid) {
      await this.emitStage(options?.attemptTelemetry, 'failure_class', { failureReason: 'validation_failed' });
      if (options?.coordinatorManagedRecovery) {
        throw new GenerationError(`${this.constructor.name}: ${validated.error}`, this.domain);
      }
      const recovery = await reserveRecovery();
      if (!recovery.granted) {
        await this.emitStage(options?.attemptTelemetry, 'failure_class', { failureReason: 'recovery_exhausted' });
        throw new GenerationError(`${this.constructor.name}: ${validated.error}`, this.domain);
      }
      await this.emitStage(options?.attemptTelemetry, 'recovery_decision', {
        recoveryDecision: 'repaired_tools',
        recoveredByAttemptId: recovery.context.attemptId,
      });
      const recoveryResult = await this.attemptRecovery(
        prompt,
        response.code,
        validated.error ?? 'Validation failed',
        systemPrompt,
        userPrompt,
        options?.signal,
        recovery.context,
      );

      if (recoveryResult) {
        await this.emitStage(recovery.context, 'validation', { validationOutcome: 'pass' });
        await this.emitStage(recovery.context, 'terminal', { recoveryDecision: 'repaired_tools' });
        response = recoveryResult;
        recoverySucceeded = true;
      } else {
        await this.emitStage(recovery.context, 'validation', { validationOutcome: 'fail' });
        await this.emitStage(recovery.context, 'failure_class', { failureReason: 'validation_failed' });
        throw new GenerationError(`${this.constructor.name}: ${validated.error}`, this.domain, {
          validationError: validated.error,
          generatedCode: response.code,
        });
      }
    }

    if (!recoverySucceeded) {
      await this.emitStage(options?.attemptTelemetry, 'terminal', { recoveryDecision: 'no_recovery' });
    }

    this.captureFitnessMetadata(response, activeAdaptations.map(adaptation => adaptation.id));

    // 7. Record successful generation to harness memory
    if (process.env.NODE_ENV !== 'test') {
      await metaHarness.onGenerationComplete({
        success: true,
        model: this.llm.getConfig().model || 'unknown',
        domain: this.domain,
        prompt,
        code: response.code,
        duration: 0,
        thinking: response.thinking,
        recoveredFromThinking: response.recoveredFromThinking,
      });

      harnessMemory.recordEpisode({
        type: 'generation',
        domain: this.domain,
        prompt,
        code: response.code,
      });

      this.harnessTools.recordSuccess(this.domain, response.code);
    }

    return response;
  }

  /**
   * Build a harness hint string from a GeneratorHarnessContext.
   * Combines skeleton, sampled APIs, and hardening hints into a compact
   * advisory block that is prepended to the system prompt.
   */
  private buildHarnessHint(ctx: ReturnType<GeneratorHarnessTools['prepare']>): string {
    if (!ctx.hintsWereSampled) return '';

    const parts: string[] = [];

    if (ctx.skeletonHint) {
      parts.push(`// Domain scaffold\n${ctx.skeletonHint}`);
    }

    if (ctx.sampledApis.length > 0) {
      parts.push(`// Required API tokens (at least 2 must appear): ${ctx.sampledApis.join(', ')}`);
    }

    if (ctx.hardeningHints.length > 0) {
      parts.push(`// Hardening hints:\n${ctx.hardeningHints.map((h: string) => `// - ${h}`).join('\n')}`);
    }

    return parts.join('\n\n');
  }

  private async retryWithoutGeneratorTools(
    originalPrompt: string,
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    maxTokens?: number,
    telemetry?: GenerationAttemptTelemetryContext,
  ): Promise<{ response: LLMResponse | null; error?: string }> {
    if (typeof this.llm.complete !== 'function') return { response: null };
    Logger.warn('TierBasedGenerator', `${this.domain} tool loop returned empty code; retrying once without tools`);
    await this.emitStage(telemetry, 'request');
    await this.emitStage(telemetry, 'tool_selection', { toolName: 'no_tools_direct' });
    const directResult = await this.llm.complete({
      systemPrompt: this.buildEmptyCodeRetrySystemPrompt(systemPrompt),
      prompt: this.buildEmptyCodeRetryPrompt(originalPrompt, userPrompt),
      maxTokens: this.maxTokensForDirectRetry(maxTokens),
      temperature: this.temperatureForDirectRetry(),
      signal,
    });
    if (!directResult) return { response: null };
    await this.emitStage(telemetry, 'assistant_payload', {
      payloadByteLength: Buffer.byteLength(directResult.text ?? '', 'utf8'),
      payloadDigest: directResult.text ? sha256Hex(directResult.text) : undefined,
      durationMs: signedDurationMs(directResult.executorAttestations),
      resolvedExecutor: directResult.provenance?.model,
      providerFamily: directResult.provenance?.provider,
    }, this.signedCounterDelta(directResult.executorAttestations, directResult.usage), directResult.executorAttestations);
    const code = this.normalizeGeneratedContent(directResult.text ?? '').trim();
    await this.emitStage(telemetry, 'extracted_artifact', {
      extractionOutcome: code ? 'pass' : 'fail',
    });
    if (!code) return { response: null, error: directResult.error };
    return {
      response: {
        code,
        explanation: directResult.text,
        success: true,
        error: directResult.error,
        isComplete: this.isStructurallyComplete(code),
        provenance: directResult.provenance,
      },
      error: directResult.error,
    };
  }

  /**
   * Build the counter delta from signed W8C-03 quota-counter deltas. Falls back
   * to provider-reported token usage when no signed ref was bound (e.g. the
   * host-owned transport authority was not installed). Never hard-code
   * `providerCalls/quotaUnits=1`; every retry/fallback counts truthfully.
   */
  private signedCounterDelta(
    refs: readonly ExecutorAttestationRef[] | undefined,
    usage: { readonly inputTokens?: number; readonly outputTokens?: number } | undefined,
  ): GenerationAttemptCounterDelta {
    if (refs && refs.length > 0) {
      return refs.reduce((acc, ref) => ({
        providerCalls: acc.providerCalls + ref.quotaCounterDelta.calls,
        inputTokens: acc.inputTokens + ref.quotaCounterDelta.inputTokens,
        outputTokens: acc.outputTokens + ref.quotaCounterDelta.outputTokens,
        activeTimeMs: acc.activeTimeMs + Math.round(ref.quotaCounterDelta.activeSeconds * 1_000),
        quotaUnits: acc.quotaUnits + ref.quotaCounterDelta.calls,
      }), { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeTimeMs: 0, quotaUnits: 0 });
    }
    // No signed receipt — record observed usage only, do NOT fabricate calls.
    return {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    };
  }

  protected buildEmptyCodeRetrySystemPrompt(systemPrompt: string): string {
    const trimmed = (systemPrompt || '').trim();
    if (trimmed) return trimmed;
    return `You generate complete runnable ${this.domain} code only. Output code only, no markdown fences.`;
  }

  protected buildEmptyCodeRetryPrompt(originalPrompt: string, userPrompt: string): string {
    return [
      userPrompt,
      '',
      'The previous model call returned no final artifact.',
      `Generate the final ${this.domain} artifact for the original request now.`,
      'Return only the runnable output. Do not include markdown fences, explanations, reasoning, or tool calls.',
      `Original request: ${originalPrompt}`,
    ].join('\n');
  }

  protected maxTokensForDirectRetry(maxTokens?: number): number | undefined {
    // Tool-loop failures often burn the budget on empty tool chatter. Give the
    // no-tools retry a floor so craft is not truncated mid-function (W4 K3).
    const configured = maxTokens ?? this.llm.getConfig().maxTokens;
    const modelId = (this.llm.getConfig().model || '').toLowerCase();
    const floor = modelId.includes('kimi-k3') ? 8192 : 4096;
    if (typeof configured === 'number' && Number.isFinite(configured)) {
      return Math.max(configured, floor);
    }
    return floor;
  }

  protected temperatureForDirectRetry(): number | undefined {
    return this.llm.getConfig().temperature;
  }

  private describeEmptyGenerationFailure(...errors: Array<string | undefined>): string {
    const upstreamError = errors.find((error) => typeof error === 'string' && error.trim().length > 0);
    if (upstreamError) {
      return `LLM failed before returning code: ${this.formatProviderErrorForOperator(upstreamError)}`;
    }
    return 'LLM returned empty code';
  }

  private emptyArtifactFailure(
    upstreamError: string | undefined,
    usedTools: boolean,
    attemptId: string | undefined,
    failureReason: GenerationAttemptFailureReason,
  ): EmptyArtifactFailure {
    const providerFamily = this.providerFamilyFromBaseUrl(this.llm.getConfig().baseUrl);
    const model = this.llm.getConfig().model || null;
    const metadata: EmptyArtifactMetadata = {
      providerFamily,
      modelId: model,
      requestedExecutor: model,
      resolvedExecutor: model,
      toolName: usedTools ? 'submit_code' : 'no_tools_direct',
      toolCallId: null,
      finishReason: 'tool_calls',
      noToolsRetryAttempted: true,
      repairAttempted: false,
      causalTrace: [
        { stage: 'request' },
        { stage: 'assistant_payload', outcome: 'empty' },
      ],
    };
    return new EmptyArtifactFailure({
      failureReason,
      message: `${this.constructor.name}: ${this.describeEmptyGenerationFailure(upstreamError)}`,
      domain: this.domain,
      metadata,
      attemptId,
    });
  }

  private formatProviderErrorForOperator(error: string): string {
    const extracted = this.extractProviderErrorMessage(error);
    const message = extracted || error;
    if (/invalid model identifier/i.test(message)) {
      const config = this.llm.getConfig();
      const provider = this.providerNameForOperator(config.baseUrl);
      const model = config.model || 'the configured model';
      return `${provider} cannot use model "${model}": ${message} Open ${provider} and load that model, or choose a loaded model in Settings.`;
    }
    return message;
  }

  private extractProviderErrorMessage(error: string): string | undefined {
    const jsonStart = error.indexOf('{');
    if (jsonStart < 0) return undefined;
    try {
      const parsed = JSON.parse(error.slice(jsonStart)) as { error?: { message?: unknown } };
      return typeof parsed.error?.message === 'string' ? parsed.error.message : undefined;
    } catch {
      return undefined;
    }
  }

  private providerNameForOperator(baseUrl?: string): string {
    const lower = (baseUrl || '').toLowerCase();
    if (lower.includes('localhost:1234') || lower.includes('127.0.0.1:1234')) return 'LM Studio';
    if (lower.includes('localhost:11434') || lower.includes('127.0.0.1:11434')) return 'Ollama';
    return 'the provider';
  }

  private extractToolThinking(toolResult: unknown): string | undefined {
    if (!toolResult || typeof toolResult !== 'object') return undefined;
    const maybeThinking = (toolResult as { thinking?: unknown; reasoning?: unknown }).thinking
      ?? (toolResult as { thinking?: unknown; reasoning?: unknown }).reasoning;
    return typeof maybeThinking === 'string' && maybeThinking.trim() ? maybeThinking : undefined;
  }

  /** L9 dual mandate: models end responses with 'IMPROVE: <obs>|NONE'.
 *  Strip the trailer from delivered content; it is telemetry, not code. */
  static stripImproveTrailer(text: string): string {
    const match = text.match(/\n?\s*IMPROVE:\s*([^\n]*)\s*$/);
    if (!match || match.index === undefined) return text;
    return text.slice(0, match.index);
  }

  private normalizeGeneratedContent(content: string): string {
    let clean = (content ?? '').replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
    const markdownMatch = clean.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (markdownMatch) clean = markdownMatch[1].trim();
    return clean.trim();
  }

  private isStructurallyComplete(code: string): boolean {
    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    return openBraces <= closeBraces && openParens <= closeParens;
  }

  /**
   * Attempt one recovery generation using harness-guided repair prompt.
   * Returns the corrected LLMResponse, or null if recovery also fails.
   */
  private async attemptRecovery(
    originalPrompt: string,
    failedCode: string,
    errorMessage: string,
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    telemetry?: GenerationAttemptTelemetryContext,
  ): Promise<LLMResponse | null> {
    const failure = this.harnessTools.classifyFailure(errorMessage, failedCode);
    const repairPrompt = this.harnessTools.buildRepairPrompt(
      this.domain,
      originalPrompt,
      failedCode,
      failure
    );

    if (!repairPrompt) return null;

    Logger.info('TierBasedGenerator', `Attempting recovery for ${failure.failureClass}: ${errorMessage}`);

    const recoveryUserPrompt =
      `${userPrompt}\n\n` +
      `The previous output failed validation.\n` +
      `Validation error: ${errorMessage}\n` +
      `Failure classification: ${failure.failureClass}\n\n` +
      `${repairPrompt}\n\n` +
      `Original prompt: ${originalPrompt}`;

    const recoveryResult = await this.llm.generateWithToolLoop({
      systemPrompt,
      userPrompt: recoveryUserPrompt,
      tools: GENERATOR_TOOLS,
      toolExecutor: createGeneratorToolExecutor(this.domain),
      maxIterations: 2,
      signal,
      attemptTelemetry: telemetry,
    });

    const recoveryCode = this.normalizeGeneratedContent(recoveryResult.content).trim();

    if (!recoveryCode || recoveryCode.length < 10) return null;

    // Re-validate recovered code (async to support compile checks in subclasses)
    const revalidated = await this.validateForGeneration(recoveryCode);
    if (!revalidated.valid) {
      Logger.info('TierBasedGenerator', `Recovery validation failed: ${revalidated.error}`);
      return null;
    }

    return {
      code: recoveryCode,
      success: true,
      error: undefined,
      provenance: recoveryResult.provenance,
    };
  }

  /**
   * Domain-specific validation - override in subclasses
   */
  protected validateOutput(_code: string): { valid: boolean; error?: string } {
    return { valid: true };
  }

  /**
   * Async domain-specific validation with compile check support.
   *
   * Base implementation calls validateOutput() synchronously.
   * Override in subclasses (like ShaderGenerator) to add async compile checks.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  protected async validateForGeneration(code: string): Promise<{ valid: boolean; error?: string }> {
    return this.validateOutput(code);
  }

  /**
   * Get default token budget based on tier
   */
  private getDefaultBudget(): number {
    switch (this.tier) {
      case 'flagship': return 8000;
      case 'medium': return 4000;
      case 'local': return 2000;
      case 'tiny': return 1000;
    }
  }

  /**
   * Get recent successful adaptations from memory
   */
  private getRecentAdaptations(): AdaptationRecord[] {
    return harnessMemory.getSuccessfulAdaptations()
      .slice(-3);
  }

  /**
   * Get user preferences from memory
   */
  private getUserPreferences(): string {
    const recent = harnessMemory.getRecentEpisodes(5);
    const domains = recent.map(e => e.domain).filter(Boolean);
    const uniqueDomains = [...new Set(domains)];
    
    if (uniqueDomains.length > 0) {
      return `User frequently works with: ${uniqueDomains.join(', ')}`;
    }
    return '';
  }

  /**
   * Get current tier info
   */
  getTierInfo(): { tier: ModelTier; budget: number; domain: string } {
    return {
      tier: this.tier,
      budget: this.getDefaultBudget(),
      domain: this.domain,
    };
  }

  /**
   * Wrap generated code for gallery iframe display.
   * Base class returns code unchanged — subclasses override with domain-specific harnesses.
   */
  wrapForGallery(_code: string): string {
    return _code;
  }

  /**
   * Enrich a prompt using a concept graph via nodeprompt's synthesizePrompt.
   * Opt-in: call this when you have a concept graph to incorporate spatial prompt engineering.
   */
  async enrichWithConceptGraph(prompt: string, graphPath: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const { synthesizePrompt } = await import('../nodeprompt/index.js');

    const graphJson = readFileSync(graphPath, 'utf-8');
    const graph = JSON.parse(graphJson);

    if (!graph.nodes || !graph.edges || !graph.originalPrompt) {
      throw new GenerationError(
        `${this.constructor.name}: Graph JSON must contain { nodes, edges, originalPrompt }`,
        this.domain,
      );
    }

    return synthesizePrompt(prompt ?? graph.originalPrompt, graph.nodes, graph.edges);
  }
}
