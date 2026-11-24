/**
 * ScoringEngine — pluggable, normalized scoring for creative output.
 *
 * All strategies output 0-1 scores on the same dimensions. Register
 * custom strategies or use the built-in ones: comprehensive, fast, keyword,
 * creative, aesthetic, fitness.
 *
 * Consolidated as part of Fix 8: Consolidate Triple Redundancy.
 * CreativeEvaluator and AestheticCritic are now available as scoring strategies.
 */

import { sourcePaletteFacts } from '../aesthetic/ColorExtractor.js';
import { evaluatorCall } from './EvaluatorScope.js';
import { CreativeEvaluator } from './CreativeEvaluator.js';
import { AestheticCritic } from '../aesthetic/AestheticCritic.js';
import { resolvePromptTier, tiered } from '../prompts/PromptTier.js';
import { detectProviderFromUrl } from '../harness/MultiProviderConfig.js';
import { Logger } from '../utils/Logger.js';
import { firstJsonObject, boundedEvaluatorImages, parseJudgeJson } from './EvaluatorIO.js';
export { firstJsonObject, boundedEvaluatorImages, parseJudgeJson };
import { HeuristicScorer } from '../swarm/HeuristicScorer.js';
import { quickScore } from '../collab/Scoring.js';
import { Domain } from '../types/domains.js';
import type { SwarmPersona } from '../swarm/types.js';
import type { DesignConstraints, CriticConfig, LIREvaluationContext } from '../aesthetic/types.js';
import { LLMClient } from '../llm/LLMClient.js';
import { CapabilityRegistry } from '../llm/CapabilityRegistry.js';
import { frameDescriptorText } from '../render/FrameDescriptor.js';
import type { DecisionImage, DecisionModelClient } from '../llm/DecisionModelClient.js';
import { EVALUATOR_TOOLS, createGeneratorToolExecutor } from '../harness/tools/generator-tools.js';
import { Result, ok, err } from 'neverthrow';
import { LLMError } from '../llm/errors.js';
import type { RenderEvidence, GenerationEvaluation, RenderMeasure } from './types/GenerationEvaluation.js';
import { ALIVE_GLITCH_SCORE_FLOOR, glitchLivenessSummary } from '../render/GlitchLiveness.js';
import { OVERMIXED_SCORE_CAP, overmixedRepairAdvice, valueStructureSummary } from '../render/ValueStructure.js';
import { SPARSE_COVERAGE_MIN_SHARE, frameCoverageSummary, sparseFrameRepairAdvice } from '../render/FrameCoverage.js';
import { NEAR_FLAT_MAX_STD } from '../render/LuminanceVerdict.js';
import { evaluateRenderEvidencePerception, measureRenderEvidence } from '../perception/RenderEvidencePerception.js';
import { DomainEvaluatorRegistry } from './evaluators/DomainEvaluatorRegistry.js';
import { TIMEOUT_EVALUATOR_MS } from '../constants/limits.js';
import {
  CREATIVE_JUDGMENT_DIMENSIONS,
  loadCreativeJudgmentProfile,
  scoreCreativeJudgment,
  type CreativeJudgmentProfile,
  type CreativeJudgmentScores,
} from '../learning/CreativeJudgmentCalibration.js';

/** Palette facts for the judge brief when the judge is handed source (the governed path withholds it and judges frames only). */
export function sourcePaletteSummary(code: string): string {
  const facts = sourcePaletteFacts(code);
  return facts ? `\nSource palette (declared hex colours): ${facts}.` : '';
}

const RUBRIC_BANDS = `Score bands (anchor your score in a band first, then refine):
- 0.90-1.00: gallery-grade — strong composition AND deliberate palette AND evident craft; nothing broken.
- 0.75-0.89: competent — coherent and intentional, but missing one dimension (flat lighting, no focal point, sparse).
- 0.60-0.74: weak — renders something relevant but visually thin, muddled, or accidental-looking.
- 0.40-0.59: poor — barely related to the brief, severe visual defects, or mostly empty.
- 0.00-0.39: broken — blank, black, garbled, or unrelated to the brief.
Most competent work belongs in 0.75-0.89. Reserve 0.90+ for work you would exhibit.
Glitch is not broken: saturated, structured, moving datamosh, pixel-sort or feedback blow-up is alive. "Broken" means blank, near-uniform, frozen or crashed. Judge glitch on impact (motion, colour, structure) like any other piece; aliasing and pixel noise are its material, not a defect.`;

const PRIMORDIAL_CRAFT_RUBRIC = `Score each visible dimension independently:
- cohesion: elements behave as one visual system rather than unrelated effects.
- structuralDepth: topology, occlusion, parallax, and lighting create legible spatial organization.
- spatialEmbodiment: perspective, foreshortening, occlusion, parallax, or transmission make forms occupy convincing volume rather than a flat picture plane.
- materiality: surfaces show convincing texture, thickness, transmission, refraction, or tactile response.
- motionPurpose: movement reveals form, hierarchy, or transformation rather than adding random activity.
- composition: hierarchy, focal structure, balance, and negative space are intentional.
- palette: color relationships support the form and remain controlled over time. Palette fit never outweighs impact: a frame with no real light, no clean colour and no value separation (overmixed) scores low on palette however well it matches the brief's named colours.
- finish: detail, texture, transitions, and edge treatment withstand close inspection.`;
const PERCEPTUAL_ANTI_PROXY_RULES = `Anti-proxy rules:
- Score demonstrated pixels across both frames, never intended technique inferred from the brief or code.
- Flat overlap, alpha, or contour density alone do not demonstrate structural depth or materiality.
- Materiality above 0.70 requires visible thickness, texture, transmission, refraction, or light response.
- Palette cleanliness and smooth edges cannot compensate for absent structure, material behavior, or form-revealing motion.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Legacy evaluation strategy names (backward-compatible with EvaluationFramework). */
export type EvaluationStrategy = 'detailed' | 'fast' | 'heuristic' | 'fitness' | 'comprehensive' | 'keyword' | 'creative' | 'aesthetic' | 'llm';

/** Legacy evaluation result shape (backward-compatible with EvaluationFramework). */
export type EvaluationResult = ScoringResult;

/** Legacy evaluation context shape (backward-compatible with EvaluationFramework). */
export interface EvaluationContext {
  prompt?: string;
  domain?: Domain;
  criteria?: string[];
  previousOutputs?: string[];
  persona?: SwarmPersona;
  dimensionScores?: Record<string, number | undefined>;
  weights?: Record<string, number | undefined>;
  /** Design constraints for aesthetic evaluation. */
  designConstraints?: DesignConstraints;
  /** Critic configuration for aesthetic evaluation. */
  criticConfig?: Partial<CriticConfig>;
  /** LIR context for LIR-aware evaluation. */
  lirContext?: LIREvaluationContext;
}

/** Normalized dimension names shared across all strategies. */
export type ScoreDimension =
  | 'technical'
  | 'creative'
  | 'novelty'
  | 'aesthetic'
  | 'emergence'
  | 'interestingness'
  | 'constraint'
  | 'vocabulary'
  | 'codeStructure'
  | 'length'
  | 'intuition';

/** Score input context — everything a strategy might need. */
export interface ScoringInput {
  /** The creative output to score. */
  output: string;
  /** Domain hint for domain-specific heuristics. */
  domain?: Domain;
  /** Original prompt / constraint text. */
  prompt?: string;
  /** Previous outputs for novelty calculation. */
  previousOutputs?: string[];
  /** Persona context (swarm). */
  persona?: SwarmPersona;
  /** Evaluation criteria dimensions. */
  criteria?: string[];
  /** Optional LIR context for LIR-aware evaluation strategies. */
  lirContext?: LIREvaluationContext;
  /** Design constraints for aesthetic evaluation. */
  designConstraints?: DesignConstraints;
  /** Critic configuration for aesthetic evaluation. */
  criticConfig?: Partial<CriticConfig>;
  /** Optional cancellation signal for LLM-backed scoring paths. */
  signal?: AbortSignal;
}

/** Result from any scoring strategy. */
export interface ScoringResult {
  /** Overall score, always 0-1. */
  score: number;
  /** Per-dimension scores, all normalized 0-1. */
  dimensions: Partial<Record<ScoreDimension, number>>;
  /** Human-readable issues (from comprehensive strategy). */
  issues?: string[];
  /** The strategy name that produced this result. */
  strategy: string;
  /** Optional aesthetic violations (from aesthetic strategy). */
  violations?: Array<{ rule: string; severity: 'error' | 'warning' | 'info'; message: string }>;
  /** Optional report details (from creative/aesthetic strategies). */
  report?: unknown;
}

/** A scoring strategy plugin. */
export interface ScoringStrategy {
  /** Unique strategy name. */
  name: string;
  /**
   * Score the given input.
   * Must return a ScoringResult with score in [0, 1] and
   * dimension scores in [0, 1].
   */
  score(input: ScoringInput): ScoringResult | Promise<ScoringResult>;
}

// ---------------------------------------------------------------------------
// Built-in strategies
// ---------------------------------------------------------------------------

/** Comprehensive strategy — wraps CreativeEvaluator.assess(). */
class ComprehensiveStrategy implements ScoringStrategy {
  name = 'comprehensive';
  private readonly domainEvaluators = DomainEvaluatorRegistry.withDefaults();

  score(input: ScoringInput): ScoringResult {
    const result = CreativeEvaluator.assess(input.output, {
      evaluationCriteria: input.criteria,
      domain: input.domain,
    });

    const dimensions: Partial<Record<ScoreDimension, number>> = {
      technical: result.technicalScore,
      creative: result.creativeScore,
    };
    if (result.noveltyScore !== undefined) dimensions.novelty = result.noveltyScore;
    if (result.aestheticScore !== undefined) dimensions.aesthetic = result.aestheticScore;
    if (result.emergenceScore !== undefined) dimensions.emergence = result.emergenceScore;
    if (result.interestingnessScore !== undefined) dimensions.interestingness = result.interestingnessScore;

    const domainEvaluation = this.domainEvaluators.evaluate(input.domain, input.output);

    return {
      score: result.score,
      dimensions,
      issues: result.issues,
      strategy: this.name,
      report: domainEvaluation ? { domainEvaluation } : undefined,
    };
  }
}

/** Fast strategy — wraps HeuristicScorer.scoreOutput(). */
class FastStrategy implements ScoringStrategy {
  name = 'fast';

  score(input: ScoringInput): ScoringResult {
    const defaultPersona: SwarmPersona = {
      id: 'default',
      name: 'Default',
      displayName: 'Default',
      model: 'default',
      temperature: 0.7,
      maxTokens: 2000,
      systemPrompt: 'Evaluate creative code.',
      voice: 'neutral',
      thinkingStyle: 'balanced',
      votingBias: 'neutral',
      constraints: [],
      votingPower: 2,
    };

    const persona = input.persona ?? defaultPersona;
    const dims = HeuristicScorer.scoreOutput(
      input.output,
      persona,
      input.prompt ?? '',
      input.previousOutputs ?? [],
    );

    const weights = { constraint: 0.25, novelty: 0.20, length: 0.20, vocabulary: 0.20, codeStructure: 0.15 };
    const score =
      weights.constraint * dims.constraint +
      weights.novelty * dims.novelty +
      weights.length * dims.length +
      weights.vocabulary * dims.vocabulary +
      weights.codeStructure * dims.codeStructure;

    return {
      score,
      dimensions: {
        constraint: dims.constraint,
        novelty: dims.novelty,
        length: dims.length,
        vocabulary: dims.vocabulary,
        codeStructure: dims.codeStructure,
      },
      strategy: this.name,
    };
  }
}

/** Keyword strategy — wraps quickScore(). */
class KeywordStrategy implements ScoringStrategy {
  name = 'keyword';

  score(input: ScoringInput): ScoringResult {
    const raw = quickScore(input.output, input.domain ?? Domain.EMPTY);
    return {
      score: Math.max(0, Math.min(1, raw)),
      dimensions: {},
      strategy: this.name,
    };
  }
}

/** Fitness strategy — pure weighted-average of pre-computed dimension scores. */
class FitnessStrategy implements ScoringStrategy {
  name = 'fitness';

  score(input: ScoringInput): ScoringResult {
    const weights = (input as FitnessInput).weights ?? {};
    const scores = (input as FitnessInput).dimensionScores ?? {};
    const entries = Object.entries(scores).filter(([, val]) => val !== undefined) as [string, number][];

    let totalWeight = 0;
    let weightedSum = 0;
    for (const [dimension, score] of entries) {
      const weight = weights[dimension] ?? weights['default'] ?? 1;
      weightedSum += score * weight;
      totalWeight += weight;
    }
    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

    const details: Record<string, number> = {};
    for (const [key, value] of entries) {
      details[key] = value;
    }

    return { score, dimensions: details, strategy: this.name };
  }
}

/** Creative strategy — wraps CreativeEvaluator for detailed creative assessment. */
class CreativeStrategy implements ScoringStrategy {
  name = 'creative';

  score(input: ScoringInput): ScoringResult {
    const result = CreativeEvaluator.assess(input.output, {
      evaluationCriteria: ['creative', 'technical', 'novelty', 'emergence', 'interestingness'],
      domain: input.domain,
    });

    const dimensions: Partial<Record<ScoreDimension, number>> = {
      creative: result.creativeScore,
      technical: result.technicalScore,
    };
    if (result.noveltyScore !== undefined) dimensions.novelty = result.noveltyScore;
    if (result.emergenceScore !== undefined) dimensions.emergence = result.emergenceScore;
    if (result.interestingnessScore !== undefined) dimensions.interestingness = result.interestingnessScore;

    return {
      score: result.score,
      dimensions,
      issues: result.issues,
      strategy: this.name,
      report: {
        metrics: result.metrics,
        improvementTrajectory: (result as unknown as { improvementTrajectory?: number[] }).improvementTrajectory,
      },
    };
  }
}

/** Aesthetic strategy — wraps AestheticCritic for design-focused assessment. */
class AestheticStrategy implements ScoringStrategy {
  name = 'aesthetic';
  private critic = new AestheticCritic();
  private llmWired = false;

  /** Wire LLM for dual-path evaluation. Called lazily on first score. */
  private async wireLLM(): Promise<void> {
    if (this.llmWired) return;
    try {
      const { LLMClient } = await import('../llm/LLMClient.js');
      const llm = new LLMClient({ role: 'evaluator' });
      this.critic.setLLMClient(llm as unknown as import('../aesthetic/critics/LLMJudgeCritic.js').LLMClientLike);
      this.llmWired = true;
    } catch (err) {
      Logger.warn('ScoringEngine', 'Failed to wire LLM for dual-path evaluation:', err);
      this.llmWired = false; // Allow retry on next score() call
    }
  }

  async score(input: ScoringInput): Promise<ScoringResult> {
    // Ensure LLM is wired before scoring (handles errors internally)
    await this.wireLLM();
    const report = input.domain
      ? this.critic.critique(input.output, input.criticConfig, input.lirContext, input.domain)
      : this.critic.critique(input.output, input.criticConfig, input.lirContext);

    // Map aesthetic dimensions
    const dimensions: Partial<Record<ScoreDimension, number>> = {
      aesthetic: report.score,
    };

    return {
      score: report.score,
      dimensions,
      strategy: this.name,
      violations: report.violations,
      report: {
        passed: report.passed,
        timestamp: report.timestamp,
        ...(report as unknown as Record<string, unknown>),
      },
    };
  }
}

/** Extended input shape for the fitness strategy. */
export interface FitnessInput extends ScoringInput {
  dimensionScores?: Record<string, number | undefined>;
  weights?: Record<string, number | undefined>;
}

/** LLM strategy — uses an LLM to evaluate creative output quality. */
export class LLMScoringStrategy implements ScoringStrategy {
  name = 'llm';
  private llm: LLMClient;

  constructor(llm?: LLMClient) {
    this.llm = llm ?? new LLMClient({ role: 'evaluator' });
  }

  /**
   * Score with Result return — callers must explicitly handle LLM failures.
   * Use this instead of score() when silent fallback to 0.5 is undesirable.
   */
  async scoreWithResult(input: ScoringInput): Promise<Result<ScoringResult, LLMError>> {
    const criteria = input.criteria?.join(', ') ?? 'technical quality, creativity, novelty';
    const config = this.llm.getConfig();
    const provider = config.provider ?? (config.baseUrl ? detectProviderFromUrl(config.baseUrl) : undefined);
    const promptTier = resolvePromptTier(config.model, provider);
    const systemPrompt = tiered({
      full: `You are an expert creative artifact evaluator. Score the artifact against the given criteria.
${RUBRIC_BANDS}
	Return ONLY a JSON object with this exact structure:
	{
	  "score": <number 0-1>,
	  "technical": <number 0-1>,
	  "creative": <number 0-1>,
	  "novelty": <number 0-1>,
	  "reasoning": "<brief explanation>",
	  "suggestions": ["<suggestion1>", ...]
	}`,
      compact: `${RUBRIC_BANDS}
Reply with ONE line of flat JSON only: {"score":0.0,"technical":0.0,"creative":0.0,"novelty":0.0,"reasoning":"...","suggestions":["..."]}. No markdown. No nested objects.`,
    }, promptTier);

    const userPrompt = `Criteria: ${criteria}\nDomain: ${input.domain ?? 'general'}\n${input.prompt ? `Prompt: ${input.prompt}\n` : ''}Artifact:\n${input.output}`;

    try {
      const toolResult = await evaluatorCall(() => this.llm.generateWithToolLoop({
        systemPrompt,
        userPrompt,
        tools: EVALUATOR_TOOLS,
        toolExecutor: createGeneratorToolExecutor(String(input.domain ?? 'general')),
        maxIterations: 2,
        signal: input.signal,
        jsonMode: promptTier === 'compact',
      }));
      const responseText = toolResult.content;

      if (!toolResult.success || !responseText) {
        return err(new LLMError('LLM evaluation failed: no successful response', 'scoring-engine', undefined, true));
      }

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return err(new LLMError('LLM evaluation failed: could not parse LLM response', 'scoring-engine', undefined, true));
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const dimensions: Partial<Record<ScoreDimension, number>> = {};
      const parsedDimensions = typeof parsed.dimensions === 'object' && parsed.dimensions ? parsed.dimensions : {};
      const technical = typeof parsed.technical === 'number' ? parsed.technical : parsedDimensions.technical;
      const creative = typeof parsed.creative === 'number' ? parsed.creative : parsedDimensions.creative;
      const novelty = typeof parsed.novelty === 'number' ? parsed.novelty : parsedDimensions.novelty;
      if (typeof technical === 'number') dimensions.technical = Math.max(0, Math.min(1, technical));
      if (typeof creative === 'number') dimensions.creative = Math.max(0, Math.min(1, creative));
      if (typeof novelty === 'number') dimensions.novelty = Math.max(0, Math.min(1, novelty));

      return ok({
        score: Math.max(0, Math.min(1, typeof parsed.score === 'number' ? parsed.score : 0.5)),
        dimensions,
        strategy: this.name,
        issues: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        report: { reasoning: parsed.reasoning || '' },
      });
    } catch (error) {
      Logger.warn('ScoringEngine', 'LLM evaluation parse failed:', error);
      return err(new LLMError('LLM evaluation error', 'scoring-engine', undefined, true));
    }
  }

  /**
   * Interface-compliant score() — delegates to scoreWithResult().
   * Returns neutral 0.5 score on LLM failure for backward compatibility.
   * Prefer scoreWithResult() for callers that need explicit error handling.
   */
  async score(input: ScoringInput): Promise<ScoringResult> {
    const result = await this.scoreWithResult(input);
    return result.match(
      (scoringResult) => scoringResult,
      (error) => {
        Logger.warn('ScoringEngine', `LLM evaluation failed, using neutral score: ${error.message}`);
        return { score: 0.5, dimensions: {}, strategy: this.name, issues: [error.message] };
      },
    );
  }
}

// ---------------------------------------------------------------------------
// ScoringEngine
// ---------------------------------------------------------------------------

/**
 * ScoringEngine — THE scoring system for Sinter.
 *
 * Consolidated as part of Fix 8: Consolidate Triple Redundancy.
 * Now serves as a plugin host with Strategy pattern, supporting:
 * - comprehensive: Full assessment via CreativeEvaluator
 * - creative: Creative-focused assessment
 * - aesthetic: Design-focused assessment via AestheticCritic
 * - fast: Heuristic scoring
 * - keyword: Quick keyword-based scoring
 * - fitness: Weighted average of pre-computed scores
 */
export class ScoringEngine {
  private strategies = new Map<string, ScoringStrategy>();
  private defaultStrategyName: string;
  private readonly reliableLlmBoostEnabled: boolean;

  constructor(defaultStrategy: string = 'comprehensive', llm?: LLMClient) {
    // Register built-in strategies
    this.register(new ComprehensiveStrategy());
    this.register(new FastStrategy());
    this.register(new KeywordStrategy());
    this.register(new FitnessStrategy());

    // New strategies from consolidated systems
    this.register(new CreativeStrategy());
    this.register(new AestheticStrategy());

    // LLM-based evaluation strategy
    this.register(new LLMScoringStrategy(llm));

    // Legacy aliases (backward-compatible names from EvaluationFramework)
    this.registerAlias('detailed', 'comprehensive');
    this.registerAlias('heuristic', 'fast');
    this.registerAlias('fast', 'keyword');

    this.defaultStrategyName = defaultStrategy;
    // Reliable scoring runs inside interactive generation loops. Keep that path
    // local by default so a missing or slow evaluator cannot silently stall the
    // operator journey; callers can opt into the LLM boost explicitly.
    this.reliableLlmBoostEnabled = Boolean(llm)
      || defaultStrategy === 'llm'
      || process.env.LIMINAL_SCORE_LLM_BOOST === 'true';
  }

  /** Register an alias name that maps to an existing strategy. */
  private registerAlias(alias: string, targetName: string): void {
    const target = this.strategies.get(targetName);
    if (!target) return;
    this.strategies.set(alias, target);
  }

  /** Register a custom scoring strategy. */
  register(strategy: ScoringStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /** Unregister a strategy by name. */
  unregister(name: string): boolean {
    return this.strategies.delete(name);
  }

  /** Get a registered strategy by name. */
  getStrategy(name: string): ScoringStrategy | undefined {
    return this.strategies.get(name);
  }

  /** List all registered strategy names. */
  listStrategies(): string[] {
    return [...this.strategies.keys()];
  }

  /**
   * Check if the engine has a registered strategy.
   */
  hasStrategy(name: string): boolean {
    return this.strategies.has(name);
  }

  /**
   * Score using a specific strategy.
   * Falls back to default if the named strategy is not found.
   *
   * NOTE: For feedback-driven systems that need reliable score spread, use
   * scoreReliable() instead — it adds a minimum coverage gate that avoids
   * the 0.68 dead zone. This method returns raw strategy results as-is.
   */
  async score(input: ScoringInput, strategyName?: string): Promise<ScoringResult> {
    const name = strategyName ?? this.defaultStrategyName;
    const strategy = this.strategies.get(name);

    if (!strategy) {
      throw new Error(`Unknown scoring strategy: "${name}". Available: ${this.listStrategies().join(', ')}`);
    }

    let result = strategy.score(input);
    result = result instanceof Promise ? await result : result;

    return result;
  }

  /**
   * Convenience: score a plain string with the default strategy.
   */
  async quick(input: string): Promise<number> {
    const result = await this.score({ output: input });
    return result.score;
  }

  /**
   * Score with creative focus.
   */
  async scoreCreative(input: string, domain?: Domain): Promise<ScoringResult> {
    return this.score({ output: input, domain }, 'creative');
  }

  /**
   * Score with aesthetic focus.
   */
  async scoreAesthetic(
    input: string,
    criticConfig?: Partial<CriticConfig>,
    lirContext?: LIREvaluationContext,
    domain?: Domain,
  ): Promise<ScoringResult> {
    return this.score({ output: input, criticConfig, lirContext, domain }, 'aesthetic');
  }

  /** Set the default strategy. */
  setDefault(name: string): void {
    if (!this.strategies.has(name)) {
      throw new Error(`Unknown scoring strategy: "${name}". Available: ${this.listStrategies().join(', ')}`);
    }
    this.defaultStrategyName = name;
  }

  /**
   * Get the default strategy name.
   */
  getDefault(): string {
    return this.defaultStrategyName;
  }

  /**
   * Score with reliable dimension coverage (minimum 6 dimensions).
   * Starts with the comprehensive strategy, then boosts dimension coverage via
   * the LLM strategy if fewer than 6 dimensions were computed. This avoids the
   * "0.68 dead zone" where sparse dimensions produce clumped scores.
   *
   * Use this for feedback-driven systems (swarm, compost, vocabulary evolution)
   * where score spread is critical for effective selection pressure.
   */
  async scoreReliable(input: ScoringInput): Promise<ScoringResult> {
    const result = await this.score(input, 'comprehensive');

    const MIN_DIMENSIONS = 6;
    const dimensionCount = Object.keys(result.dimensions).length;

    if (dimensionCount >= MIN_DIMENSIONS) {
      return result; // Already sufficient coverage
    }

    if (!this.reliableLlmBoostEnabled) {
      return result;
    }

    // Boost coverage via LLM strategy only when explicitly enabled.
    const llmStrategy = this.strategies.get('llm');
    if (!llmStrategy) {
      return result; // No LLM available, return as-is
    }

    if (typeof LLMClient.isConfigured === 'function' && !LLMClient.isConfigured()) {
      return result;
    }

    const boostTimeoutMs = reliableScoreBoostTimeoutMs();
    const timeoutController = createTimeoutController(input.signal, boostTimeoutMs);

    try {
      const boostInput = timeoutController.signal
        ? { ...input, signal: timeoutController.signal }
        : input;
      const llmResult = llmStrategy.score(boostInput);
      const resolved = llmResult instanceof Promise
        ? await withScoringTimeout(llmResult, boostTimeoutMs)
        : llmResult;

      return {
        ...resolved,
        dimensions: { ...result.dimensions, ...resolved.dimensions },
        strategy: `${result.strategy}+llm`,
        issues: [...(result.issues ?? []), ...(resolved.issues ?? [])],
      };
    } catch (err) {
      Logger.warn('ScoringEngine', 'LLM score boost failed, returning heuristic result:', err instanceof Error ? err.message : err);
      return {
        ...result,
        issues: [...(result.issues ?? []), `LLM score boost unavailable: ${err instanceof Error ? err.message : String(err)}`],
      };
    } finally {
      timeoutController.cleanup();
    }
  }
}

function reliableScoreBoostTimeoutMs(): number {
  const configured = Number.parseInt(process.env.LIMINAL_SCORING_LLM_BOOST_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return process.env.NODE_ENV === 'test' ? 1_000 : 8_000;
}

// Bound for the rendered-evidence evaluator call. Without it, a slow or hanging
// evaluator endpoint compounds through RetryManager (6 attempts x 120s provider
// timeout + 62s backoff ≈ 13min worst case) — the observed multi-minute hydra
// stalls. On timeout the caller falls back to legacy scoring (8s-bounded).
export function renderedEvidenceScoreTimeoutMs(
  localEvaluator = false,
  actionTimeoutMs?: number,
): number {
  if (actionTimeoutMs !== undefined) return actionTimeoutMs;
  const configured = Number.parseInt(process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  if (process.env.NODE_ENV === 'test') return 1_000;
  // Local inference (ollama/lmstudio on the local host) prefills large vision
  // payloads far slower than cloud endpoints — the 45s default produced false
  // 'scorer' failures (measured: gemma4 answered the same artifact in 7.5s warm,
  // but timed out inside the full scoring payload at 45s).
  // Cloud evaluators get TIMEOUT_EVALUATOR_MS (180s). The old 45s cloud default
  // timed out glm-5.3-flash on every run (#709): a reasoning-capable judge reads
  // the screenshot and the source, then writes dimension scores and repair
  // advice, and Hermes judges already missed 45s in 4 of 10 cells (2026-11-10).
  // 180s clears the 120s local full-payload budget, stays well under the old
  // 300s undici cutoff, and the call is still bounded, so a hung endpoint costs
  // three minutes, not the multi-minute retry stall. Override with
  // LIMINAL_RENDERED_SCORE_TIMEOUT_MS or options.timeoutMs.
  return localEvaluator ? 120_000 : TIMEOUT_EVALUATOR_MS;
}

/**
 * Evaluators that get the long scoring budget: local inference, and CLI seats
 * (Hermes/Claude/Codex subprocesses), which pay a process launch plus any Hermes
 * update-fence wait before the model call. Live Hermes vision judges hit the 45s
 * cloud budget with no response in 4 of 10 rerun cells (2026-11-10).
 */
export function isSlowEvaluatorProvider(provider: string | undefined): boolean {
  return ['ollama', 'lmstudio', 'cli'].includes((provider ?? '').toLowerCase());
}

const RENDER_MEASURE_SCORE_MULTIPLIER = 0.6;

function renderMeasureSummary(measure: RenderMeasure): string {
  const std = measure.brightnessStd === undefined ? 'n/a' : measure.brightnessStd.toFixed(2);
  const clipped = measure.clippedHighlightFraction === undefined
    ? '' : `, clipped=${measure.clippedHighlightFraction.toFixed(3)}`;
  const decay = measure.temporalDecay ? ', decays-after-capture' : '';
  return `verdict=${measure.verdict}, mean=${measure.meanLuminance.toFixed(3)}, bright=${measure.brightFraction.toFixed(3)}, dark=${measure.darkFraction.toFixed(3)}${clipped}, std=${std}${decay}`;
}

function repairAdviceForRenderMeasure(measure: RenderMeasure) {
  const issue = `Rendered frame measured ${measure.verdict}: ${renderMeasureSummary(measure)}`;
  const fix = measure.verdict === 'washout'
    ? 'Reduce additive brightness, lower lightening blends, and raise foreground/background contrast.'
    : measure.verdict === 'highlight-clipped'
      ? 'Reduce concentrated additive highlights while preserving the existing composition, palette, and structural identity.'
    : measure.verdict === 'too-dark'
      ? 'Raise subject luminance, add visible focal highlights, and avoid crushed dark backgrounds.'
      : 'Increase luminance separation between subject and background before retrying.';
  return {
    issue,
    fix,
    constraint: 'Rendered output must pass objective luminance measurement as well as evaluator judgment.',
  };
}

function isNearFlatMeasure(measure: RenderMeasure, hasPixelScreenshot: boolean): boolean {
  return hasPixelScreenshot
    && measure.brightnessStd !== undefined
    && Number.isFinite(measure.brightnessStd)
    && measure.brightnessStd < NEAR_FLAT_MAX_STD;
}

function repairAdviceForNearFlat(measure: RenderMeasure) {
  return {
    issue: `Rendered frame is blank or near-flat: ${renderMeasureSummary(measure)}`,
    fix: 'Ensure visible foreground geometry renders with clear luminance contrast against the background across the frame.',
    constraint: `Rendered output must contain visible structure (brightness stddev >= ${NEAR_FLAT_MAX_STD}) before aesthetic evaluation.`,
  };
}

/** The judge's brief-difficulty rating: an integer 1-10, or undefined when the reply gave no usable number. */
export function parseBriefDifficulty(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(10, Math.round(n)));
}

/**
 * An evaluation that never produced a verdict. The 0.5 is a neutral placeholder, never a grade:
 * scoreState + confidence 0 keep it out of admission, ranking and archives (Sol L3-02/L3-03).
 */
function unscoredVerdict(
  measure: RenderMeasure | undefined,
  failureClass: 'parse' | 'scorer',
  unscoredReason: string,
  issue: string,
): GenerationEvaluation {
  return applyRenderMeasurePenalty({
    score: 0.5,
    confidence: 0,
    failureClass,
    scoreState: 'unscored',
    unscoredReason,
    repairAdvice: {
      issue,
      fix: 'Retry the evaluation or verify the evaluator model returns the requested JSON verdict',
      constraint: 'Evaluator must return a parseable JSON object with a score and a confidence',
    },
  }, measure);
}

/** Tells the judge how much piece time the late frame actually covers, so a cut-short arc is not read as the finished piece. */
function arcNote(evidence: RenderEvidence): string {
  const arc = evidence.arc;
  if (!arc) return '';
  const short = arc.reachedMs < arc.horizonMs;
  return ` Late frame at piece time ${Math.round(arc.reachedMs)} of ${Math.round(arc.horizonMs)} ms${short ? ' (the arc budget ran out before the horizon: judge only what was seen)' : ''}.`;
}

function applyRenderMeasurePenalty(result: GenerationEvaluation, measure: RenderMeasure | undefined): GenerationEvaluation {
  if (!measure) return result;
  // A placeholder is not a grade: no multiplier, floor or cap may act on it.
  if (result.scoreState === 'unscored') return { ...result, renderMeasure: measure };
  if (measure.verdict === 'ok') {
    const vs = measure.valueStructure;
    if (!vs?.overmixed) {
      const live = measure.glitchLiveness;
      // Deterministic evidence beats a vision judge that reads glitch as corrupted: an alive frame is never in the broken band.
      if (live?.alive && result.score < ALIVE_GLITCH_SCORE_FLOOR) {
        return {
          ...result,
          score: ALIVE_GLITCH_SCORE_FLOOR,
          reasoning: [result.reasoning, `Alive glitch (${glitchLivenessSummary(live)}): saturated, structured and moving is not broken; score lifted from ${result.score.toFixed(2)} to the ${ALIVE_GLITCH_SCORE_FLOOR} broken-band line.`].filter(Boolean).join(' '),
          renderMeasure: measure,
        };
      }
      const fc = measure.frameCoverage;
      if (fc?.sparse) {
        // Advice only: the score is unchanged, so the judge's reasoning stays the judge's own words. The gallery
        // archives that reasoning as quoted judge comments for the next brief, which must never quote this warning
        // as praise (cli-gallery-next-brief). The repair turn reads repairAdvice and renderMeasure.
        return {
          ...result,
          repairAdvice: result.repairAdvice ?? sparseFrameRepairAdvice(fc),
          renderMeasure: measure,
        };
      }
      return { ...result, renderMeasure: measure };
    }
    // Painter's check: overmixed / lost value structure. Cap, not reject, so a
    // strong judged piece can still land just under the creative floor.
    return {
      ...result,
      score: Math.min(result.score, OVERMIXED_SCORE_CAP),
      repairAdvice: overmixedRepairAdvice(vs),
      reasoning: [result.reasoning, `Overmixed / lost value structure (${valueStructureSummary(vs)}); score capped at ${OVERMIXED_SCORE_CAP}.`].filter(Boolean).join(' '),
      renderMeasure: measure,
    };
  }
  const measuredLine = `Measured render penalty applied: ${renderMeasureSummary(measure)}.`;
  return {
    ...result,
    score: Math.max(0, Math.min(1, result.score * RENDER_MEASURE_SCORE_MULTIPLIER)),
    repairAdvice: repairAdviceForRenderMeasure(measure),
    reasoning: [result.reasoning, measuredLine].filter(Boolean).join(' '),
    renderMeasure: measure,
  };
}

function createTimeoutController(parent: AbortSignal | undefined, timeoutMs: number): { signal?: AbortSignal; cleanup: () => void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: parent, cleanup: () => undefined };
  }

  const controller = new AbortController();
  let cleaned = false;
  const onParentAbort = () => {
    controller.abort(parent?.reason ?? new Error('Scoring aborted'));
  };
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM call timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  };

  if (parent?.aborted) {
    onParentAbort();
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true });
  }

  return { signal: controller.signal, cleanup };
}

// A judge stall is rare (3 of 238 glm-5.3-flash calls on 2026-11-16; p90
// 70 s), so one fresh attempt usually saves the score. Only a timeout retries.
async function callWithOneTimeoutRetry<T>(
  call: (signal?: AbortSignal) => Promise<T>, attemptTimeoutMs: number, deadlineAt?: number,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const timeoutMs = deadlineAt === undefined ? attemptTimeoutMs : Math.min(attemptTimeoutMs, deadlineAt - Date.now());
    if (timeoutMs <= 0) throw new Error('Rendered evidence evaluation deadline already spent');
    const controller = createTimeoutController(undefined, timeoutMs);
    try {
      const pending = call(controller.signal);
      // The aborted call still rejects after the timeout wins; observe it so
      // it cannot crash the process.
      void pending.catch(() => undefined);
      return await withScoringTimeout(pending, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 2 || !/timed out after \d+ms/.test(message)) throw error;
      Logger.warn('ScoringEngine', `Evaluator timed out after ${timeoutMs}ms; retrying once`);
    } finally {
      controller.cleanup();
    }
  }
}

async function withScoringTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Rendered-evidence scoring entrypoint (DF3 Phase 1)
// ---------------------------------------------------------------------------

/**
 * Judge-independent gates every rendered-evidence scorer runs before spending a
 * judge call: missing infra, failed render, and human-perception failures.
 */
async function gateRenderedEvidence(evidence: RenderEvidence, domain?: string): Promise<{
  readonly verdict?: GenerationEvaluation;
  readonly renderMeasure?: RenderMeasure;
}> {
  if (evidence.rendered === false || (domain === 'revideo' && evidence.rendered !== true)) {
    return { verdict: { score: 0, confidence: 0, failureClass: 'render',
      reasoning: 'Revideo scene not rendered; visual scoring excluded.' } };
  }
  if (evidence.infraUnavailable) {
    return { verdict: { score: 0, confidence: 0, failureClass: 'infra' } };
  }

  if (evidence.candidateFailure) {
    return { verdict: {
      score: 0,
      confidence: 1,
      failureClass: 'render',
      repairAdvice: {
        issue: evidence.failure
          ? `The artwork failed to render: ${evidence.failure.slice(0, 500)}`
          : 'Rendered output failed to produce a valid artifact (blank screen, compile error, or timeout)',
        fix: 'Fix syntax errors, ensure all required imports/libraries are loaded, and verify the code runs without runtime exceptions.',
        constraint: 'Return a complete, runnable artifact.',
      },
    } };
  }

  // Sol L3-08: an audio piece's frame is the player shell, not the work; its pixels never grade the music.
  const hasPixelScreenshot = Boolean(evidence.screenshot || evidence.lateScreenshot);
  const renderMeasure = domain === 'tone' || domain === 'strudel' ? undefined : await measureRenderEvidence(evidence);
  const perceptionReport = domain ? await evaluateRenderEvidencePerception(evidence, domain) : undefined;
  if (perceptionReport && !perceptionReport.passed) {
    const issueIds = perceptionReport.issues.map(issue => issue.id).join(', ');
    const measuredAdvice = renderMeasure && renderMeasure.verdict !== 'ok'
      ? repairAdviceForRenderMeasure(renderMeasure)
      : (renderMeasure && isNearFlatMeasure(renderMeasure, hasPixelScreenshot)
        ? repairAdviceForNearFlat(renderMeasure)
        : undefined);
    return { renderMeasure, verdict: {
      score: 0,
      confidence: 1,
      failureClass: 'render',
      repairAdvice: measuredAdvice ?? {
        issue: `Rendered output failed human perception checks: ${issueIds}`,
        fix: 'Revise the artifact so the rendered output is visible, audible, readable, or viewable for humans as appropriate for the domain.',
        constraint: 'Runtime evidence must satisfy human perception ergonomics before aesthetic evaluation.',
      },
      reasoning: perceptionReport.issues.map(issue => issue.message).join(' '),
      renderMeasure,
    } };
  }
  // #1744: Gate near-black (too-dark) and blank/near-flat (brightnessStd < 4)
  // frames before spending a judge LLM call — even when domain is omitted.
  if (renderMeasure && renderMeasure.verdict === 'too-dark') {
    return { renderMeasure, verdict: {
      score: 0,
      confidence: 1,
      failureClass: 'render',
      repairAdvice: repairAdviceForRenderMeasure(renderMeasure),
      reasoning: `Rendered frame is near-black / too dark (${renderMeasureSummary(renderMeasure)}).`,
      renderMeasure,
    } };
  }
  if (renderMeasure && isNearFlatMeasure(renderMeasure, hasPixelScreenshot)) {
    return { renderMeasure, verdict: {
      score: 0,
      confidence: 1,
      failureClass: 'render',
      repairAdvice: repairAdviceForNearFlat(renderMeasure),
      reasoning: `Rendered frame is blank or near-flat (std=${renderMeasure.brightnessStd!.toFixed(2)} < ${NEAR_FLAT_MAX_STD}): ${renderMeasureSummary(renderMeasure)}.`,
      renderMeasure,
    } };
  }
  return { renderMeasure };
}

/**
 * Score rendered evidence from a headless render pass.
 *
 * Fast paths:
 *   - infraUnavailable → degraded evaluation (score 0, confidence 0, failureClass 'infra')
 *   - candidateFailure → render failure (score 0, confidence 1, failureClass 'render')
 *
 * Otherwise, uses an LLM-based evaluator when available, or a neutral fallback.
 */
async function defaultEvaluatorClient(): Promise<LLMClient | undefined> {
  try {
    // Role configs load async into a static cache; without this the
    // constructor falls back to defaults and tier/timeout resolution
    // sees model 'auto' instead of the real evaluator.
    await LLMClient.loadRoles();
    return new LLMClient({ role: 'evaluator' });
  } catch {
    return undefined;
  }
}

export async function scoreRenderedEvidence(
  evidence: RenderEvidence,
  code: string,
  brief: string,
  llmClient?: LLMClient,
  domain?: string,
  options: {
    readonly judgmentProfile?: CreativeJudgmentProfile;
    readonly timeoutMs?: number;
    readonly deadlineAt?: number;
    /** A decision model (Liquid AI d1) scores alone in place of the LLM judge. */
    readonly decisionModel?: DecisionModelClient;
  } = {},
): Promise<GenerationEvaluation> {
  if (options.decisionModel) {
    return scoreRenderedEvidenceWithDecisionModel(evidence, brief, options.decisionModel, domain);
  }
  const gate = await gateRenderedEvidence(evidence, domain);
  if (gate.verdict) return gate.verdict;
  const renderMeasure = gate.renderMeasure;

  const llm = llmClient ?? await defaultEvaluatorClient();

  if (!llm) {
    return applyRenderMeasurePenalty({
      score: 0.5,
      confidence: 0,
      failureClass: 'scorer',
      scoreState: 'unscored',
      unscoredReason: 'no evaluator LLM is available for rendered-evidence scoring',
      repairAdvice: {
        issue: 'Evaluator LLM is unavailable for rendered-evidence scoring',
        fix: 'Set ANTHROPIC_API_KEY (or SINTER_LLM_BASE_URL / SINTER_LLM_MODEL for a custom endpoint), or switch to legacy evaluation mode',
        constraint: 'Evaluator LLM must be reachable for rendered-evidence scoring',
      },
    }, renderMeasure);
  }

  // Tiered judge prompt: frontier models get the rich rubric + nested repair
  // structure; small/local models get a flat, banded, one-line-JSON variant
  // (nested objects and anchor-free rubrics measurably break 12B-class judges:
  // gemma4 parsed 6/8 and ceiling-pinned 0.95 before this).
  const evalConfig = llm.getConfig();
  const evalProvider = evalConfig.provider
    ?? (evalConfig.baseUrl ? detectProviderFromUrl(evalConfig.baseUrl) : undefined);
  const promptTier = resolvePromptTier(evalConfig.model, evalProvider);
  const judgmentProfile = options.judgmentProfile ?? loadCreativeJudgmentProfile();
  const judgmentWeights = CREATIVE_JUDGMENT_DIMENSIONS
    .map(dimension => `${dimension}=${judgmentProfile.weights[dimension].toFixed(4)}`)
    .join(', ');
  const learnedGuidance = judgmentProfile.guidance.join('\n- ');
  const systemPrompt = tiered({
    full: `You are an expert creative artifact evaluator. Evaluate the rendered output of the provided code against the brief.
${RUBRIC_BANDS}
${PRIMORDIAL_CRAFT_RUBRIC}
${PERCEPTUAL_ANTI_PROXY_RULES}
Active learned weights: ${judgmentWeights}
Learned hierarchy guidance: ${learnedGuidance || 'none'}
Return ONLY a JSON object with this exact structure:
{
  "score": <number 0-1>,
  "confidence": <number 0-1>,
  "dimensions": {"cohesion":0.0,"structuralDepth":0.0,"spatialEmbodiment":0.0,"materiality":0.0,"motionPurpose":0.0,"composition":0.0,"palette":0.0,"finish":0.0},
  "reasoning": "<brief explanation>",
  "difficulty": <integer 1-10>,
  "repairAdvice": {
    "issue": "<one-sentence description of the problem>",
    "fix": "<one-sentence instruction for how to fix it>",
    "constraint": "<one-sentence boundary condition>"
  }
}
"difficulty" rates the BRIEF, not the artwork: how hard it is to realise well in this medium (1 = trivial, 5 = needs real craft, 10 = at the edge of what the medium can do). Rate it the same whether this attempt succeeded or failed.
Include repairAdvice whenever score is below 0.9. Below 0.7 it is a repair (what is broken).
For 0.7-0.89 it is an ELEVATION: issue names the single weakest craft dimension (composition, depth, light/value, palette, motion, negative space, or finish) and fix gives one concrete change that would lift the work into the 0.90 band.
If score is 0.9 or above, omit repairAdvice or set it to null.
If an image is attached, evaluate the visible rendered artifact first and use the code only to diagnose repair advice.`,
    compact: `Score the rendered artifact (image attached) against the brief.
${RUBRIC_BANDS}
${PRIMORDIAL_CRAFT_RUBRIC}
${PERCEPTUAL_ANTI_PROXY_RULES}
Active learned weights: ${judgmentWeights}
Learned hierarchy guidance: ${learnedGuidance || 'none'}
Reply with ONE line of flat JSON, nothing else:
{"score":0.0,"confidence":0.0,"cohesion":0.0,"structuralDepth":0.0,"spatialEmbodiment":0.0,"materiality":0.0,"motionPurpose":0.0,"composition":0.0,"palette":0.0,"finish":0.0,"reasoning":"...","difficulty":5,"issue":"...","fix":"..."}
difficulty is an integer 1-10 rating the BRIEF (not the artwork): how hard it is to realise well in this medium; 1 trivial, 10 at the edge of the medium. Rate it the same whether this attempt succeeded or failed.
issue and fix whenever score < 0.9: name the weakest craft dimension (composition, depth, light, palette, motion, space, finish) and one concrete change to lift it. No nested objects. No markdown.`,
  }, promptTier);

  // TEXT-JUDGE CONTRACT (M-20261008-14): when the evaluator cannot see images
  // (glm-5.3 flagship class — probe evidence: api.z.ai paas/v4 rejects image
  // content with error 1210, and the anthropic wire delivers an image the
  // model cannot access), the rendered frames are summarized into a
  // deterministic MEASURED descriptor instead. The old path dropped the
  // images and scored from code alone, silently; now the judge's input is
  // explicit about what it receives. Vision-capable evaluators are unaffected.
  // Hermes seats (cli://hermes/...) attach the frames through the gateway
  // (CliProvider HERMES_IMAGE_PATCH). The other CLI seats (cli://codex, ...)
  // pass a text prompt only, so a vision model behind one of them is still a
  // text-only judge.
  const evalBaseUrl = String(evalConfig.baseUrl ?? '');
  const evalVisionCapable = CapabilityRegistry.supportsVision(String(evalConfig.model ?? ''))
    && (!evalBaseUrl.startsWith('cli://') || evalBaseUrl.startsWith('cli://hermes/'));
  const textOnlyJudge = !evalVisionCapable;
  let frameDescriptorNote = '';
  if (textOnlyJudge && evidence.screenshot) {
    const frameParts: string[] = [];
    try {
      frameParts.push(`Early frame:\n${await frameDescriptorText(Buffer.from(evidence.screenshot.dataBase64, 'base64'))}`);
    } catch { /* descriptor stays absent rather than guessed */ }
    if (evidence.lateScreenshot) {
      try {
        frameParts.push(`Late frame:\n${await frameDescriptorText(Buffer.from(evidence.lateScreenshot.dataBase64, 'base64'))}`);
      } catch { /* ditto */ }
    }
    if (frameParts.length > 0) {
      frameDescriptorNote = `\nMEASURED FRAME DESCRIPTOR (deterministic pixel statistics of the rendered frames — the screenshots themselves are NOT visible to a text-only judge):\n${frameParts.join('\n\n')}`;
    }
  }
  const notVisibleNote = '\nScreenshot: NOT visible to this text-only judge (image input withheld).';
  const screenshotNote = evidence.screenshot
    ? (textOnlyJudge ? notVisibleNote : `\nScreenshot: attached ${evidence.screenshot.mimeType}${evidence.screenshot.width && evidence.screenshot.height ? ` ${evidence.screenshot.width}x${evidence.screenshot.height}` : ''}`)
    : '\nScreenshot: not available; evaluate from code and timing only.';
  const lateScreenshotNote = evidence.lateScreenshot
    ? (textOnlyJudge ? notVisibleNote.replace('Screenshot', 'Late screenshot') : `\nLate screenshot: attached ${evidence.lateScreenshot.mimeType}${evidence.lateScreenshot.width && evidence.lateScreenshot.height ? ` ${evidence.lateScreenshot.width}x${evidence.lateScreenshot.height}` : ''}`)
    : '\nLate screenshot: not available.';
  const renderMeasureNote = renderMeasure
    ? `\nRender measure: ${renderMeasureSummary(renderMeasure)}${renderMeasure.glitchLiveness?.alive ? `\nMeasured alive glitch (${glitchLivenessSummary(renderMeasure.glitchLiveness)}): saturated, structured and moving; do not call it broken.` : ''}${renderMeasure.frameCoverage?.sparse ? `\nMeasured sparse frame coverage (${frameCoverageSummary(renderMeasure.frameCoverage)}): visible subject covers under ${(SPARSE_COVERAGE_MIN_SHARE * 100).toFixed(0)}% of the canvas.` : ''}`
    : '';
  const audioNote = evidence.audio
    ? `\nMeasured audio: ${evidence.audio.success ? 'audible' : 'inaudible'}; peak ${evidence.audio.peakAmplitude ?? 'n/a'}; rms ${evidence.audio.rmsAmplitude ?? 'n/a'}${(evidence.audio.peakAmplitude ?? 0) > 1 ? ' (peak above 1.0: clipping)' : ''}`
    : '';
  const sourcePaletteNote = sourcePaletteSummary(code);
  const userPrompt = `Brief: ${brief}\nCode:\n${code}\nTiming: ${evidence.timingMs}ms${arcNote(evidence)}${audioNote}${screenshotNote}${lateScreenshotNote}${renderMeasureNote}${sourcePaletteNote}${frameDescriptorNote}`;

  const localEvaluator = isSlowEvaluatorProvider(evalProvider);
  const scoreTimeoutMs = renderedEvidenceScoreTimeoutMs(localEvaluator, options.timeoutMs);
  const scoreStartedAt = Date.now();
  try {
    const evaluatorImages = evidence.screenshot && !textOnlyJudge
      ? await boundedEvaluatorImages([{
          mimeType: evidence.screenshot.mimeType,
          dataBase64: evidence.screenshot.dataBase64,
          width: evidence.screenshot.width,
          height: evidence.screenshot.height,
          label: 'rendered-artifact',
        }, ...(evidence.lateScreenshot ? [{
          mimeType: evidence.lateScreenshot.mimeType,
          dataBase64: evidence.lateScreenshot.dataBase64,
          width: evidence.lateScreenshot.width,
          height: evidence.lateScreenshot.height,
          label: 'rendered-artifact-late',
        }] : [])])
      : [];
    const response = await callWithOneTimeoutRetry((signal) => (evaluatorImages.length > 0
      ? evaluatorCall(() => llm.generateWithImages(systemPrompt, userPrompt, evaluatorImages, signal, true, { jsonMode: true }))
      : evaluatorCall(() => llm.generate(systemPrompt, userPrompt, signal, true, undefined, { jsonMode: true }))), scoreTimeoutMs, options.deadlineAt);
    Logger.info(
      'ScoringEngine',
      `[stage-timing] rendered-evidence-score: ${Date.now() - scoreStartedAt}ms (screenshot: ${evidence.screenshot ? `${Math.round(evidence.screenshot.dataBase64.length / 1024)}KB` : 'none'})`,
    );
    // A transport that says it failed (for example a reply cut at the token cap)
    // never yields a verdict, whatever text came back with it (Sol L3-02).
    if (response.success === false) {
      return unscoredVerdict(renderMeasure, 'scorer',
        `evaluator ${String(evalConfig.model ?? 'model')} reply was unsuccessful${response.error ? `: ${response.error}` : ''}`,
        'Evaluator reply was incomplete or failed at the transport');
    }
    const jsonObject = firstJsonObject(response.code);
    if (!jsonObject) {
      return unscoredVerdict(renderMeasure, 'parse',
        `evaluator ${String(evalConfig.model ?? 'model')} reply held no JSON object`,
        'Evaluator LLM response could not be parsed');
    }
    const parsed = parseJudgeJson(jsonObject);
    const rawDimensions = parsed.dimensions && typeof parsed.dimensions === 'object'
      ? parsed.dimensions as Record<string, unknown>
      : parsed as Record<string, unknown>;
    const dimensionEntries = CREATIVE_JUDGMENT_DIMENSIONS.map(dimension => (
      [dimension, typeof rawDimensions[dimension] === 'number' && Number.isFinite(rawDimensions[dimension])
        ? Math.max(0, Math.min(1, rawDimensions[dimension] as number))
        : undefined]
    ));
    const hasAllDimensions = dimensionEntries.every(([, value]) => value !== undefined);
    const dimensionScores = hasAllDimensions
      ? Object.fromEntries(dimensionEntries) as CreativeJudgmentScores
      : undefined;
    const hasAggregate = typeof parsed.score === 'number' && Number.isFinite(parsed.score);
    // Structurally valid JSON is not a verdict: with no aggregate score and no
    // complete dimensions, or no usable confidence, nothing was judged (Sol L3-02).
    if ((!hasAggregate && !dimensionScores)
      || typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)) {
      return unscoredVerdict(renderMeasure, 'parse',
        `evaluator ${String(evalConfig.model ?? 'model')} returned JSON without a usable ${hasAggregate || dimensionScores ? 'confidence' : 'score'}`,
        'Evaluator reply was valid JSON but carried no verdict');
    }
    const rawScore = hasAggregate ? Math.max(0, Math.min(1, parsed.score as number)) : 0;
    const score = dimensionScores
      ? scoreCreativeJudgment(dimensionScores, judgmentProfile)
      : rawScore;
    const confidence = Math.max(0, Math.min(1, parsed.confidence));

    // Compact tier returns flat issue/fix; normalize to the nested shape.
    const rawAdvice = parsed.repairAdvice
      ?? ((typeof parsed.issue === 'string' || typeof parsed.fix === 'string')
        ? { issue: parsed.issue, fix: parsed.fix, constraint: undefined }
        : undefined);
    const repairAdvice =
      rawAdvice && typeof rawAdvice === 'object' && rawAdvice !== null
        ? {
            issue: typeof rawAdvice.issue === 'string' ? rawAdvice.issue : 'The artifact did not meet the brief.',
            fix: typeof rawAdvice.fix === 'string' ? rawAdvice.fix : 'Revise the code to better match the brief.',
            constraint: typeof rawAdvice.constraint === 'string' ? rawAdvice.constraint : 'Return a complete, runnable artifact.',
          }
        : undefined;

    return applyRenderMeasurePenalty({
      score,
      confidence,
      failureClass: 'none',
      repairAdvice,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
      ...(parseBriefDifficulty(parsed.difficulty) !== undefined ? { difficulty: parseBriefDifficulty(parsed.difficulty) } : {}),
      dimensionScores,
      calibrationDigest: dimensionScores ? judgmentProfile.profileDigest : undefined,
    }, renderMeasure);
  } catch (error) {
    Logger.warn('ScoringEngine', `Rendered evidence LLM scoring failed after ${Date.now() - scoreStartedAt}ms:`, error instanceof Error ? error.message : error);
    // A slow reasoning judge (glm-5.3 at 32k maxTokens) blew the budget on
    // every run while the advice blamed the network. Name the real cause.
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out after \d+ms/.test(message)) {
      return applyRenderMeasurePenalty({
        score: 0.5,
        confidence: 0,
        failureClass: 'scorer',
        // The 0.5 is a neutral placeholder, not a verdict. Say so in the record.
        scoreState: 'unscored',
        unscoredReason: `evaluator ${String(evalConfig.model ?? 'model')} timed out after ${scoreTimeoutMs}ms (LIMINAL_RENDERED_SCORE_TIMEOUT_MS)`,
        repairAdvice: {
          issue: `Evaluator ${String(evalConfig.model ?? 'model')} did not answer within ${scoreTimeoutMs}ms`,
          fix: 'Bind a faster evaluator seat (a flash/vision model such as glm-5.3-flash) or raise LIMINAL_RENDERED_SCORE_TIMEOUT_MS',
          constraint: 'Evaluator LLM must complete successfully for rendered-evidence scoring',
        },
      }, renderMeasure);
    }
    return applyRenderMeasurePenalty({
      score: 0.5,
      confidence: 0,
      failureClass: 'scorer',
      scoreState: 'unscored',
      unscoredReason: `evaluator call failed: ${message.slice(0, 200)}`,
      repairAdvice: {
        issue: 'Evaluator LLM scoring failed during execution',
        fix: 'Check network connectivity and evaluator credentials, or fall back to legacy evaluation mode',
        constraint: 'Evaluator LLM must complete successfully for rendered-evidence scoring',
      },
    }, renderMeasure);
  }
}

/** Ordered quality labels the decision model scores against (worst → best). */
export const DECISION_QUALITY_LABELS = Object.freeze([
  'broken or blank', 'weak', 'competent', 'strong', 'gallery-grade',
] as const);
/**
 * Below this P(coherent artwork) the candidate is a render failure. Liquid AI
 * calls d1 probabilities calibrated but says thresholds must be fit on your
 * own data; 0.5 is the uncalibrated prior until gold labels exist.
 */
export const DECISION_VALIDITY_THRESHOLD = 0.5;

/** Size of each frame's panel in the composite sent to the decision model. */
export const DECISION_PANEL = Object.freeze({ width: 400, height: 300 });

/**
 * Joins early and late frames side by side into ONE image the size of a single
 * frame. A llama.cpp d1 server takes the whole request in one physical batch
 * (512 tokens by default); two full frames plus the questions come to 522 and
 * are rejected, while one composite keeps the motion comparison and fits.
 */
export async function composeDecisionFrames(frames: readonly DecisionImage[]): Promise<DecisionImage> {
  const sharp = (await import('sharp').catch(() => null))?.default;
  if (!sharp) throw new Error('DECISION_FRAMES_UNCOMPOSABLE: sharp is not installed; two frames exceed the decision batch');
  const { width, height } = DECISION_PANEL;
  const panels = await Promise.all(frames.map(async frame => (await sharp(frame.data)
    .resize({ width, height, fit: 'contain', background: '#000000' })
    .png().toBuffer({ resolveWithObject: true })).data));
  const { data } = await sharp({ create: { width: width * panels.length, height, channels: 3, background: '#000000' } })
    .composite(panels.map((input, i) => ({ input, left: i * width, top: 0 })))
    .png().toBuffer({ resolveWithObject: true });
  return { mimeType: 'image/png', data };
}

/**
 * Rendered-evidence scoring by a decision model (Liquid AI d1) instead of a
 * chat judge: one forward pass answers a `score` over quality labels and a
 * `noul` validity check, using the rendered frames as images. Transport and
 * answer errors propagate; a decision seat never falls back to a neutral score.
 */
export async function scoreRenderedEvidenceWithDecisionModel(
  evidence: RenderEvidence,
  brief: string,
  decision: DecisionModelClient,
  domain?: string,
): Promise<GenerationEvaluation> {
  const gate = await gateRenderedEvidence(evidence, domain);
  if (gate.verdict) return gate.verdict;
  const frames = [evidence.screenshot, evidence.lateScreenshot]
    .filter((shot): shot is NonNullable<typeof shot> => Boolean(shot))
    .map(shot => ({ mimeType: shot.mimeType, data: Buffer.from(shot.dataBase64, 'base64') }));
  const images: DecisionImage[] = frames.length > 1 ? [await composeDecisionFrames(frames)] : frames;
  const attached = frames.length > 1
    ? `Attached: one image, early frame (left) and late frame (right).`
    : frames.length === 1 ? 'Attached: 1 rendered frame.' : 'No frames were captured.';
  const state = [
    `Domain: ${domain ?? 'unknown'}.`,
    `Brief: ${brief || 'none'}.`,
    attached,
    `Render time: ${evidence.timingMs} ms.${arcNote(evidence)} Runtime errors: ${evidence.errors?.length ?? 0}.`,
  ].join('\n');
  const result = await decision.decide({
    state,
    images,
    questions: {
      coherent: { type: 'noul',
        instructions: 'Do the frames show a coherent, intentional artwork (not blank, not an error or placeholder screen)?' },
      quality: { type: 'score',
        instructions: 'Rate the visual craft of the artwork: composition, depth, palette, motion, finish.',
        criteria: [...DECISION_QUALITY_LABELS] },
    },
  });
  const coherent = result.answers.coherent;
  const quality = result.answers.quality;
  if (coherent?.type !== 'noul' || quality?.type !== 'score') {
    throw new Error('DECISION_ANSWER_INVALID: decision scorer answers have the wrong types');
  }
  const top = DECISION_QUALITY_LABELS.length - 1;
  const reasoning = `decision model ${result.model}: P(coherent)=${coherent.probability.toFixed(3)}, quality=${quality.label} (${quality.score.toFixed(2)}/${top})`;
  if (coherent.probability < DECISION_VALIDITY_THRESHOLD) {
    return applyRenderMeasurePenalty({
      score: 0,
      confidence: 1 - coherent.probability,
      failureClass: 'render',
      reasoning,
      repairAdvice: {
        issue: 'The decision model judged the rendered frames not to be a coherent artwork',
        fix: 'Make the artwork visibly render intentional form: no blank canvas, error text or placeholder.',
        constraint: 'Runtime evidence must show a coherent artwork before quality is scored.',
      },
    }, gate.renderMeasure);
  }
  return applyRenderMeasurePenalty({
    score: Math.min(1, Math.max(0, quality.score / top)),
    confidence: coherent.probability,
    failureClass: 'none',
    reasoning,
  }, gate.renderMeasure);
}
