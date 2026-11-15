/**
 * Sinter - Creative Coding Agent
 *
 * Main entry point for the creative coding agent with internal Ralph-Wiggum Loop
 * for generating emergent generative art.
 */

// Core Ralph-Wiggum Loop components
import { RalphLoop } from './core/RalphLoop.js';
import { writeTheorySidecar } from './utils/theorySidecar.js';
import { GuidanceEngine } from './chat/GuidanceEngine.js';
import { ValidationError } from './errors/ValidationError.js';
import { GenerationError } from './errors/GenerationError.js';
import { CodeValidator } from './core/CodeValidator.js';
import { CreativeEvaluator } from './core/CreativeEvaluator.js';
import { PromiseDetector } from './core/PromiseDetector.js';
import { PromptStore } from './core/PromptStore.js';
import { ContextAccumulation } from './core/ContextAccumulation.js';
import { createHash } from 'node:crypto';

// Core shared types
import type { CreativeFragment, FragmentOrigin } from './core/types.js';
import {
  seedToFragment,
  compostFragmentToFragment,
  minedFragmentToFragment,
  scavengerToFragment,
  isFromOrigin,
} from './core/types.js';

import { promptToGeneratorParams } from './utils/promptToGeneratorParams.js';
import { validatePrompt } from './utils/validation.js';
import { P5Generator } from './generators/p5/P5Generator.js';
import { ParticleSystem } from './generators/p5/ParticleSystem.js';
import { CellularAutomata } from './generators/p5/CellularAutomata.js';
import { FlowField } from './generators/p5/FlowField.js';
import { noise2D, noise3D, noiseSeed, flowField } from './generators/p5/Noise.js';

import { P5GeneratorLLM } from './generators/p5/P5GeneratorLLM.js';

// HTML Web Generator & ASCII Art Generator (imported for type exports only)
import type { HTMLGeneratorOptions as _HTMLGeneratorOptions } from './generators/html/HTMLWebGenerator.js';
import type { ASCIIOptions as _ASCIIOptions, ASCIIStyle as _ASCIIStyle } from './generators/ascii/ASCIIArtGenerator.js';

// Rendering and export
import { Renderer } from './render/Renderer.js';
import { PreviewServer } from './render/PreviewServer.js';
import { Exporter, type Project } from './export/Exporter.js';
import { Gallery, type Iteration } from './gallery/Gallery.js';
import { SeedArchive, type SeedMetadata } from './gallery/SeedArchive.js';
import { MapElites } from './evolution/MapElites.js';
import { NoveltyArchive } from './evolution/NoveltyArchive.js';
import { extractBehavior, detectDomain } from './evolution/BehaviorVectors.js';
import { AestheticModel } from './evolution/AestheticModel.js';
import { MetaMode } from './evolution/MetaMode.js';
import { SafetyGuardrails } from './core/SafetyGuardrails.js';

import { metaHarness } from './harness/MetaHarnessIntegration.js';
import { validateLLMConfig } from './config/schema.js';
import { generateVisuals } from './generateVisuals.js';
import { generateMusicToVisual } from './musicToVisual/generateMusicToVisual.js';
import { generateMusic } from './music/generateMusic.js';

import fs from 'fs/promises';
import path from 'path';
import { resolveOutputPath, assertSafeSegment } from './utils/normalizePath.js';
import { SERVICE_DEFAULTS } from './constants/index.js';

export const SINTER_VERSION = '2.4.0';

export interface SinterConfig {
  name: string;
  version: string;
  loop: {
    maxIterations: number;
    timeoutMinutes: number;
    completionPromise: string;
  };
  creative: {
    defaultFramework: 'p5.js';
    evaluationCriteria: string[];
    minQualityScore: number;
  };
  gallery: {
    autoSave: boolean;
    maxHistoryPerProject: number;
  };
  renderer: {
    port: number;
    screenshotOnIteration: boolean;
  };
}

export const defaultConfig: SinterConfig = {
  name: 'sinter',
  version: SINTER_VERSION,
  loop: {
    maxIterations: 20,
    timeoutMinutes: 30,
    completionPromise: 'COMPLETE',
  },
  creative: {
    defaultFramework: 'p5.js',
    evaluationCriteria: ['aesthetic', 'technical', 'novelty'],
    minQualityScore: 0.7,
  },
  gallery: {
    autoSave: true,
    maxHistoryPerProject: 50,
  },
  renderer: {
    port: SERVICE_DEFAULTS.PREVIEW_PORT,
    screenshotOnIteration: true,
  },
};

type SourceFileExtension = 'js' | 'svg' | 'txt' | 'py';

export function getSourceFileExtension(code: string): SourceFileExtension {
  const domain = CodeValidator.detectDomain(code);
  if (domain === 'svg') return 'svg';
  if (domain === 'ascii' || domain === 'textgen') return 'txt';
  if (domain === 'blender') return 'py';
  return 'js';
}

function isCurrentRunIteration(iteration: { timestamp: string }, runStartedAt: number): boolean {
  const timestamp = Date.parse(iteration.timestamp);
  return Number.isFinite(timestamp) && timestamp >= runStartedAt;
}

/**
 * Main run function for Liminal
 *
 * @param prompt - The creative prompt to generate from
 * @param options - Configuration options
 * @returns Result object with code, iterations, metadata
 */
export async function run(prompt: string, options: {
  maxIterations?: number;
  timeoutMinutes?: number;
  output?: string;
  project?: string;
  minQualityScore?: number;
  galleryDir?: string;
  seedCode?: string;
  seedTemplate?: string;
  tolerateErrors?: boolean;
  /** Optional creative options; when provided, evaluationCriteria is passed to RalphLoop and CreativeEvaluator. */
  creativeOptions?: { evaluationCriteria?: string[] };
  /** Progress callback: iteration number, score, promiseDetected, code, timestamp (streaming progress) */
  onProgress?: (data: { iteration: number; score: number; promiseDetected: boolean; code: string; timestamp: string }) => void;
  /** Optional AbortSignal to stop the run (Stop button) */
  signal?: AbortSignal;
  /** Enable swarm generation */
  /** @deprecated Use swarm.enabled instead */
  useSwarm?: boolean;
  /** Swarm generative mode */
  /** @deprecated Use swarm.mode instead */
  swarmMode?: string;
  /** Swarm configuration overrides */
  /** @deprecated Use swarm.config instead */
  swarmConfig?: Record<string, unknown>;
  /** New nested swarm options (preferred) */
  swarm?: import('./types/options/SwarmOptions.js').SwarmOptions;
  /** Enable intuition-based quality scoring dimension */
  useIntuition?: boolean;
  /** Enable cross-run archive learning: high-scoring outputs enrich a persistent
   *  QualityArchive that enhances future prompts (the self-improvement loop). */
  useArchiveLearning?: boolean;
  /** Path to the persistent quality archive (defaults to ~/.sinter/archive/quality_archive.json). */
  archivePath?: string;
  /** Creative domain to route generation + validation to (else defaults to p5). */
  collabDomain?: import('./types/domains.js').Domain;
  /** Enable the AestheticCritic "soul" guardrails in the quality gate. */
  useAestheticGuardrails?: boolean;
  /** Aesthetic critic configuration (preset/strictness/constraints). */
  aestheticConfig?: { preset?: string; strictness?: 'lenient' | 'moderate' | 'strict'; constraints?: Record<string, unknown> };
  /** Governed provider stages and their shared action-level call ceiling. */
  providerCallBudget?: import('./llm/ActionProviderBudget.js').ActionProviderBudgetPlan;
  /** Evaluation mode override; generation-only uses legacy local scoring. */
  evalMode?: import('./config/FeatureFlags.js').EvalMode;
  /** Fail unless the exact final candidate was persisted before evaluation. */
  requirePreEvaluationPersistence?: boolean;
} = {}): Promise<{
  code: string;
  iterations: number;
  completed: boolean;
  reason: string;
  timestamp: string;
  duration: number;
  finalScore: number;
  /** Confidence of the reported finalScore (0 = degraded/evaluator-offline fallback). */
  evaluationConfidence?: number;
  /** Failure class of the scorer; 'parse'/'scorer'/'infra'/'validator'/'legacy' mean finalScore is not real fitness ('legacy' still displays but is never banked). */
  evaluationFailureClass?: 'none' | 'render' | 'validator' | 'parse' | 'scorer' | 'infra' | 'legacy';
  project?: string;
  outputDir: string;
  prompt: string;
  htmlPath?: string;
  sourcePath?: string;
  jsPath?: string;
  zipPath?: string;
  /** For the `meta` custom domain: path to the `<artifact>.domain.json` descriptor sidecar. */
  domainSidecarPath?: string;
  thinking?: string;
  model?: string;
  providerCallBudget?: import('./llm/ActionProviderBudget.js').ActionProviderBudgetSnapshot;
  artifactDigest: string;
  preEvaluationArtifact?: {
    sourcePath: string;
    playablePath: string;
    manifestPath: string;
    artifactDigest: string;
    sourceDigest: string;
    playableDigest: string;
    persistedAt: string;
  };
  renderedEvidenceArtifact?: {
    receiptPath: string;
    receiptDigest: string;
    artifactDigest: string;
    earlyFramePath: string;
    earlyFrameDigest: string;
    lateFramePath: string;
    lateFrameDigest: string;
    evaluationReceiptPath?: string;
    evaluationReceiptDigest?: string;
  };
}> {
  const startTime = Date.now();

  const {
    maxIterations = 20,
    timeoutMinutes = 30,
    output = './output',
    project = 'default',
    minQualityScore = 0.7,
    galleryDir = 'gallery',
    seedCode,
    seedTemplate,
    tolerateErrors = false,
    creativeOptions,
    onProgress,
    signal
  } = options;

  const evaluationCriteria = creativeOptions?.evaluationCriteria ?? defaultConfig.creative.evaluationCriteria;

  try {
    // Validate config early
    const rawConfig = {
      baseUrl: process.env.LIMINAL_LLM_BASE_URL,
      apiKey: process.env.LIMINAL_LLM_API_KEY,
      model: process.env.LIMINAL_LLM_MODEL,
    };
    validateLLMConfig(rawConfig); // Fail fast on bad config

    // Validate input
    validatePrompt(prompt);

    const cwd = process.cwd();
    const outputResolved = resolveOutputPath(cwd, output);
    const galleryDirResolved = resolveOutputPath(cwd, galleryDir);
    assertSafeSegment(project, 'Project name');

    // Create output directory if it doesn't exist
    await fs.mkdir(outputResolved, { recursive: true });

    // B11: construct a GuidanceEngine for the autonomous (non-chat) run() path
    // too, mirroring ConversationManager's chatMode construction. Without this the
    // MetaHarness→HarnessMemory→GuidanceEngine feed-forward only reached the chat
    // loop, so the MAIN learning loop (the daemon's path) got none of it.
    const guidanceEngine = new GuidanceEngine();
    const exporter = new Exporter();
    const preEvaluationArtifacts = new Map<string, {
      sourcePath: string;
      playablePath: string;
      manifestPath: string;
      artifactDigest: string;
      sourceDigest: string;
      playableDigest: string;
      persistedAt: string;
    }>();
    const renderedEvidenceArtifacts = new Map<string, {
      receiptPath: string;
      receiptDigest: string;
      artifactDigest: string;
      earlyFramePath: string;
      earlyFrameDigest: string;
      lateFramePath: string;
      lateFrameDigest: string;
      evaluationReceiptPath?: string;
      evaluationReceiptDigest?: string;
    }>();

    // Run the Ralph-Wiggum Loop with all sophisticated components
    const loopResult = await RalphLoop.run(prompt, {
      maxIterations,
      timeoutMinutes,
      galleryDir: galleryDirResolved,
      project,
      tolerateErrors,
      minQualityScore,
      seedCode,
      seedTemplate,
      evaluationCriteria,
      onProgress,
      signal,
      swarm: options.swarm,
      // Legacy flat properties (deprecated, use swarm instead)
      useSwarm: options.useSwarm,
      swarmMode: options.swarmMode as import('./swarm/types.js').SwarmMode,
      swarmConfig: options.swarmConfig as Partial<import('./swarm/types.js').SwarmConfig>,
      useIntuition: options.useIntuition,
      useArchiveLearning: options.useArchiveLearning,
      archivePath: options.archivePath,
      collabDomain: options.collabDomain,
      // B8: forward the AestheticCritic guardrails so --aesthetic actually runs the
      // "soul" critic in the loop. These were dropped here, so even when bin/sinter
      // set useAestheticGuardrails the critic never ran in the autonomous path.
      useAestheticGuardrails: options.useAestheticGuardrails,
      aestheticConfig: options.aestheticConfig,
      // B11: wire the autonomous-path guidance engine into the loop.
      guidanceEngine,
      onCandidateGenerated: async ({ iteration, candidateIndex, kind, code }) => {
        const artifactDigest = createHash('sha256').update(code).digest('hex');
        const stem = `${project}-candidate-${iteration}-${candidateIndex + 1}-${kind}-${artifactDigest.slice(0, 12)}`;
        const sourcePath = path.join(outputResolved, `${stem}.${getSourceFileExtension(code)}`);
        const playablePath = path.join(outputResolved, `${stem}.html`);
        const manifestPath = path.join(outputResolved, `${stem}.pre-evaluation.json`);
        await exporter.exportHTML(code, playablePath);
        if (sourcePath.endsWith('.svg') || sourcePath.endsWith('.txt') || sourcePath.endsWith('.py')) {
          await fs.writeFile(sourcePath, code, 'utf-8');
        } else {
          await exporter.exportJS(code, sourcePath);
        }
        const sourceDigest = createHash('sha256')
          .update(await fs.readFile(sourcePath))
          .digest('hex');
        const playableDigest = createHash('sha256')
          .update(await fs.readFile(playablePath))
          .digest('hex');
        const persistedAt = new Date().toISOString();
        const artifact = { sourcePath, playablePath, manifestPath, artifactDigest, sourceDigest, playableDigest, persistedAt };
        await fs.writeFile(manifestPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
        preEvaluationArtifacts.set(artifactDigest, artifact);
      },
      onRenderedEvidence: async ({ code, evidence }) => {
        const artifactDigest = createHash('sha256').update(code).digest('hex');
        const source = preEvaluationArtifacts.get(artifactDigest);
        if (!source || !evidence.screenshot || !evidence.lateScreenshot) return;
        const stem = source.sourcePath.replace(/\.[^.]+$/, '');
        const earlyFramePath = `${stem}.early.png`;
        const lateFramePath = `${stem}.late.png`;
        const receiptPath = `${stem}.render-evidence.json`;
        await fs.writeFile(earlyFramePath, Buffer.from(evidence.screenshot.dataBase64, 'base64'));
        await fs.writeFile(lateFramePath, Buffer.from(evidence.lateScreenshot.dataBase64, 'base64'));
        const digestFile = async (file: string) => createHash('sha256')
          .update(await fs.readFile(file)).digest('hex');
        const earlyFrameDigest = await digestFile(earlyFramePath);
        const lateFrameDigest = await digestFile(lateFramePath);
        const receipt = {
          schemaVersion: 1, artifactDigest, sourceDigest: source.sourceDigest,
          playableDigest: source.playableDigest, earlyFramePath, earlyFrameDigest,
          lateFramePath, lateFrameDigest, framesDiffer: earlyFrameDigest !== lateFrameDigest,
          rendererEnvironmentDigest: evidence.rendererEnvironmentDigest,
          timingMs: evidence.timingMs, runtimeErrors: evidence.errors ?? [],
          logs: evidence.logs ?? [], audio: evidence.audio, playback: evidence.playback,
          interaction: evidence.interaction, containment: evidence.containment,
          infraUnavailable: evidence.infraUnavailable,
          candidateFailure: evidence.candidateFailure,
          capturedAt: new Date().toISOString(),
        };
        await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
        renderedEvidenceArtifacts.set(artifactDigest, {
          receiptPath, receiptDigest: await digestFile(receiptPath), artifactDigest,
          earlyFramePath, earlyFrameDigest, lateFramePath, lateFrameDigest,
        });
      },
      providerCallBudget: options.providerCallBudget,
      evalMode: options.evalMode,
    });

    // Final validation gate before saving. Pass the known domain so the gate
    // validates against it instead of re-detecting from content — otherwise a
    // valid non-p5 artifact (e.g. a short Strudel pattern) can be misdetected
    // as another domain (ASCII) and wrongly rejected.
    const finalValidation = CodeValidator.validate(loopResult.code, options.collabDomain);
    if (!finalValidation.valid) {
      throw new ValidationError('Generation failed validation', finalValidation.errors, {
          reason: loopResult.reason
        });
    }
    const finalCode = finalValidation.cleanedCode;
    // S4 completion (adversary finding): the -p/chat path also drops the
    // theory assessment. Persist it as a per-artifact sidecar so every
    // strudel-producing organ surfaces theory output (greppable acceptance).
    const artifactDigest = createHash('sha256').update(finalCode).digest('hex');
    const preEvaluationArtifact = preEvaluationArtifacts.get(artifactDigest);
    if (options.requirePreEvaluationPersistence && !preEvaluationArtifact) {
      throw new ValidationError(
        'Exact final candidate was not persisted before evaluation',
        ['Missing pre-evaluation source/playable digest manifest'],
      );
    }
    let renderedEvidenceArtifact = renderedEvidenceArtifacts.get(artifactDigest);
    const domain = String(options.collabDomain ?? '').toLowerCase();
    const requiresRenderedEvidence = options.evalMode !== 'legacy'
      && domain !== 'tone' && domain !== 'strudel';
    if (options.requirePreEvaluationPersistence && requiresRenderedEvidence && !renderedEvidenceArtifact) {
      throw new ValidationError(
        'Exact final candidate has no persisted rendered evidence',
        ['Missing early frame, late frame, or render-evidence receipt'],
      );
    }
    if (renderedEvidenceArtifact) {
      const evaluationReceiptPath = renderedEvidenceArtifact.receiptPath
        .replace(/\.render-evidence\.json$/, '.rendered-evaluation.json');
      const evaluationReceipt = {
        schemaVersion: 1, artifactDigest,
        renderEvidenceReceiptDigest: renderedEvidenceArtifact.receiptDigest,
        score: loopResult.finalScore,
        confidence: loopResult.evaluationConfidence,
        failureClass: loopResult.evaluationFailureClass,
        reasoning: loopResult.evaluation?.reasoning,
        dimensionScores: loopResult.evaluation?.dimensionScores,
        repairAdvice: loopResult.evaluation?.repairAdvice,
        renderMeasure: loopResult.evaluation?.renderMeasure,
        calibrationDigest: loopResult.evaluation?.calibrationDigest,
        evaluatedAt: new Date().toISOString(),
      };
      await fs.writeFile(evaluationReceiptPath, `${JSON.stringify(evaluationReceipt, null, 2)}\n`, 'utf-8');
      renderedEvidenceArtifact = {
        ...renderedEvidenceArtifact, evaluationReceiptPath,
        evaluationReceiptDigest: createHash('sha256')
          .update(await fs.readFile(evaluationReceiptPath)).digest('hex'),
      };
    }

    // Export final code as HTML
    const htmlPath = path.join(outputResolved, `${project}-final.html`);
    await exporter.exportHTML(finalCode, htmlPath);

    // For the `meta` custom domain, capture the inferred custom-domain descriptor
    // the generator embedded in the artifact as a `<artifact>.domain.json` sidecar
    // so the custom medium is recorded and reusable. Parsing is best-effort: a
    // missing/invalid descriptor never fails the run (the HTML artifact still wins).
    let domainSidecarPath: string | undefined;
    if (String(options.collabDomain || '').toLowerCase() === 'meta') {
      try {
        const { parseMetaDescriptorFromHtml } = await import('./generators/meta/MetaGenerator.js');
        const descriptor = parseMetaDescriptorFromHtml(finalCode);
        if (descriptor) {
          domainSidecarPath = path.join(outputResolved, `${project}-final.domain.json`);
          await fs.writeFile(domainSidecarPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf-8');
        }
      } catch {
        // Descriptor capture is non-fatal; the rendered artifact is the deliverable.
        domainSidecarPath = undefined;
      }
    }

    // Export final source with the right extension for non-JS artifact types.
    const sourcePath = path.join(outputResolved, `${project}-final.${getSourceFileExtension(finalCode)}`);
    // S4 completion (adversary finding): the -p/chat path also dropped the
    // theory assessment. Persist it as a per-artifact sidecar so every
    // strudel-producing organ surfaces theory output (greppable acceptance).
    if (finalValidation.theoryAssessment && finalValidation.theoryAssessment.length > 0) {
      writeTheorySidecar(sourcePath, options.collabDomain, finalValidation.theoryAssessment);
    }
    if (sourcePath.endsWith('.svg') || sourcePath.endsWith('.txt') || sourcePath.endsWith('.py')) {
      await fs.writeFile(sourcePath, finalCode, 'utf-8');
    } else {
      await exporter.exportJS(finalCode, sourcePath);
    }

    // Load project history from gallery for ZIP export
    const gallery = new Gallery(galleryDirResolved);
    let zipPath: string | undefined;

    try {
      const history = (await gallery.loadHistory(project)).filter((iter) => isCurrentRunIteration(iter, startTime));

      // Create project object for ZIP export (p5 code or organism as JSON string)
      const projectData: Project = {
        name: project,
        iterations: (history.length > 0 ? history : [{ code: finalCode, timestamp: loopResult.timestamp }]).map((iter, index) => {
          const code = 'code' in iter && iter.code != null
            ? iter.code
            : JSON.stringify({
                type: 'organism',
                musicCode: (iter as { musicCode: string; visualCode: string }).musicCode,
                visualCode: (iter as { musicCode: string; visualCode: string }).visualCode,
              });
          return {
            version: index + 1,
            code,
            timestamp: iter.timestamp
          };
        })
      };

      // Export as ZIP
      zipPath = path.join(outputResolved, `${project}-archive.zip`);
      await exporter.exportZIP(projectData, zipPath);
    } catch {
      // If gallery loading fails, create a simple ZIP with just the final code
      const simpleProject: Project = {
        name: project,
        iterations: [
          {
            version: 1,
            code: loopResult.code,
            timestamp: loopResult.timestamp
          }
        ]
      };

      zipPath = path.join(outputResolved, `${project}-archive.zip`);
      await exporter.exportZIP(simpleProject, zipPath);
    }

    const duration = Date.now() - startTime;

    // Report the REAL completion state to Meta-Harness for analysis.
    // NOTE: RalphLoop already reports with thinking, but we also report here
    // to ensure the top-level run() result is captured. A failed loop must
    // not be recorded as a success episode (W1.1 honesty fix).
    if (process.env.NODE_ENV !== 'test') {
      await metaHarness.onGenerationComplete({
        success: loopResult.completed,
        model: loopResult.model || 'local',
        domain: 'unknown', // Generators report their own domain with thinking
        prompt: prompt,
        code: loopResult.code,
        error: loopResult.completed ? undefined : loopResult.reason,
        duration: duration,
        thinking: loopResult.thinking,
      });
    }

    return {
      code: loopResult.code,
      iterations: loopResult.iterations,
      completed: loopResult.completed,
      reason: loopResult.reason,
      timestamp: loopResult.timestamp,
      duration,
      finalScore: loopResult.finalScore,
      evaluationConfidence: loopResult.evaluationConfidence,
      evaluationFailureClass: loopResult.evaluationFailureClass,
      project: loopResult.project,
      outputDir: outputResolved,
      prompt,
      htmlPath,
      sourcePath,
      jsPath: sourcePath,
      zipPath,
      domainSidecarPath,
      thinking: loopResult.thinking,
      model: loopResult.model,
      providerCallBudget: loopResult.providerCallBudget,
      artifactDigest,
      preEvaluationArtifact,
      renderedEvidenceArtifact,
    };

  } catch (error) {
    // Report ERROR to Meta-Harness
    if (process.env.NODE_ENV !== 'test') {
      await metaHarness.onGenerationComplete({
        success: false,
        model: 'local',
        domain: 'unknown', // Generators report their own domain with thinking
        prompt: prompt,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      });
    }
    throw new GenerationError(
        `Sinter run failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'unknown',
        {},
        error instanceof Error ? error : undefined
      );
  }
}

/**
 * Convenience function to run Sinter with CLI-style arguments
 *
 * @param args - Command line arguments
 * @returns Result object
 */
export async function runFromArgs(args: {
  prompt: string;
  maxIterations?: number;
  output?: string;
  project?: string;
}) {
  const {
    prompt,
    maxIterations = 20,
    output = './output',
    project = 'default'
  } = args;

  return run(prompt, {
    maxIterations,
    output,
    project
  });
}

/**
 * Main Sinter class - entry point for the creative coding agent
 */
export class Sinter {
  private config: SinterConfig;

  constructor(config: Partial<SinterConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  getConfig(): SinterConfig {
    return this.config;
  }

  /**
   * Run the Ralph-Wiggum Loop with the configured settings
   */
  async run(prompt: string, options?: {
    maxIterations?: number;
    timeoutMinutes?: number;
    output?: string;
    project?: string;
    minQualityScore?: number;
    tolerateErrors?: boolean;
    creativeOptions?: { evaluationCriteria?: string[] };
  }) {
    return run(prompt, {
      ...options,
      maxIterations: options?.maxIterations || this.config.loop.maxIterations,
      timeoutMinutes: options?.timeoutMinutes || this.config.loop.timeoutMinutes,
      minQualityScore: options?.minQualityScore || this.config.creative.minQualityScore,
      creativeOptions: options?.creativeOptions ?? { evaluationCriteria: this.config.creative.evaluationCriteria }
    });
  }
}

/** @deprecated Renamed to {@link Sinter} in the Liminal→Sinter rebrand. Kept as a back-compat alias. */
export const Liminal = Sinter;

// ============================================================================
// CORE COMPONENT EXPORTS - Programmatic Access
// ============================================================================

// Core Ralph-Wiggum Loop Engine
export { RalphLoop };
export { normalizeOptions, DEFAULT_MAX_ITERATIONS, DEFAULT_TIMEOUT_MINUTES, DEFAULT_MIN_QUALITY_SCORE } from './core/LoopConfig.js';
export type { LoopOptions, LoopResult, IterationContext, NormalizedLoopOptions } from './core/LoopConfig.js';

// Options types (Render, Swarm, Debug)
export type { RenderOptions, RecordingOptions, PreviewOptions, CanvasDimensions, RecordingFormat } from './types/options/RenderOptions.js';
export { DEFAULT_RENDER_OPTIONS, normalizeRenderOptions } from './types/options/RenderOptions.js';
export type { SwarmOptions } from './types/options/SwarmOptions.js';
export type { DebugOptions } from './types/options/DebugOptions.js';
import { requestImprovement } from './core/SelfImprovement.js';
export { requestImprovement, type ImprovementContext, type RequestImprovementOptions, type ImprovementGenerator } from './core/SelfImprovement.js';
export type { RequestImprovementState } from './improvement/requestImprovement.js';

// Creative Evaluation and Quality Control
export { CreativeEvaluator };
export { ScoringEngine } from './core/ScoringEngine.js';
export type { ScoringResult, ScoringInput, ScoringStrategy, ScoreDimension, EvaluationResult, EvaluationStrategy, EvaluationContext } from './core/ScoringEngine.js';

// Promise Detection for Loop Termination
export { PromiseDetector };

// Prompt Management
export { PromptStore };

// Context and State Management
export { ContextAccumulation };

// Core shared types and conversions
export type { CreativeFragment, FragmentOrigin };
export { seedToFragment, compostFragmentToFragment, minedFragmentToFragment, scavengerToFragment, isFromOrigin };

// p5.js Generators
export { P5Generator };
export { ParticleSystem };
export { CellularAutomata };
export { FlowField };
export { promptToGeneratorParams };

// Noise utilities
export { noise2D, noise3D, noiseSeed, flowField };

// Rendering and Preview
export { Renderer };
export { PreviewServer };

// Export and Persistence
export { Exporter, type Project };

// Gallery and Seed Management
export { Gallery, type Iteration };
export type { OrganismIteration, GalleryIteration } from './gallery/Gallery.js';
export { SeedArchive, type SeedMetadata };


// Evolution: MAP-Elites, Novelty, Behavior Vectors, Aesthetic Model, Meta Mode
export { MapElites } from './evolution/MapElites.js';
export type { MapElitesCell } from './evolution/MapElites.js';
export { createExplorationDecisionAdmission,
  validateExplorationDecisionAdmission }
  from './evolution/ExplorationDecisionAdmission.js';
export type { ExplorationDecisionAdmission, ExplorationDecisionPurpose }
  from './evolution/ExplorationDecisionAdmission.js';
export { NoveltyArchive } from './evolution/NoveltyArchive.js';
export { extractBehavior, detectDomain } from './evolution/BehaviorVectors.js';
export type { Domain } from './evolution/BehaviorVectors.js';
/** @library Public API — not wired into RalphLoop */
export { AestheticModel } from './evolution/AestheticModel.js';
export type { AestheticDataPoint } from './evolution/AestheticModel.js';
/** @library Public API — not wired into RalphLoop */
export { MetaMode } from './evolution/MetaMode.js';
export type { Experiment } from './evolution/MetaMode.js';
/** @library Public API — creative variation generator */
export { generateFiveVariations } from './evolution/generateFiveVariations.js';
/** @library Public API — cross-domain technique transfer */
export { crossoverReasoning, combineReasoning } from './evolution/CrossDomainCrossover.js';

// Safety Guardrails
export { SafetyGuardrails } from './core/SafetyGuardrails.js';
export type { SafetyConfig } from './core/SafetyGuardrails.js';

// Music generation API
export { generateMusic };
export type { GenerateMusicOptions, GenerateMusicResult } from './music/generateMusic.js';
export {
  createDeterministicMusicArtifact,
  measureAudio,
  renderSamples,
  MUSIC_SOUND_ARTIFACT_SCHEMA,
  MUSIC_SOUND_ARTIFACT_VERSION,
  MUSIC_SOUND_AUDIO_CLOCK_ID,
  MUSIC_SOUND_RUNTIME_ID,
  MUSIC_SOUND_REVISION_MAX,
} from './music/MusicSoundArtifact.js';
export type {
  DeterministicMusicArtifact,
  MusicSoundEvidence,
  MusicSoundMeasurements,
  MusicSoundProvenance,
  MusicSoundRevisionEvidence,
  MusicSoundTarget,
} from './music/MusicSoundArtifact.js';

// generateVisuals API (hydra-synth / p5 reactive visuals)
export { generateVisuals, type GenerateVisualsOptions, type GenerateVisualsResult } from './generateVisuals.js';

// Music-to-visual bridge
export {
  generateMusicToVisual,
  type GenerateMusicToVisualOptions,
  type GenerateMusicToVisualResult,
  type AudioInput,
} from './musicToVisual/generateMusicToVisual.js';

// ============================================================================
// DEFAULT EXPORT
// ============================================================================

export default {
  // Main functions
  run,
  runFromArgs,

  // Main class
  Liminal,

  // Core components
  RalphLoop,
  requestImprovement,
  CreativeEvaluator,
  PromiseDetector,
  PromptStore,
  ContextAccumulation,
  seedToFragment,
  compostFragmentToFragment,
  minedFragmentToFragment,
  scavengerToFragment,
  isFromOrigin,

  // Generators
  P5Generator,
  ParticleSystem,
  CellularAutomata,
  FlowField,
  promptToGeneratorParams,

  // Noise
  noise2D,
  noise3D,
  noiseSeed,
  flowField,

  // Rendering and export
  Renderer,
  PreviewServer,
  Exporter,
  Gallery,
  SeedArchive,

  // Evolution
  MapElites,
  NoveltyArchive,
  extractBehavior,
  detectDomain,
  AestheticModel,
  MetaMode,
  SafetyGuardrails,

  // generateVisuals API
  generateVisuals,

  // Music-to-visual bridge
  generateMusicToVisual,

  // Music API
  generateMusic,

  // Configuration
  SINTER_VERSION,
  defaultConfig
};

// LLM Generator (Legacy - use P5GeneratorV2 for tier-based)
export { P5GeneratorLLM };
export { LLMError, LLMTimeoutError, LLMRateLimitError, LLMAuthError } from './llm/LLMClient.js';
export type { LLMConfig, LLMResponse } from './llm/LLMClient.js';

// Model Configuration - Harness/Generation Split
export {
  loadModelConfig,
  validateModelConfig,
  formatModelConfig,
  getModelEnvDocs,
  type ModelConfig,
  type SplitModelConfig,
} from './llm/ModelConfig.js';

// Model Tier Detection & Prompt Building
export { 
  detectModelTier, 
  getModelProfile, 
  trimContext, 
  type ModelTier,
  type ModelProfile 
} from './llm/ModelTier.js';
export { PromptBuilder, type PromptContext, type BuiltPrompt } from './llm/PromptBuilder.js';

// Tier-Based Generator Infrastructure
export { 
  TierBasedGenerator, 
  type TierBasedGeneratorOptions 
} from './generators/TierBasedGenerator.js';

// V2 Generators (tier-based)
export { P5GeneratorV2, type P5GeneratorV2Options } from './generators/p5/P5GeneratorV2.js';
export { ShaderGenerator } from './generators/glsl/ShaderGenerator.js';
export { ThreeGenerator } from './generators/three/ThreeGenerator.js';
export { HydraGenerator } from './generators/hydra/HydraGenerator.js';
export { SVGGenerator } from './generators/svg/SVGGenerator.js';
export {
  SVG_MODE_PROFILES,
  inferSVGMode,
  type SVGMode,
  type SVGModeProfile,
} from './generators/svg/SVGModeProfiles.js';
export { sanitizeSVG } from './generators/svg/SVGSanitizer.js';
export { validateSVG, type SVGValidationOptions, type SVGValidationResult } from './generators/svg/SVGValidator.js';
export { StrudelGenerator } from './generators/strudel/StrudelGenerator.js';
export { ToneGenerator } from './generators/tone/ToneGenerator.js';
export { RevideoGenerator } from './generators/revideo/RevideoGenerator.js';
export { HTMLWebGenerator } from './generators/html/HTMLWebGenerator.js';
export { ASCIIArtGenerator } from './generators/ascii/ASCIIArtGenerator.js';
export { TextGenerativeGenerator } from './generators/textgen/TextGenerativeGenerator.js';

export type { PersistedLoopState } from './core/ContextAccumulation.js';



// M9-M11 Guardrails
export { 
  SemanticValidator,
  RuntimeHealthMonitor, 
  AccessibilityGuardrails,
  type SemanticValidationResult,
  type RuntimeHealthResult,
  type AccessibilityResult,
} from './guardrails/index.js';

// Swarm
export { SwarmOrchestrator } from './swarm/SwarmOrchestrator.js';
export { VotingEngine } from './swarm/VotingEngine.js';
export { MiningEngine } from './swarm/MiningEngine.js';
export { DEFAULT_PERSONAS } from './swarm/personas.js';
export { DEFAULT_REFINEMENT_CONSTRAINTS } from './swarm/types.js';
export { SwarmMode } from './swarm/types.js';
export type { SwarmPersona, SwarmConfig, SwarmOutput, Vote, RoundResult, SwarmResult, MinedFragment } from './swarm/types.js';
export type { SwarmOrchestratorOptions } from './swarm/SwarmOrchestrator.js';

// Scavenger
export type { ProjectDNA, ScavengerConfig } from './scavenger/types.js';

// Routing
/** @library Public API — not wired into RalphLoop */
export {
  AB_TEST_RESULTS,
  DOMAIN_ROUTING_DATA,
  OVERALL_FITNESS,
  DOMAIN_KEYWORDS,
} from './routing/index.js';

// Audio pipeline
export { AudioAnalyzer } from './audio/index.js';
export type { AudioFeatures, PitchData, TimbreData, AudioAnalysisResult, VisualMappingParams } from './audio/types.js';

// Aesthetic guardrails
export { AestheticCritic } from './aesthetic/index.js';
export { AestheticStrategy } from './aesthetic/index.js';
export type { DesignConstraints, AestheticViolation, AestheticReport, CriticConfig, AestheticPreset } from './aesthetic/types.js';
export { DEFAULT_DESIGN_CONSTRAINTS, PRESET_PROFILES } from './aesthetic/types.js';

// Collaboration
export { CollaborationEngine } from './collab/CollaborationEngine.js';
export type { CollaborationMode, CollaborationEngineResult, CollaborationEngineConfig } from './collab/CollaborationEngine.js';
export type {
  RoutingDecision,
  RoutingConfig,
  DomainType as RoutingDomainType,
  ModelChoice,
  DomainFitness,
  DomainRoutingConfig,
} from './routing/index.js';

// Learning
/** @library Public API — not wired into RalphLoop */
export { ArchiveLearning } from './learning/index.js';
export { QualityArchive } from './learning/index.js';
export {
  compareRenderedJudgment,
  learnCreativeJudgment,
  loadCreativeJudgmentProfile,
  persistCreativeJudgmentProfile,
  validateCreativeJudgmentProfile,
} from './learning/index.js';
export type {
  ArchiveConfig,
  ArchivedItem,
  ArchiveQueryOptions,
  ArchiveEntry,
  QualityArchiveConfig,
  CreativeJudgmentComparison,
  CreativeJudgmentProfile,
  RenderedComparisonCandidate,
  RenderedJudgmentComparison,
} from './learning/index.js';

// Constants
export { SERVICE_DEFAULTS } from './constants/index.js';
export {
  OPENAI_RECOMMENDED_MODELS_BY_ROLE,
  OPENAI_SMALL_ROLE_POLICY,
  OPENAI_SMALL_ROLE_POLICY_EVIDENCE,
  getOpenAIRolePolicy,
  getRecommendedOpenAIModelsForRole,
  isOpenAIModelRecommendedForRole,
  type OpenAIRolePolicyEntry,
  type OpenAIRolePolicyStatus,
} from './config/OpenAIRolePolicy.js';

// HTML Web Generator & ASCII Art Generator types (classes exported above with tier-based generators)
export type { HTMLGeneratorOptions } from './generators/html/HTMLWebGenerator.js';
export type { ASCIIOptions, ASCIIStyle } from './generators/ascii/ASCIIArtGenerator.js';
export type { TextGenOptions, TextGenForm, TextGenStyle } from './generators/textgen/TextGenerativeGenerator.js';
export type { SVGGeneratorOptions } from './generators/svg/SVGGenerator.js';
// Note: ShaderGenerator, ThreeGenerator, HTMLWebGenerator, ASCIIArtGenerator, TextGenerativeGenerator exported below with TierBasedGenerator

export { SinterFS } from './fs/index.js';
export type {
  SinterObjectKind,
  SinterObjectRef,
  WriteArtifactInput,
  SinterRunRecord,
} from './fs/index.js';

// Meta-Harness - Failure observation and pattern detection
export {
  failureLogger,
  patternDetector,
  metaHarness,
  harnessMemory,
  HarnessMemory,
  type FailureRecord,
  type Pattern,
  type MetaHarnessStatus,
  type ProviderType,
  type ProviderConfig,
  type HarnessMemoryState,
  type HarnessTask,
  getProviderConfig,
  getActiveProvider,
  getActiveProviderConfig,
  listConfiguredProviders,
  isProviderConfigured,
  detectProviderFromUrl,
  PROVIDER_TEMPLATES,
} from './harness/index.js';

// Embeddings - Semantic search and vector similarity
export {
  EmbeddingService,
  getGlobalEmbeddingService,
  resetGlobalEmbeddingService,
} from './embeddings/index.js';
export type {
  EmbeddingConfig,
  EmbeddingResult,
} from './embeddings/index.js';

// Evidence consolidation — corroborated, falsifiable improvement hypotheses
export {
  CONSOLIDATION_SOURCES,
  EvidenceConsolidationCoordinator,
} from './intuition/EvidenceConsolidationCoordinator.js';
export type {
  ConsolidationEvidence,
  ConsolidationSource,
  ConsolidatedHypothesis,
  EvidenceConsolidationConfig,
  EvidenceConsolidationResult,
  EvidenceStance,
} from './intuition/EvidenceConsolidationCoordinator.js';

// Wave 5 typed causal gate receipts
export {
  W5_MEMORY_FEED_FORWARD_SCHEMA_VERSION,
  W5_COMPOSITION_EVALUATION_SCHEMA_VERSION,
  W5_COMPOSITION_DREAM_SCHEMA_VERSION,
  W5_EVIDENCE_CONSOLIDATION_SCHEMA_VERSION,
  W5_AUTORESEARCH_EXPERIMENT_SCHEMA_VERSION,
  W5_SEALED_REVIEW_SCHEMA_VERSION,
  W5_CAUSAL_CANDIDATE_SCHEMA_VERSION,
  W5_DOMAIN_INCUBATION_SCHEMA_VERSION,
  W5_MODEL_ASSIMILATION_SCHEMA_VERSION,
  W5_CORTEX_CYCLE_SCHEMA_VERSION,
  createMemoryFeedForwardGateReceipt,
  parseMemoryFeedForwardGateReceipt,
  createCompositionEvaluationGateReceipt,
  parseCompositionEvaluationGateReceipt,
  createCompositionDreamGateReceipt,
  parseCompositionDreamGateReceipt,
  createEvidenceConsolidationGateReceipt,
  parseEvidenceConsolidationGateReceipt,
  createAutoresearchExperimentGateReceipt,
  parseAutoresearchExperimentGateReceipt,
  createSealedReviewGateReceipt,
  parseSealedReviewGateReceipt,
  createCausalCandidateGateReceipt,
  parseCausalCandidateGateReceipt,
  createDomainIncubationGateReceipt,
  parseDomainIncubationGateReceipt,
  createModelAssimilationGateReceipt,
  parseModelAssimilationGateReceipt,
  createCortexCycleGateReceipt,
  parseCortexCycleGateReceipt,
  type MemoryFeedForwardCondition,
  type MemoryFeedForwardChecks,
  type MemoryFeedForwardGateReceipt,
  type CompositionEvaluationGateChecks,
  type CompositionEvaluationGateReceipt,
  type CompositionDreamGateChecks,
  type CompositionDreamGateReceipt,
  type EvidenceConsolidationGateChecks,
  type EvidenceConsolidationGateReceipt,
  type Wave5PrerequisiteRef,
  type AutoresearchExperimentGateChecks,
  type AutoresearchExperimentGateReceipt,
  type SealedReviewGateChecks,
  type SealedReviewGateReceipt,
  type CausalCandidateGateChecks,
  type CausalCandidateGateReceipt,
  type DomainIncubationGateChecks,
  type DomainIncubationGateReceipt,
  type ModelAssimilationGateChecks,
  type ModelAssimilationGateReceipt,
  type CortexCycleGateChecks,
  type CortexCycleGateReceipt,
  type CortexCyclePrerequisiteRef,
} from './runtime-core/Wave5GateReceipt.js';

export {
  CREATIVE_PROOF_SCHEMA_VERSION,
  evaluateCreativeProof,
  type CreativeProofDomain,
  type CreativeProofEvidence,
  type CreativeProofEvidenceKind,
  type CreativeProofInput,
  type CreativeProofModality,
  type CreativeProofResult,
  type CreativeProofVerdict,
  type CreativeProofVerdictRecord,
  type CreativeProofViolation,
} from './quality/CreativeProofGate.js';

export {
  FORMAL_RUN_ORDER,
  WAVE6_LANE_DEFINITIONS,
  aggregateWave6LaneReceipts,
  evaluateWave6Experiment,
  resumeWave6Lineage,
  type Wave6ExperimentEvidence,
  type Wave6ExperimentResult,
  type Wave6FormalPair,
  type Wave6RunLabel,
  type Wave6Status,
} from './quality/Wave6CreativeFlywheel.js';

export {
  WAVE7_BUDGETS,
  WAVE7_SEAT_FREEZE,
  WAVE7_CONTRACT_DIGEST,
  createFrozenDomainManifest,
  createPreExistingQueueManifest,
  createDefaultWave7DeclaredRuns,
  createWave7ReleaseEvidenceManifest,
  parseWave7ReleaseEvidenceManifest,
  validateQueueDispositions,
  assertEvidenceReceiptMatchesReleaseManifest,
  type FrozenDomainManifest,
  type PreExistingQueueManifest,
  type QueueDisposition,
  type Wave7ReleaseRunKind,
  type Wave7ReleaseRunSlot,
  type Wave7ReleaseEvidenceManifest,
  type Wave7ChildEvidenceReceiptBinding,
} from './runtime-core/Wave7ReleaseContract.js';

export {
  OwnerReactionCausality,
  OwnerReactionError,
  type OwnerReactionAction,
  type OwnerReactionReceipt,
  type NextCreateReactionContext,
} from './runtime-core/OwnerReactionCausality.js';

export {
  WAVE7_CREATIVE_LANES,
  WAVE7_CREATIVE_DECISION_RULE,
  evaluateWave7CreativeLadder,
  type Wave7CreativeLadderEvidence,
  type Wave7CreativeLaneEvidence,
  type Wave7CreativeTrial,
  type Wave7CreativeLaneResult,
} from './runtime-core/Wave7CreativeLadder.js';

export {
  buildWave7OwnerReviewPacket,
  type Wave7OwnerReviewInput,
  type Wave7OwnerReviewPair,
  type Wave7OwnerDecision,
} from './runtime-core/Wave7OwnerCreativeReview.js';

export {
  validateWave7ReleaseReadiness,
  WAVE7_QUALITY_GATES,
  WAVE7_AUXILIARY_ARTIFACTS,
  WAVE7_RELEASE_CONJUNCT_IDS,
  type Wave7ReleaseEvidenceIndex,
  type Wave7ReleaseReadinessReport,
  type Wave7RunEvidenceReceipt,
} from './runtime-core/Wave7ReleaseReadinessValidator.js';

export {
  collectWave7RepositoryReleaseTruth,
  compareWave7ReleaseTruth,
  formatWave7RepositoryReleaseTruth,
  wave7RepositoryTruthPaths,
} from './runtime-core/Wave7RepositoryReleaseTruth.js';

export {
  auditWave7Artifacts,
  type Wave7LeakFinding,
} from './runtime-core/Wave7LeakAudit.js';

export {
  WAVE8_RELEASE_CONJUNCT_IDS,
  WAVE8_PLANTED_NEGATIVES,
  WAVE8_PLANTED_NEGATIVE_IDS,
  createWave8EvidenceReceipt,
  parseWave8EvidenceReceipt,
  createWave8ReleaseRoot,
  parseWave8ReleaseRoot,
  validateWave8ReleaseRoot,
  collectWave8ReleaseRootTruth,
  compareWave8ReleaseRootTruth,
  formatWave8ReleaseRootTruth,
  wave8ReleaseRootPaths,
  type Wave8EvidenceReceipt,
  type Wave8ReleaseRoot,
  type Wave8ReleaseReadinessReport,
  type Wave8ReceiptKind,
  type Wave8PlantedNegative,
} from './runtime-core/Wave8ReleaseRoot.js';
export {
  buildWave7PreSpendFeasibility,
  type Wave7FeasibilityBundle,
  type Wave7PaidRole,
  type Wave7PriceEvidence,
  type Wave7PriceReceipt,
  type Wave7ResolvedPaidRoute,
} from './runtime-core/Wave7PreSpendFeasibility.js';

export {
  LIVE_PROTOCOL_SCHEMA,
  LIVE_PROTOCOL_SCHEMA_VERSION,
  WAVE8_LIVE_CHECKPOINTS,
  WAVE8_LIVE_CONJUNCTS,
  buildLiveProtocol,
  validateLiveProtocol,
  assertLiveProtocolAllowsPaidExecution,
  assertLiveProtocolReceiptCurrent,
  digestLiveProtocol,
  liveAuthorityAttestationPayload,
  parseLiveProtocolReceipt,
  type CurrentPriceReceipt,
  type LiveArtifactSet,
  type LiveAuthorityAttestation,
  type LiveAuthorityRole,
  type LiveBudgetFreeze,
  type LiveBudgetRow,
  type LiveCheckpoint,
  type LiveConjunctEvidence,
  type LiveProtocolContext,
  type LiveProtocolConjunct,
  type LiveProtocolFreeze,
  type LiveProtocolInput,
  type LiveProtocolReceipt,
  type LiveProtocolReport,
  type LiveRoleIdentity,
  type LiveProtocolTrust,
  type LivePriceEvidence,
  type NoSpendEvidence,
  type OwnerUsdCeilingApproval,
  type ProductReviewEvidence,
  type SolApprovalEvidence,
} from './runtime-core/LiveProtocol.js';
export {
  buildWave8LiveAuthorityBundle,
  externalReviewSchema,
  liveAuthoritySpecSchema,
  prepareLiveAuthorityReviewContext,
  type ExternalReview,
  type LiveAuthorityReviewContext,
  type LiveAuthoritySlot,
  type LiveAuthoritySpec,
  type Wave8LiveAuthorityBundle,
} from './runtime-core/Wave8LiveAuthorityBundle.js';

export {
  configurePreSpendInterlock,
  configureWave8LivePreSpendInterlock,
  ensureWave8LivePreSpendInterlockConfigured,
  authorizeCanonicalStudioInvocation,
  completeCanonicalStudioInvocation,
  failCanonicalStudioInvocation,
  assertPreSpendInterlockConfigured,
  runWithPreSpendCallContext,
  createPreSpendFeasibilityProof,
  digestProviderRequest,
  getPreSpendCallLedger,
  type PaidCallSlot,
  type PreSpendBudgetRow,
  type PreSpendFeasibilityProof,
  type PreSpendInterlockPolicy,
  type Wave8LiveExecutionConfig,
  type CanonicalPreSpendCapability,
} from './llm/PreSpendInterlock.js';

export {
  AutoresearchExperimentRunner,
  type AutoresearchExperimentInput,
  type AutoresearchExperimentResult,
  type AutoresearchFailureRecord,
  type AutoresearchStageContext,
  type AutoresearchStageRecord,
  type AutoresearchStageResult,
  type ExperimentUsage,
} from './runtime-core/AutoresearchExperimentRunner.js';

export {
  SEALED_EVALUATOR_MANIFEST_VERSION,
  SEALED_REVIEW_READ_ONLY_TOOLS,
  ReviewedAutoresearchExperimentRunner,
  assertReviewedCandidate,
  parseSealedEvaluatorManifest,
  type SealedFileRef,
  type SealedEvaluatorManifest,
  type ProviderIdentityReceipt,
  type IndependentReviewResult,
  type IndependentReviewContext,
  type SealedReviewReceipt,
  type ReviewedAutoresearchResult,
  type ReviewedAutoresearchInput,
} from './runtime-core/SealedIndependentReview.js';

export {
  CAUSAL_CANDIDATE_SCHEMA_VERSION,
  fingerprintTrialConfiguration,
  packageOwnerControlledCandidate,
  parseOwnerControlledCandidate,
  type FrozenTrialConfiguration,
  type MetricFloor,
  type CausalDecisionRule,
  type CausalTrialPair,
  type CausalAnalysis,
  type CandidateDiffEvidence,
  type CausalCandidateInput,
  type OwnerControlledCandidate,
} from './runtime-core/CausalCandidatePackager.js';

export {
  DOMAIN_INCUBATION_SCHEMA_VERSION,
  DomainIncubatorStore,
  recommendDomainIncubation,
  parseDomainIncubationRecommendation,
  evaluateDomainIncubator,
  parseEvaluatedDomainIncubation,
  type IncubationEvidenceKind,
  type MissingCapabilitySignal,
  type DomainIncubationSpecification,
  type DomainIncubationInput,
  type DomainIncubationRecommendation,
  type IncubationCapabilityProof,
  type EvaluatedDomainIncubation,
  type PersistableIncubationRecord,
} from './runtime-core/DomainIncubator.js';

export {
  MODEL_ASSIMILATION_SCHEMA_VERSION,
  ASSIMILATION_ROLES,
  fingerprintAuditionSlice,
  assimilateModelsByRole,
  parseRoleModelAssimilationReport,
  type AssimilationRole,
  type AuditionModelIdentity,
  type AuditionSlice,
  type AuditionArmResult,
  type MatchedModelAudition,
  type ModelAssimilationDecisionRule,
  type RoleModelAssimilationInput,
  type RoleModelRecommendation,
  type RoleModelAssimilationReport,
} from './runtime-core/RoleModelAssimilator.js';

export {
  DreamQueue,
  GovernedDreamTaskRunner,
  buildGovernedDreamRequest,
  mutateCompositionRecipe,
  runNextDreamTask,
  runNextCompositionDream,
  CompositionDreamCognitiveAdapter,
  type DreamTask,
  type DreamTaskKind,
  type DreamAssimilationGovernance,
  type DreamAssimilationRunner,
  type DreamCampaignAdmission,
  type DreamCampaignAdmissionBoundary,
  type DreamTaskClaimPersistence,
  type DurableDreamTaskClaim,
  type DreamTaskConsumer,
  type DreamTaskRunResult,
  type CompositionDreamMutation,
  type CompositionDreamProvenance,
  type CompositionDreamPlan,
  type CompositionDreamRecord,
  type DreamFailureRecord,
  type CompositionDreamCognitiveSink,
  type CompositionDreamEvidenceProvider,
  type CompositionDreamRunResult,
} from './dreaming/index.js';

// Wave 5 recursive experiment authority
export {
  EXPERIMENT_AUTHORITY_SCHEMA_VERSION,
  authorizeCandidateDiff,
  authorizeExperimentRequest,
  createExperimentAuthorityPolicy,
  parseExperimentAuthorityReceipt,
  requestFromToolCall,
  type ExperimentAuthorityPolicy,
  type ExperimentAuthorityReceipt,
  type ExperimentAuthorityRequest,
  type ExperimentCapabilityKind,
} from './harness/authority/ExperimentAuthority.js';

// Vector utilities
export {
  cosineSimilarity,
  euclideanDistance,
  normalizeVector,
  dotProduct,
  findKNearestNeighbors,
} from './utils/vectors.js';

// =============================================================================
// COMPOSITION ENGINE - Multi-layer composition system
// =============================================================================

export {
  // Core engine
  CompositionEngine,
  StateManager,
  LayerManager,

  // Constants
  DEFAULT_LAYER_CONFIG,
  DEFAULT_GLOBAL_SETTINGS,

  // Factory functions
  createLayer,
  createLayerFromResponse,
  createComposition,
  exportProject,

  // Adapters
  AdapterRegistry,
  adapterRegistry,
  p5Adapter,
  toneAdapter,
  CompositionControlRuntime,
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  validateControlRecipe,
  migrateControlRecipe,
  controlRecipeLayers,
  generateControlArtifact,
  COMPOSITION_GRAPH_SCHEMA,
  COMPOSITION_GRAPH_VERSION,
  graphFromCompositionSpec,
  planCompositionGraph,
  lowerCompositionGraph,
  prepareComposition,
  executeCompositionGraph,
  CompositionGraphAbortError,
  CompositionGraphLossyError,
  CompositionGraphRollbackController,
  contractCompositionGraphToV1,
  lowerCompositionGraphForExecution,
  migrateCompositionGraph,
} from './composition/index.js';

export {
  CreativeRunCoordinator,
  FileCreativeRunPersistence,
  MemoryCreativeRunPersistence,
  TemporalArtifactBuilder,
} from './creative-run/CreativeRunCoordinator.js';
export type { CoordinatedTemporalResult } from './creative-run/CreativeRunCoordinator.js';

export {
  DREAM_ASSIMILATION_CHECKPOINT_SCHEMA,
  DREAM_ASSIMILATION_CHECKPOINT_VERSION,
  DREAM_ASSIMILATION_SCHEMA,
  DREAM_ASSIMILATION_VERSION,
  DREAM_EVALUATOR_SCHEMA,
  DREAM_EVALUATOR_VERSION,
  DREAM_PRODUCTION_ARTIFACT_SCHEMA,
  DREAM_PRODUCTION_ARTIFACT_VERSION,
  DREAM_JUDGMENT_ASSIMILATION_SCHEMA,
  DREAM_JUDGMENT_ASSIMILATION_VERSION,
  DreamAssimilationReviewVeto,
  FileDreamAssimilationRunStore,
  MemoryDreamAssimilationRunStore,
  parseDreamAssimilationCheckpoint,
  parseDreamAssimilationResult,
  runDreamAndAssimilate,
  sealDreamEvaluatorManifest,
} from './creative-run/DreamAssimilationRun.js';

export {
  CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_SCHEMA,
  CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_VERSION,
  CANDIDATE_MANIFEST_SCHEMA,
  CANDIDATE_MANIFEST_VERSION,
  buildCampaignActualCandidateManifest,
  buildCandidateManifest,
  campaignActualArtifactDigest,
  campaignActualSource,
  campaignActualSourceDigest,
  campaignCreativeThesisDigest,
  candidateDiversityGate,
  evaluateCandidateDiversity,
  evaluateCandidateGate,
  evaluateCandidateQuality,
  generateCandidateHypotheses,
} from './creative-run/CandidateHypothesisProduction.js';

export {
  CAMPAIGN_MANIFEST_SCHEMA,
  CAMPAIGN_MANIFEST_VERSION,
  CampaignCandidateLedger,
  buildCampaignExecutionPlan,
  computeRouteFreezeDigest,
  createCampaignManifest,
  isLunaModel,
  preflightCampaignBudget,
  validateCampaignSlotGraph,
} from './creative-run/CampaignManifest.js';
export {
  CampaignStageCounters,
  DurableCampaignCandidateLedger,
  FileCampaignLedgerPersistence,
} from './creative-run/CampaignPersistence.js';
export {
  CAMPAIGN_PROGRESS_JOURNAL_SCHEMA,
  CAMPAIGN_PROGRESS_JOURNAL_VERSION,
  CampaignProgressJournal,
  parseCampaignProgressJournal,
  type CampaignOriginReceiptVerifier,
  type CampaignProgressBinding,
  type CampaignProgressJournalRecord,
  type CampaignProgressJournalSpec,
  type CampaignProgressReceiptRequirement,
} from './creative-run/CampaignProgressJournal.js';

export { CAMPAIGN_EXECUTION_INPUT_SCHEMA, CampaignService } from './creative-run/CampaignService.js';
export {
  InMemoryLiminalArtifactStore,
  InMemoryLiminalOperationJournal,
  LiminalCommandService,
  bootstrapProductionReceiptAuthority,
  createTestReceiptAuthority,
} from './runtime-core/LiminalCommandService.js';
export { FileLiminalArtifactStore, FileLiminalOperationJournal }
  from './runtime-core/LiminalCommandFilePersistence.js';
export { createLiminalProductionEffects, isLiminalProductionDomain,
  SUPPORTED_LIMINAL_PRODUCTION_DOMAINS } from './runtime-core/LiminalProductionEffects.js';
export { FileLiminalProductCommandStore, LiminalProductCommandPort,
  MemoryLiminalProductCommandStore } from './runtime-core/LiminalProductCommandPort.js';
export { bootstrapProductionLiminalOwnerReviewAuthority,
  createTestLiminalOwnerReviewAuthority }
  from './runtime-core/LiminalOwnerReviewAuthority.js';
export type { LiminalCommandProposal, LiminalOwnerReviewAuthority,
  LiminalOwnerReviewCommand, LiminalOwnerReviewReceipt,
  LiminalProductCommandStore, LiminalProductProjection, LiminalTeachingCompiler,
  LiminalTeachingReceipt }
  from './runtime-core/LiminalProductCommandPort.js';
export { GovernedCreativeTeachingCompiler }
  from './runtime-core/GovernedCreativeTeachingCompiler.js';
export { createProductionLiminalRuntime }
  from './runtime-core/ProductionLiminalRuntime.js';
export { attachTourProductRoleTransport }
  from './runtime-core/TourProductTransport.js';
export type { ProductionLiminalCreateInput, ProductionLiminalRuntime,
  ProductionLiminalRuntimeOptions, ProductionDreamRuntimeOptions }
  from './runtime-core/ProductionLiminalRuntime.js';
export { DreamProductCommandPort, FileDreamProductProjectionStore }
  from './runtime-core/DreamProductCommandPort.js';
export type { DreamExperimentTemplate, DreamProductCommand,
  DreamProductProjection, DreamProductProjectionStore }
  from './runtime-core/DreamProductCommandPort.js';
export { DreamActivationCommandPort, DreamTransferCommandPort, FileDreamProjectionStore,
  sealDreamActivationPolicy } from './runtime-core/DreamTransferActivationPort.js';
export type { DreamActivationCommand, DreamActivationPolicy, DreamActivationProjection,
  DreamTransferCommand, DreamTransferHostComposition, DreamTransferProjection }
  from './runtime-core/DreamTransferActivationPort.js';
export { CompoundCreateProofPort, compoundCreateExecutionContextDigest,
  sealCompoundCreatePolicy }
  from './runtime-core/CompoundCreateProofPort.js';
export type { CompoundCreateCommand, CompoundCreateHost, CompoundCreateJudge,
  CompoundCreateJudgment, CompoundCreatePolicy, CompoundCreateProjection,
  CompoundCreateProjectionStore, CompoundCreateTask }
  from './runtime-core/CompoundCreateProofPort.js';
export { assertGovernedCliCompatibility, runProductionCliGenerate }
  from './cli/LiminalProductionGenerate.js';
export { createCreativeLabelAdmission, isCreativeLabelAdmitted,
  validateCreativeLabelAdmission } from './learning/CreativeLabelAdmission.js';
export type { CreativeLabelAdmission, CreativeLabelTrustKind,
  CreativeLabelUse } from './learning/CreativeLabelAdmission.js';
export { FileOperationalMemoryBoundary }
  from './runtime-core/OperationalMemoryBoundary.js';
export type { HistoricalMemoryClassification, HistoricalMemoryRecord }
  from './runtime-core/OperationalMemoryBoundary.js';
export { AuthoredCreativeDoctrineStore }
  from './runtime-core/AuthoredCreativeDoctrine.js';
export { classifyActivatedKnowledgeInput, classifyDoctrineInput,
  classifyTaintedExplorationInput, formatClassifiedCreativeInput }
  from './runtime-core/CreativeInputClassification.js';
export type { CreativeInputClassification }
  from './runtime-core/CreativeInputClassification.js';
export type { AuthoredCreativeDoctrine, AuthoredCreativeDoctrineInput,
  DoctrineUpdateReceipt, QuarantinedSemanticRecord }
  from './runtime-core/AuthoredCreativeDoctrine.js';
export { createRoutingOutcomeAdmission, validateRoutingOutcomeAdmission }
  from './routing/RoutingOutcomeAdmission.js';
export type { RoutingOutcomeAdmission } from './routing/RoutingOutcomeAdmission.js';
export { AuthorityLineage } from './runtime-core/AuthorityLineage.js';
export type { AuthorityLineageRecord, AuthorityTrustKind }
  from './runtime-core/AuthorityLineage.js';
export { bootstrapProductionAuthorityRegistry, ProductionAuthorityRegistry,
  productionAuthorityInventory } from './runtime-core/ProductionAuthorityRegistry.js';
export type { OrganismMigrationReceipt, ProductionAuthorityPath,
  ProductionAuthoritySealReceipt } from './runtime-core/ProductionAuthorityRegistry.js';
export { ORGANISM_LINEAGE_STAGES, proveOrganismRecovery }
  from './runtime-core/OrganismRecoveryProof.js';
export type { OrganismLineageNode, OrganismLineageStage,
  OrganismRecoveryProofInput, RestartProbe, RetainedEvidenceRoot }
  from './runtime-core/OrganismRecoveryProof.js';
export { runLiminalCommandJourney } from './cli/LiminalCommandCli.js';
export { runRenderedEvidenceProof } from './cli/LiminalRenderedEvidenceProof.js';
export { runAuthoritativeC0, reevaluateAuthoritativeC0, type Wave8C0AuthorityPackage,
  type AuthoritativeCreateResult } from './cli/LiminalAuthoritativeCreate.js';
export type {
  LiminalAuthorityReceipt,
  LiminalCommandEffects,
  LiminalCommandResult,
  LiminalCreativeCommand,
  LiminalReceiptAuthority,
  RenderedObservation,
} from './runtime-core/LiminalCommandService.js';
export { closeCampaignCliClosure, createCampaignCliService, recordCampaignCliRevisionClosure,
  runCampaignCliJourney, runCampaignCliOwnerDecision, runCampaignCliOwnerDecisionStart,
  runCampaignCliOwnerReview } from './cli/CampaignCli.js';
export { closeCampaignStudioClosure, recordCampaignStudioRevisionClosure,
  runCampaignStudioJourney, runCampaignStudioOwnerReview,
  runGovernedCampaignStudioJourney } from './tui-bridge/CampaignStudio.js';

export {
  BLIND_REVIEW_PACKET_SCHEMA,
  BLIND_REVIEW_PACKET_VERSION,
  BlindReviewSession,
  createBlindReviewSession,
  resolveCampaignBlindCandidateBinding,
} from './creative-run/BlindReviewEvidence.js';

export {
  CREATIVE_QUALITY_RUBRIC,
  OWNER_CAPTURE_SCHEMA,
  OWNER_ENVELOPE_SCHEMA,
  OWNER_ENVELOPE_VERSION,
  OWNER_REVIEW_PACKET_SCHEMA,
  OWNER_REVIEW_PACKET_VERSION,
  assertDurableBlindReviewProvenance,
  createCaptureAuthority,
  createEnvelopeAuthority,
  createOwnerReviewPacket,
  createReviewerAttestationVerifier,
  deriveEvidenceSchedule,
  hasIntactOwnerReviewPacketDigest,
  publishOwnerReviewPacket,
  recomputeAndPublishOwnerReviewPacket,
  renderOwnerReviewPacket,
  sealOwnerQualityReview,
  verifyEnvelopeWithTrustedKey,
  verifyOwnerQualityReviewBundle,
  verifyOwnerReviewPacket,
} from './creative-run/OwnerQualityReview.js';

export { ManagedOwnerReviewRenderer } from './creative-run/ManagedOwnerReviewRenderer.js';
export { runCliOwnerReview, runOwnerReviewLifecycle, runStudioOwnerReview }
  from './creative-run/OwnerReviewLifecycle.js';
export type { OwnerReviewClosureContext, OwnerReviewLifecycleInput, OwnerReviewLifecycleResult }
  from './creative-run/OwnerReviewLifecycle.js';

export {
  EXPERIMENT_PLAN_SCHEMA,
  EXPERIMENT_PLAN_VERSION,
  FIGURE_GROUND_METRIC,
  FIGURE_GROUND_TARGET,
  WCAG_CONTRAST_METRIC,
  compileExperimentPlan,
  createCanonicalCreativeArtifact,
  createAttributableRevisionSession,
  createIndependentBlindTreatmentPreference,
  serializeCreativeRevisionState,
} from './creative-run/AttributableRevision.js';

export { CampaignClosureLedger, DurableCampaignClosureLedger, DurableCampaignClosureEvidenceRegistry,
  bootstrapCampaignClosureEvidenceAuthority, resolveRuntimeCampaignClosureEvidenceAuthority, createCampaignBlindPreferenceEvidence,
  createCampaignOwnerTerminalDecision } from './creative-run/CampaignClosure.js';

export {
  OWNER_AUTHORITY_SCHEMA_VERSION,
  OWNER_LEARNING_PERSISTENCE_BOUNDARY,
} from './creative-run/OwnerLearningAuthority.js';

export {
  ARTIST_REVIEW_STATE_VERSION,
  ArtistReviewSession,
  createArtistReviewSession,
} from './creative-run/ArtistReviewExperience.js';
export { formatArtistReviewState, runArtistReviewCli } from './cli/ArtistReviewCli.js';

export {
  SIMILARITY_DIMENSIONS,
  TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY,
  TRANSFER_PROMOTION_SCHEMA_VERSION,
  TransferPromotionGateSession,
} from './creative-run/CreativeRunCoordinator.js';

export type { CampaignRunAdmission, CoordinatedCampaignResult,
  CoordinatedCampaignSlotResult, VerifiedCampaignSlotExecution,
  CampaignEvidenceCheckpoint, CampaignOwnerReviewEvidence,
} from './creative-run/CreativeRunCoordinator.js';
export {
  formatTransferPromotionDecision,
  formatTransferPromotionReceipt,
  runTransferPromotionCli,
} from './cli/TransferPromotionCli.js';


export {
  BOUNDED_REVISION_MAX,
  COLOR_COMPOSITION_DISPOSITION_MATRIX,
  COLOR_COMPOSITION_MANIFEST_SCHEMA,
  COLOR_COMPOSITION_MANIFEST_VERSION,
  COLOR_COMPOSITION_SOURCE_ROWS,
  MUSIC_SOUND_DISPOSITION_MATRIX,
  MUSIC_SOUND_MANIFEST_SCHEMA,
  MUSIC_SOUND_MANIFEST_VERSION,
  MUSIC_SOUND_SOURCE_ROWS,
  MUSIC_SOUND_SUPPORTED_CONTRACT_IDS,
  CREATIVE_PRINCIPLE_MANIFEST,
  CREATIVE_PRINCIPLE_MANIFEST_SCHEMA,
  CREATIVE_PRINCIPLE_MANIFEST_VERSION,
  CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  CREATIVE_THESIS_SCHEMA,
  CREATIVE_THESIS_VERSION,
  FORM_TYPOGRAPHY_ROWS,
  INTERACTION_A11Y_BOUNDED_REVISION_MAX,
  INTERACTION_A11Y_DISPOSITION_MATRIX,
  INTERACTION_A11Y_MANIFEST_SCHEMA,
  INTERACTION_A11Y_MANIFEST_VERSION,
  INTERACTION_A11Y_SOURCE_ROWS,
  INTERACTIVE_ARTIFACT_SCHEMA,
  INTERACTIVE_ARTIFACT_VERSION,
  DEFAULT_TEMPORAL_REVISIONS,
  TEMPORAL_ARTIFACT_SCHEMA,
  TEMPORAL_ARTIFACT_VERSION,
  CROSS_MODAL_ARTIFACT_SCHEMA,
  CROSS_MODAL_ARTIFACT_VERSION,
  CROSS_MODAL_CONTRACTS,
  CROSS_MODAL_MANIFEST,
  CROSS_MODAL_MANIFEST_SCHEMA,
  CROSS_MODAL_MANIFEST_VERSION,
  assertInteractiveArtifactIdentity,
  buildInteractiveArtifact,
  buildInteractiveArtifactFromBrief,
  buildTemporalArtifact,
  buildCrossModalArtifact,
  closeCrossModalManifest,
  deriveCrossModalTimingSamples,
  MOTION_TEMPORAL_CONTRACTS,
  MOTION_TEMPORAL_CONTRACT_IDS,
  TEMPORAL_EVIDENCE_SCHEMA,
  TEMPORAL_EVIDENCE_VERSION,
  TEMPORAL_REVISION_OPERATOR_SCHEMA,
  applyBoundedTemporalRevision,
  buildTemporalEvidence,
  buildThesisFor,
  compileCreativeThesis,
  creativeThesisPromptContext,
  detectDuplicateTemporalSamples,
  detectProjectionSourceDrift,
  detectProjectionDrift,
  inspectInteractiveArtifactIdentity,
  interactionAccessibilityDispositionFor,
  principleDispositionFor,
  detectTemporalClockDrift,
  motionTemporalContractDigest,
  projectCreativePrinciple,
  projectCreativePrincipleContract,
  musicSoundDispositionFor,
  resolveMusicSoundContract,
  resolveCreativePrinciple,
  resolveMotionTemporalContract,
  selectPrincipleForBrief,
  temporalClockFingerprint,
  temporalEvidenceDigest,
  transitionInteractiveArtifactState,
  validateCreativePrincipleContract,
  validateFormTypographyManifest,
  validateCreativeThesis,
  validateCrossModalRuntimeReceipt,
} from './creative-intelligence/index.js';

export type {
  BuildInteractiveArtifactOptions,
  ColorCompositionDisposition,
  ColorCompositionDispositionEntry,
  ColorCompositionRowType,
  ColorCompositionSourceRow,
  MusicSoundDisposition,
  MusicSoundDispositionEntry,
  MusicSoundRowDomain,
  MusicSoundSourceRow,
  CompileCreativeThesisOptions,
  CrossModalArtifact,
  CrossModalArtifactOptions,
  CrossModalClosure,
  CrossModalContract,
  CrossModalDisposition,
  CrossModalEvidence,
  CrossModalManifestRow,
  CrossModalObservable,
  CrossModalRole,
  CrossModalRuntimeHandoff,
  CrossModalRuntimeReceipt,
  CrossModalTimingSample,
  CreativePrincipleContract,
  CreativePrincipleManifest,
  CreativePrincipleStatus,
  CreativeThesis,
  CreativeThesisCitation,
  CreativeFormTypographyPlan,
  CreativeThesisDisposition,
  CreativeThesisPrinciple,
  FormTypographyDisposition,
  FormTypographyRow,
  InteractionA11yDisposition,
  InteractionA11yDispositionEntry,
  InteractionA11yRowType,
  InteractionA11ySourceRow,
  InteractiveArtifactIdentity,
  InteractiveArtifactAction,
  InteractiveArtifactTrace,
  InteractiveArtifactTraceStep,
  PrincipleSelection,
  ProjectionDriftReport,
  TemporalClockIdentity,
  TemporalArtifact,
  TemporalArtifactOptions,
  TemporalEvidence,
  TemporalEvidenceBuildOptions,
  TemporalRevisionApplyOptions,
  TemporalRevisionApplyResult,
  TemporalRevisionKind,
  TemporalRevisionOperator,
  TemporalSample,
  TemporalSampleUnit,
  TemporalSamplingSchedule,
  ThesisPrincipleDisposition,
} from './creative-intelligence/index.js';
export type {
  CreativeRunCoordinatorOptions,
  CoordinatedCrossModalArtifactResult,
  CreativeRunEntryPoint,
  CreativeRunHandle,
  CreativeRunPersistence,
  CreativeRunReadiness,
  CreativeRunRecord,
  CreativeRunRequest,
  CampaignOriginRecord,
  ProviderReservation,
} from './creative-run/CreativeRunCoordinator.js';

export type {
  DreamAssimilationBudget,
  DreamArtifactRenderer,
  DreamAssimilationCheckpoint,
  DreamAssimilationCoordinator,
  DreamAssimilationIdentities,
  DreamAssimilationEvaluator,
  DreamAssimilationEvaluators,
  DreamAssimilationRecommendation,
  DreamAssimilationRequest,
  DreamAssimilationResult,
  DreamAssimilationRunStore,
  DreamAssimilationReviewBundle,
  DreamCheckpointPhase,
  DreamEvaluatorContext,
  DreamEvaluatorCriterion,
  DreamEvaluatorCriterionResult,
  DreamEvaluatorDecision,
  DreamProductionEvidence,
  DreamProductionArtifactEvidence,
  DreamJudgmentAssimilationReceipt,
  DreamRenderedEvidence,
  DreamRenderedFrame,
  DreamRecommendationStore,
  SealedDreamEvaluatorManifest,
  SealedDreamReviewReceipt,
} from './creative-run/DreamAssimilationRun.js';

export type {
  BuildCandidateManifestOptions,
  CampaignActualCandidate,
  CampaignActualCandidateArtifact,
  CampaignActualCandidateInput,
  CampaignActualCandidateManifest,
  CandidateArtifactPlan,
  CandidateDimensions,
  CandidateDiversityReport,
  CandidateGateReport,
  CandidateHypothesis,
  CandidateManifest,
  CandidatePairDifference,
  CandidateQualityReport,
  IntentDerivedDimension,
} from './creative-run/CandidateHypothesisProduction.js';

export type {
  CampaignBudgetFeasibility,
  CampaignBrief,
  CampaignCandidateInsertion,
  CampaignCandidateSlot,
  CampaignAudioRequirement,
  CampaignEvidenceModality,
  CampaignOwnerEvidenceSlot,
  CampaignCapacity,
  CampaignCeilings,
  CampaignDiversityDimension,
  CampaignCandidateDiversityFreeze,
  CampaignExecutionPlan,
  CampaignExecutionStage,
  CampaignManifest,
  CampaignManifestInput,
  CampaignRoleRoute,
  CampaignRouteFreeze,
  CampaignSeatCapacity,
  CampaignSlotGraph,
  CampaignSlotGraphProof,
  CampaignStageKind,
  CampaignTransferFreeze,
  CampaignTransportBudget,
  CampaignTransportPurpose,
  CampaignTransportTemplate,
} from './creative-run/CampaignManifest.js';
export type {
  CampaignLedgerPersistence,
  CampaignStageCounterRecord,
} from './creative-run/CampaignPersistence.js';

export type { CampaignExecutionInputV1, CampaignOwnerDecisionFinalizationInput,
  CampaignOwnerDecisionSealInput, CampaignProjection, CampaignRevisionClosureInput } from './creative-run/CampaignService.js';
export type {
  CampaignFundingAllocation,
  CampaignFundingDebitReceipt,
  CampaignFundingLimits,
  CampaignFundingReservationV1,
  CampaignStageSettlement,
  OwnerReviewAdmission,
} from './creative-run/CampaignExecutionAuthority.js';
export {
  assertOwnerReviewAdmission,
} from './creative-run/CampaignExecutionAuthority.js';

export type {
  BlindCandidateEvidence,
  BlindReviewJudgment,
  BlindReviewPacket,
  BlindReviewRecord,
  CandidateEvidenceAssignment,
  CanonicalMediaReference,
  GenerationIdentity,
  PlayableMediaManifestEntry,
  RecordedBlindJudgment,
  ReviewClaim,
  ReviewModality,
  ReviewOutcome,
  UnmaskedReview,
} from './creative-run/BlindReviewEvidence.js';

export type {
  AudioRequirement,
  BriefSlotArtifact,
  CaptureAuthority,
  CaptureSealInput,
  CreativeQualityCandidateResult,
  CreativeQualityDimension,
  CreativeQualityReviewInput,
  CreativeQualityScores,
  EnvelopeAuthority,
  EnvelopeSealInput,
  EvidenceBackedFinding,
  EvidenceBackedScore,
  EvidenceBackedVeto,
  EvidenceSchedule,
  OwnerCaptureInputs,
  OwnerEvidenceCapture,
  OwnerEvidenceClass,
  OwnerPacketEnvelope,
  OwnerPacketVerification,
  OwnerQualityReviewBundle,
  OwnerQualityReviewVerification,
  OwnerReviewPacket,
  OwnerReviewPacketRenderer,
  OwnerReviewPacketStore,
  OwnerReviewHandle,
  SealedOwnerCampaignRef,
  ReviewerAttestationVerifier,
  ReviewerExecutorAttestation,
} from './creative-run/OwnerQualityReview.js';

export type { ManagedRendererOptions } from './creative-run/ManagedOwnerReviewRenderer.js';

export type {
  ApplyAttributableRevisionOptions,
  AttributableRevisionSession,
  AttributableRevisionReceipt,
  BlindTreatmentPreferenceOutcome,
  CanonicalCreativeArtifactEnvelope,
  CanonicalPostEvidence,
  CapturePoint,
  CausalIdentity,
  CausalPredicate,
  CompileExperimentPlanOptions,
  CreativeRevisionSnapshot,
  CreativeRevisionState,
  CriticContribution,
  CriticRole,
  DeclaredTreatment,
  DeterministicMeasurementReceipt,
  ExperimentPlan,
  ExperimentOutcome,
  FrozenRoute,
  FrozenRuntime,
  HardFloor,
  IndependentBlindTreatmentPreference,
  RevisionScalar,
  TreatmentTargetKind,
} from './creative-run/AttributableRevision.js';

export type {
  CampaignBlindPreferenceEvidence,
  CampaignBlindPreferenceReviewer,
  CampaignBriefClosureRecord,
  CampaignClosureBinding,
  CampaignClosureEvidenceAuthority,
  CampaignClosureEvidenceBootstrapOptions,
  CampaignClosurePersistence,
  CampaignClosureReceipt,
  CampaignExperimentOutcome,
  CampaignLearningAuthorizationEvidence,
  CampaignLearningAuthorizationExecution,
  CampaignLearningAuthorizationScope,
  CampaignLearningAuthorizationState,
  CampaignLearningComparisonArm,
  CampaignOwnerPreference,
  CampaignOwnerDecisionEvidence,
  CampaignOwnerTerminalDecision,
  CampaignReleaseDecision,
  CampaignRevisionOutcome,
  CampaignRevisionEvidence,
  CampaignRevisionSettlement,
} from './creative-run/CampaignClosure.js';

export type {
  AuthorityCapabilityBinding,
  AuthorityIdentity,
  CreateContextSnapshot,
  IssueLearningAuthorizationOptions,
  LearningAuthorization,
  LearningStageReceipt,
  LearningTerminalReason,
  LearningTransferReceipt,
  MutationCounters,
  OwnerAuthorityBootstrapConfig,
  OwnerAuthorityCapability,
  OwnerLearningAuthoritySession,
  OwnerLearningAuthoritySessionOptions,
  PreferenceDecisionReceipt,
  ProvisionalLearningTransfer,
  ReleaseDecisionReceipt,
  RollbackReceipt,
  TrustedAuthorityAssertion,
} from './creative-run/OwnerLearningAuthority.js';

export type {
  ArtistReviewAction,
  ArtistReviewActionAuthority,
  ArtistReviewActionResult,
  ArtistReviewCandidate,
  ArtistReviewCriticFinding,
  ArtistReviewLearningState,
  ArtistReviewSessionOptions,
  ArtistReviewState,
} from './creative-run/ArtistReviewExperience.js';
export type { ArtistReviewSurface } from './cli/ArtistReviewCli.js';

export type {
  BlindedComparisonJudgment,
  OwnerComparisonJudgment,
  PromotionComparisonCandidate,
  PromotionComparisonPacket,
  PromotionReviewOutcome,
  SimilarityDimension,
  SimilarityFingerprint,
  TransferPromotionComparison,
  TransferPromotionDecision,
  TransferPromotionDecisionReason,
  TransferPromotionFreeze,
  TransferPromotionGateOptions,
  TransferPromotionReceipt,
} from './creative-run/TransferPromotionGate.js';
export type { TransferPromotionSurface } from './cli/TransferPromotionCli.js';

export {
  CompositionEvaluator,
  COMPOSITION_EVIDENCE_DIMENSIONS,
} from './evaluation/index.js';

export type {
  CompositionEvidenceDimension,
  EvidenceStatus,
  EvidenceDirection,
  CompositionEvidenceMeasure,
  LayerEvaluationInput,
  WholeWorkScores,
  CouplingTrial,
  CompositionEvaluationAttempt,
  LayerEvaluation,
  WholeWorkEvaluation,
  CompositionEvaluationChecks,
  CompositionEvaluationResult,
} from './evaluation/index.js';

export type {
  // String-union types
  DomainType,
  BlendMode,
  MaskMode,
  AssetType,

  // Core interfaces
  Layer,
  LayerConfig,
  LayerMetadata,
  Composition,
  GlobalSettings,
  AudioSettings,
  CompositionMetadata,
  SinterProject,
  Export,
  Import,

  // Engine option types
  CompositionEngineOptions,
  RenderContext,
  LayerManagerOptions,
  LayerAdapter,
  ControlRecipe,
  LegacyControlRecipe,
  ControlLayer,
  ControlPort,
  ControlMapping,
  OwnedResource,
  ControlValueType,
  StaleBehavior,
  LayerControlBinding,
  ControlScheduler,
  ControlRuntimeReceipt,
  ControlValue,
  CompositionGraph,
  CompositionGraphNode,
  CompositionGraphEdge,
  CompositionGraphBudget,
  PlannedCompositionGraph,
  CompositionRequest,
  LegacyCompositionGraphV1,
  CompositionGraphClock,
  CompositionGraphGroup,
  CompositionGraphScene,
  CompositionGraphPhase,
  CompositionGraphControl,
  CompositionGraphResource,
  CompositionTimingIsland,
  CompositionClockBridge,
  CompositionGraphRetryPolicy,
  CompositionGraphLifecycle,
  CompositionGraphExecutionPlan,
  CompositionGraphExecutionNode,
  GraphExecutionReceipt,
  GraphExecutionOptions,
  GraphNodeExecutionContext,
  CompositionGraphRollbackState,
} from './composition/index.js';
