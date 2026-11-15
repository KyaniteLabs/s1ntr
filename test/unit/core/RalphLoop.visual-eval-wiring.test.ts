/**
 * Visual evaluation end-to-end (#376) — pixels reach the aesthetic judge.
 *
 * When an iteration produces render evidence with a screenshot, the
 * AestheticCritic guardrail block must route through `critiqueWithLLM` WITH
 * the screenshot so the aesthetic LLM judge sees the rendered artifact
 * instead of code alone. When no screenshot exists, the loop must keep the
 * legacy sync heuristic `critique` path untouched (no regression).
 *
 * Harness mirrors RalphLoop.degradedGates.test.ts (all boundaries mocked).
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
      mimeType: 'image/png',
      dataBase64: 'fake-image-late',
      width: 400,
      height: 400,
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
      mimeType: 'image/png',
      dataBase64: 'fake-image-late',
      width: 400,
      height: 400,
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

// ─── Aesthetic module mock (visual-eval wiring seam) ───────────────────────

const mockCritiqueWithLLM = vi.hoisted(() =>
  vi.fn(async () => ({
    score: 0.8,
    violations: [],
    passed: true,
    timestamp: Date.now(),
    usedLLM: true,
  }))
);
const mockSyncCritique = vi.hoisted(() =>
  vi.fn(() => ({
    score: 0.6,
    violations: [],
    passed: true,
    timestamp: Date.now(),
  }))
);
const mockSetLLMClient = vi.hoisted(() => vi.fn());

vi.mock('../../../src/aesthetic/index.js', () => ({
  AestheticCritic: class {
    setLLMClient = mockSetLLMClient;
    critiqueWithLLM = mockCritiqueWithLLM;
    critique = mockSyncCritique;
  },
  DEFAULT_DESIGN_CONSTRAINTS: { general: { minAestheticScore: 0.6 } },
}));

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('RalphLoop — visual evaluation wiring (#376)', () => {
  beforeEach(() => {
    resetAllMocks();
    mockCritiqueWithLLM.mockClear();
    mockSyncCritique.mockClear();
    mockSetLLMClient.mockClear();
    vi.mocked(getEvalMode).mockReturnValue('auto');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the render screenshot to the aesthetic LLM judge when render evidence exists', async () => {
    await RalphLoop.run('create a sketch', {
      maxIterations: 1,
      minQualityScore: 0.1,
      useAestheticGuardrails: true,
      useHumanPerceptionGuardrails: false,
      _disableIterationExtension: true,
    });

    expect(mockCritiqueWithLLM).toHaveBeenCalledTimes(1);
    const [code, domain, , imageInputs] = mockCritiqueWithLLM.mock.calls[0]!;
    expect(code).toBe('function setup() {} function draw() {}');
    expect(domain).toBe('p5');
    expect(imageInputs).toEqual([{
      mimeType: 'image/png',
      dataBase64: 'fake-image',
      width: 400,
      height: 400,
      label: 'rendered-artifact',
    }]);
    // The sync heuristic-only path must NOT be the one used here.
    expect(mockSyncCritique).not.toHaveBeenCalled();
  });

  it('persists the validated candidate before rendered evaluation begins', async () => {
    const order: string[] = [];
    mockHeadlessRenderWithEvidence.mockImplementationOnce(async () => {
      order.push('render');
      return {
        timingMs: 5,
        infraUnavailable: false,
        candidateFailure: false,
        screenshot: { mimeType: 'image/png', dataBase64: 'fake-image', width: 400, height: 400 },
        lateScreenshot: { mimeType: 'image/png', dataBase64: 'fake-image-late', width: 400, height: 400 },
      };
    });
    mockScoreRenderedEvidence.mockImplementationOnce(async () => {
      order.push('evaluate');
      return { score: 0.92, confidence: 0.95, failureClass: 'none',
        reasoning: 'Visible hierarchy is coherent.', dimensionScores: { cohesion: 0.94 },
        calibrationDigest: 'b'.repeat(64) };
    });

    const result = await RalphLoop.run('create a persisted sketch', {
      maxIterations: 1,
      minQualityScore: 0.1,
      _disableIterationExtension: true,
      onCandidateGenerated: async ({ code }) => {
        expect(code).toBe('function setup() {} function draw() {}');
        order.push('persist');
      },
      onRenderedEvidence: async () => { order.push('persist-rendered'); },
    });

    expect(order).toEqual(['persist', 'render', 'persist-rendered', 'evaluate']);
    expect(result.evaluation).toMatchObject({
      reasoning: 'Visible hierarchy is coherent.',
      dimensionScores: { cohesion: 0.94 },
      calibrationDigest: 'b'.repeat(64),
    });
  });

  it('fails closed before scoring when rendered frames are missing', async () => {
    mockHeadlessRenderWithEvidence.mockResolvedValue({
      timingMs: 5,
      infraUnavailable: false,
      candidateFailure: false,
    });

    await expect(RalphLoop.run('create a sketch', {
      maxIterations: 1,
      minQualityScore: 0.1,
      useAestheticGuardrails: true,
      useHumanPerceptionGuardrails: false,
      _disableIterationExtension: true,
    })).rejects.toThrow('Rendered evidence is incomplete');

    expect(mockCritiqueWithLLM).not.toHaveBeenCalled();
    expect(mockScoreRenderedEvidence).not.toHaveBeenCalled();
  });
});
