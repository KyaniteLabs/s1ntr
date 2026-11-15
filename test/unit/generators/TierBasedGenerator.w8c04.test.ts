import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toolLoop: vi.fn(),
  complete: vi.fn(),
  prepare: vi.fn(() => ({ skeletonHint: '', sampledApis: [], hardeningHints: [], hintsWereSampled: false })),
}));

vi.mock('../../../src/llm/LLMClient.js', () => {
  class MockLLMClient {
    generateWithToolLoop = mocks.toolLoop;
    complete = mocks.complete;
    getConfig = () => ({ model: 'test-model', baseUrl: 'http://localhost:1234/v1', role: 'generator' });
  }
  Object.assign(MockLLMClient, { isConfigured: () => true });
  return { LLMClient: MockLLMClient };
});
vi.mock('../../../src/config/ConfigLoader.js', () => ({ getEffectiveConfig: vi.fn() }));
vi.mock('../../../src/config/RoleConfig.js', () => ({
  loadRoleConfig: vi.fn(),
  isFatalRoleConfigError: (error: unknown) => error instanceof Error && error.message === 'fatal-role-config',
}));
vi.mock('../../../src/llm/PromptBuilder.js', () => ({
  PromptBuilder: class {
    static loadContext = vi.fn(async () => ({}));
    build = () => ({ system: 'system', user: 'user', combined: 'combined' });
  },
}));
vi.mock('../../../src/llm/ModelTier.js', () => ({ detectModelTier: () => 'flagship', trimContext: (value: string) => value }));
vi.mock('../../../src/harness/HarnessMemory.js', () => ({
  harnessMemory: { getSuccessfulAdaptations: () => [], getRecentEpisodes: () => [], recordEpisode: vi.fn() },
}));
vi.mock('../../../src/harness/MetaHarnessIntegration.js', () => ({ metaHarness: { onGenerationComplete: vi.fn() } }));
vi.mock('../../../src/harness/tools/generator-tools.js', () => ({
  GENERATOR_TOOLS: [{ name: 'submit_code', description: '', parameters: {} }],
  createGeneratorToolExecutor: () => vi.fn(),
}));
vi.mock('../../../src/generators/GeneratorHarnessTools.js', () => ({
  GeneratorHarnessTools: class {
    prepare = mocks.prepare;
    classifyFailure = () => ({ failureClass: 'syntax' });
    buildRepairPrompt = () => 'repair';
    recordSuccess = vi.fn();
  },
}));
vi.mock('../../../src/utils/Logger.js', () => ({ Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { TierBasedGenerator } from '../../../src/generators/TierBasedGenerator.js';
import {
  GenerationAttemptLedger,
  MemoryGenerationAttemptPersistence,
} from '../../../src/runtime-core/generationAttemptSink.js';
import { isEmptyArtifactFailure } from '../../../src/runtime-core/emptyArtifactFailure.js';

class TestGenerator extends TierBasedGenerator {
  constructor() { super('p5'); }
  protected override validateOutput(code: string): { valid: boolean; error?: string } {
    return code.includes('INVALID') ? { valid: false, error: 'invalid fixture' } : { valid: true };
  }
}

async function governedOptions() {
  const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
  const attemptTelemetry = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate', domain: 'p5' });
  return { ledger, options: { attemptLedger: ledger, attemptTelemetry } };
}

describe('TierBasedGenerator governed attempt integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockResolvedValue({ text: '', success: false, error: 'empty' });
  });

  it('records validation and terminal truth in the coordinator ledger', async () => {
    mocks.toolLoop.mockResolvedValue({
      content: 'function setup() { createCanvas(10, 10); }', success: true, iterations: 1, toolCallsMade: 0,
    });
    const { ledger, options } = await governedOptions();
    await new TestGenerator().generate('brief', options);
    const stages = (await ledger.snapshot('run', 'candidate'))?.events.map((event) => event.stage);
    expect(stages).toEqual(['validation', 'terminal']);
  });

  it('consumes the only recovery and preserves failed-primary lineage for an empty artifact', async () => {
    mocks.toolLoop.mockResolvedValue({ content: '', success: true, iterations: 1, toolCallsMade: 0 });
    const { ledger, options } = await governedOptions();
    await expect(new TestGenerator().generate('brief', options)).rejects.toSatisfy(isEmptyArtifactFailure);
    const snapshot = await ledger.snapshot('run', 'candidate');
    expect(snapshot?.counters.retries).toBe(1);
    expect(snapshot?.recovery.consumedByAttemptId).toBe(options.attemptTelemetry.attemptId);
    expect(snapshot?.events.some((event) => event.recoveryOfAttemptId === options.attemptTelemetry.attemptId)).toBe(true);
  });

  it('leaves recovery to the coordinator without making a hidden provider call', async () => {
    mocks.complete.mockResolvedValueOnce({ text: '', success: true });
    const { ledger, options } = await governedOptions();
    await expect(new TestGenerator().generate('brief', {
      ...options, useGeneratorTools: false, coordinatorManagedRecovery: true,
    })).rejects.toSatisfy(isEmptyArtifactFailure);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect((await ledger.snapshot('run', 'candidate'))?.counters.retries).toBe(0);
  });

  it('does not grant a second validation recovery after an empty-output recovery', async () => {
    mocks.toolLoop.mockResolvedValueOnce({ content: '', success: true, iterations: 1, toolCallsMade: 0 });
    mocks.complete.mockResolvedValueOnce({ text: 'INVALID artifact source', success: true });
    const { ledger, options } = await governedOptions();
    await expect(new TestGenerator().generate('brief', options)).rejects.toThrow('invalid fixture');
    expect((await ledger.snapshot('run', 'candidate'))?.counters.retries).toBe(1);
  });

  it('returns a successful recovery linked to the failed primary', async () => {
    mocks.toolLoop.mockResolvedValueOnce({ content: '', success: true, iterations: 1, toolCallsMade: 0 });
    mocks.complete.mockResolvedValueOnce({ text: 'function setup() { createCanvas(10, 10); }', success: true });
    const { ledger, options } = await governedOptions();
    await expect(new TestGenerator().generate('brief', options)).resolves.toContain('createCanvas');
    const snapshot = await ledger.snapshot('run', 'candidate');
    expect(snapshot?.events).toContainEqual(expect.objectContaining({
      stage: 'terminal', recoveryDecision: 'recovered_no_tools',
      recoveryOfAttemptId: options.attemptTelemetry.attemptId,
    }));
  });
});
