/**
 * W1.2 / W4 — The generation loop never acts on a degraded evaluation.
 *
 * A degraded evaluation (failureClass scorer/infra/validator/legacy, or zeroed
 * confidence) is not a trustworthy fitness signal. These tests pin the honesty
 * gates at the RalphLoop seam:
 *
 *   - repair/elevation never fires on a degraded evaluation;
 *   - a repair candidate evaluated by a degraded evaluator is never adopted;
 *   - best-candidate tracking ignores degraded evaluations (a degraded 0.99
 *     must not displace an honest 0.80);
 *   - convergence detection treats degraded scores as absent;
 *   - intuition recordOutcome is gated on the honesty predicate;
 *   - the emergence/taste hook is gated on the honesty predicate;
 *   - audio/legacy-eval paths stamp failureClass 'legacy' — the score still
 *     displays but is never banked as an exemplar;
 *   - W4: EvolutionEngine recentScores is fitness — gated;
 *   - W4: EvolutionIntegration.update still runs for novelty, but scoreIsHonest
 *     is false so MAP-Elites/aesthetic fitness banking is skipped;
 *   - W4: LOOP_EVALUATION remains a display stream — degraded scores still emit;
 *   - W4 FIX R1: autoCompost is fitness (heap → materials → enhancePrompt) — gated;
 *   - W4 FIX R1: stagnation.check + successRateTracker.recordAttempt are
 *     fitness/policy (plateau + exploreAggressively → numCandidates) — gated;
 *   - W4 FIX R1: guidance is advisory/display (chat onSuggestion only) —
 *     intentionally ungated (classification comment in source).
 *
 * Harness mirrors RalphLoop.comprehensive.test.ts (all boundaries mocked).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mock variables ───────────────────────────────────────────────

const mockPromptStoreLoad = vi.hoisted(() => vi.fn(() => 'loaded-prompt-content'));
const mockPromptStoreInjectContext = vi.hoisted(() =>
  vi.fn((_prompt: string, _context: string) => 'prompt-with-context')
);
const mockBuildContextForInjection = vi.hoisted(() =>
  vi.fn((_iter: number, _opts: any, _prompt: string, _loaded: string, _prevCode: string) => 'injection-context')
);
const mockEnhancePrompt = vi.hoisted(() =>
  vi.fn(async (prompt: string) => prompt)
);
const mockContextAccumulationSave = vi.hoisted(() => vi.fn());
const mockContextAccumulationGetHistory = vi.hoisted(() => vi.fn(() => []));
const mockContextAccumulationClear = vi.hoisted(() => vi.fn());
const mockEventBusEmit = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockLoggerInfo = vi.hoisted(() => vi.fn());
const mockScoringEngineScore = vi.hoisted(() =>
  vi.fn(async () => ({ score: 0.75, issues: [] }))
);
const mockScoringEngineScoreReliable = vi.hoisted(() =>
  vi.fn(async () => ({ score: 0.75, issues: [] }))
);
const mockGeneratorGenerate = vi.hoisted(() =>
  vi.fn(async () => ({
    code: 'function setup() {} function draw() {}',
    thinking: 'test-thinking',
    model: 'test-model',
  }))
);
const mockStagnationCheck = vi.hoisted(() =>
  vi.fn(() => ({ shouldBreak: false, reason: '', successRate: 0.5 }))
);
const mockEvolutionUpdate = vi.hoisted(() =>
  vi.fn(() => ({ noveltyScore: 0.5, hints: '' }))
);
const mockPersistenceSaveIteration = vi.hoisted(() => vi.fn(async () => {}));
const mockPersistenceSaveMergeStep = vi.hoisted(() => vi.fn(async () => {}));
const mockRecordRoutingOutcome = vi.hoisted(() => vi.fn(async () => {}));
const mockAmbiguityDetect = vi.hoisted(() => vi.fn(() => []));
const mockRunOrganismMode = vi.hoisted(() =>
  vi.fn(async () => ({
    code: 'organism-code',
    iterations: 1,
    completed: true,
    reason: 'organism done',
    timestamp: new Date().toISOString(),
    duration: 1000,
    finalScore: 0.9,
  }))
);
const mockCodeValidatorValidate = vi.hoisted(() =>
  vi.fn(() => ({ valid: true, errors: [], cleanedCode: 'function setup() {} function draw() {}' }))
);
const mockSuccessRateTrackerGetRecommended = vi.hoisted(() => vi.fn(() => 1));
const mockSuccessRateTrackerRecordAttempt = vi.hoisted(() => vi.fn());
const mockSuccessRateTrackerShouldExplore = vi.hoisted(() => vi.fn(() => false));
const mockSuccessRateTrackerGetSuccessRate = vi.hoisted(() => vi.fn(() => 0.5));
const mockRenderPipelineProcess = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, score: 0.8, domain: 'p5', duration: 5, warnings: [] }))
);
const mockRenderPipelineClose = vi.hoisted(() => vi.fn(async () => {}));
const mockRenderPipelineBlendScores = vi.hoisted(() =>
  vi.fn(({ baseScore, renderScore, renderWeight = 0.5 }) => baseScore * (1 - renderWeight) + renderScore * renderWeight)
);
const mockHeadlessRenderWithEvidence = vi.hoisted(() =>
  vi.fn(async () => ({
    timingMs: 5,
    infraUnavailable: false,
    candidateFailure: false,
    screenshot: {
      mimeType: 'image/png',
      dataBase64: 'fake-image',
      width: 400,
      height: 400,
    },
    lateScreenshot: {
      mimeType: 'image/png', dataBase64: 'fake-image-late', width: 400, height: 400,
    },
  }))
);
const mockScoreRenderedEvidence = vi.hoisted(() =>
  vi.fn(async () => ({
    score: 0.92,
    confidence: 0.95,
    failureClass: 'none' as const,
    reasoning: 'rendered evaluator passed',
  }))
);
const mockArchiveLearningAddOutput = vi.hoisted(() => vi.fn(async () => {}));
const mockBuildRepairPacket = vi.hoisted(() => vi.fn(() => '--- REPAIR PACKET ---'));
const mockRankCandidates = vi.hoisted(() => vi.fn(() => ({ rankedIndices: [0], winnerIndex: 0 })));
const mockIntuitionRecordOutcome = vi.hoisted(() => vi.fn());
const mockIntuitionGenerateHint = vi.hoisted(() => vi.fn(() => undefined));
const mockIntuitionLoad = vi.hoisted(() => vi.fn(async () => {}));
const mockIntuitionSave = vi.hoisted(() => vi.fn(async () => {}));
const mockEmergenceOnCreativeRun = vi.hoisted(() =>
  vi.fn(async () => ({
    placement: { outcome: 'accepted', cellId: 'cell-1', accepted: true },
    signals: { novelty: 0.5 },
  }))
);

// ─── Mock registrations ────────────────────────────────────────────────────

vi.mock('../../../src/core/PromptStore.js', () => ({
  PromptStore: {
    load: mockPromptStoreLoad,
    injectContext: mockPromptStoreInjectContext,
  },
}));

vi.mock('../../../src/core/ContextBuilder.js', () => ({
  buildContextForInjection: mockBuildContextForInjection,
}));

vi.mock('../../../src/core/PromptEnhancer.js', () => ({
  enhancePrompt: mockEnhancePrompt,
}));

vi.mock('../../../src/core/ContextAccumulation.js', () => ({
  ContextAccumulation: {
    save: mockContextAccumulationSave,
    getHistory: mockContextAccumulationGetHistory,
    clear: mockContextAccumulationClear,
  },
}));

vi.mock('../../../src/core/EventBus.js', () => ({
  eventBus: { emit: mockEventBusEmit },
  EventTypes: {
    PROCESS_START: 'PROCESS_START',
    PROCESS_END: 'PROCESS_END',
    LOOP_ITERATION: 'LOOP_ITERATION',
    LOOP_EVALUATION: 'LOOP_EVALUATION',
    COMPOST_STAGE: 'COMPOST_STAGE',
  },
}));

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: {
    warn: mockLoggerWarn,
    info: mockLoggerInfo,
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/core/ScoringEngine.js', () => ({
  ScoringEngine: class { score = mockScoringEngineScore; scoreReliable = mockScoringEngineScoreReliable; },
  scoreRenderedEvidence: mockScoreRenderedEvidence,
}));

vi.mock('../../../src/core/GenerationOrchestrator.js', () => ({
  GenerationOrchestrator: class { generate = mockGeneratorGenerate; },
}));

vi.mock('../../../src/core/EvolutionIntegration.js', () => ({
  EvolutionIntegration: class { update = mockEvolutionUpdate; },
}));

vi.mock('../../../src/core/LoopPersistence.js', () => ({
  LoopPersistence: class { saveIteration = mockPersistenceSaveIteration; saveMergeStep = mockPersistenceSaveMergeStep; },
}));

vi.mock('../../../src/core/StagnationDetector.js', () => ({
  StagnationDetector: class { check = mockStagnationCheck; },
}));

vi.mock('../../../src/core/SuccessRateTracker.js', () => ({
  SuccessRateTracker: class {
    getRecommendedCandidates = mockSuccessRateTrackerGetRecommended;
    recordAttempt = mockSuccessRateTrackerRecordAttempt;
    shouldExploreAggressively = mockSuccessRateTrackerShouldExplore;
    getSuccessRate = mockSuccessRateTrackerGetSuccessRate;
  },
}));

vi.mock('../../../src/core/AmbiguityDetector.js', () => ({
  AmbiguityDetector: class { detect = mockAmbiguityDetect; },
}));

vi.mock('../../../src/core/OrganismLoop.js', () => ({
  runOrganismMode: mockRunOrganismMode,
}));

vi.mock('../../../src/core/CodeValidator.js', () => ({
  CodeValidator: { validate: mockCodeValidatorValidate },
}));

vi.mock('../../../src/render/HeadlessRenderer.js', () => ({
  HeadlessRenderer: {
    getInstance: vi.fn(() => ({
      renderWithEvidence: mockHeadlessRenderWithEvidence,
    })),
  },
}));

const mockPromiseDetectorDetect = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../../src/core/PromiseDetector.js', () => ({
  PromiseDetector: { detect: mockPromiseDetectorDetect },
}));

const mockSafetyGuardrailsCheckAll = vi.hoisted(() => vi.fn(() => true));
const mockSafetyGuardrailsRecordApiCall = vi.hoisted(() => vi.fn());

vi.mock('../../../src/core/SafetyGuardrails.js', () => ({
  SafetyGuardrails: class {
    checkAll = mockSafetyGuardrailsCheckAll;
    recordApiCall = mockSafetyGuardrailsRecordApiCall;
  },
}));

vi.mock('../../../src/gallery/Gallery.js', () => ({
  Gallery: class {},
}));

vi.mock('../../../src/routing/RoutingData.js', () => ({
  recordRoutingOutcome: mockRecordRoutingOutcome,
}));

vi.mock('../../../src/harness/MetaHarnessIntegration.js', () => ({
  metaHarness: { onGenerationComplete: vi.fn(async () => {}) },
}));

vi.mock('../../../src/utils/env.js', () => ({
  env: vi.fn(() => 'lmstudio'),
}));

vi.mock('../../../src/compost/defaults.js', () => ({
  mergeConfig: vi.fn(() => ({})),
}));

const mockCompostHeapAddFile = vi.hoisted(() => vi.fn(async () => {}));
const mockCompostHeapIsOverCapacity = vi.hoisted(() => vi.fn(async () => false));
const mockCompostMillDigest = vi.hoisted(() => vi.fn(async () => {}));
const mockCompostMillGetGenerationMaterials = vi.hoisted(() =>
  vi.fn(async () => ({ seeds: [], dna: [], techniques: [] }))
);

vi.mock('../../../src/compost/CompostHeap.js', () => ({
  CompostHeap: class {
    addFile = mockCompostHeapAddFile;
    isOverCapacity = mockCompostHeapIsOverCapacity;
  },
}));

vi.mock('../../../src/compost/CompostMill.js', () => ({
  CompostMill: class {
    digest = mockCompostMillDigest;
    getGenerationMaterials = mockCompostMillGetGenerationMaterials;
  },
}));

vi.mock('../../../src/llm/LLMClient.js', () => ({
  LLMClient: class {},
}));

vi.mock('../../../src/learning/index.js', () => ({
  ArchiveLearning: class { getArchive = vi.fn(() => ({ load: vi.fn(async () => {}), save: vi.fn(async () => {}) })); addOutput = mockArchiveLearningAddOutput; },
  QualityArchive: vi.fn(),
}));

vi.mock('../../../src/evolution/AestheticModel.js', () => ({
  AestheticModel: class { load = vi.fn(async () => {}); save = vi.fn(async () => {}); },
}));

vi.mock('../../../src/evolution/MapElites.js', () => ({
  MapElites: class { load = vi.fn(async () => {}); save = vi.fn(async () => {}); },
}));

vi.mock('../../../src/evolution/NoveltyArchive.js', () => ({
  NoveltyArchive: vi.fn(),
}));

vi.mock('../../../src/types/domains.js', () => ({
  Domain: { P5: 'p5', GLSL: 'glsl', HYDRA: 'hydra', STRUDEL: 'strudel', REVIDEO: 'revideo' },
}));

vi.mock('../../../src/core/lir/GeneratedCodeParser.js', () => ({
  GeneratedCodeParser: class { parse = vi.fn(() => []); },
}));

vi.mock('../../../src/types/providers.js', () => ({
  Provider: { LMSTUDIO: 'lmstudio', OLLAMA: 'ollama' },
}));

vi.mock('../../../src/render/RenderAndScorePipeline.js', () => ({
  RenderAndScorePipeline: class {
    static blendScores = mockRenderPipelineBlendScores;
    process = mockRenderPipelineProcess;
    close = mockRenderPipelineClose;
  },
}));

vi.mock('../../../src/fs/SinterFS.js', () => ({
  SinterFS: {
    open: vi.fn(() => ({
      recordRun: vi.fn(),
      writeArtifact: vi.fn(() => ({ kind: 'generated-code', id: 'art-1' })),
      getProjectStore: vi.fn(() => ({
        getEventStore: vi.fn(() => ({
          queryEvents: vi.fn(() => []),
        })),
      })),
      readRef: vi.fn(() => null),
      readArtifact: vi.fn(() => null),
      close: vi.fn(),
    })),
  },
}));

vi.mock('../../../src/git/GitIntegration.js', () => ({
  GitIntegration: class {
    startRun = vi.fn(async () => 'test-branch');
    commitIteration = vi.fn(async () => {});
    endRun = vi.fn(async () => {});
    getStatus = vi.fn(() => ({ enabled: false }));
  },
}));

vi.mock('../../../src/entropy/MetabolicEntropyEngine.js', () => ({
  MetabolicEntropyEngine: class {
    harvest = vi.fn(async () => ({ seed: 1, phrase: 'test' }));
  },
}));

vi.mock('../../../src/generators/GeneratorHarnessTools.js', () => ({
  GeneratorHarnessTools: class {
    buildDiversityPrompt = vi.fn((p: string) => p);
    rankCandidates = mockRankCandidates;
    buildRepairPacket = mockBuildRepairPacket;
    modulateRepairPrompt = vi.fn((p: string) => p);
  },
}));

vi.mock('../../../src/config/FeatureFlags.js', () => ({
  getEvalMode: vi.fn(() => 'legacy'),
  getRepairMode: vi.fn(() => 'off'),
}));

/** Captures the shared recentScores array RalphLoop hands EvolutionEngine. */
const evolutionEngineSharedScores = vi.hoisted(() => ({ ref: null as number[] | null }));

vi.mock('../../../src/evolution/EvolutionEngine.js', () => ({
  EvolutionEngine: class {
    constructor(options?: { recentScores?: number[] }) {
      evolutionEngineSharedScores.ref = options?.recentScores ?? null;
    }
    propose = vi.fn(() => null);
    clamp = vi.fn((p: any) => p);
  },
}));

vi.mock('../../../src/intuition/index.js', () => ({
  IntuitionEngine: class {
    load = mockIntuitionLoad;
    save = mockIntuitionSave;
    recordOutcome = mockIntuitionRecordOutcome;
    generateHint = mockIntuitionGenerateHint;
  },
}));

vi.mock('../../../src/emergence/EmergenceHooks.js', () => ({
  EmergenceHooks: class {
    onCreativeRun = mockEmergenceOnCreativeRun;
  },
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { RalphLoop } from '../../../src/core/RalphLoop.js';
import { getEvalMode, getRepairMode } from '../../../src/config/FeatureFlags.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function resetAllMocks(): void {
  vi.clearAllMocks();
  evolutionEngineSharedScores.ref = null;
  mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.75, issues: [] });
  mockScoringEngineScore.mockResolvedValue({ score: 0.75, issues: [] });
  mockGeneratorGenerate.mockResolvedValue({
    code: 'function setup() {} function draw() {}',
    thinking: 'test-thinking',
    model: 'test-model',
  });
  mockCodeValidatorValidate.mockReturnValue({
    valid: true,
    errors: [],
    cleanedCode: 'function setup() {} function draw() {}',
  });
  mockStagnationCheck.mockReturnValue({
    shouldBreak: false,
    reason: '',
    successRate: 0.5,
    // Real StagnationDetector always returns exploreAggressively; include it so
    // the outer successRateTracker.recordAttempt path is exercised.
    exploreAggressively: false,
  });
  mockEvolutionUpdate.mockReturnValue({ noveltyScore: 0.5, hints: '' });
  mockSuccessRateTrackerGetRecommended.mockReturnValue(1);
  mockCompostHeapAddFile.mockResolvedValue(undefined);
  mockCompostHeapIsOverCapacity.mockResolvedValue(false);
  mockCompostMillDigest.mockResolvedValue(undefined);
  mockCompostMillGetGenerationMaterials.mockResolvedValue({ seeds: [], dna: [], techniques: [] });
  mockPromptStoreLoad.mockReturnValue('loaded-prompt-content');
  mockPromptStoreInjectContext.mockReturnValue('prompt-with-context');
  mockAmbiguityDetect.mockReturnValue([]);
  mockContextAccumulationGetHistory.mockReturnValue([]);
  mockRenderPipelineProcess.mockResolvedValue({ success: true, score: 0.8, domain: 'p5', duration: 5, warnings: [] });
  mockRenderPipelineClose.mockResolvedValue(undefined);
  mockRenderPipelineBlendScores.mockImplementation(({ baseScore, renderScore, renderWeight = 0.5 }) =>
    baseScore * (1 - renderWeight) + renderScore * renderWeight,
  );
  mockHeadlessRenderWithEvidence.mockResolvedValue({
    timingMs: 5,
    infraUnavailable: false,
    candidateFailure: false,
    screenshot: {
      mimeType: 'image/png',
      dataBase64: 'fake-image',
      width: 400,
      height: 400,
    },
    lateScreenshot: {
      mimeType: 'image/png', dataBase64: 'fake-image-late', width: 400, height: 400,
    },
  });
  mockScoreRenderedEvidence.mockResolvedValue({
    score: 0.92,
    confidence: 0.95,
    failureClass: 'none',
    reasoning: 'rendered evaluator passed',
  });
  mockBuildRepairPacket.mockReturnValue('--- REPAIR PACKET ---');
  mockRankCandidates.mockReturnValue({ rankedIndices: [0], winnerIndex: 0 });
  mockIntuitionGenerateHint.mockReturnValue(undefined);
  mockEmergenceOnCreativeRun.mockResolvedValue({
    placement: { outcome: 'accepted', cellId: 'cell-1', accepted: true },
    signals: { novelty: 0.5 },
  });
  vi.mocked(getEvalMode).mockReturnValue('legacy');
  vi.mocked(getRepairMode).mockReturnValue('off');
  mockPromiseDetectorDetect.mockReturnValue(false);
  mockSafetyGuardrailsCheckAll.mockReturnValue(true);
}

const DEGRADED_SCORER_EVAL = {
  score: 0,
  confidence: 0,
  failureClass: 'scorer' as const,
  reasoning: 'Evaluator LLM unavailable',
  repairAdvice: {
    issue: 'Evaluator unavailable',
    fix: 'Restore evaluator model availability before trusting quality.',
    constraint: 'Do not mark the artifact release-ready from legacy fallback alone.',
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('RalphLoop — degraded-evaluation gates (W1.2)', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('repair/elevation gate', () => {
    it('never fires single-round repair on a degraded (scorer) evaluation', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      vi.mocked(getRepairMode).mockReturnValue('single-round');
      mockScoreRenderedEvidence.mockResolvedValue(DEGRADED_SCORER_EVAL);
      // The degraded fallback score lands below the repair threshold, so the
      // ungated loop WOULD repair here — the gate must prevent it.
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.5, issues: [] });

      await RalphLoop.run('create a sketch', {
        maxIterations: 2,
        minQualityScore: 0.7,
        _disableIterationExtension: true,
      });

      expect(mockBuildRepairPacket).not.toHaveBeenCalled();
      // Exactly one generation call (the initial candidate) — no repair pass.
      expect(mockGeneratorGenerate).toHaveBeenCalledTimes(1);
    });

    it('still fires single-round repair on an honest below-band score (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      vi.mocked(getRepairMode).mockReturnValue('single-round');
      let evalCall = 0;
      mockScoreRenderedEvidence.mockImplementation(async () => {
        evalCall++;
        return evalCall === 1
          ? { score: 0.5, confidence: 0.9, failureClass: 'none' as const, reasoning: 'honest low score' }
          : { score: 0.6, confidence: 0.9, failureClass: 'none' as const, reasoning: 'honest repair score' };
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        minQualityScore: 0.1,
        _disableIterationExtension: true,
      });

      expect(mockBuildRepairPacket).toHaveBeenCalledTimes(1);
      expect(mockGeneratorGenerate).toHaveBeenCalledTimes(2);
      // The second generation call is the repair pass (isRepair = true).
      expect(mockGeneratorGenerate.mock.calls[1]?.[2]).toBe(true);
    });

    it('does not adopt a repair candidate whose own evaluation came back degraded', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      vi.mocked(getRepairMode).mockReturnValue('single-round');
      mockCodeValidatorValidate.mockImplementation((code: string) => ({ valid: true, errors: [], cleanedCode: code }));
      mockGeneratorGenerate
        .mockResolvedValueOnce({ code: 'ORIGINAL_CODE', thinking: 't1', model: 'm1' })
        .mockResolvedValueOnce({ code: 'REPAIR_CODE', thinking: 't2', model: 'm2' });
      let evalCall = 0;
      mockScoreRenderedEvidence.mockImplementation(async () => {
        evalCall++;
        // Initial evaluation honest but low (repair fires); the repair
        // candidate's evaluation is degraded (scorer outage) with a tempting
        // 0.99 legacy fallback score that must NOT win adoption.
        return evalCall === 1
          ? { score: 0.5, confidence: 0.9, failureClass: 'none' as const, reasoning: 'honest low score' }
          : DEGRADED_SCORER_EVAL;
      });
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.99, issues: [] });

      const result = await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        minQualityScore: 0.1,
        _disableIterationExtension: true,
      });

      // Repair fired honestly, but the degraded 0.99 repair evaluation must not
      // displace the honest 0.50 incumbent.
      expect(mockGeneratorGenerate).toHaveBeenCalledTimes(2);
      expect(result.code).toBe('ORIGINAL_CODE');
      expect(result.finalScore).toBe(0.5);
    });
  });

  describe('best-candidate selection', () => {
    it('ignores a degraded 0.99 and returns the honest 0.80 candidate', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockCodeValidatorValidate.mockImplementation((code: string) => ({ valid: true, errors: [], cleanedCode: code }));
      mockGeneratorGenerate
        .mockResolvedValueOnce({ code: 'ITER1_HONEST_CODE', thinking: 't1', model: 'm1' })
        .mockResolvedValue({ code: 'ITER2_DEGRADED_CODE', thinking: 't2', model: 'm2' });
      let evalCall = 0;
      mockScoreRenderedEvidence.mockImplementation(async () => {
        evalCall++;
        return evalCall === 1
          ? { score: 0.8, confidence: 0.9, failureClass: 'none' as const, reasoning: 'honest iteration one' }
          : DEGRADED_SCORER_EVAL; // iter 2 + its scorer retry
      });
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.99, issues: [] });

      const result = await RalphLoop.run('create a sketch', {
        maxIterations: 5,
        minQualityScore: 0.1,
        _disableIterationExtension: true,
      });

      expect(result.reason).toContain('evaluation evidence degraded');
      expect(result.code).toBe('ITER1_HONEST_CODE');
      expect(result.finalScore).toBe(0.8);
      expect(result.evaluationFailureClass).toBe('none');
    });
  });

  describe('convergence detection', () => {
    it('treats degraded (legacy) scores as absent — a plateau never converges', async () => {
      // Legacy eval mode: every evaluation is heuristic and therefore degraded.
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.8, issues: [] });

      const result = await RalphLoop.run('create a sketch', {
        maxIterations: 4,
        minQualityScore: 0.1,
        _disableIterationExtension: true,
      });

      expect(result.iterations).toBe(4);
      expect(result.reason).toContain('max iterations');
      expect(result.reason).not.toContain('convergence detected');
    });

    it('still converges on an honest score plateau (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.8,
        confidence: 0.9,
        failureClass: 'none',
        reasoning: 'honest plateau',
      });

      const result = await RalphLoop.run('create a sketch', {
        maxIterations: 10,
        minQualityScore: 0.1,
        _disableIterationExtension: true,
      });

      expect(result.reason).toContain('convergence detected');
    });
  });

  describe('intuition recordOutcome gate', () => {
    it('does not record a degraded (legacy) outcome into the intuition engine', async () => {
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.92, issues: [] });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        useIntuition: true,
        _disableIterationExtension: true,
      });

      expect(mockIntuitionRecordOutcome).not.toHaveBeenCalled();
    });

    it('records an honest outcome into the intuition engine (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.92,
        confidence: 0.95,
        failureClass: 'none',
        reasoning: 'honest excellent',
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        useIntuition: true,
        _disableIterationExtension: true,
      });

      expect(mockIntuitionRecordOutcome).toHaveBeenCalledTimes(1);
      expect(mockIntuitionRecordOutcome).toHaveBeenCalledWith(
        'function setup() {} function draw() {}',
        'p5',
        0.92,
        'test-model',
      );
    });
  });

  describe('emergence/taste hook gate', () => {
    it('does not feed a degraded-only run to the emergence archive', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.92, issues: [] });

        await RalphLoop.run('create a sketch', {
          maxIterations: 1,
          _disableIterationExtension: true,
        });

        expect(mockEmergenceOnCreativeRun).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = savedNodeEnv;
      }
    });

    it('feeds an honest run to the emergence archive (control)', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        vi.mocked(getEvalMode).mockReturnValue('auto');
        mockScoreRenderedEvidence.mockResolvedValue({
          score: 0.92,
          confidence: 0.95,
          failureClass: 'none',
          reasoning: 'honest excellent',
        });

        await RalphLoop.run('create a sketch', {
          maxIterations: 1,
          _disableIterationExtension: true,
        });

        expect(mockEmergenceOnCreativeRun).toHaveBeenCalledTimes(1);
        expect(mockEmergenceOnCreativeRun).toHaveBeenCalledWith(
          expect.objectContaining({ qualityScore: 0.92 }),
        );
      } finally {
        process.env.NODE_ENV = savedNodeEnv;
      }
    });
  });

  describe('legacy-eval stamping (audio + LIMINAL_EVAL_MODE=legacy)', () => {
    it('stamps failureClass legacy, still displays the score, and never banks it as an exemplar', async () => {
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.8, issues: [] });

      const result = await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        useArchiveLearning: true,
        _disableIterationExtension: true,
      });

      // The score displays normally...
      expect(result.finalScore).toBe(0.8);
      // ...but carries the legacy provenance class...
      expect(result.evaluationFailureClass).toBe('legacy');
      // ...and is never banked as a few-shot exemplar.
      expect(mockArchiveLearningAddOutput).not.toHaveBeenCalled();
    });

    it('banks an honest score as an exemplar (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.92,
        confidence: 0.95,
        failureClass: 'none',
        reasoning: 'honest excellent',
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        useArchiveLearning: true,
        _disableIterationExtension: true,
      });

      expect(mockArchiveLearningAddOutput).toHaveBeenCalledTimes(1);
    });
  });

  // ─── W4: remaining raw-score consumers ─────────────────────────────
  //
  // Note: CreativeIterationGate early-exits on scorer/infra (confidence 0)
  // BEFORE evolution.update / recentScores. Legacy-mode scores still reach those
  // consumers with failureClass 'legacy' (degraded honesty, confidence > 0),
  // so they are the right degraded path for post-gate fitness consumers.
  // Honest controls use score < 0.90 so the excellence early-exit does not skip
  // evolution.update either.

  describe('W4 — EvolutionEngine recentScores fitness gate', () => {
    it('does not push a degraded (legacy) score into EvolutionEngine recentScores', async () => {
      // Default evalMode is legacy — score displays, honesty is false.
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.75, issues: [] });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        useEvolution: true,
        _disableIterationExtension: true,
      });

      expect(evolutionEngineSharedScores.ref).toEqual([]);
    });

    it('pushes an honest score into EvolutionEngine recentScores (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      // Stay below 0.90 so the excellence gate does not skip evolution update.
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.75,
        confidence: 0.95,
        failureClass: 'none',
        reasoning: 'honest mid-band',
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        useEvolution: true,
        _disableIterationExtension: true,
      });

      expect(evolutionEngineSharedScores.ref).toEqual([0.75]);
    });
  });

  describe('W4 — EvolutionIntegration.update novelty vs fitness', () => {
    it('still calls update on a degraded evaluation, with scoreIsHonest=false', async () => {
      // Legacy path reaches evolution.update (unlike scorer confidence-0 early exit).
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.75, issues: [] });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        _disableIterationExtension: true,
      });

      // Novelty path must keep running; fitness banking is gated via the 5th arg.
      expect(mockEvolutionUpdate).toHaveBeenCalledTimes(1);
      expect(mockEvolutionUpdate).toHaveBeenCalledWith(
        1,
        'function setup() {} function draw() {}',
        0.75,
        'create a sketch',
        false,
      );
    });

    it('calls update with scoreIsHonest=true on an honest evaluation (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.75,
        confidence: 0.95,
        failureClass: 'none',
        reasoning: 'honest mid-band',
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        _disableIterationExtension: true,
      });

      expect(mockEvolutionUpdate).toHaveBeenCalledTimes(1);
      expect(mockEvolutionUpdate).toHaveBeenCalledWith(
        1,
        'function setup() {} function draw() {}',
        0.75,
        'create a sketch',
        true,
      );
    });
  });

  describe('W4 — LOOP_EVALUATION display stream (not fitness)', () => {
    it('still emits LOOP_EVALUATION with a degraded score (must not over-gate)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      // Scorer outage falls back to legacy diagnostic score (0.75) while stamping
      // failureClass 'scorer' — the emit must still fire with that diagnostic score.
      mockScoreRenderedEvidence.mockResolvedValue(DEGRADED_SCORER_EVAL);
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.75, issues: [] });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        _disableIterationExtension: true,
      });

      expect(mockEventBusEmit).toHaveBeenCalledWith(
        'LOOP_EVALUATION',
        'RalphLoop',
        expect.objectContaining({
          overallScore: 0.75,
          iteration: 1,
        }),
      );
    });

    it('emits LOOP_EVALUATION with an honest score (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.93,
        confidence: 0.95,
        failureClass: 'none',
        reasoning: 'honest excellent',
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        _disableIterationExtension: true,
      });

      expect(mockEventBusEmit).toHaveBeenCalledWith(
        'LOOP_EVALUATION',
        'RalphLoop',
        expect.objectContaining({
          overallScore: 0.93,
          iteration: 1,
        }),
      );
    });
  });

  // ─── W4 FIX R1: under-enumerated fitness consumers ─────────────────
  //
  // autoCompost / stagnation / successRateTracker sit AFTER CreativeIterationGate.
  // Scorer confidence-0 early-exits the gate before those consumers; legacy-mode
  // (failureClass 'legacy', confidence > 0) is the degraded path that reaches them.
  // Honest controls use score in [0.70, 0.90) so compost banks without excellence
  // early-exit, and stagnation still runs.

  describe('W4 FIX R1 — autoCompost fitness gate', () => {
    it('does not bank a degraded (legacy) score into the compost heap', async () => {
      // Default evalMode is legacy — score displays at 0.75 but honesty is false.
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.75, issues: [] });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        autoCompost: true,
        project: 'degraded-compost-test',
        _disableIterationExtension: true,
      });

      expect(mockCompostHeapAddFile).not.toHaveBeenCalled();
    });

    it('banks an honest score >= 0.7 into the compost heap (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.75,
        confidence: 0.95,
        failureClass: 'none',
        reasoning: 'honest mid-band compostable',
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        autoCompost: true,
        project: 'honest-compost-test',
        _disableIterationExtension: true,
      });

      expect(mockCompostHeapAddFile).toHaveBeenCalledTimes(1);
      // Path includes project + iteration artifact name.
      expect(mockCompostHeapAddFile).toHaveBeenCalledWith(
        expect.stringMatching(/honest-compost-test[/\\]v1\.js$/),
      );
    });
  });

  describe('W4 FIX R1 — stagnation + successRateTracker fitness/policy gate', () => {
    it('does not call stagnation.check or recordAttempt on a degraded (legacy) score', async () => {
      mockScoringEngineScoreReliable.mockResolvedValue({ score: 0.75, issues: [] });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        _disableIterationExtension: true,
      });

      // Degraded 0.75 must not reset plateaus or count as success.
      expect(mockStagnationCheck).not.toHaveBeenCalled();
      expect(mockSuccessRateTrackerRecordAttempt).not.toHaveBeenCalled();
    });

    it('calls stagnation.check and recordAttempt on an honest score (control)', async () => {
      vi.mocked(getEvalMode).mockReturnValue('auto');
      mockScoreRenderedEvidence.mockResolvedValue({
        score: 0.75,
        confidence: 0.95,
        failureClass: 'none',
        reasoning: 'honest mid-band',
      });

      await RalphLoop.run('create a sketch', {
        maxIterations: 1,
        _disableIterationExtension: true,
      });

      expect(mockStagnationCheck).toHaveBeenCalledTimes(1);
      expect(mockStagnationCheck).toHaveBeenCalledWith(
        1,
        0.75,
        0.5, // noveltyScore from mockEvolutionUpdate
        'create a sketch',
        expect.any(String),
      );
      // 0.75 >= 0.7 → success recorded for exploration policy.
      expect(mockSuccessRateTrackerRecordAttempt).toHaveBeenCalledTimes(1);
      expect(mockSuccessRateTrackerRecordAttempt).toHaveBeenCalledWith(true);
    });
  });
});
