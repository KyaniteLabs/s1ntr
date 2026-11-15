import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (only for external I/O) ────────────────────────────────
const {
  mockLLM,
  mockRenderArtifact,
  mockFailureLogger,
  mockLogger,
  mockRateLimiter,
  mockTelemetry,
} = vi.hoisted(() => ({
  mockLLM: {
    getConfig: vi.fn(() => ({ model: 'kimi-k3-instruct' })),
    complete: vi.fn(),
  },
  mockRenderArtifact: { execute: vi.fn() },
  mockFailureLogger: { log: vi.fn() },
  mockLogger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  mockRateLimiter: {
    execute: vi.fn(async (_op: string, fn: () => unknown) => ({ result: await fn() })),
  },
  mockTelemetry: {
    setContext: vi.fn(),
    clearContext: vi.fn(),
    wrap: vi.fn(async (tool: { execute: (p: unknown) => unknown }, params: unknown) => tool.execute(params)),
  },
}));

vi.mock('../../../../src/llm/LLMClient.js', () => ({
  LLMClient: class { constructor() { return mockLLM; } },
}));
vi.mock('../../../../src/utils/Logger.js', () => ({
  Logger: mockLogger,
}));
vi.mock('../../../../src/harness/FailureLogger.js', () => ({
  failureLogger: mockFailureLogger,
}));
vi.mock('../../../../src/harness/tools/RateLimiter.js', () => ({
  rateLimiter: mockRateLimiter,
}));
vi.mock('../../../../src/harness/tools/TelemetryWrapper.js', () => ({
  telemetryWrapper: mockTelemetry,
}));
vi.mock('../../../../src/harness/RunStateStore.js', () => ({
  saveRunState: vi.fn(async () => undefined),
  readRunState: vi.fn(async () => null),
  formatResumeContext: vi.fn(() => ''),
  clearRunState: vi.fn(async () => undefined),
  captureWorkspaceFingerprint: vi.fn(async () => ({})),
  validateWorkspaceFingerprint: vi.fn(async () => ({ valid: true })),
  SemanticBoundary: {
    INTERRUPTED: 'interrupted',
    MUTATION_APPLIED: 'mutation_applied',
    VERIFICATION_STARTED: 'verification_started',
    VERIFICATION_FINISHED: 'verification_finished',
  },
}));
vi.mock('../../../../src/harness/tools/index.js', () => ({
  readFileTool: { execute: vi.fn(async () => ({ success: true, data: { content: 'x' } })) },
  writeFileTool: { execute: vi.fn(async () => ({ success: true, data: {} })) },
  applyEditTool: { execute: vi.fn(async () => ({ success: true, data: {} })) },
  runBuildTool: { execute: vi.fn(async () => ({ success: true })) },
  runTestsTool: { execute: vi.fn(async () => ({ success: true })) },
  restoreBackupTool: { execute: vi.fn(async () => ({ success: true })) },
  createBackupTool: { execute: vi.fn(async () => ({ success: true, data: { backupPath: '/tmp/bak' } })) },
  executeSkillTool: { execute: vi.fn(async () => ({ success: true, data: {} })) },
  listSkillsTool: { execute: vi.fn(async () => ({ success: true, data: { skills: [] } })) },
  attachImageTool: { execute: vi.fn(async () => ({ success: true, data: {} })) },
  searchTool: { execute: vi.fn(async () => ({ success: true })) },
  searchCodeTool: { execute: vi.fn(async () => ({ success: true, data: {} })) },
  searchDocsTool: { execute: vi.fn(async () => ({ success: true, data: {} })) },
  listDirTool: { execute: vi.fn(async () => ({ success: true })) },
  typeCheckTool: { execute: vi.fn(async () => ({ success: true })) },
  npmTool: { execute: vi.fn(async () => ({ success: true })) },
  runLintTool: { execute: vi.fn(async () => ({ success: true })) },
  runFocusedTestsTool: { execute: vi.fn(async () => ({ success: true })) },
  lspTool: { execute: vi.fn(async () => ({ success: true })) },
  astValidatorTool: { execute: vi.fn(async () => ({ success: true })) },
  importGuardTool: { execute: vi.fn(async () => ({ success: true })) },
  gitStatusTool: { execute: vi.fn(async () => ({ success: true, data: {} })) },
  gitLogTool: { execute: vi.fn(async () => ({ success: true, data: { commits: '', count: 0, ref: 'HEAD' } })) },
  gitDiffTool: { execute: vi.fn(async () => ({ success: true, data: { diff: '', truncated: false, range: '(working tree)' } })) },
  renderArtifactTool: mockRenderArtifact,
}));

import { LLMModeAgent } from '../../../../src/harness/agent/LLMModeAgent.js';
import { AVAILABLE_TOOL_NAMES } from '../../../../src/harness/agent/HarnessAgent.js';
import { CapabilityRegistry } from '../../../../src/llm/CapabilityRegistry.js';
import { Status } from '../../../../src/types/status.js';
import type { LLMClient } from '../../../../src/llm/LLMClient.js';

const SCREENSHOT_B64 = 'QUJDREVGRw==';

function renderArtifactSuccess() {
  return {
    success: true,
    data: {
      domain: 'html',
      timingMs: 12,
      infraUnavailable: false,
      candidateFailure: false,
      screenshot: { mimeType: 'image/png', dataBase64: SCREENSHOT_B64, width: 800, height: 600 },
      logs: ['[log] rendered'],
      errors: [],
    },
  };
}

function planResponse(tool: string, params: Record<string, unknown> = {}) {
  return {
    success: true,
    text: JSON.stringify({
      thought: `planning ${tool}`,
      tool,
      params,
      expectedResult: 'progress',
    }),
  };
}

async function runRenderThenComplete(model: string) {
  mockLLM.getConfig.mockReturnValue({ model });
  mockLLM.complete
    .mockResolvedValueOnce(planResponse('renderArtifact', { code: '<html><body>hi</body></html>' }))
    .mockResolvedValueOnce(planResponse('complete'));

  const agent = new LLMModeAgent(mockLLM as unknown as LLMClient);
  const session = await agent.executeTask({
    id: `vision-test-${model}`,
    title: 'Look at the artifact',
    description: 'Render the artifact and look at it.',
    approved: true,
  });
  return { agent, session };
}

describe('LLMModeAgent renderArtifact vision gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRenderArtifact.execute.mockResolvedValue(renderArtifactSuccess());
  });

  it('attaches the rendered screenshot as image input on the next planning call for vision models', async () => {
    const { session } = await runRenderThenComplete('kimi-k3-instruct');

    expect(session.status).toBe(Status.SUCCESS);
    // Second planning call (after renderArtifact) carries the screenshot.
    const secondCall = mockLLM.complete.mock.calls[1][0] as { imageInputs?: Array<{ dataBase64: string; label?: string }> };
    expect(secondCall.imageInputs).toHaveLength(1);
    expect(secondCall.imageInputs![0].dataBase64).toBe(SCREENSHOT_B64);
    expect(secondCall.imageInputs![0].label).toBe('rendered-artifact');
    // No degradation recorded.
    expect(mockFailureLogger.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'degraded' }),
    );
  });

  it('keeps base64 screenshots out of the planning transcript', async () => {
    const { session } = await runRenderThenComplete('kimi-k3-instruct');

    const toolMessage = session.messages.find(
      (m) => m.role === 'tool' && m.toolResult !== undefined && m.content.includes('rendered'),
    );
    expect(toolMessage!.content).not.toContain(SCREENSHOT_B64);
    expect(toolMessage!.content).toContain('attached as image input');
  });

  it('degrades loudly and proceeds text-only when the harness model cannot accept images', async () => {
    const { session } = await runRenderThenComplete('qwen2.5-coder');

    expect(session.status).toBe(Status.SUCCESS);
    const secondCall = mockLLM.complete.mock.calls[1][0] as { imageInputs?: unknown };
    expect(secondCall.imageInputs).toBeUndefined();
    // Loud degradation: warn log + degraded failure record.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'LLMModeAgent',
      expect.stringContaining('text-only'),
    );
    expect(mockFailureLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'degraded',
        model: 'qwen2.5-coder',
        error: expect.stringContaining('cannot accept image input'),
      }),
    );
    // The transcript placeholder tells the model to diagnose from logs/errors.
    const toolMessage = session.messages.find(
      (m) => m.role === 'tool' && m.toolResult !== undefined && m.content.includes('rendered'),
    );
    expect(toolMessage!.content).not.toContain(SCREENSHOT_B64);
    expect(toolMessage!.content).toContain('text-only');
  });
});

describe('harness tool surface (shell posture)', () => {
  it('exposes the new read-only tools and still refuses generic shell names', async () => {
    expect(AVAILABLE_TOOL_NAMES).toContain('renderArtifact');
    expect(AVAILABLE_TOOL_NAMES).toContain('gitLog');
    expect(AVAILABLE_TOOL_NAMES).toContain('gitDiff');
    expect(AVAILABLE_TOOL_NAMES).not.toContain('execute');
    expect(AVAILABLE_TOOL_NAMES).not.toContain('bash');
    expect(AVAILABLE_TOOL_NAMES).not.toContain('shell');
    expect(AVAILABLE_TOOL_NAMES).not.toContain('runCommand');
  });

  it('treats Kimi K3 as vision-capable and Kimi K2 / local coders as text-only', () => {
    expect(CapabilityRegistry.supportsVision('kimi-k3-instruct')).toBe(true);
    expect(CapabilityRegistry.supportsVision('kimi-k3-0716')).toBe(true);
    expect(CapabilityRegistry.supportsVision('kimi-k2-p5')).toBe(false);
    expect(CapabilityRegistry.supportsVision('qwen2.5-coder')).toBe(false);
  });
});
