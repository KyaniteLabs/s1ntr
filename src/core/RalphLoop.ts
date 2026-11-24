/**
 * RalphLoop - Self-recursive iteration engine for Sinter
 *
 * Implements the Ralph-Wiggum Loop pattern:
 * - Same prompt every iteration
 * - Context changes each iteration (previous work, history)
 * - Self-evaluation and improvement
 * - Terminates on promise detection or max-iterations
 *
 * This module is now a thin orchestrator that delegates to extracted modules:
 * - LoopConfig: types and normalization
 * - ContextBuilder: context accumulation formatting
 * - PromptEnhancer: compost seed/DNA/archive injection
 * - GenerationOrchestrator: swarm/collab/generator dispatch
 * - EvolutionIntegration: MAP-Elites + novelty + aesthetic
 * - LoopPersistence: gallery save + merge-every-N
 * - StagnationDetector: stagnation + self-reflection
 * - CreativeIterationGate: quality and continuation gate
 * - OrganismLoop: organism mode
 */

import { getEvalMode, getRepairMode } from '../config/FeatureFlags.js';
import type { GenerationEvaluation, ConcreteRepairAdvice, RenderEvidence } from '../core/types/GenerationEvaluation.js';
import { isHonestFitnessScore } from './fitnessHonesty.js';
import { GeneratorHarnessTools } from '../generators/GeneratorHarnessTools.js';
import { CRAFT_CONTRACT } from '../prompts/CraftContract.js';
import { MetabolicEntropyEngine } from '../entropy/MetabolicEntropyEngine.js';
import type { EntropyResult } from '../entropy/types.js';
import { Domain } from '../types/domains.js';
import { isCodeComplete } from './isCodeComplete.js';
import { PromptStore } from './PromptStore.js';
import path from 'node:path';
import { homedir } from 'node:os';
import { ContextAccumulation } from './ContextAccumulation.js';
import { ScoringEngine } from './ScoringEngine.js';
import { PromiseDetector } from './PromiseDetector.js';
import { Gallery } from '../gallery/Gallery.js';
import { SinterFS } from '../fs/SinterFS.js';
import { resolveSinterProjectRoot } from '../fs/projectRoot.js';
import { SafetyGuardrails } from './SafetyGuardrails.js';
import { CompostHeap } from '../compost/CompostHeap.js';
import { formatError } from '../utils/errors.js';
import { CodeValidator } from './CodeValidator.js';
import { loadRoleConfig } from '../config/RoleConfig.js';
import { mergeConfig as mergeCompostConfig } from '../compost/defaults.js';
import { ArchiveLearning } from '../learning/index.js';
import { QualityArchive } from '../learning/index.js';
import { AestheticModel } from '../evolution/AestheticModel.js';
// B1: `domainToRoutingType` was only used for the dead-bandit recordRoutingOutcome
// call removed above. The import is dropped; re-import if a real reader lands.
import { eventBus, EventTypes } from './EventBus.js';
import { LLMClient, withProviderAttemptGuard } from '../llm/LLMClient.js';
import { ActionProviderBudget } from '../llm/ActionProviderBudget.js';
import { Logger } from '../utils/Logger.js';
import { metaHarness } from '../harness/MetaHarnessIntegration.js';
import { failureLogger } from '../harness/FailureLogger.js';
import { LLMGenerationError } from '../errors/LLMGenerationError.js';

// Extracted modules
import {
  normalizeOptions,
  DEFAULT_MAX_ITERATIONS,
  type LoopOptions,
  type LoopResult,
  type IterationContext,
  type NormalizedLoopOptions,
} from './LoopConfig.js';
import type { LIREvaluationContext } from '../aesthetic/types.js';
import type { VisualMappingParams } from '../audio/types.js';
import type { LLMClientLike } from '../aesthetic/critics/LLMJudgeCritic.js';
import { buildContextForInjection } from './ContextBuilder.js';
import { enhancePrompt } from './PromptEnhancer.js';
import { GenerationOrchestrator } from './GenerationOrchestrator.js';
import { EvolutionIntegration } from './EvolutionIntegration.js';
import { EvolutionEngine, type EvolutionProposal } from '../evolution/EvolutionEngine.js';
import { LoopPersistence } from './LoopPersistence.js';
import { StagnationDetector } from './StagnationDetector.js';
import { CreativeIterationGate } from './CreativeIterationGate.js';
import { SuccessRateTracker } from './SuccessRateTracker.js';
import { GitIntegration } from '../git/GitIntegration.js';
import { AmbiguityDetector } from './AmbiguityDetector.js';
import { env } from '../utils/env.js';
import { Provider } from '../types/providers.js';
import { SinterError } from '../errors/index.js';
import { isAbortError } from '../utils/abort.js';
import { appendFitnessObservation } from '../quality/FitnessObservationStore.js';
import { recordEvent } from '../telemetry/EventLedger.js';
import { setSinterMemoryStage } from '../telemetry/SinterMemoryProfile.js';

export type { LoopOptions, LoopResult, IterationContext, NormalizedLoopOptions };

// DF3 shared contracts: imported for downstream use, referenced to satisfy TS
void getEvalMode;
void getRepairMode;
void 0 as unknown as GenerationEvaluation;

type RalphQualityEvaluation = {
  score: number;
  issues?: string[];
  dimensions?: Record<string, number>;
  repairAdvice?: ConcreteRepairAdvice;
  evaluatorReasoning?: string;
  report?: unknown;
  confidence?: number;
  failureClass?: GenerationEvaluation['failureClass'];
  renderMeasure?: GenerationEvaluation['renderMeasure'];
  calibrationDigest?: string;
};

function logStageTiming(stage: string, startedAt: number): void {
  setSinterMemoryStage(stage);
  Logger.info('RalphLoop', `[stage-timing] ${stage}: ${Date.now() - startedAt}ms`);
}

function assertCompleteRenderedEvidence(evidence: RenderEvidence): void {
  if (evidence.infraUnavailable) return;
  if (evidence.candidateFailure || !evidence.screenshot || !evidence.lateScreenshot) {
    throw new SinterError(
      'Rendered evidence is incomplete; refusing to produce a quality score',
      'ERR_RENDER_EVIDENCE_INCOMPLETE',
    );
  }
}

function logEvaluatorDegradation(context: {
  model?: string;
  provider?: string;
  domain: string;
  prompt: string;
  code: string;
  reason: string;
  iteration: number;
}): void {
  failureLogger.log({
    model: context.model ?? 'unknown',
    provider: context.provider,
    domain: context.domain,
    prompt: context.prompt,
    code: context.code,
    error: `[evaluator-degraded] ${context.reason}`,
    errorType: 'degraded',
    duration: 0,
    iteration: context.iteration,
    codeLength: context.code.length,
  });
  // Additive event-ledger lane (#400) — never replaces FailureLogger.
  // screenshotRef intentionally omitted: GenerationEvaluation does not carry it,
  // and half-wired call sites made the contract dishonest.
  void recordEvent({
    event: 'eval.verdict',
    model: context.model ?? null,
    provider: context.provider ?? null,
    role: 'evaluator',
    runId: null,
    episodeId: null,
    domain: context.domain,
    inputHash: null,
    verdict: 'degraded',
    latencyMs: 0,
    costUsd: null,
    evidenceRefs: [],
    payload: {
      // score/confidence omitted when unknown — same optional shape as other producers
      failureClass: 'scorer',
      degraded: true,
      reason: context.reason,
    },
  }).catch(err => {
    Logger.warn('RalphLoop', 'Failed to record eval.verdict event:', err instanceof Error ? err.message : err);
  });
}

/**
 * generation.scored + eval.verdict producer after a FitnessObservation append.
 * Exported so producer-path tests can exercise the same emit RalphLoop uses.
 */
export async function emitRalphLoopScoringEvents(
  obs: {
    model: string | null;
    provider: string | null;
    runId: string;
    episodeId: string | null;
    domain: string;
    sourceFingerprint: string;
    honest: boolean;
    score: number;
    confidence: number;
    failureClass: string;
    timestamp: string;
  },
  durationMs: number,
): Promise<void> {
  const payload = { ...obs } as Record<string, unknown>;
  await recordEvent({
    event: 'generation.scored',
    model: obs.model,
    provider: obs.provider,
    role: 'generator',
    runId: obs.runId,
    episodeId: obs.episodeId,
    domain: obs.domain,
    inputHash: obs.sourceFingerprint,
    verdict: obs.honest ? 'honest' : 'degraded',
    latencyMs: durationMs,
    costUsd: null,
    evidenceRefs: [],
    payload,
    ts: obs.timestamp,
  });
  await recordEvent({
    event: 'eval.verdict',
    model: obs.model,
    provider: obs.provider,
    role: 'evaluator',
    runId: obs.runId,
    episodeId: obs.episodeId,
    domain: obs.domain,
    inputHash: obs.sourceFingerprint,
    verdict: obs.honest ? 'pass' : 'degraded',
    latencyMs: durationMs,
    costUsd: null,
    evidenceRefs: [],
    payload: {
      score: obs.score,
      confidence: obs.confidence,
      failureClass: obs.failureClass,
      degraded: !obs.honest,
    },
    ts: obs.timestamp,
  });
}

/**
 * Honest aesthetic-penalty multiplier based on the threshold gap.
 *
 * Returns a factor in [0, 1] applied to the evaluation score:
 *   - 1.0 (no penalty) when `score` is at or above `threshold`.
 *   - shrinks toward 0 as the score falls further BELOW the threshold.
 *
 * The previous implementation multiplied the score by the raw aesthetic score,
 * which is not a function of the threshold gap at all: a candidate further below
 * threshold did not reliably get a larger penalty. This makes the magnitude
 * honest — the bigger the shortfall, the bigger the penalty.
 */
export function aestheticPenaltyFactor(score: number, threshold: number): number {
  if (threshold <= 0) return 1;
  if (score >= threshold) return 1;
  const gap = threshold - Math.max(0, score);
  return Math.max(0, 1 - gap / threshold);
}

/**
 * Whether a GLSL fragment shader has a runtime entry point AND a fragment-output
 * marker. Accepts BOTH the legacy `gl_FragColor` builtin and the GLSL ES 3.0
 * `out vec4 <name>;` form (any name) — the same output markers GLSLValidator
 * treats as valid. The previous gl_FragColor-only check false-rejected a valid
 * `#version 300 es` shader whose only output is `out vec4 <name>;`.
 */
export function glslHasRuntimeOutput(code: string): boolean {
  const hasMain = /void\s+main\s*\(/.test(code);
  const hasFragColor = /gl_FragColor/.test(code);
  const hasOutVec4 = /\bout\s+(?:(?:lowp|mediump|highp)\s+)?vec4\s+\w+\s*;/.test(code);
  return hasMain && (hasFragColor || hasOutVec4);
}

function extractScoringReasoning(result: { report?: unknown }): string | undefined {
  const report = result.report;
  if (!report || typeof report !== 'object') return undefined;
  const reasoning = (report as { reasoning?: unknown }).reasoning;
  return typeof reasoning === 'string' && reasoning.trim() ? reasoning : undefined;
}

function buildGenerationEvaluationFromReliableScore(
  evaluation: { score: number; issues?: string[]; report?: unknown },
  degradation?: { failureClass: Exclude<GenerationEvaluation['failureClass'], 'none'>; reason: string },
): GenerationEvaluation {
  const legacyReasoning = extractScoringReasoning(evaluation);
  const reasoning = degradation
    ? [
        degradation.reason,
        `Legacy fallback score ${evaluation.score.toFixed(2)} is diagnostic only.`,
        legacyReasoning,
      ].filter(Boolean).join(' ')
    : legacyReasoning;

  return {
    score: evaluation.score,
    confidence: degradation ? 0 : 1,
    failureClass: degradation?.failureClass ?? 'none',
    repairAdvice: evaluation.issues?.[0]
      ? { issue: evaluation.issues[0], fix: 'Address the reported issue and regenerate.', constraint: 'Return a complete, runnable artifact.' }
      : degradation
        ? { issue: degradation.reason, fix: 'Restore evaluator evidence before trusting this score.', constraint: 'Do not mark degraded evaluator fallback as release-ready.' }
        : undefined,
    reasoning,
  };
}

function qualityEvaluationFromGenerationEvaluation(genEval: GenerationEvaluation): RalphQualityEvaluation {
  return {
    score: genEval.score,
    issues: genEval.repairAdvice ? [genEval.repairAdvice.issue] : [],
    dimensions: genEval.dimensionScores ?? {},
    repairAdvice: genEval.repairAdvice,
    evaluatorReasoning: genEval.reasoning,
    confidence: genEval.confidence,
    failureClass: genEval.failureClass,
    renderMeasure: genEval.renderMeasure,
    calibrationDigest: genEval.calibrationDigest,
  };
}

function generationEvaluationFromQualityEvaluation(evaluation: RalphQualityEvaluation): GenerationEvaluation {
  return {
    score: evaluation.score,
    confidence: evaluation.confidence ?? 1,
    failureClass: evaluation.failureClass ?? 'none',
    repairAdvice: evaluation.repairAdvice ?? (evaluation.issues && evaluation.issues.length > 0
      ? { issue: evaluation.issues[0], fix: 'Address the reported issue and regenerate.', constraint: 'Return a complete, runnable artifact.' }
      : undefined),
    reasoning: evaluation.evaluatorReasoning ?? extractScoringReasoning(evaluation),
    renderMeasure: evaluation.renderMeasure,
    dimensionScores: evaluation.dimensions,
    calibrationDigest: evaluation.calibrationDigest,
  };
}

function hasFailedRenderMeasure(evaluation: GenerationEvaluation): boolean {
  return evaluation.renderMeasure !== undefined && evaluation.renderMeasure.verdict !== 'ok';
}

export class RalphLoop {
  /**
   * Run the Ralph-Wiggum Loop
   *
   * @param prompt - The prompt to use for all iterations
   * @param options - Optional configuration
   * @returns Loop result with code, iterations, and metadata
   */
  static async run(prompt: string, options: LoopOptions | null = {}): Promise<LoopResult> {
    const plan = options?.providerCallBudget;
    if (!plan) return RalphLoop.runInternal(prompt, options);
    const budget = new ActionProviderBudget(plan);
    const result = await withProviderAttemptGuard(budget.guard, () => RalphLoop.runInternal(prompt, options));
    return { ...result, providerCallBudget: budget.snapshot() };
  }

  private static async runInternal(prompt: string, options: LoopOptions | null = {}): Promise<LoopResult> {
    const startTime = Date.now();
    const normalizedOptions = normalizeOptions(options);

    // Generate session ID once per run for git branch reuse and stash namespacing
    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    eventBus.emit(EventTypes.PROCESS_START, 'RalphLoop', { process: 'ralph-loop', maxIterations: normalizedOptions.maxIterations });

    // Ambiguity pre-check: warn if prompt has unresolved ambiguities
    const ambiguityIssues = new AmbiguityDetector().detect(prompt);
    if (ambiguityIssues.length > 0) {
      const highPriority = ambiguityIssues.filter(i => i.severity === 'high');
      if (highPriority.length > 0) {
        Logger.warn('RalphLoop', `Prompt has ${highPriority.length} high-priority ambiguity issues:`);
        for (const issue of highPriority) {
          Logger.warn('RalphLoop', `  [${issue.type}] ${issue.description}`);
        }
      }
    }

    // Warn if swarm mode is used with non-Ollama provider
    if (normalizedOptions.useSwarm) {
      const provider = env('LLM_PROVIDER') || Provider.LMSTUDIO;
      if (provider !== Provider.OLLAMA) {
        Logger.warn('RalphLoop', `Swarm mode is designed for Ollama. Current provider is "${provider}". Swarm may not work correctly.`);
      }
    }

    // Initialize SinterFS once per run (used by all modes)
    const liminalFs = SinterFS.open(resolveSinterProjectRoot());

    try {
      liminalFs.recordRun({
        runId: sessionId,
        prompt,
        project: normalizedOptions.project,
        status: 'started',
        metadata: { maxIterations: normalizedOptions.maxIterations, mode: normalizedOptions.mode },
      });
    } catch (err) {
      // Non-critical to the run, but the 'started' record is lost.
      Logger.warn('RalphLoop', 'SinterFS recordRun (started) failed:', err);
    }

    // Organism mode: delegate entirely to OrganismLoop
    if (normalizedOptions.mode === 'organism') {
      try {
        const { runOrganismMode } = await import('./OrganismLoop.js');
        return await runOrganismMode(prompt, normalizedOptions, startTime, liminalFs, sessionId);
      } finally {
        try {
          liminalFs.close();
        } catch {
          // ignore close errors
        }
      }
    }

    // Initialize subsystems
    const gallery = new Gallery(normalizedOptions.galleryDir);
    const projectStore = liminalFs.getProjectStore();
    const stagnation = new StagnationDetector(normalizedOptions.stagnationThreshold ?? 7);
    const creativeIterationGate = new CreativeIterationGate();
    const successRateTracker = new SuccessRateTracker({
      windowSize: 20,
      explorationThreshold: 0.2,
      recoveryThreshold: 0.3,
    });

    // Git integration — auto-on, agent manages version control behind the scenes
    const gitIntegration = new GitIntegration(normalizedOptions.git ?? {});
    const gitStartRunStartedAt = Date.now();
    await gitIntegration.startRun(normalizedOptions.project ?? `run-${Date.now()}`, sessionId);
    logStageTiming('preloop:git-start-run', gitStartRunStartedAt);

    // Voice-driven visual mapping: analyze audio file if provided
    if (normalizedOptions.voiceFile && !normalizedOptions.visualMappingParams) {
      try {
        const { AudioAnalyzer } = await import('../audio/index.js');
        const { spawn } = await import('child_process');

        // Decode audio file to raw PCM (s16le, mono, 44100Hz) via ffmpeg
        // Use spawn with timeout to prevent zombie processes
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', normalizedOptions.voiceFile,
          '-f', 's16le',
          '-ac', '1',
          '-ar', '44100',
          '-v', 'quiet',
          'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        // Set up timeout to kill hanging processes
        const FFMPEG_TIMEOUT_MS = 30000; // 30 seconds
        const timeout = setTimeout(() => {
          Logger.warn('RalphLoop', 'ffmpeg timeout reached, killing process');
          ffmpegProcess.kill('SIGTERM');
          // Force kill after grace period
          setTimeout(() => {
            if (!ffmpegProcess.killed) {
              ffmpegProcess.kill('SIGKILL');
            }
          }, 5000);
        }, FFMPEG_TIMEOUT_MS);

        // Collect stdout data
        const chunks: Buffer[] = [];
        ffmpegProcess.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));

        // Wait for process to complete
        const exitCode = await new Promise<number | null>((resolve) => {
          ffmpegProcess.on('close', (code) => resolve(code));
          ffmpegProcess.on('error', () => resolve(null));
        });

        clearTimeout(timeout);

        if (exitCode !== 0) {
          throw new LLMGenerationError(`ffmpeg exited with code ${exitCode}`, { model: 'ffmpeg' });
        }

        const pcmBuffer = Buffer.concat(chunks);

        // Convert Int16 PCM to Float32 (-1.0 to 1.0)
        const int16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }

        const analyzer = new AudioAnalyzer();
        const result = analyzer.analyze(float32, 44100);
        const visualMapping = analyzer.getVisualMapping(result);
        // eslint-disable-next-line require-atomic-updates -- normalizedOptions is built per run by normalizeOptions() and never shared across runs
        normalizedOptions.visualMappingParams = visualMapping as unknown as Record<string, unknown>;
        Logger.info('RalphLoop', `Voice analysis complete: mapped audio features to visual params`);
      } catch (err) {
        Logger.warn('RalphLoop', `Voice analysis failed (is ffmpeg installed?), continuing without visual mapping: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Mic-driven visual mapping
    if (normalizedOptions.voice && !normalizedOptions.visualMappingParams) {
      try {
        const { captureMicAudio } = await import('../audio/MicCapture.js');
        const { AudioAnalyzer } = await import('../audio/index.js');
        const float32 = await captureMicAudio();
        const analyzer = new AudioAnalyzer();
        const result = analyzer.analyze(float32);
        // eslint-disable-next-line require-atomic-updates -- normalizedOptions is built per run by normalizeOptions() and never shared across runs
        normalizedOptions.visualMappingParams = analyzer.getVisualMapping(result) as unknown as Record<string, unknown>;
        Logger.info('RalphLoop', `Mic capture analysis complete: mapped audio features to visual params`);
      } catch (err) {
        Logger.warn('RalphLoop', `Mic capture failed, continuing without visual mapping: ${err instanceof Error ? err.message : err}`);
      }
    }

    let archiveLearning: ArchiveLearning | null = null;
    let qualityArchive: QualityArchive | null = null;
    let aestheticModel: AestheticModel | null = null;

    if (normalizedOptions.useArchiveLearning) {
      const archiveLoadStartedAt = Date.now();
      archiveLearning = new ArchiveLearning({ archivePath: normalizedOptions.archivePath });
      qualityArchive = archiveLearning.getArchive();
      await qualityArchive.load();
      logStageTiming('preloop:archive-load', archiveLoadStartedAt);
    }

    if (normalizedOptions.useAestheticModel) {
      aestheticModel = new AestheticModel();
      const aestheticPath = `${homedir()}/.sinter/aesthetic_model.json`;
      await aestheticModel.load(aestheticPath).catch((err) => { Logger.warn('RalphLoop', 'Failed to load aesthetic model:', err); });
    }

    if (normalizedOptions.useMapElites) {
      const mapElitesPath = `${homedir()}/.sinter/map_elites.json`;
      const mapElites = normalizedOptions._mapElites;
      if (mapElites) {
        await mapElites.load(mapElitesPath).catch((err) => { Logger.warn('RalphLoop', 'Failed to load MAP-Elites archive:', err); });
      }
    }

    const evolution = new EvolutionIntegration(normalizedOptions, aestheticModel);
    const persistence = new LoopPersistence(gallery, normalizedOptions, liminalFs);
    const generator = new GenerationOrchestrator(normalizedOptions, gallery, archiveLearning);

    // DF3 Phase 8: EvolutionEngine for adaptive loop tuning
    const recentScores: number[] = [];
    const evolutionEngine = normalizedOptions.useEvolution
      ? new EvolutionEngine({
          recentScores,
          currentPolicy: {
            minQualityScore: normalizedOptions.minQualityScore,
            maxIterations: normalizedOptions.maxIterations,
          },
        })
      : undefined;

    // DF3 Phase 4: Pre-digest compost for seed-aware initial generation
    let compostMaterials: import('../compost/types.js').GenerationMaterials | undefined;
    if (normalizedOptions.autoCompost || normalizedOptions.useCompostEnhancement) {
      try {
        const compostConfig = mergeCompostConfig();
        const { openCompostMill } = await import('../compost/openCompostMill.js');
        const mill = openCompostMill({ llm: new LLMClient({ role: 'generator' }), projectStore, config: compostConfig });
        await mill.digest();
        compostMaterials = await mill.getGenerationMaterials(normalizedOptions.collabDomain || 'p5');
      } catch (err) {
        Logger.warn('RalphLoop', 'Compost digest for generation failed:', err);
      }
    }

    let iteration = 0;
    let completed = false;
    let reason = '';
    let currentCode = '';
    let previousCode = '';
    let finalScore = 0;
    // Track the honesty of the score we report, so callers/ledgers can mark a degraded
    // (evaluator-offline) score as such instead of treating it as real fitness.
    let finalConfidence = 1;
    let finalFailureClass: GenerationEvaluation['failureClass'] = 'none';
    let finalEvaluation: GenerationEvaluation | undefined;
    let lastThinking: string | undefined;
    // Model provenance: generation uses the generator role, so seed lastModel
    // with its resolved model. Generators that return only a code string drop
    // the model, which would otherwise be recorded as "unknown".
    let generatorRoleModel: string | undefined;
    try {
      generatorRoleModel = (await loadRoleConfig()).generator?.model;
      if (generatorRoleModel === 'auto' || generatorRoleModel === 'unknown') generatorRoleModel = undefined;
    } catch { /* role config unavailable — leave undefined */ }
    let lastModel: string | undefined = generatorRoleModel;
    let lastProvider: string | undefined;
    let lastActiveAdaptationIds: string[] = [];
    // Best VALID candidate across iterations. The loop must return its best
    // result, not merely the last one: a later iteration can regress, and the
    // final validation gate would otherwise reject a good earlier result and
    // throw away usable work. bestScore < 0 means no valid candidate yet.
    let bestScore = -1;
    let bestCode = '';
    let bestConfidence = 1;
    let bestFailureClass: GenerationEvaluation['failureClass'] = 'none';
    let bestEvaluation: GenerationEvaluation | undefined;
    let bestThinking: string | undefined;
    let bestModel: string | undefined;
    let bestProvider: string | undefined;
    let bestActiveAdaptationIds: string[] = [];

    // Convergence tracking: score history for detecting plateau
    const scoreHistory: number[] = [];
    const CONVERGENCE_WINDOW = 3;
    const CONVERGENCE_THRESHOLD = 0.01;

    // DF3 Phase 2: repair history for repeated-failure detection
    const repairHistory: GenerationEvaluation[] = [];

    const evalMode = normalizedOptions.evalMode ?? getEvalMode();
    const guardrails = normalizedOptions.safetyConfig
      ? new SafetyGuardrails(normalizedOptions.safetyConfig)
      : null;

    // Main loop
    try {
    while (iteration < normalizedOptions.maxIterations) {
      if (normalizedOptions.signal?.aborted) {
        reason = 'aborted by user';
        break;
      }

      // Safety guardrails check (persists across iterations for circuit breaker, rate limit, budget)
      if (guardrails) {
        if (!guardrails.checkAll(iteration > 0 ? finalScore : undefined)) {
          reason = 'safety guardrails triggered';
          break;
        }
        guardrails.recordApiCall();
      }

      iteration++;
      let generationDurationMs = 0;
      let evaluationDurationMs = 0;

      try {
        // Emit thoughts during generation for chat display
        if (normalizedOptions.chatMode) {
          normalizedOptions.onThought?.(`Starting iteration ${iteration}...`);
          normalizedOptions.onThought?.('Loading prompt...');
        }

        // Load prompt (same every time)
        const loadedPrompt = PromptStore.load(prompt);

        // Build context and enhance prompt
        // Pass previous code to generate unique hash for cache defeat
        const contextForInjection = buildContextForInjection(iteration, normalizedOptions, prompt, loadedPrompt, previousCode);
        let usedPrompt = PromptStore.injectContext(loadedPrompt, contextForInjection);
        if (usedPrompt === loadedPrompt) {
          usedPrompt = loadedPrompt + '\n\n---\nContext from previous iterations:\n' + contextForInjection;
        }
        // Every generation carries the craft contract — the generation-side
        // mirror of the judge's rubric bands. This is the daemon's prompt
        // chokepoint (PromptBuilder does NOT sit on this path).
        if (!usedPrompt.includes('<craft_contract>')) {
          usedPrompt = `${usedPrompt}\n\n${CRAFT_CONTRACT}`;
        }

        if (normalizedOptions.chatMode) {
          normalizedOptions.onThought?.('Enhancing prompt with context and compost...');
        }

        // DF3 Phase 8: Apply EvolutionEngine proposals for this iteration only
        let evoProposal: EvolutionProposal | undefined;
        const evoRestores: Array<() => void> = [];
        if (evolutionEngine && recentScores.length > 2) {
          const rawProposal = evolutionEngine.propose();
          if (rawProposal) {
            evoProposal = { ...rawProposal, delta: evolutionEngine.clamp(rawProposal.delta) };
            Logger.info('RalphLoop', `Evolution proposal (${evoProposal.type}): ${evoProposal.description}`);
            if (evoProposal.delta.promptPrefix) {
              usedPrompt = evoProposal.delta.promptPrefix + usedPrompt;
            }
            if (evoProposal.delta.promptSuffix) {
              usedPrompt = usedPrompt + evoProposal.delta.promptSuffix;
            }
            if (evoProposal.delta.minQualityScoreAdjustment !== undefined) {
              const original = normalizedOptions.minQualityScore;
              normalizedOptions.minQualityScore = Math.max(0, Math.min(1, normalizedOptions.minQualityScore + evoProposal.delta.minQualityScoreAdjustment));
              evoRestores.push(() => { normalizedOptions.minQualityScore = original; });
            }
          }
        }

        // Generate intuition hint if enabled
        let intuitionHint: string | undefined;
        if (normalizedOptions.useIntuition) {
          try {
            const { IntuitionEngine } = await import('../intuition/index.js');
            const intuitionEngine = new IntuitionEngine();
            await intuitionEngine.load();
            intuitionHint = intuitionEngine.generateHint(String(normalizedOptions.collabDomain), 200);
          } catch (err) {
            Logger.warn('RalphLoop', 'Intuition hint generation failed:', err);
          }
        }

        // Enhance with compost seed, DNA, and archive examples
        // eslint-disable-next-line require-atomic-updates -- usedPrompt is a per-iteration local of this run; no other task can write it
        usedPrompt = await enhancePrompt(usedPrompt, loadedPrompt, normalizedOptions, archiveLearning, compostMaterials, intuitionHint);

        // Adjust numCandidates based on success rate for high-exploration mode
        const adjustedNumCandidates = successRateTracker.getRecommendedCandidates(normalizedOptions.numCandidates ?? 1);
        if (adjustedNumCandidates !== (normalizedOptions.numCandidates ?? 1) && normalizedOptions.chatMode) {
          normalizedOptions.onThought?.(`Increasing to ${adjustedNumCandidates} candidates for exploration...`);
        }

        if (normalizedOptions.chatMode) {
          normalizedOptions.onThought?.(`Generating ${adjustedNumCandidates} candidate(s)...`);
        }

        const generationPhaseStartedAt = Date.now();
        setSinterMemoryStage(`iter${iteration}:generating`);
        // Best-of-N: Generate multiple candidates with bounded parallelism
        let numCandidates = adjustedNumCandidates;
        const candidates: Array<{
          code: string;
          score: number;
          issues: string[];
          index: number;
          thinking?: string;
          provider?: string;
          model?: string;
          activeAdaptationIds?: string[];
          genEval?: GenerationEvaluation;
        }> = [];
        let lastGenerationError: Error | undefined;
        // The last per-candidate VALIDATION failure (vs a generation throw).
        // Captured so an all-candidates-failed error can name a validation cause
        // (e.g. kinetic <head> mismatch) instead of collapsing to the generic bucket.
        let lastValidationError: string | undefined;
        let winnerIndex = 0; // track winner index for evaluation phase

        // Harvest entropy before generation if enabled
        let entropyEngine: MetabolicEntropyEngine | undefined;
        let entropyResult: EntropyResult | undefined;
        if (normalizedOptions.useEntropy) {
          try {
            entropyEngine = new MetabolicEntropyEngine({
              eventStore: { getRecent: () => [] },
              // eslint-disable-next-line @typescript-eslint/require-await -- inline mock satisfies Promise<string[]> contract
              heap: { listFiles: async () => [] },
              telemetry: { getSummary: () => ({ successRate: 0, avgDurationMs: 0, totalTasks: 0, totalViolations: 0 }) },
            });
            entropyResult = await entropyEngine.harvest();
          } catch (err) {
            Logger.warn('RalphLoop', 'Entropy harvest failed:', err);
          }
        }

        // Use entropy for candidate search breadth (bounded)
        if (entropyResult && entropyResult.seed % 2 === 0) {
          numCandidates += 1;
        }

        const harnessTools = entropyEngine
          ? new GeneratorHarnessTools({ entropySource: entropyEngine })
          : new GeneratorHarnessTools({ seededRandom: Math.random });
        const maxParallelism = normalizedOptions.maxParallelism ?? 3;

        for (let batchStart = 0; batchStart < numCandidates; batchStart += maxParallelism) {
          const batchEnd = Math.min(batchStart + maxParallelism, numCandidates);
          const batchPromises: Promise<{
            code: string;
            score: number;
            issues: string[];
            index: number;
            thinking?: string;
            provider?: string;
            model?: string;
            activeAdaptationIds?: string[];
          } | undefined>[] = [];

          for (let i = batchStart; i < batchEnd; i++) {
            batchPromises.push(
              (async (index: number) => {
                try {
                  const diversityPrompt = normalizedOptions.swarmDiversify
                    ? harnessTools.buildDiversityPrompt(usedPrompt, index, numCandidates, entropyResult?.phrase)
                    : usedPrompt;
                  // Generate code (bypass cache to ensure fresh generation each iteration)
                  // Ralph Loop requires fresh LLM calls each iteration - caching would defeat the iterative improvement pattern
                  const generationResult = await generator.generate(diversityPrompt, loadedPrompt, true, normalizedOptions.signal);

                  if (generationResult.needsClarification) {
                    const msgs = generationResult.clarifyingQuestions.map(q => q.question).join('; ');
                    throw new Error(
                      `Ambiguous prompt — please clarify before running RalphLoop:\n${msgs}\n\n` +
                      `Detected intent: ${generationResult.suggestions.join(', ') || 'unknown'}`
                    );
                  }

                  let { code, thinking, provider, model, activeAdaptationIds } = generationResult;
                  const validationDomain = String(normalizedOptions.collabDomain || normalizedOptions.mode || 'p5');

                  // Validate generated code before accepting it
                  let validation = CodeValidator.validate(code, validationDomain);

                  // One repair turn: a single syntax slip should not end the run.
                  // The model sees the validator's exact errors and its own code.
                  if (!validation.valid) {
                    Logger.warn('RalphLoop', `Candidate ${index} validation failed, asking for one repair: ${validation.errors.join('; ')}`);
                    const repairPrompt = `${diversityPrompt}\n\n---\nYour previous code failed validation:\n${validation.errors.map(e => `- ${e}`).join('\n')}\n\nPrevious code:\n${code}\n\nReturn the complete corrected code.`;
                    const repaired = await generator.generate(repairPrompt, loadedPrompt, true, normalizedOptions.signal);
                    if (!repaired.needsClarification) {
                      ({ code, thinking, provider, model, activeAdaptationIds } = repaired);
                      validation = CodeValidator.validate(code, validationDomain);
                    }
                  }

                  if (!validation.valid) {
                    lastValidationError = validation.errors.join('; ');
                    Logger.warn('RalphLoop', `Candidate ${index} validation failed: ${validation.errors.join('; ')}`);
                    // Report validation failure to Meta-Harness (skip during tests to avoid log pollution)
                    if (process.env.NODE_ENV !== 'test') {
                      await metaHarness.onGenerationComplete({
                        success: false,
                        model: normalizedOptions.useSwarm ? 'swarm' : 'local',
                        domain: normalizedOptions.collabDomain as unknown as import('../chat/types.js').Domain,
                        prompt: prompt,
                        code: code,
                        error: `Validation failed: ${validation.errors.join('; ')}`,
                        duration: Date.now() - startTime,
                        thinking,
                      });
                    }
                    // Skip this candidate - don't add to candidates list
                    return undefined;
                  }

                  const candidateCode = validation.cleanedCode;

                  await normalizedOptions.onCandidateGenerated?.({
                    iteration,
                    candidateIndex: index,
                    kind: 'initial',
                    code: candidateCode,
                  });

                  // Check code completeness (domain-aware: balance + terminal marker)
                  const isComplete = RalphLoop.isCodeComplete(
                    candidateCode,
                    normalizedOptions.collabDomain,
                  );

                  // Quick score for candidate selection (simpler than full evaluation)
                  // We'll do full evaluation on the best candidate
                  const quickScore = isComplete ? 0.5 : 0.3; // Basic completeness bonus

                  return {
                    code: candidateCode,
                    score: quickScore, // Will be replaced with full score
                    issues: [],
                    index,
                    thinking,
                    provider,
                    model,
                    activeAdaptationIds,
                  };
                } catch (candidateError) {
                  Logger.warn('RalphLoop', `Candidate ${index} generation failed: ${formatError('RalphLoop', candidateError)}`);
                  lastGenerationError = candidateError instanceof Error ? candidateError : new Error(String(candidateError));
                  // Continue to next candidate
                  if (!normalizedOptions.tolerateErrors) {
                    throw lastGenerationError;
                  }
                  return undefined;
                }
              })(i)
            );
          }

          const batchResults = await Promise.all(batchPromises);
          for (const result of batchResults) {
            if (result) {
              candidates.push(result);
            }
          }
        }

        // Select the best candidate or fail if none valid
        if (candidates.length === 0) {
          // Surface the specific per-candidate reason in the MESSAGE, not only in
          // the details. The daemon/probe classify failures from the error text;
          // a bare 'All generation candidates failed' collapses every real cause
          // (svg truncation, glsl undefined fn, brightness reject, …) into one
          // generic 'candidate_pool_empty' bucket, hiding what actually broke.
          const innerReason = lastGenerationError?.message ?? lastValidationError;
          throw new SinterError(
            innerReason
              ? `All generation candidates failed: ${innerReason}`
              : 'All generation candidates failed',
            'ERR_ALL_CANDIDATES_FAILED',
            {
              attempts: numCandidates,
              lastError: innerReason,
            }
          );
        } else {
          // For single candidate (default), just use it
          // For multiple candidates, we need to fully evaluate each to find the best
          let bestCandidate = candidates[0];

          if (candidates.length > 1) {
            // Score all candidates fully to find the best using GenerationEvaluation contract
            const candidateEvaluations: GenerationEvaluation[] = [];
            for (let i = 0; i < candidates.length; i++) {
              const candidate = candidates[i];
              try {
                // LIR: Parse generated code into structured tokens if enabled
                let lirContext: LIREvaluationContext | undefined;
                if (normalizedOptions.lirEnabled) {
                  try {
                    const { GeneratedCodeParser } = await import('./lir/GeneratedCodeParser.js');
                    const genParser = new GeneratedCodeParser();
                    const lirTokens = genParser.parse(candidate.code);
                    if (lirTokens.length > 0) {
                      lirContext = {
                        lirTokens,
                        visualIntent: normalizedOptions.visualMappingParams as unknown as VisualMappingParams,
                        lirEnabled: true,
                      };
                    }
                  } catch (err) {
                    Logger.debug('RalphLoop', 'LIR parsing failed, regex fallback will be used:', err);
                    // LIR parsing failed — regex fallback will be used
                  }
                }

                let genEval: GenerationEvaluation;
                if ((evalMode === 'auto' || evalMode === 'strict-browser') && !isAudioDomain(normalizedOptions.collabDomain)) {
                  const { HeadlessRenderer } = await import('../render/HeadlessRenderer.js');
                  const renderer = HeadlessRenderer.getInstance();
                  const renderEvidence = await renderer.renderWithEvidence(candidate.code, {
                    domain: (normalizedOptions.collabDomain || 'p5') as import('../render/HeadlessRenderer.js').RenderDomain,
                    width: 400,
                    height: 400,
                  });
                  await normalizedOptions.onRenderedEvidence?.({
                    iteration, candidateIndex: candidate.index, kind: 'initial',
                    code: candidate.code, evidence: renderEvidence,
                  });
                  assertCompleteRenderedEvidence(renderEvidence);

                  if (renderEvidence.infraUnavailable) {
                    if (evalMode === 'strict-browser') {
                      throw new SinterError(
                        'Browser rendering infrastructure is unavailable in strict-browser mode',
                        'ERR_RENDER_INFRA_UNAVAILABLE',
                      );
                    }
                    Logger.warn('RalphLoop', 'Browser render infra unavailable, falling back to legacy scoring for candidate');
                    logEvaluatorDegradation({
                      model: lastModel,
                      provider: env('LLM_PROVIDER'),
                      domain: String(normalizedOptions.collabDomain || 'p5'),
                      prompt,
                      code: candidate.code,
                      reason: 'Browser render infrastructure is unavailable; using legacy candidate scoring.',
                      iteration,
                    });
                    const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
                    const quickEvaluation = await scoringEngine.scoreReliable({
                      output: candidate.code,
                      criteria: normalizedOptions.evaluationCriteria,
                      lirContext,
                    });
                    genEval = buildGenerationEvaluationFromReliableScore(quickEvaluation, {
                      failureClass: 'infra',
                      reason: 'Browser render infrastructure is unavailable in auto evaluation mode.',
                    });
                    candidate.score = quickEvaluation.score;
                    candidate.issues = quickEvaluation.issues ?? [];
                  } else {
                    const { scoreRenderedEvidence } = await import('../core/ScoringEngine.js');
                    genEval = await scoreRenderedEvidence(
                      renderEvidence,
                      candidate.code,
                      prompt,
                      undefined,
                      String(normalizedOptions.collabDomain || 'p5'),
                    );
                    if (genEval.failureClass === 'parse') {
                      // A malformed judge response gets one repair attempt. Evaluator
                      // availability, timeout, and provider failures are not retried here.
                      genEval = await scoreRenderedEvidence(
                        renderEvidence,
                        candidate.code,
                        prompt,
                        undefined,
                        String(normalizedOptions.collabDomain || 'p5'),
                      );
                    }
                    if (genEval.failureClass === 'parse') {
                      logEvaluatorDegradation({
                        model: lastModel,
                        provider: env('LLM_PROVIDER'),
                        domain: String(normalizedOptions.collabDomain || 'p5'),
                        prompt,
                        code: candidate.code,
                        reason: genEval.reasoning ?? 'Evaluator response could not be parsed after retry; keeping degraded candidate score.',
                        iteration,
                      });
                    }
                    if (genEval.failureClass === 'scorer') {
                      if (evalMode === 'strict-browser') {
                        throw new SinterError(
                          'Evaluator LLM is unavailable in strict-browser mode',
                          'ERR_EVALUATOR_UNAVAILABLE',
                        );
                      }
                      if (hasFailedRenderMeasure(genEval)) {
                        Logger.warn('RalphLoop', 'Evaluator LLM unavailable but render measurement failed; keeping objective render penalty for candidate');
                        candidate.score = genEval.score;
                        candidate.issues = genEval.repairAdvice ? [genEval.repairAdvice.issue] : [];
                      } else {
                        Logger.warn('RalphLoop', 'Evaluator LLM unavailable for rendered-evidence scoring, falling back to legacy scoring for candidate');
                        logEvaluatorDegradation({
                          model: lastModel,
                          provider: env('LLM_PROVIDER'),
                          domain: String(normalizedOptions.collabDomain || 'p5'),
                          prompt,
                          code: candidate.code,
                          reason: genEval.reasoning ?? 'Evaluator LLM is unavailable; using legacy candidate scoring.',
                          iteration,
                        });
                        const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
                        const quickEvaluation = await scoringEngine.scoreReliable({
                          output: candidate.code,
                          criteria: normalizedOptions.evaluationCriteria,
                          lirContext,
                        });
                        genEval = buildGenerationEvaluationFromReliableScore(quickEvaluation, {
                          failureClass: 'scorer',
                          reason: genEval.reasoning ?? 'Evaluator LLM is unavailable in auto evaluation mode.',
                        });
                        candidate.score = quickEvaluation.score;
                        candidate.issues = quickEvaluation.issues ?? [];
                      }
                    } else {
                      candidate.score = genEval.score;
                      candidate.issues = genEval.repairAdvice ? [genEval.repairAdvice.issue] : [];
                    }
                  }
                } else {
                  const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
                  const quickEvaluation = await scoringEngine.scoreReliable({
                    output: candidate.code,
                    criteria: normalizedOptions.evaluationCriteria,
                    lirContext,
                  });
                  genEval = buildGenerationEvaluationFromReliableScore(quickEvaluation);
                  // W1.2: the heuristic path (audio domains, LIMINAL_EVAL_MODE=legacy)
                  // produces no evaluator evidence — stamp the legacy provenance class
                  // so the loop treats the score as display-only/degraded downstream.
                  genEval.failureClass = 'legacy';
                  candidate.score = quickEvaluation.score;
                  candidate.issues = quickEvaluation.issues ?? [];
                }

                candidate.genEval = genEval;
                candidateEvaluations.push(genEval);
              } catch (scoringError) {
                Logger.warn('RalphLoop', `Failed to score candidate ${candidate.index}: ${formatError('RalphLoop', scoringError)}`);
                const fallbackEval: GenerationEvaluation = {
                  score: candidate.score,
                  confidence: 0,
                  failureClass: 'scorer',
                };
                candidate.genEval = fallbackEval;
                candidateEvaluations.push(fallbackEval);
              }
            }

            const { winnerIndex: rankedWinnerIndex } = harnessTools.rankCandidates(
              candidates.map(c => c.code),
              candidateEvaluations,
            );
            if (rankedWinnerIndex === -1) {
              Logger.warn('RalphLoop', 'Candidate evaluations are empty; falling back to first candidate');
            }
            winnerIndex = rankedWinnerIndex === -1 ? 0 : rankedWinnerIndex;
            bestCandidate = candidates[winnerIndex] ?? candidates[0];

            if (normalizedOptions.chatMode) {
              normalizedOptions.onThought?.(`Selected candidate ${bestCandidate.index + 1}/${numCandidates} (score: ${bestCandidate.score.toFixed(2)})`);
            }
          }

          currentCode = bestCandidate.code;
          lastThinking = bestCandidate.thinking;
          lastProvider = bestCandidate.provider;
          // Keep the seeded generator-role model when the candidate didn't carry one.
          lastModel = bestCandidate.model ?? lastModel;
          lastActiveAdaptationIds = bestCandidate.activeAdaptationIds ?? [];
        }
        generationDurationMs = Math.max(0, Date.now() - generationPhaseStartedAt);
        logStageTiming(`iter${iteration}:generate`, generationPhaseStartedAt);

        // Check code completeness (domain-aware: balance + terminal marker)
        const isComplete = RalphLoop.isCodeComplete(currentCode, normalizedOptions.collabDomain);

        // Runtime validation: test if code actually works
        let runtimeValid = true;
        let runtimeError = '';

        // Detect output type and run appropriate runtime test
        const outputType = detectOutputType(currentCode);
        if (outputType === Domain.GLSL) {
          // For GLSL we can't run a real GL context in Node, so we check for the
          // required entry point and a fragment-output marker. glslHasRuntimeOutput
          // accepts both the legacy gl_FragColor builtin AND the ES 3.0
          // `out vec4 <name>;` form, so a valid `#version 300 es` shader is no
          // longer false-rejected for lacking gl_FragColor.
          if (!glslHasRuntimeOutput(currentCode)) {
            runtimeValid = false;
            runtimeError = 'Missing main() or a fragment output (gl_FragColor / out vec4 <name>;)';
          }
        }

        // Log runtime validation results. The runtimeValid flag is enforced below
        // (after evaluation) so an invalid runtime result fails the candidate
        // instead of being silently accepted.
        if (!runtimeValid) {
          Logger.warn('RalphLoop', `Runtime validation failed: ${runtimeError}`);
          if (normalizedOptions.chatMode) {
            normalizedOptions.onThought?.(`Runtime check failed: ${runtimeError}`);
          }
        }

        // Diagnostic: Log that we got fresh code (not from cache)
        if (normalizedOptions.chatMode) {
          normalizedOptions.onThought?.(`Generated ${currentCode.length} characters of code (iteration ${iteration})`);
        }

        const evaluationPhaseStartedAt = Date.now();
        // Evaluate quality
        // If we already evaluated multiple candidates, use the best candidate's score
        // Otherwise, run evaluation for the single candidate
        let evaluation: RalphQualityEvaluation;
        let lirContext: LIREvaluationContext | undefined;
        // Screenshot from this iteration's render evidence, forwarded to the
        // aesthetic LLM judge below so it sees pixels instead of code alone.
        let iterationScreenshot: import('../llm/ProviderTypes.js').ProviderImageInput | undefined;

        // Handle case where all candidates failed validation
        if (candidates.length === 0) {
          evaluation = { score: 0, issues: ['All candidates failed validation'] };
        } else if (candidates.length > 1) {
          // We already evaluated all candidates, use the best one's score
          // bestCandidate already holds the winner from line 672 — no re-lookup needed
          const winner = candidates[winnerIndex];
          evaluation = {
            score: winner?.score ?? 0,
            issues: winner?.issues ?? [],
            dimensions: {},
            repairAdvice: winner?.genEval?.repairAdvice,
            evaluatorReasoning: winner?.genEval?.reasoning,
            confidence: winner?.genEval?.confidence,
            failureClass: winner?.genEval?.failureClass,
            renderMeasure: winner?.genEval?.renderMeasure,
          };
          if (normalizedOptions.chatMode) {
            normalizedOptions.onThought?.(`Using pre-evaluated score: ${evaluation.score.toFixed(2)}`);
          }
        } else {
          // Single candidate - run full evaluation
          if (normalizedOptions.chatMode) {
            normalizedOptions.onThought?.('Evaluating code quality...');
          }

          // LIR: Parse generated code into structured tokens if enabled
          if (normalizedOptions.lirEnabled) {
            try {
              const { GeneratedCodeParser } = await import('./lir/GeneratedCodeParser.js');
              const genParser = new GeneratedCodeParser();
              const lirTokens = genParser.parse(currentCode);
              if (lirTokens.length > 0) {
                lirContext = {
                  lirTokens,
                  visualIntent: normalizedOptions.visualMappingParams as unknown as VisualMappingParams,
                  lirEnabled: true,
                };
              }
            } catch (err) {
              Logger.debug('RalphLoop', 'LIR parsing failed, regex fallback will be used:', err);
              // LIR parsing failed — regex fallback will be used
            }
          }

          // DF3 Phase 1: eval-mode-aware scoring with browser-render evidence
          if ((evalMode === 'auto' || evalMode === 'strict-browser') && !isAudioDomain(normalizedOptions.collabDomain)) {
            const { HeadlessRenderer } = await import('../render/HeadlessRenderer.js');
            const renderer = HeadlessRenderer.getInstance();
            const renderStartedAt = Date.now();
            const renderEvidence = await renderer.renderWithEvidence(currentCode, {
              domain: (normalizedOptions.collabDomain || 'p5') as import('../render/HeadlessRenderer.js').RenderDomain,
              width: 400,
              height: 400,
            });
            await normalizedOptions.onRenderedEvidence?.({
              iteration, candidateIndex: 0, kind: 'initial', code: currentCode,
              evidence: renderEvidence,
            });
            assertCompleteRenderedEvidence(renderEvidence);
            logStageTiming(`iter${iteration}:evaluate:render`, renderStartedAt);
            iterationScreenshot = renderEvidence.screenshot
              ? { ...renderEvidence.screenshot, label: 'rendered-artifact' }
              : undefined;

            if (renderEvidence.infraUnavailable) {
              if (evalMode === 'strict-browser') {
                throw new SinterError(
                  'Browser rendering infrastructure is unavailable in strict-browser mode',
                  'ERR_RENDER_INFRA_UNAVAILABLE',
                );
              }
              Logger.warn('RalphLoop', 'Browser render infra unavailable, falling back to legacy scoring');
              logEvaluatorDegradation({
                model: lastModel,
                provider: env('LLM_PROVIDER'),
                domain: String(normalizedOptions.collabDomain || 'p5'),
                prompt,
                code: currentCode,
                reason: 'Browser render infrastructure is unavailable; using legacy scoring.',
                iteration,
              });
              const legacyScoreStartedAt = Date.now();
              const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
              const quickEvaluation = await scoringEngine.scoreReliable(
                {
                  output: currentCode,
                  criteria: normalizedOptions.evaluationCriteria,
                  lirContext,
                },
              );
              logStageTiming(`iter${iteration}:evaluate:legacy-score(infra)`, legacyScoreStartedAt);
              evaluation = qualityEvaluationFromGenerationEvaluation(
                buildGenerationEvaluationFromReliableScore(quickEvaluation, {
                  failureClass: 'infra',
                  reason: 'Browser render infrastructure is unavailable in auto evaluation mode.',
                }),
              );
            } else {
              const { scoreRenderedEvidence } = await import('../core/ScoringEngine.js');
              const renderedScoreStartedAt = Date.now();
              let genEval = await scoreRenderedEvidence(
                renderEvidence,
                currentCode,
                prompt,
                undefined,
                String(normalizedOptions.collabDomain || 'p5'),
              );
              if (genEval.failureClass === 'parse') {
                // A malformed judge response gets one repair attempt. Evaluator
                // availability, timeout, and provider failures are not retried here.
                genEval = await scoreRenderedEvidence(
                  renderEvidence,
                  currentCode,
                  prompt,
                  undefined,
                  String(normalizedOptions.collabDomain || 'p5'),
                );
              }
              if (genEval.failureClass === 'parse') {
                logEvaluatorDegradation({
                  model: lastModel,
                  provider: env('LLM_PROVIDER'),
                  domain: String(normalizedOptions.collabDomain || 'p5'),
                  prompt,
                  code: currentCode,
                  reason: genEval.reasoning ?? 'Evaluator response could not be parsed after retry; keeping degraded score.',
                  iteration,
                });
              }
              logStageTiming(`iter${iteration}:evaluate:rendered-score`, renderedScoreStartedAt);
              if (genEval.failureClass === 'scorer') {
                if (evalMode === 'strict-browser') {
                  throw new SinterError(
                    'Evaluator LLM is unavailable in strict-browser mode',
                    'ERR_EVALUATOR_UNAVAILABLE',
                  );
                }
                if (hasFailedRenderMeasure(genEval)) {
                  Logger.warn('RalphLoop', 'Evaluator LLM unavailable but render measurement failed; keeping objective render penalty');
                  evaluation = qualityEvaluationFromGenerationEvaluation(genEval);
                } else {
                  Logger.warn('RalphLoop', 'Evaluator LLM unavailable for rendered-evidence scoring, falling back to legacy scoring');
                  logEvaluatorDegradation({
                    model: lastModel,
                    provider: env('LLM_PROVIDER'),
                    domain: String(normalizedOptions.collabDomain || 'p5'),
                    prompt,
                    code: currentCode,
                    reason: genEval.reasoning ?? 'Evaluator LLM is unavailable; using legacy scoring.',
                    iteration,
                  });
                  const legacyScoreStartedAt = Date.now();
                  const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
                  const quickEvaluation = await scoringEngine.scoreReliable(
                    {
                      output: currentCode,
                      criteria: normalizedOptions.evaluationCriteria,
                      lirContext,
                    },
                  );
                  logStageTiming(`iter${iteration}:evaluate:legacy-score(scorer)`, legacyScoreStartedAt);
                  evaluation = qualityEvaluationFromGenerationEvaluation(
                    buildGenerationEvaluationFromReliableScore(quickEvaluation, {
                      failureClass: 'scorer',
                      reason: genEval.reasoning ?? 'Evaluator LLM is unavailable in auto evaluation mode.',
                    }),
                  );
                }
              } else {
                evaluation = qualityEvaluationFromGenerationEvaluation(genEval);
              }
            }
          } else {
            // legacy mode
            const legacyScoreStartedAt = Date.now();
            const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
            evaluation = await scoringEngine.scoreReliable(
              {
                output: currentCode,
                criteria: normalizedOptions.evaluationCriteria,
                lirContext,
              },
            );
            // W1.2: audio domains and LIMINAL_EVAL_MODE=legacy return heuristic
            // ScoringEngine results with no evaluator evidence. Stamp the legacy
            // provenance class so the score still displays but is never repaired
            // against, banked, converged on, or learned from.
            evaluation.failureClass = 'legacy';
            logStageTiming(`iter${iteration}:evaluate:legacy-score`, legacyScoreStartedAt);
          }
        }

        // DF3 Phase 2: Single-Round Repair — extended to rubric climbing.
        // Below the quality floor it repairs; in the competent band
        // (floor..elevationBand) it runs ONE elevation pass against the
        // judge's named weakest craft dimension. Keep-best below adopts the
        // revision only if it scores >= the original. Bounded cost: +1
        // gen/eval per competent generation.
        const repairMode = getRepairMode();
        const elevationBand = (() => {
          const v = Number.parseFloat(process.env.SINTER_ELEVATION_BAND ?? '');
          return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
        })();
        // W1.2: never repair/elevate against a DEGRADED evaluation. A scorer/infra
        // fallback or a legacy heuristic score is not evaluator evidence — repairing
        // toward it burns a generation chasing evaluator noise (or a keyword proxy).
        // 'render' stays repairable: a failed render measure is a real, actionable
        // signal (broken artifact), exactly what repair exists for.
        const evaluationHonestForRepair = isHonestFitnessScore(evaluation.confidence, evaluation.failureClass);
        if (repairMode === 'single-round' && evaluationHonestForRepair && evaluation.score < Math.max(normalizedOptions.minQualityScore, elevationBand)) {
          const repairStartedAt = Date.now();
          if (normalizedOptions.chatMode) {
            normalizedOptions.onThought?.('Attempting single-round repair...');
          }

          try {
            const harness = new GeneratorHarnessTools({ seededRandom: Math.random });

            // Build repair packet with repeated-failure detection
            const genEval = generationEvaluationFromQualityEvaluation(evaluation);
            const repairPacket = harness.buildRepairPacket(genEval, repairHistory);

            if (repairPacket) {
              let repairPrompt = `${usedPrompt}\n\n---\n${repairPacket}`;
              if (entropyResult) {
                repairPrompt = harness.modulateRepairPrompt(repairPrompt, entropyResult.phrase);
              }
              const repairResult = await generator.generate(repairPrompt, loadedPrompt, true, normalizedOptions.signal);

              if (!repairResult.needsClarification) {
                const repairValidation = CodeValidator.validate(
                  repairResult.code,
                  String(normalizedOptions.collabDomain || normalizedOptions.mode || 'p5'),
                );
                if (repairValidation.valid) {
                  const repairCode = repairValidation.cleanedCode;

                  await normalizedOptions.onCandidateGenerated?.({
                    iteration,
                    candidateIndex: winnerIndex,
                    kind: 'repair',
                    code: repairCode,
                  });

                  // Evaluate repair candidate using the same path
                  let repairEval: RalphQualityEvaluation;
                  let repairLirContext: LIREvaluationContext | undefined;

                  if (normalizedOptions.lirEnabled) {
                    try {
                      const { GeneratedCodeParser } = await import('./lir/GeneratedCodeParser.js');
                      const genParser = new GeneratedCodeParser();
                      const lirTokens = genParser.parse(repairCode);
                      if (lirTokens.length > 0) {
                        repairLirContext = {
                          lirTokens,
                          visualIntent: normalizedOptions.visualMappingParams as unknown as VisualMappingParams,
                          lirEnabled: true,
                        };
                      }
                    } catch {
                      // ignore LIR parse errors for repair
                    }
                  }

                  if ((evalMode === 'auto' || evalMode === 'strict-browser') && !isAudioDomain(normalizedOptions.collabDomain)) {
                    const { HeadlessRenderer } = await import('../render/HeadlessRenderer.js');
                    const renderer = HeadlessRenderer.getInstance();
                    const renderEvidence = await renderer.renderWithEvidence(repairCode, {
                      domain: (normalizedOptions.collabDomain || 'p5') as import('../render/HeadlessRenderer.js').RenderDomain,
                      width: 400,
                      height: 400,
                    });
                    await normalizedOptions.onRenderedEvidence?.({
                      iteration, candidateIndex: winnerIndex, kind: 'repair',
                      code: repairCode, evidence: renderEvidence,
                    });
                    assertCompleteRenderedEvidence(renderEvidence);

                    if (renderEvidence.infraUnavailable) {
                      logEvaluatorDegradation({
                        model: lastModel,
                        provider: env('LLM_PROVIDER'),
                        domain: String(normalizedOptions.collabDomain || 'p5'),
                        prompt,
                        code: repairCode,
                        reason: 'Browser render infrastructure is unavailable; using legacy repair scoring.',
                        iteration,
                      });
                      const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
                      const quickRepairEval = await scoringEngine.scoreReliable({
                        output: repairCode,
                        criteria: normalizedOptions.evaluationCriteria,
                        lirContext: repairLirContext,
                      });
                      repairEval = qualityEvaluationFromGenerationEvaluation(
                        buildGenerationEvaluationFromReliableScore(quickRepairEval, {
                          failureClass: 'infra',
                          reason: 'Browser render infrastructure is unavailable during repair evaluation.',
                        }),
                      );
                    } else {
                      const { scoreRenderedEvidence } = await import('../core/ScoringEngine.js');
                      const genEvalRepair = await scoreRenderedEvidence(
                        renderEvidence,
                        repairCode,
                        prompt,
                        undefined,
                        String(normalizedOptions.collabDomain || 'p5'),
                      );
                      if (genEvalRepair.failureClass === 'parse') {
                        logEvaluatorDegradation({
                          model: lastModel,
                          provider: env('LLM_PROVIDER'),
                          domain: String(normalizedOptions.collabDomain || 'p5'),
                          prompt,
                          code: repairCode,
                          reason: genEvalRepair.reasoning ?? 'Evaluator response could not be parsed; keeping degraded repair score.',
                          iteration,
                        });
                      }
                      if (genEvalRepair.failureClass === 'scorer') {
                        if (evalMode === 'strict-browser') {
                          throw new SinterError(
                            'Evaluator LLM is unavailable in strict-browser mode',
                            'ERR_EVALUATOR_UNAVAILABLE',
                          );
                        }
                        if (hasFailedRenderMeasure(genEvalRepair)) {
                          Logger.warn('RalphLoop', 'Evaluator LLM unavailable but repair render measurement failed; keeping objective render penalty');
                          repairEval = qualityEvaluationFromGenerationEvaluation(genEvalRepair);
                        } else {
                          Logger.warn('RalphLoop', 'Evaluator LLM unavailable for rendered-evidence repair scoring, falling back to legacy scoring');
                          logEvaluatorDegradation({
                            model: lastModel,
                            provider: env('LLM_PROVIDER'),
                            domain: String(normalizedOptions.collabDomain || 'p5'),
                            prompt,
                            code: repairCode,
                            reason: genEvalRepair.reasoning ?? 'Evaluator LLM is unavailable; using legacy repair scoring.',
                            iteration,
                          });
                          const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
                          const quickRepairEval = await scoringEngine.scoreReliable({
                            output: repairCode,
                            criteria: normalizedOptions.evaluationCriteria,
                            lirContext: repairLirContext,
                          });
                          repairEval = qualityEvaluationFromGenerationEvaluation(
                            buildGenerationEvaluationFromReliableScore(quickRepairEval, {
                              failureClass: 'scorer',
                              reason: genEvalRepair.reasoning ?? 'Evaluator LLM is unavailable during repair evaluation.',
                            }),
                          );
                        }
                      } else {
                        repairEval = qualityEvaluationFromGenerationEvaluation(genEvalRepair);
                      }
                    }
                  } else {
                    const scoringEngine = new ScoringEngine(normalizedOptions.evaluationStrategy ?? 'detailed');
                    repairEval = await scoringEngine.scoreReliable({
                      output: repairCode,
                      criteria: normalizedOptions.evaluationCriteria,
                      lirContext: repairLirContext,
                    });
                    // W1.2: heuristic repair evaluation is display-only (degraded).
                    repairEval.failureClass = 'legacy';
                  }

                  // Incumbent preservation: only replace if repair is better or equal —
                  // and only when the repair's own evaluation is honest (W1.2). A
                  // degraded repair evaluation (evaluator outage mid-repair, legacy
                  // heuristic) must not displace an honest incumbent.
                  const repairEvalHonest = isHonestFitnessScore(repairEval.confidence, repairEval.failureClass);
                  if (repairEvalHonest && repairEval.score >= evaluation.score) {
                    // eslint-disable-next-line require-atomic-updates -- sequential loop, no concurrent mutation
                    currentCode = repairCode;
                    evaluation = repairEval;
                    if (normalizedOptions.chatMode) {
                      normalizedOptions.onThought?.(`Repair improved score to ${evaluation.score.toFixed(2)}`);
                    }
                  } else if (normalizedOptions.chatMode) {
                    if (!repairEvalHonest) {
                      normalizedOptions.onThought?.('Repair evaluation was degraded — keeping incumbent');
                    } else {
                      normalizedOptions.onThought?.(`Repair did not improve (score ${repairEval.score.toFixed(2)}), keeping incumbent`);
                    }
                  }
                }
              }
            }
          } catch (repairError) {
            Logger.warn('RalphLoop', 'Single-round repair failed:', repairError instanceof Error ? repairError.message : repairError);
            if (normalizedOptions.chatMode) {
              normalizedOptions.onThought?.('Repair attempt failed, continuing with incumbent');
            }
          }
          logStageTiming(`iter${iteration}:repair`, repairStartedAt);
        }
        evaluationDurationMs = Math.max(0, Date.now() - evaluationPhaseStartedAt);
        logStageTiming(`iter${iteration}:evaluate(total)`, evaluationPhaseStartedAt);

        // Enforce the runtime-validity gate. An invalid runtime result (e.g. a
        // GLSL shader with no main()/fragment output) must FAIL the candidate so
        // the loop retries — not be silently accepted. Cap the score to a failing
        // value and tag it 'validator' so the iteration gate cannot break on it.
        if (!runtimeValid) {
          evaluation.score = Math.min(evaluation.score, 0.2);
          evaluation.failureClass = 'validator';
          evaluation.issues = [
            ...(evaluation.issues ?? []),
            `[runtime] ${runtimeError}`,
          ];
        }

        // Record evaluation for repeated-failure detection
        repairHistory.push(generationEvaluationFromQualityEvaluation(evaluation));

        // W1.2: one honesty verdict for this iteration's settled evaluation,
        // consumed by the intuition, best-candidate and convergence gates below.
        // A degraded evaluation (scorer/infra/validator/legacy or zeroed
        // confidence) is displayable but is NOT a fitness signal.
        const evaluationHonest = isHonestFitnessScore(evaluation.confidence, evaluation.failureClass);

        const shouldRunHumanPerception = normalizedOptions.useHumanPerceptionGuardrails;
        let aestheticScore = evaluation.dimensions?.aesthetic ?? evaluation.dimensions?.creative ?? 0;
        let humanPerceptionPassed: boolean | undefined;
        let humanPerceptionIssues: string[] | undefined;

        // Layer 2 creative-form critics: run AestheticCritic only when explicitly enabled
        if (normalizedOptions.useAestheticGuardrails) {
          try {
            const { AestheticCritic } = await import('../aesthetic/index.js');
            const critic = new AestheticCritic();
            // Wire LLM client for dual-path evaluation (LLM-as-Judge + heuristic)
            try {
              const llmForCritic = new LLMClient({ role: 'evaluator' });
              critic.setLLMClient(llmForCritic as unknown as LLMClientLike);
            } catch (err) {
              Logger.debug('RalphLoop', 'LLM client creation for AestheticCritic failed, heuristic-only path will be used:', err);
              // LLM client creation failed — heuristic-only path will be used
            }
            // When this iteration produced render evidence, route through the
            // LLM judge WITH the screenshot so the aesthetic score reflects the
            // rendered artifact, not code alone. critiqueWithLLM falls back to
            // the heuristic critics when no LLM client is wired. Without render
            // evidence, keep the existing heuristic path untouched.
            const aestheticConfig = normalizedOptions.aestheticConfig as unknown as Partial<import('../aesthetic/types.js').CriticConfig>;
            const aestheticReport = iterationScreenshot
              ? await critic.critiqueWithLLM(
                  currentCode,
                  String(normalizedOptions.collabDomain || 'p5'),
                  aestheticConfig,
                  [iterationScreenshot],
                )
              : critic.critique(
                  currentCode,
                  aestheticConfig,
                  lirContext,  // Pass LIR context for structured evaluation
                );
            aestheticScore = aestheticReport.score;

            // Critic agreement (HybridJudge's synthesizer): when the code scorer and the aesthetic critic
            // disagree sharply the score is less trustworthy, so say so in the feedback. Default off.
            if (process.env.LIMINAL_CRITIC_AGREEMENT === '1') {
              const { synthesize } = await import('../evaluation/ConfidenceSynthesizer.js');
              const agreement = synthesize(evaluation as unknown as import('./ScoringEngine.js').ScoringResult, aestheticReport);
              if (agreement.agreement === 'major-divergence') {
                evaluation.issues = [...(evaluation.issues ?? []),
                  `[critics] code score ${evaluation.score.toFixed(2)} and aesthetic ${aestheticReport.score.toFixed(2)} diverge sharply; trust neither alone`];
              }
            }

            // Apply penalty if violations detected. The penalty scales with how
            // far the aesthetic score falls BELOW the threshold — a worse score
            // gets a bigger penalty (the old code multiplied by the raw score,
            // which did not track the threshold gap honestly).
            if (!aestheticReport.passed) {
              const { DEFAULT_DESIGN_CONSTRAINTS } = await import('../aesthetic/index.js');
              const configThreshold = (normalizedOptions.aestheticConfig as
                | { constraints?: { general?: { minAestheticScore?: number } } }
                | undefined)?.constraints?.general?.minAestheticScore;
              const threshold = typeof configThreshold === 'number'
                ? configThreshold
                : DEFAULT_DESIGN_CONSTRAINTS.general.minAestheticScore;
              const penaltyFactor = aestheticPenaltyFactor(aestheticReport.score, threshold);
              evaluation.score = evaluation.score * penaltyFactor;

              // Append violations to issues for next iteration feedback
              const aestheticIssues = aestheticReport.violations
                .filter(v => v.severity === 'error' || v.severity === 'warning')
                .map(v => `[aesthetic] ${v.rule}: ${v.message}`);
              if (evaluation.issues) {
                evaluation.issues = [...evaluation.issues, ...aestheticIssues];
              }
            }
          } catch (e) {
            // Aesthetic analysis failed gracefully — don't block generation
            normalizedOptions.onThought?.(`Aesthetic analysis skipped: ${e instanceof Error ? e.message : 'unknown error'}`);
          }
        }

        if (shouldRunHumanPerception) {
          try {
            const { evaluateCodePerception } = await import('../perception/index.js');
            const perceptionReport = evaluateCodePerception(
              currentCode,
              String(normalizedOptions.collabDomain || normalizedOptions.mode || 'p5'),
            );
            humanPerceptionPassed = perceptionReport.passed;
            humanPerceptionIssues = perceptionReport.issues.map(issue => issue.id);
            if (!perceptionReport.passed) {
              evaluation.score = evaluation.score * 0.85;
              const perceptionIssues = perceptionReport.issues
                .filter(issue => issue.severity === 'error' || issue.severity === 'warning')
                .map(issue => `[human-perception] ${issue.id}: ${issue.message}`);
              evaluation.issues = [...(evaluation.issues ?? []), ...perceptionIssues];
            }
          } catch (e) {
            normalizedOptions.onThought?.(`Human perception analysis skipped: ${e instanceof Error ? e.message : 'unknown error'}`);
          }
        }

        // W4: LOOP_EVALUATION is DISPLAY/OBSERVABILITY — event stream for UI and
        // CortexPerceptionBus. Intentionally emits degraded scores so operators see
        // what the evaluator actually returned; suppressing them would hide failures.
        // Not a fitness consumer (no banking, selection, or adaptive policy).
        eventBus.emit(EventTypes.LOOP_EVALUATION, 'RalphLoop', {
          iteration,
          overallScore: evaluation.score,
          technicalScore: evaluation.dimensions?.technical ?? 0,
          aestheticScore,
          ...(humanPerceptionPassed === undefined ? {} : { humanPerceptionPassed }),
          ...(humanPerceptionIssues === undefined ? {} : { humanPerceptionIssues }),
          noveltyScore: evaluation.dimensions?.novelty ?? 0,
        });

        // Intuition-based scoring: advisory only, no score blending.
        // W1.2: gated on the honesty predicate — a degraded evaluation must not
        // teach the intuition engine that a fabricated score is a real outcome.
        if (normalizedOptions.useIntuition && candidates.length > 0 && evaluationHonest) {
          try {
            const { IntuitionEngine } = await import('../intuition/index.js');
            const intuitionEngine = new IntuitionEngine();
            await intuitionEngine.load();
            // Record outcome for future learning (advisory only, no score blending),
            // then persist so the next run's generateHint can read it back.
            intuitionEngine.recordOutcome(currentCode, String(normalizedOptions.collabDomain), evaluation.score, lastModel);
            await intuitionEngine.save();
          } catch (e) {
            normalizedOptions.onThought?.(`Intuition recording skipped: ${e instanceof Error ? e.message : 'unknown error'}`);
          }
        }

        // Render-based scoring: if enabled, render code and blend with syntactic score
        // Skip the legacy RenderAndScorePipeline in auto/strict-browser modes to avoid double work
        if (normalizedOptions.useRenderScoring && candidates.length > 0 && evalMode === 'legacy') {
          try {
            if (normalizedOptions.chatMode) {
              normalizedOptions.onThought?.('Running render-based quality analysis...');
            }

            const { RenderAndScorePipeline } = await import('../render/RenderAndScorePipeline.js');
            const pipeline = new RenderAndScorePipeline(normalizedOptions.renderScoringOptions);

            const renderResult = await pipeline.process(currentCode, normalizedOptions.collabDomain === Domain.BLENDER ? 'blender' : undefined);

            if (renderResult.success) {
              // Blend render score with existing score
              const blendedScore = RenderAndScorePipeline.blendScores({
                baseScore: evaluation.score,
                renderScore: renderResult.score,
                renderWeight: 0.4,
                mode: 'adaptive',
              });

              const oldScore = evaluation.score;
              evaluation.score = blendedScore;

              if (normalizedOptions.chatMode) {
                normalizedOptions.onThought?.(`Render score: ${renderResult.score.toFixed(2)}, blended: ${blendedScore.toFixed(2)} (was ${oldScore.toFixed(2)})`);
                if (renderResult.warnings?.length) {
                  normalizedOptions.onThought?.(`Render warnings: ${renderResult.warnings.join(' | ')}`);
                }
              }
              if (renderResult.warnings?.length) {
                Logger.warn('RalphLoop', `Render scoring warnings: ${renderResult.warnings.join(' | ')}`);
              }

              // Add render score info to dimensions
              if (!evaluation.dimensions) {
                evaluation.dimensions = {};
              }
              evaluation.dimensions.render = renderResult.score;

              // Log render details
              if (renderResult.visual) {
                Logger.debug('RalphLoop', `Visual score: ${renderResult.visual.score.toFixed(2)} (color: ${renderResult.visual.colorVariety.toFixed(2)}, edges: ${renderResult.visual.edgeComplexity.toFixed(2)})`);
              }
              if (renderResult.audio) {
                Logger.debug('RalphLoop', `Audio score: ${renderResult.audio.score.toFixed(2)} (freq: ${renderResult.audio.frequencyVariety.toFixed(2)}, dynamics: ${renderResult.audio.dynamics.toFixed(2)})`);
              }
            } else {
              Logger.warn('RalphLoop', `Render scoring failed: ${renderResult.error}`);
              if (normalizedOptions.chatMode) {
                normalizedOptions.onThought?.(`Render analysis skipped: ${renderResult.error}`);
              }
            }

            // Clean up resources
            await pipeline.close();
          } catch (renderError) {
            Logger.warn('RalphLoop', 'Render scoring error:', renderError);
            if (normalizedOptions.chatMode) {
              normalizedOptions.onThought?.('Render analysis unavailable');
            }
          }
        }

        // Save iteration context and update final score before quality/success gates
        // so that callbacks and finalScore are set even when breaking early
        const iterationContext: IterationContext = {
          iteration,
          prompt: loadedPrompt,
          usedPrompt,
          code: currentCode,
          evaluation: {
            score: evaluation.score,
            issues: evaluation.issues ?? [],
            confidence: evaluation.confidence ?? 1,
            failureClass: evaluation.failureClass ?? 'none',
          },
          timestamp: new Date().toISOString(),
          maxIterations: normalizedOptions.maxIterations,
          selectedCandidateIndex: candidates.length > 0 ? (candidates[winnerIndex]?.index ?? winnerIndex) : 0,
          numCandidatesGenerated: numCandidates,
          generatorThinking: lastThinking,
          generatorModel: lastModel,
          evaluatorReasoning: evaluation.evaluatorReasoning ?? extractScoringReasoning(evaluation),
          evaluatorRepairAdvice: evaluation.repairAdvice,
          stageTimings: [
            { label: 'Generate', durationMs: generationDurationMs },
            { label: 'Evaluate', durationMs: evaluationDurationMs },
          ],
        };
        ContextAccumulation.save(iterationContext);
        normalizedOptions.onIteration?.(iterationContext);
        finalScore = evaluation.score;
        finalConfidence = evaluation.confidence ?? 1;
        finalFailureClass = evaluation.failureClass ?? 'none';
        finalEvaluation = generationEvaluationFromQualityEvaluation(evaluation);
        // Remember the highest-scoring candidate that also passes the final
        // validation gate, so a later regression or an invalid last iteration
        // can't discard earlier good work. W1.2: degraded evaluations are
        // ignored — a fabricated 0.99 must never displace an honest 0.80.
        if (evaluation.score > bestScore && evaluationHonest) {
          const domainForValidation = String(normalizedOptions.collabDomain || normalizedOptions.mode || 'p5');
          if (CodeValidator.validate(currentCode, domainForValidation).valid) {
            bestScore = evaluation.score;
            bestCode = currentCode;
            bestConfidence = evaluation.confidence ?? 1;
            bestFailureClass = evaluation.failureClass ?? 'none';
            bestEvaluation = generationEvaluationFromQualityEvaluation(evaluation);
            bestThinking = lastThinking;
            bestProvider = lastProvider;
            bestModel = lastModel;
            bestActiveAdaptationIds = [...lastActiveAdaptationIds];
          }
        }
        let persistedCurrentIteration = false;
        const promiseDetected = PromiseDetector.detect(currentCode);

        normalizedOptions.onProgress?.({
          iteration,
          score: evaluation.score,
          promiseDetected,
          code: currentCode,
          timestamp: iterationContext.timestamp,
        });

        if (normalizedOptions.signal?.aborted) {
          reason = 'aborted by user';
          break;
        }

        // Persist before any break gate below. High-quality first iterations can
        // stop immediately, but they still need gallery and run artifacts.
        previousCode = currentCode;
        const persistStartedAt = Date.now();
        await persistence.saveIteration(iteration, currentCode);
        await persistence.saveMergeStep(iteration);
        logStageTiming(`iter${iteration}:persist:gallery`, persistStartedAt);
        persistedCurrentIteration = true;

        if (normalizedOptions.signal?.aborted) {
          reason = 'aborted by user';
          break;
        }

        const gateDecision = creativeIterationGate.decide({
          iteration,
          prompt,
          score: evaluation.score,
          evaluationConfidence: evaluation.confidence ?? 1,
          evaluationFailureClass: evaluation.failureClass ?? 'none',
          isComplete,
          maxIterations: normalizedOptions.maxIterations,
          minQualityScore: normalizedOptions.minQualityScore,
          domainQualityThresholds: normalizedOptions.domainQualityThresholds,
          collabDomain: normalizedOptions.collabDomain,
          disableIterationExtension: normalizedOptions._disableIterationExtension,
        });
        const domain = gateDecision.domain;
        if (gateDecision.logMessage) {
          Logger.info('RalphLoop', gateDecision.logMessage);
        }
        if (gateDecision.maxIterations !== normalizedOptions.maxIterations) {
          normalizedOptions.maxIterations = gateDecision.maxIterations;
          if (normalizedOptions.chatMode && gateDecision.thought) {
            normalizedOptions.onThought?.(gateDecision.thought);
          }
        }
        // Archive learning: store high-quality outputs BEFORE any early-exit so the
        // accepted/break-triggering output is captured — not just the non-final
        // intermediate iterations. Without this, a gen that achieves the quality
        // threshold on its FIRST iteration (common for tone/ascii/kinetic/textgen)
        // breaks here and never archives, so those domains never accumulate.
        const archiveEvalConfidence = evaluation.confidence ?? 1;
        const archiveEvalFailureClass = evaluation.failureClass ?? 'none';
        // Only HONEST scores become few-shot exemplars. A degraded score (LLM scorer/infra
        // failure → confidence 0, keyword fallback) readily clears 0.65 and would then bias
        // every future generation toward a fabricated exemplar. 'none'/'render' are real
        // signals (render = deterministic luminance measure applied); 'scorer'/'infra' are
        // degraded and must not be persisted as quality exemplars.
        const isHonestScore = isHonestFitnessScore(evaluation.confidence, evaluation.failureClass);
        if (archiveLearning && evaluation.score >= 0.65 && isHonestScore) {
          const archiveAddStartedAt = Date.now();
          const archiveMetadata: Record<string, unknown> = {
            iteration,
            domain: normalizedOptions.collabDomain || 'p5',
            evaluationConfidence: archiveEvalConfidence,
            evaluationFailureClass: archiveEvalFailureClass,
          };
          if (evaluation.renderMeasure) archiveMetadata.renderMeasure = evaluation.renderMeasure;
          await archiveLearning.addOutput(
            loadedPrompt, currentCode,
            normalizedOptions.collabDomain || 'p5',
            evaluation.score,
            archiveMetadata,
          );
          logStageTiming(`iter${iteration}:archive:add-output`, archiveAddStartedAt);
        } else if (archiveLearning && evaluation.score >= 0.65) {
          Logger.info(
            'RalphLoop',
            `archive: skipped degraded exemplar (score ${evaluation.score.toFixed(2)}, ` +
              `confidence ${archiveEvalConfidence}, failureClass ${archiveEvalFailureClass}) — ` +
              `not a trustworthy fitness signal`,
          );
        }

        if (gateDecision.shouldBreak) {
          completed = gateDecision.completed;
          reason = gateDecision.reason;
          break;
        }

        // Update evolution subsystems.
        // W4: always call update — novelty is behavior-only (display/diversity signal).
        // Fitness banking inside (MAP-Elites insert, aesthetic-model rating) is gated
        // on evaluationHonest so fabricated scores never train selection.
        const evolutionStartedAt = Date.now();
        const { noveltyScore, hints } = evolution.update(
          iteration,
          currentCode,
          evaluation.score,
          prompt,
          evaluationHonest,
        );
        logStageTiming(`iter${iteration}:evolution:update`, evolutionStartedAt);

        // DF3 Phase 8: Feed score into EvolutionEngine.
        // W4: recentScores drives adaptive proposals (minQualityScore, temperature,
        // prompt prefixes) — pure fitness. Skip degraded scores so policy never
        // adapts to keyword/neutral fallbacks.
        if (evolutionEngine && evaluationHonest) {
          recentScores.push(evaluation.score);
        }

        // B5: route the aesthetic-model hint through ContextAccumulation so it
        // survives into iteration N+1. Appending to `usedPrompt` was dead: that
        // variable is rebuilt from scratch at the top of every iteration and is
        // computed AFTER generation, so the hint never reached the next prompt.
        // buildContextForInjection reads `evaluation.issues` from history into the
        // prompt, so persisting the hint there is what actually feeds it forward.
        if (hints) {
          ContextAccumulation.save({
            iteration: iteration + 0.2,
            prompt,
            usedPrompt: '',
            code: '',
            evaluation: {
              score: 0,
              issues: [hints.trim()],
              aestheticModelHint: hints.trim(),
            },
            timestamp: new Date().toISOString(),
            maxIterations: normalizedOptions.maxIterations,
          });
        }

        // Auto-compost retains material for exploration only. CompostMill's
        // generation projection is empty, so scalar scores cannot become teaching.
        if (
          normalizedOptions.autoCompost &&
          evaluationHonest &&
          evaluation.score >= 0.7 &&
          normalizedOptions.project
        ) {
          try {
            const compostConfig = mergeCompostConfig();
            const heap = new CompostHeap(compostConfig);
            const tempDir = path.join(normalizedOptions.galleryDir, normalizedOptions.project);
            const codePath = path.join(tempDir, `v${iteration}.js`);
            const fs = await import('node:fs/promises');
            await fs.mkdir(tempDir, { recursive: true });
            await fs.writeFile(codePath, currentCode, 'utf-8');
            await heap.addFile(codePath);
            eventBus.emit(EventTypes.COMPOST_STAGE, 'RalphLoop', {
              stage: 'auto-compost',
              message: `Auto-fed iteration ${iteration} (score: ${evaluation.score.toFixed(2)}) to compost heap`,
            });
            if (await heap.isOverCapacity()) {
              const { openCompostMill } = await import('../compost/openCompostMill.js');
              const mill = openCompostMill({ llm: new LLMClient({ role: 'generator' }), projectStore, config: compostConfig });
              await mill.digest();
              compostMaterials = await mill.getGenerationMaterials(normalizedOptions.collabDomain || 'p5');
              eventBus.emit(EventTypes.COMPOST_STAGE, 'RalphLoop', {
                stage: 'auto-digest',
                message: 'Heap at capacity — triggered auto-digest',
              });
            }
          } catch (err) {
            Logger.warn('RalphLoop', 'Auto-compost failed:', err);
          }
        }

        // Guidance: check for proactive suggestions.
        // B11: consult the GuidanceEngine on the AUTONOMOUS (non-chat) path too,
        // not only in chatMode. The MetaHarness→HarnessMemory→GuidanceEngine
        // feed-forward (e.g. createSessionTasteSuggestion / archive suggestions)
        // only reached the main learning loop when chatMode was true; the daemon
        // run() path got none of it. Now updateIteration + suggestNextAction run
        // whenever a guidanceEngine is present; the onSuggestion CALLBACK stays
        // chat-only because it is a UI streaming hook.
        //
        // W4 FIX R1 classification: ADVISORY/DISPLAY — not fitness.
        // updateIteration + suggestNextAction only drive Suggestion objects
        // delivered via onSuggestion (chat UI). They do not bank exemplars,
        // train selection, or change generation policy/numCandidates. Degraded
        // scores may slightly change chat suggestion text (plateau/trend
        // heuristics) but never become fitness. Intentionally ungated.
        if (normalizedOptions.guidanceEngine) {
          const guidance = normalizedOptions.guidanceEngine;
          // Update iteration tracking for guidance
          if (guidance.updateIteration) {
            guidance.updateIteration(iteration, evaluation.score);
          }
          // Get suggestions (consults the forward-read HarnessMemory signals)
          const suggestions = guidance.suggestNextAction({
            prompt: loadedPrompt,
            domain: normalizedOptions.collabDomain as unknown as import('../chat/types.js').Domain,
            techniques: [],
            constraints: [],
            references: [],
            iteration,
            currentScore: evaluation.score,
          });
          if (normalizedOptions.chatMode) {
            for (const suggestion of suggestions) {
              normalizedOptions.onSuggestion?.(suggestion);
            }
          }
        }

        // Routing bandit: outcomes are recorded at owner review (LiminalProductCommandPort), not here.

        // Store previous code before saving current iteration
        if (!persistedCurrentIteration) {
          previousCode = currentCode;

          // Persist to gallery
          await persistence.saveIteration(iteration, currentCode);
          await persistence.saveMergeStep(iteration);
          persistedCurrentIteration = true;

          // Attempt video render for video-domain code (revideo/hyperframes)
          try {
            const detectedDomain = CodeValidator.detectDomain(currentCode);
            if (detectedDomain === 'revideo' || detectedDomain === 'hyperframes') {
              const { Exporter } = await import('../export/Exporter.js');
              const videoFs = await import('node:fs/promises');
              const videoOutDir = path.join(normalizedOptions.galleryDir, normalizedOptions.project, 'video');
              await videoFs.mkdir(videoOutDir, { recursive: true });
              const videoPath = path.join(videoOutDir, `v${iteration}-${detectedDomain}.mp4`);
              const exporter = new Exporter();
              await exporter.exportVideo(currentCode, videoPath, { domain: detectedDomain, fps: 30 });
              Logger.info('RalphLoop', `Video rendered: ${videoPath}`);
              // Save video metadata alongside code iteration
              try {
                const gallery = new (await import('../gallery/Gallery.js')).Gallery(normalizedOptions.galleryDir);
                await gallery.saveVideoIteration(normalizedOptions.project, iteration, currentCode, videoPath, detectedDomain);
              } catch (galleryErr) {
                Logger.warn('RalphLoop', 'Failed to save video iteration metadata:', galleryErr instanceof Error ? galleryErr.message : galleryErr);
              }
            }
          } catch (videoErr) {
            // Non-blocking: video render failure should not stop the loop
            Logger.warn('RalphLoop', 'Video render skipped:', videoErr instanceof Error ? videoErr.message : videoErr);
          }
        }

        // Git: auto-commit iteration (agent manages this behind the scenes)
        const gitCommitStartedAt = Date.now();
        await gitIntegration.commitIteration({
          prompt: loadedPrompt,
          score: evaluation.score,
          iteration,
          code: currentCode,
          filePath: path.join(normalizedOptions.galleryDir, normalizedOptions.project, `v${iteration}.js`),
          model: lastModel,
        });
        logStageTiming(`iter${iteration}:git:commit-iteration`, gitCommitStartedAt);

        // Track score history for convergence detection. W1.2: degraded
        // evaluations are absent from the window — a plateau of fabricated
        // scores is not evidence of convergence.
        if (evaluationHonest) {
          scoreHistory.push(evaluation.score);
        }

        // Stagnation + success-rate tracking are FITNESS/POLICY:
        // stagnation.check updates bestScore, plateau counters, and an internal
        // SuccessRateTracker; exploreAggressively then drives the outer
        // successRateTracker.recordAttempt → getRecommendedCandidates (more
        // candidates) and shouldExploreAggressively generation-policy flips.
        // A degraded 0.75 would count as success, reset plateaus, and suppress
        // needed exploration. W4 FIX R1: skip entirely when not honest.
        if (evaluationHonest) {
          const stagnationResult = stagnation.check(iteration, evaluation.score, noveltyScore, prompt, domain);

          // Log exploration mode changes
          if (stagnationResult.exploreAggressively !== undefined) {
            const wasExploring = successRateTracker.shouldExploreAggressively();
            successRateTracker.recordAttempt(evaluation.score >= 0.7);
            const isExploring = successRateTracker.shouldExploreAggressively();

            if (!wasExploring && isExploring) {
              Logger.info('RalphLoop', `Entering high-exploration mode (success rate: ${(stagnationResult.successRate ?? 0).toFixed(2)})`);
              if (normalizedOptions.chatMode) {
                normalizedOptions.onThought?.('Success rate dropped — increasing exploration...');
              }
            } else if (wasExploring && !isExploring) {
              Logger.info('RalphLoop', `Exiting high-exploration mode (success rate: ${successRateTracker.getSuccessRate().toFixed(2)})`);
              if (normalizedOptions.chatMode) {
                normalizedOptions.onThought?.('Success rate recovered — returning to normal mode');
              }
            }
          }

          if (stagnationResult.shouldBreak) {
            reason = stagnationResult.reason;
            break;
          }
        }

        // Convergence detection: stop if score hasn't improved by >0.01 in 3 iterations
        if (scoreHistory.length >= CONVERGENCE_WINDOW) {
          const recentScores = scoreHistory.slice(-CONVERGENCE_WINDOW);
          const maxInWindow = Math.max(...recentScores);
          const minInWindow = Math.min(...recentScores);
          const improvement = maxInWindow - minInWindow;

          if (improvement < CONVERGENCE_THRESHOLD) {
            reason = `convergence detected (score plateau: ${minInWindow.toFixed(3)}-${maxInWindow.toFixed(3)} over ${CONVERGENCE_WINDOW} iterations)`;
            Logger.info('RalphLoop', reason);
            break;
          }
        }

        eventBus.emit(EventTypes.LOOP_ITERATION, 'RalphLoop', {
          iteration,
          maxIterations: normalizedOptions.maxIterations,
          score: evaluation.score,
          promiseDetected,
          durationMs: Date.now() - startTime,
        });

        // Success gate: break if promise detected (indicates completion)
        if (promiseDetected) {
          completed = true;
          reason = 'promise detected in generated code';
          break;
        }

        // Check timeout
        const elapsed = (Date.now() - startTime) / 1000 / 60;
        if (elapsed > normalizedOptions.timeoutMinutes) {
          reason = `Timeout exceeded (${normalizedOptions.timeoutMinutes} minutes)`;
          break;
        }

        // DF3 Phase 8: Restore any temporarily mutated loop settings
        for (const restore of evoRestores) {
          restore();
        }

      } catch (error) {
        if (isAbortError(error) || normalizedOptions.signal?.aborted) {
          completed = false;
          reason = 'aborted by user';
          break;
        }

        // Report error to Meta-Harness (skip during tests to avoid log pollution)
        if (process.env.NODE_ENV !== 'test') {
          await metaHarness.onGenerationComplete({
            success: false,
            model: normalizedOptions.useSwarm ? 'swarm' : 'local',
            domain: normalizedOptions.collabDomain || Domain.P5,
            prompt: prompt,
            error: formatError('RalphLoop', error),
            duration: Date.now() - startTime,
          });
        }

        if (!normalizedOptions.tolerateErrors) {
          throw error;
        }

        // Loops are NOT starting fresh: a tolerated failure must still carry the last good code and the
        // error text into the next iteration. When there is nothing to carry, say so loudly.
        const errorText = error instanceof Error ? error.message : String(error);
        const lastGood = ContextAccumulation.getHistory().filter(h => h.code).at(-1);
        const carriedCode = previousCode || lastGood?.code || '';
        const carried = carriedCode.length > 0;
        ContextAccumulation.save({
          iteration: iteration + 0.5,
          prompt,
          usedPrompt: '',
          code: carriedCode,
          evaluation: {
            score: lastGood?.evaluation.score ?? 0,
            issues: [`iteration ${iteration} failed before it could be scored: ${errorText.slice(0, 300)}`],
            confidence: 0,
            failureClass: 'infra',
          },
          timestamp: new Date().toISOString(),
          maxIterations: normalizedOptions.maxIterations,
        });
        eventBus.emit(EventTypes.LOOP_ITERATION, 'RalphLoop', {
          iteration, error: errorText, carriedForward: carried, carriedCodeLength: carriedCode.length,
        });
        if (!carried) {
          Logger.warn('RalphLoop', `iteration ${iteration} failed and no earlier code exists: the next iteration carries only the error text (${errorText.slice(0, 200)})`);
        }
      }
    }

    // Set completion reason if not already set
    if (!reason) {
      if (iteration >= normalizedOptions.maxIterations) {
        reason = `max iterations reached (${normalizedOptions.maxIterations})`;
        completed = false;
      } else {
        reason = 'Loop terminated';
      }
    }

    } finally {
      // Git: end run, restore original branch (always cleanup)
      const gitEndRunStartedAt = Date.now();
      await gitIntegration.endRun(reason || 'loop ended', sessionId);
      logStageTiming('postloop:git-end-run', gitEndRunStartedAt);
    }

    try {
      const duration = Date.now() - startTime;

      // Report final result to Meta-Harness (skip during tests to avoid log pollution)
      if (process.env.NODE_ENV !== 'test') {
        const metaHarnessStartedAt = Date.now();
        await metaHarness.onGenerationComplete({
          success: completed,
          model: lastModel || (normalizedOptions.useSwarm ? 'swarm' : 'local'),
          domain: normalizedOptions.collabDomain || 'p5',
          prompt: prompt,
          code: currentCode,
          error: completed ? undefined : reason,
          duration: duration,
          thinking: lastThinking,
        });
        logStageTiming('postloop:meta-harness', metaHarnessStartedAt);
      }

      // Persist archive learning data
      if (qualityArchive) {
        const archiveSaveStartedAt = Date.now();
        await qualityArchive.save();
        logStageTiming('postloop:archive-save', archiveSaveStartedAt);
      }

      // Persist MAP-Elites and AestheticModel across runs
      if (normalizedOptions.useMapElites) {
        const mapElitesPath = `${homedir()}/.sinter/map_elites.json`;
        const mapElites = normalizedOptions._mapElites;
        if (mapElites) {
          await mapElites.save(mapElitesPath).catch((err) => {
            Logger.warn('RalphLoop', 'Failed to save MAP-Elites:', err instanceof Error ? err.message : err);
          });
        }
      }
      if (aestheticModel) {
        const aestheticPath = `${homedir()}/.sinter/aesthetic_model.json`;
        await aestheticModel.save(aestheticPath).catch((err) => {
          Logger.warn('RalphLoop', 'Failed to save aesthetic model:', err instanceof Error ? err.message : err);
        });
      }

      eventBus.emit(EventTypes.PROCESS_END, 'RalphLoop', {
        process: 'ralph-loop',
        success: completed,
        durationMs: Date.now() - startTime,
        reason,
        iterations: iteration,
        finalScore,
      });

      // Phase 5A: Record run in SinterFS
      let runArtifact: import('../fs/types.js').SinterObjectRef | undefined;
      if (currentCode) {
        try {
          runArtifact = liminalFs.writeArtifact({
            kind: 'generated-code',
            content: currentCode,
            filename: 'final.js',
            metadata: {
              project: normalizedOptions.project,
              iterations: iteration,
              finalScore,
              reason,
              duration,
              sessionId,
            },
          });
        } catch (err) {
          // Must not affect loop operation, but the final artifact is not recorded.
          Logger.warn('RalphLoop', 'SinterFS writeArtifact failed:', err);
        }
      }

      try {
        liminalFs.recordRun({
          runId: sessionId,
          prompt,
          project: normalizedOptions.project,
          status: completed ? 'completed' : 'suspended',
          artifacts: runArtifact ? [runArtifact] : [],
          metadata: {
            iterations: iteration,
            finalScore,
            reason,
            duration,
          },
        });
      } catch (err) {
        // Must not affect loop operation, but the final run record is lost.
        Logger.warn('RalphLoop', 'SinterFS recordRun (final) failed:', err);
      }

      // Prefer the best valid candidate over the last iteration. best-tracking
      // only stores the highest-scoring candidate that passes validation, so if
      // any valid candidate was seen we return it — this rescues a good earlier
      // result when a later iteration regresses or produces invalid code (which
      // the final gate would otherwise reject, throwing away usable work).
      const returnBest = bestScore >= 0;
      const swappedForBest = returnBest && bestCode !== currentCode;

      // Phase 5B: record this generation as emergence/garden experience so the
      // autonomy (garden), dreaming (recombination), taste and lineage systems can
      // learn from REAL runs — this closes the recursive self-improvement loop
      // (without it the emergence archive stays empty and the garden can never
      // learn). Guarded: must never affect loop operation; skipped under test.
      // W1.2: gated on the honesty predicate — a run whose reported evaluation is
      // degraded (or whose only scores are degraded) teaches the taste/emergence
      // systems nothing real, so it is never recorded as experience.
      const reportedConfidence = returnBest ? bestConfidence : finalConfidence;
      const reportedFailureClass = returnBest ? bestFailureClass : finalFailureClass;
      const reportedEvaluationHonest = isHonestFitnessScore(reportedConfidence, reportedFailureClass);
      if (process.env.NODE_ENV !== 'test' && currentCode && reportedEvaluationHonest) {
        const emergenceStartedAt = Date.now();
        try {
          const { EmergenceHooks } = await import('../emergence/EmergenceHooks.js');
          const { DreamArchiveSourceAdmission } = await import(
            '../dreaming/research/DreamArchiveSourceAdmission.js');
          const { createDreamRenderedEvidenceAuthority } = await import(
            '../dreaming/research/DreamResearchEvidence.js');
          const renderedEvidence = createDreamRenderedEvidenceAuthority();
          const creativeRun = await new EmergenceHooks(liminalFs, undefined,
            new DreamArchiveSourceAdmission(renderedEvidence.resolver)).onCreativeRun({
            output: returnBest && bestCode ? bestCode : currentCode,
            qualityScore: returnBest ? bestScore : finalScore,
            provenance: 'fresh-generation',
            seed: sessionId,
            runId: sessionId,
            runParams: {
              project: normalizedOptions.project,
              domain: normalizedOptions.collabDomain ?? 'p5',
              model: returnBest ? bestModel : lastModel,
            },
          });
          // B18: the onCreativeRun result must be CONSUMED, not discarded. The
          // novelty signal and quality-diversity placement outcome decide what the
          // archive keeps (incl. the novelty tie-break) — surface it so the
          // diversity decision is observable and the result is not dead-ended.
          Logger.info(
            'RalphLoop',
            `emergence placement: ${creativeRun.placement.outcome} ` +
              `(cell ${creativeRun.placement.cellId}, novelty ${creativeRun.signals.novelty.toFixed(2)}, ` +
              `accepted ${creativeRun.placement.accepted})`,
          );
        } catch (err) {
          // Emergence recording must not affect loop operation — but a persistent
          // failure here silently stops all archive/emergence learning while the
          // loop still looks healthy, so surface it (mirrors the routing handler).
          Logger.warn('RalphLoop', 'Failed to record emergence outcome:', err instanceof Error ? err.message : err);
        }
        logStageTiming('postloop:emergence-hooks', emergenceStartedAt);
      } else if (process.env.NODE_ENV !== 'test' && currentCode) {
        Logger.info(
          'RalphLoop',
          `emergence: skipped degraded run (failureClass ${reportedFailureClass}, confidence ${reportedConfidence}) — ` +
            `not recorded as taste/emergence experience`,
        );
      }

      const reportedCode = returnBest ? bestCode : currentCode;
      const reportedProvider = returnBest ? bestProvider : lastProvider;
      const reportedModel = returnBest ? bestModel : lastModel;
      const reportedAdaptationIds = returnBest
        ? bestActiveAdaptationIds
        : lastActiveAdaptationIds;
      const completionTimestamp = new Date().toISOString();
      if (reportedCode) {
        try {
          const recorded = await appendFitnessObservation({
            runId: sessionId,
            domain: String(normalizedOptions.collabDomain ?? normalizedOptions.mode ?? 'p5'),
            provider: reportedProvider,
            model: reportedModel,
            sourceCode: reportedCode,
            score: returnBest ? bestScore : finalScore,
            confidence: reportedConfidence,
            failureClass: reportedFailureClass,
            activeAdaptationIds: reportedAdaptationIds,
            timestamp: completionTimestamp,
            durationMs: duration,
          });
          // Additive generation.scored lane (#400): FitnessObservation v1 is the payload.
          if (recorded) {
            await emitRalphLoopScoringEvents(recorded.observation, duration);
          }
        } catch (error) {
          Logger.warn('RalphLoop', 'Failed to record fitness observation:', error);
        }
      }

      return {
        code: reportedCode,
        iterations: iteration,
        completed,
        reason: swappedForBest
          ? `${reason} (returned best valid candidate, score ${bestScore.toFixed(2)})`
          : reason,
        timestamp: completionTimestamp,
        duration,
        finalScore: returnBest ? bestScore : finalScore,
        evaluationConfidence: returnBest ? bestConfidence : finalConfidence,
        evaluationFailureClass: returnBest ? bestFailureClass : finalFailureClass,
        evaluation: returnBest ? bestEvaluation : finalEvaluation,
        project: normalizedOptions.project,
        thinking: returnBest ? bestThinking : lastThinking,
        provider: reportedProvider,
        model: reportedModel,
        activeAdaptationIds: reportedAdaptationIds,
      };
    } finally {
      try {
        liminalFs.close();
      } catch {
        // ignore close errors
      }
    }
  }

  /**
   * Get the current loop state
   */
  static getState(): { iteration: number; history: IterationContext[] } {
    const history = ContextAccumulation.getHistory();
    return { iteration: history.length, history };
  }

  /**
   * Reset the loop state
   */
  static reset(): void {
    ContextAccumulation.clear();
  }

  /**
   * Check if loop is currently running
   */
  static isRunning(): boolean {
    return ContextAccumulation.getHistory().length > 0;
  }

  /**
   * Get progress information for current loop
   */
  static getProgress(): { iteration: number; maxIterations?: number; progress: number } | null {
    const history = ContextAccumulation.getHistory();
    if (history.length === 0) return null;

    const mostRecentRealContext = [...history].reverse().find((context) => (
      Number.isInteger(context.iteration) && context.iteration > 0
    ));
    const mostRecentContext = (mostRecentRealContext ?? history[history.length - 1]) as IterationContext;
    const iteration = mostRecentContext?.iteration ?? history.length;
    const maxIterations = mostRecentContext?.maxIterations || DEFAULT_MAX_ITERATIONS;

    return {
      iteration,
      maxIterations,
      progress: Math.min(1, iteration / maxIterations),
    };
  }

  /**
   * Check if code is structurally complete (not cut off mid-function).
   * Delegates to the shared domain-aware helper so RalphLoop and LLMClient
   * agree on what "complete" means. When a domain is known, the check also
   * verifies a domain-appropriate terminal marker (e.g. p5 draw(), glsl main()).
   */
  static isCodeComplete(code: string, domain?: string): boolean {
    return isCodeComplete(code, domain);
  }
}

/**
 * Audio domains have no meaningful visual output, so headless browser-render
 * scoring captures only silence and scores valid code 0. They must be scored
 * from the code itself (scoreReliable) instead of rendered evidence.
 */
const AUDIO_DOMAINS = new Set(['tone', 'strudel']);
function isAudioDomain(domain?: string): boolean {
  return AUDIO_DOMAINS.has(String(domain || '').toLowerCase());
}

/**
 * Detect output type from generated code
 */
function detectOutputType(code: string): 'p5' | 'three' | 'glsl' | 'hydra' | 'strudel' | 'revideo' | 'unknown' {
  if (code.includes('function setup()') || code.includes('createCanvas')) {
    return 'p5';
  }
  if (code.includes('THREE.') || code.includes('WebGLRenderer')) {
    return 'three';
  }
  if (code.includes('void main') && code.includes('gl_FragColor')) {
    return 'glsl';
  }
  if (code.includes('.out(o0)') || code.includes('src(o0)')) {
    return 'hydra';
  }
  if (code.includes('.s(') && (code.includes('stack') || code.includes('$:'))) {
    return 'strudel';
  }
  if (code.includes('makeScene') || code.includes('@revideo')) {
    return 'revideo';
  }
  return 'unknown';
}
