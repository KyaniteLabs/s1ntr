/**
 * LLMModeAgent - Full LLM-driven agent with planning and reflection
 * 
 * Unlike HarnessAgent (structured tasks), this agent:
 * - Uses LLM to plan which tools to call
 * - Reflects on tool results
 * - Adapts strategy based on feedback
 * - Handles multi-step reasoning
 */

import { LLMClient } from '../../llm/LLMClient.js';
import { CapabilityRegistry } from '../../llm/CapabilityRegistry.js';
import type { ProviderImageInput } from '../../llm/ProviderTypes.js';
import { ContextCompactor } from '../../llm/ContextCompactor.js';
import { resolvePromptTier } from '../../prompts/PromptTier.js';
import { Logger } from '../../utils/Logger.js';
import { failureLogger } from '../FailureLogger.js';
import { Status } from '../../types/status.js';
import { rateLimiter } from '../tools/RateLimiter.js';
import { formatError } from '../../utils/errors.js';
import { getSelfImprovePrompt, createReflectionPrompt } from '../prompts/self-improve.js';
import { thinkingRepository } from '../ThinkingSeparation.js';
import { thinkingAnalyzer } from '../ThinkingAnalyzer.js';
import { eventBus, EventTypes } from '../../core/EventBus.js';
import { telemetryWrapper } from '../tools/TelemetryWrapper.js';
import { classifyToolError, hashToolArgs } from '../../telemetry/EventLedger.js';
import {
  recordHarnessLaneEvent,
  resolveHarnessSeat,
  resolveHarnessSeatModel,
} from '../../telemetry/harnessLane.js';
import { repairToolCallFromText } from './repairToolCallJson.js';
import {
  readFileTool,
  writeFileTool,
  applyEditTool,
  runBuildTool,
  runTestsTool,
  restoreBackupTool,
  createBackupTool,
  executeSkillTool,
  listSkillsTool,
  attachImageTool,
  searchTool,
  searchCodeTool,
  searchDocsTool,
  listDirTool,
  typeCheckTool,
  npmTool,
  runLintTool,
  runFocusedTestsTool,
  lspTool,
  astValidatorTool,
  importGuardTool,
  gitStatusTool,
  gitLogTool,
  gitDiffTool,
  renderArtifactTool,
} from '../tools/index.js';
import type { ToolResult, RenderArtifactResult, RenderArtifactScreenshot } from '../tools/types.js';
import {
  saveRunState,
  readRunState,
  formatResumeContext,
  clearRunState,
  captureWorkspaceFingerprint,
  validateWorkspaceFingerprint,
  SemanticBoundary,
  type RunState,
} from '../RunStateStore.js';
import {
  authorizeExperimentRequest,
  requestFromToolCall,
  type ExperimentAuthorityPolicy,
  type ExperimentAuthorityReceipt,
} from '../authority/ExperimentAuthority.js';
import { pickCodeBlock, splitThinking } from '../../llm/ModelOutput.js';

const AVAILABLE_TOOL_NAMES = [
  'readFile',
  'applyEdit',
  'writeFile',
  'runBuild',
  'runTests',
  'executeSkill',
  'listSkills',
  'attachImage',
  'createBackup',
  'restoreBackup',
  'search',
  'searchCode',
  'searchDocs',
  'listDir',
  'typeCheck',
  'npm',
  'runLint',
  'runFocusedTests',
  'lsp',
  'astValidate',
  'importGuard',
  'gitStatus',
  'gitLog',
  'gitDiff',
  'renderArtifact',
  'complete',
] as const;

function unknownToolMessage(tool: string): string {
  const shellHint = ['execute', 'bash', 'shell', 'runCommand', 'terminal'].includes(tool)
    ? ' There is no generic shell/execute tool; use gitStatus for repo state, readFile/listDir/search/searchCode for inspection, and runBuild/typeCheck/runTests/runFocusedTests/runLint/npm for verification.'
    : '';
  return `Unknown tool: ${tool}.${shellHint} Available tools: ${AVAILABLE_TOOL_NAMES.join(', ')}`;
}

export interface LLMTask {
  id: string;
  title: string;
  description: string;
  /** Optional battery/kind tag (self-improve | diagnose | resume | …) */
  kind?: string;
  fileHint?: string;
  /** Deterministic working set for bounded runs - agent should read these first */
  workingSet?: string[];
  /** Ordered first-pass files for bounded localization */
  primaryFiles?: string[];
  /** Optional secondary files the runtime has already budgeted for bounded expansion */
  secondaryFiles?: string[];
  /** Secondary candidates intentionally left outside the active working set until bounded expansion is allowed */
  deferredSecondaryFiles?: string[];
  /** Number of files the bounded packet allows beyond the seeded lists before broader exploration */
  expansionBudget?: number;
  /** Whether bounded expansion is still available or already exhausted */
  expansionStatus?: 'allowed' | 'exhausted';
  /** Runtime-core confidence in the current bounded localization packet */
  localizationConfidence?: 'high' | 'medium' | 'low';
  /** Preferred first verification actions for this bounded packet */
  verificationTargets?: Array<{
    tool: 'runBuild' | 'runTests' | 'runFocusedTests' | 'typeCheck';
    reason: string;
    pattern?: string;
    priority: number;
  }>;
  /** Domain tag for the bounded run (e.g. 'runtime-core', 'runstate') */
  domain?: string;
  maxSteps?: number;
  approved: boolean;
  /** Deterministic completion policy for bounded runs */
  completionPolicy?: 'manual' | 'stop_after_verification';
  /** When true, inspection-only/no-change exits are failures; the task must mutate and verify. */
  requiresMutation?: boolean;
  /**
   * When true, applyEdit/writeFile/createBackup/restoreBackup are rejected.
   * Used for architect-diagnose seats (e.g. Kimi K3 plan-only dogfood).
   */
  forbidMutations?: boolean;
  /** Fail-closed capability and filesystem policy for recursive experiments. */
  experimentAuthority?: ExperimentAuthorityPolicy;
}

export interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
  thought: string;
  expectedResult: string;
}

interface PlanningLLMResult {
  text?: string;
  failure?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
  };
  provider?: string;
  model?: string;
}

interface PlanningLLMResponse {
  text?: string;
  success?: boolean;
  error?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  statusCode?: number;
  retryable?: boolean;
  responseBody?: unknown;
  body?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
  };
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

/** Sum of the planning calls' reported usage; callsWithUnknownUsage > 0 means the totals are partial. */
export interface SessionLLMUsage {
  prompt: number;
  completion: number;
  /** null until a call reports thinking tokens; a provider that never reports them is unknown, not 0. */
  reasoning: number | null;
  total: number;
  calls: number;
  callsWithUnknownUsage: number;
}

export interface LLMSession {
  task: LLMTask;
  messages: AgentMessage[];
  status: Status.PENDING | Status.RUNNING | Status.SUSPENDED | Status.SUCCESS | Status.FAILED | Status.ROLLED_BACK;
  startTime: string;
  endTime?: string;
  stepCount: number;
  backups: string[];
  /** Count of successful inspection-style tool calls completed in this run */
  successfulInspectionCalls: number;
  /** File extensions of files modified in this session, used for language-aware verification */
  modifiedExtensions: Set<string>;
  /** Files that were read during this session, for resume context */
  exploredPaths: Set<string>;
  /** Files that were mutated (applyEdit/writeFile) during this session */
  mutatedFiles: Set<string>;
  /** Files that were successfully mutated (applyEdit/writeFile) during this session */
  successfulMutatedFiles: Set<string>;
  /** Last verification result (build/test/typecheck) for resume context */
  lastVerification?: import('../RunStateStore.js').VerificationState;
  /**
   * Tools invoked this session (names only). Used by rotation harness metrics
   * (selfCheckUsage) so build/typecheck rates are honest, not always zero.
   */
  toolsUsed?: string[];
  /** Full markdown implementation plan when seat is diagnose-only (e.g. K3). */
  diagnosePlan?: string;
  /** Deterministic exit reason for bounded runs (e.g. 'bounded-inspection', 'bounded-no-change') */
  exitReason?: string;
  /** Most recent planning-stage failure reason for operator diagnostics */
  lastPlanError?: string;
  /** Token usage summed across this run's planning LLM calls */
  llmUsage?: SessionLLMUsage;
  /** Current bounded focus file from the task packet's primary files */
  activeFocusFile?: string;
  /** Index of the active focus inside task.primaryFiles */
  activeFocusIndex: number;
  /** Remaining inspection reads before the focus must advance or commit */
  focusInspectionBudgetRemaining: number;
  /** Current bounded-focus status */
  focusStatus: 'unresolved' | 'committed' | 'rejected';
  /** Whether the one-off adjacent file allowance has been consumed */
  focusAdjacentFileUsed: boolean;
  /** Last explicit focus decision */
  focusDecision?: 'reject' | 'resolve';
  /** When the last explicit focus decision was made */
  focusDecisionAt?: string;
  /** Immutable requested/resolved authority decisions for this run. */
  authorityReceipts: ExperimentAuthorityReceipt[];
}

/**
 * LLMModeAgent - The autonomous self-improving agent
 * 
 * Architecture:
 * 1. LLM plans tool calls based on task description
 * 2. Agent executes the tool
 * 3. Tool result fed back to LLM
 * 4. LLM reflects and plans next step
 * 5. Repeat until success or max steps
 */
export class LLMModeAgent {
  private static readonly PREFLIGHT_EXCERPT_LIMIT = 8000;
  private static readonly PLANNING_MESSAGE_LIMIT = 12000;
  private static readonly PLANNING_PROMPT_BUDGET = 30000;
  /** Head of the task message always kept inside the planning budget. */
  private static readonly PLANNING_TASK_LIMIT = 8000;
  private llmClient: LLMClient;
  private sessions: Map<string, LLMSession> = new Map();
  private currentSession?: LLMSession;
  private analyses: import('../ThinkingAnalyzer.js').ThinkingAnalysis[] = [];
  private compactor: ContextCompactor;
  private modifiedExtensions = new Set<string>();
  /** Rendered-artifact screenshots waiting to be attached to the next planning call. */
  private pendingVisionImages: ProviderImageInput[] = [];
  /** Honest marker when any harness ledger write failed during the current pass */
  private telemetryGap = false;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
    this.compactor = new ContextCompactor({
      maxMessages: 40,
      recentThreshold: 14,
      llmClient,
    });
  }

  getExecutorProjection() {
    return this.llmClient.getHarnessExecutorProjection();
  }

  private harnessSeat() {
    return resolveHarnessSeat(this.llmClient);
  }

  private async emitHarnessLane(
    event: string,
    fields: {
      verdict?: string | null;
      latencyMs?: number | null;
      inputHash?: string | null;
      evidenceRefs?: string[];
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const seat = this.harnessSeat();
    const result = await recordHarnessLaneEvent({
      event,
      model: seat.model,
      provider: seat.provider,
      role: 'harness',
      runId: this.currentSession?.task.id ?? null,
      episodeId: null,
      domain: 'harness',
      inputHash: fields.inputHash ?? null,
      verdict: fields.verdict ?? null,
      latencyMs: fields.latencyMs ?? null,
      costUsd: null,
      evidenceRefs: fields.evidenceRefs ?? [],
      payload: fields.payload,
    });
    if (result.telemetryGap) this.telemetryGap = true;
  }

  private async emitPassComplete(session: LLMSession): Promise<void> {
    const verifiedEdit = (session.successfulMutatedFiles?.size ?? 0) > 0;
    const rollback = session.status === Status.ROLLED_BACK
      || (session.backups.length > 0 && session.status !== Status.SUCCESS);
    await this.emitHarnessLane('harness.pass.complete', {
      verdict: String(session.status),
      latencyMs: Date.now() - new Date(session.startTime).getTime(),
      payload: {
        steps: session.stepCount,
        verifiedEdit,
        rollback,
        status: String(session.status),
        ...(this.telemetryGap ? { telemetryGap: true } : {}),
      },
    });
  }

  private stampSession(
    session: LLMSession,
    patch: Partial<Pick<LLMSession, 'status' | 'endTime' | 'exitReason'>>,
  ): LLMSession {
    const nextSession = { ...session, ...patch };
    this.sessions.set(nextSession.task.id, nextSession);
    this.currentSession = nextSession;
    return nextSession;
  }

  /**
   * Execute a task using LLM-driven planning
   */
  async executeTask(task: LLMTask): Promise<LLMSession> {
    if (task.approved !== true) {
      throw new Error(`Task "${task.id}" must be explicitly approved before execution.`);
    }

    const maxSteps = task.maxSteps || 15;
    this.pendingVisionImages = [];
    this.telemetryGap = false;
    // F1: resolve seat model before any harness.* rows so Model: auto never ships.
    await resolveHarnessSeatModel(this.llmClient);

    let session: LLMSession = {
      task,
      messages: [],
      status: Status.RUNNING,
      startTime: new Date().toISOString(),
      stepCount: 0,
      backups: [],
      successfulInspectionCalls: 0,
      modifiedExtensions: new Set(),
      exploredPaths: new Set(),
      mutatedFiles: new Set(),
      successfulMutatedFiles: new Set(),
      toolsUsed: [],
      activeFocusIndex: 0,
      focusInspectionBudgetRemaining: 0,
      focusStatus: 'rejected',
      focusAdjacentFileUsed: false,
      focusDecision: undefined,
      focusDecisionAt: undefined,
      authorityReceipts: [],
    };

    this.sessions.set(task.id, session);
    this.currentSession = session;
    this.initializeFocusState(session);

    try {
    // Resume detection: check for a suspended run
    const existingRunState = await readRunState();
    const isResume = existingRunState !== null && existingRunState.taskId === task.id;

    if (isResume) {
      // ── Workspace identity guard ─────────────────────────────────
      // If the suspended run captured a fingerprint, validate that the
      // workspace (same machine, same worktree) has not drifted.
      if (existingRunState.workspaceFingerprint) {
        const validation = await validateWorkspaceFingerprint(existingRunState.workspaceFingerprint);
        if (!validation.valid) {
          Logger.error('LLMModeAgent', `Resume blocked - workspace identity drifted: ${validation.reason}`);
          await clearRunState();
          session = this.stampSession(session, {
            status: Status.FAILED,
            endTime: new Date().toISOString(),
          });
          return session;
        }
      }

      this.restoreSessionFromRunState(session, existingRunState);

      Logger.debug('LLMModeAgent', `Resuming suspended run: ${existingRunState.stepsCompleted}/${existingRunState.maxSteps} steps completed`);
      Logger.debug('LLMModeAgent', `Restored ${session.exploredPaths.size} explored paths, ${session.mutatedFiles.size} mutated files`);
    }

    Logger.debug('LLMModeAgent', `Starting autonomous task: ${task.title}`);
    Logger.debug('LLMModeAgent', `Budget: ${maxSteps} LLM calls`);

    // Emit start event for TUI/SSE streaming
    eventBus.emit(EventTypes.PROCESS_START, 'LLMModeAgent', {
      process: 'agent-task',
      stage: 'planning',
      metadata: { taskId: task.id, title: task.title, maxSteps, isResume },
    });

    // Initialize conversation with system prompt
    session.messages.push({
      role: 'system',
      content: getSelfImprovePrompt(),
    });

    // Build task prompt with optional resume context
    const resumeSection = isResume && existingRunState
      ? '\n' + formatResumeContext(existingRunState)
      : '';

    const initialPreflightFiles = this.getInitialPreflightFiles(session);

    // Build deterministic preflight section from the bounded packet
    const descriptionHasDeterministicPacket = task.description.includes('## Deterministic Task Packet');
    const preflightSection = !descriptionHasDeterministicPacket && task.workingSet && task.workingSet.length > 0
      ? `\n\n## Deterministic Task Packet\nStart in these primary files before any broader reconnaissance:\n${(task.primaryFiles && task.primaryFiles.length > 0 ? task.primaryFiles : task.workingSet).map((f, i) => `${i === 0 ? '→' : '-'} ${f}`).join('\n')}${task.secondaryFiles && task.secondaryFiles.length > 0 ? `\nSecondary files (use only if the primary files are insufficient):\n${task.secondaryFiles.map(f => `- ${f}`).join('\n')}` : ''}\nHint: Start by looking in ${task.fileHint || task.workingSet[0]}`
      : (task.fileHint ? `\nHint: Start by looking in ${task.fileHint}` : '');

    // Add task description
    const taskPrompt = `## Current Task

Task ID: ${task.id}
Title: ${task.title}
Description: ${task.description}${preflightSection}${resumeSection}${task.requiresMutation ? `

Mutation requirement: this task is not complete until you make at least one successful writeFile/applyEdit mutation and then run the required verification target. Inspection-only/no-change outcomes are failures for this task.` : ''}${this.isBoundedInspectionTask(task) ? `

${task.requiresMutation
    ? `Step budget: ${maxSteps} steps. If no applyEdit/writeFile has landed by step ${this.boundedEditDeadlineStep(maxSteps)}, the run stops there and fails. Read the primary file, then edit early and spend the rest on verification.`
    : `Step budget: ${maxSteps} steps. With no edit, the run ends after step ${this.boundedEditDeadlineStep(maxSteps)}; no edit is a valid outcome when none is warranted.`}` : ''}

You are in LLM-driven mode. Plan your own steps. ${isResume ? 'Continue from where the previous run left off.' : 'Start by reading the relevant file(s).'}
If readFile returns truncated=true with startLine/endLine, continue that file with offset=endLine rather than rereading from the top.
If you need a specific method, symbol, or error location inside a large file, use search with the current file path before reading more pages.
${this.formatVerificationTargetPrompt(task)}

Respond with a JSON object containing your tool call:
{\n  "thought": "What you're doing and why",\n  "tool": "toolName",\n  "params": { ... },\n  "expectedResult": "What you expect"\n}

When the task is complete and build passes, respond with tool "complete".`;

    session.messages.push({
      role: 'user',
      content: taskPrompt,
    });

    // ── Deterministic preflight read for bounded runs ──────────────
    // For bounded runs with a packet, read the primary files NOW before
    // the LLM planning loop begins. This injects file contents into
    // session context deterministically, reducing early blind reads.
    if (initialPreflightFiles.length > 0) {
      const unreadFiles = initialPreflightFiles.filter(f => !session.exploredPaths.has(f));
      if (unreadFiles.length > 0) {
        Logger.debug('LLMModeAgent', `Preflight: reading ${unreadFiles.length} primary packet files`);
        const preflightContents: string[] = [];
        for (const filePath of unreadFiles) {
          try {
            const authorityReceipt = await this.authorizeToolCall('readFile', { path: filePath });
            if (authorityReceipt?.decision === 'deny') {
              session.lastPlanError = `experiment-authority:${authorityReceipt.reason}`;
              session = this.stampSession(session, {
                status: Status.FAILED,
                endTime: new Date().toISOString(),
              });
              return session;
            }
            const fileResult = await readFileTool.execute({ path: filePath });
            if (fileResult.success && fileResult.data) {
              session.exploredPaths.add(filePath);
              const content = typeof fileResult.data === 'object' && fileResult.data.content
                ? fileResult.data.content
                : typeof fileResult.data === 'string'
                  ? fileResult.data
                  : JSON.stringify(fileResult.data);
              preflightContents.push(`=== ${filePath} ===\n${this.formatPreflightExcerpt(content)}`);
            } else {
              Logger.warn('LLMModeAgent', `Preflight read failed for ${filePath}: ${fileResult.error || 'unknown error'}`);
            }
          } catch (err) {
            Logger.warn('LLMModeAgent', `Preflight read error for ${filePath}: ${err}`);
          }
        }
        if (preflightContents.length > 0) {
          session.messages.push({
            role: 'tool',
            content: `Preflight file contents loaded:\n\n${preflightContents.join('\n\n')}`,
          });
          Logger.debug('LLMModeAgent', `Preflight complete: ${preflightContents.length} files loaded into session context`);
          // Count the preflighted active focus as one inspection read, but still
          // leave room for one explicit follow-up read before the gate forces
          // edit / verify / advance behavior.
          if (session.activeFocusFile && session.exploredPaths.has(session.activeFocusFile) && session.focusInspectionBudgetRemaining > 0) {
            session.focusInspectionBudgetRemaining -= 1;
            Logger.debug('LLMModeAgent', `Preflight consumed one focus read for ${session.activeFocusFile}; remaining=${session.focusInspectionBudgetRemaining}`);
          }
        }
      }
    }

    try {
      let parseFailure = false;
      while (session.stepCount < maxSteps) {
        session.stepCount++;
        Logger.debug('LLMModeAgent', `Step ${session.stepCount}/${maxSteps}`);

        // ── Bounded-inspection guardrail ─────────────────────────────
        // For bounded runs (tui-self-* or stop_after_verification), if
        // more than half the step budget is spent with no mutations,
        // terminate deterministically instead of open-ended reconnaissance.
        if (this.shouldStopForBoundedInspection(session, maxSteps)) {
          Logger.info('LLMModeAgent', `Bounded-inspection guardrail triggered at step ${session.stepCount}/${maxSteps} - no mutations after 50% budget`);
          await clearRunState();
          const requiresMutation = session.task.requiresMutation === true;
          session = this.stampSession(session, {
            status: requiresMutation ? Status.FAILED : Status.SUCCESS,
            exitReason: requiresMutation ? 'bounded-no-mutation' : 'bounded-inspection',
            endTime: new Date().toISOString(),
          });
          eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
            process: 'agent-task',
            success: !requiresMutation,
            reason: requiresMutation
              ? 'bounded-no-mutation: self-improvement execution inspected but did not mutate'
              : 'bounded-inspection: no mutation warranted within budget',
            iterations: session.stepCount,
            durationMs: Date.now() - new Date(session.startTime).getTime(),
          });
          return session;
        }

        // Emit progress event for TUI
        eventBus.emit(EventTypes.PROCESS_PROGRESS, 'LLMModeAgent', {
          process: 'agent-task',
          current: session.stepCount,
          total: maxSteps,
          stage: `planning step ${session.stepCount}`,
          message: `asking ${this.llmClient.getConfig().model || 'model'} for next tool call`,
        });

        // Diagnose seats: after real inspection, force plan delivery — do not burn the budget on more recon.
        this.maybeInjectDiagnosePlanDeadline(session, maxSteps);
        // Bounded mutation runs: warn before the 50% no-edit guardrail ends the run.
        this.maybeInjectEditDeadline(session, maxSteps);

        // Get LLM's plan
        const toolCall = await this.getLLMPlan(session);
        
        if (!toolCall) {
          Logger.error('LLMModeAgent', session.lastPlanError || 'Failed to parse LLM response');
          parseFailure = true;
          break;
        }

        // Record assistant's plan
        session.messages.push({
          role: 'assistant',
          content: JSON.stringify(toolCall),
          toolCall,
        });

        await this.emitHarnessLane('harness.step', {
          verdict: 'planned',
          inputHash: hashToolArgs(toolCall.params ?? {}),
          payload: {
            phase: 'planned',
            step: session.stepCount,
            tool: toolCall.tool,
            argsHash: hashToolArgs(toolCall.params ?? {}),
          },
        });

        eventBus.emit(EventTypes.PROCESS_PROGRESS, 'LLMModeAgent', {
          process: 'agent-task',
          current: session.stepCount,
          total: maxSteps,
          stage: `planned ${toolCall.tool}`,
          message: `${toolCall.tool}: ${toolCall.thought}`,
          thought: toolCall.thought,
        });

        // Check for completion
        if (toolCall.tool === 'complete') {
          const completionGateError = this.getCompletionGateError(
            session,
            (toolCall.params || {}) as Record<string, unknown>,
          );
          if (completionGateError) {
            const gateResult: ToolResult = { success: false, error: completionGateError };
            session.messages.push({
              role: 'tool',
              content: JSON.stringify(gateResult),
              toolResult: gateResult,
            });
            eventBus.emit(EventTypes.PROCESS_PROGRESS, 'LLMModeAgent', {
              process: 'agent-task',
              current: session.stepCount,
              total: maxSteps,
              stage: 'executed complete',
              message: `complete failed: ${completionGateError.slice(0, 100)}`,
            });
            continue;
          }
          // Capture diagnose plan for harvest (K3 plan-only seats).
          if (this.isDiagnoseOnlyTask(session.task) && typeof toolCall.params?.plan === 'string') {
            session.diagnosePlan = String(toolCall.params.plan);
          }
          Logger.debug('LLMModeAgent', 'Task completed by LLM');
          await clearRunState();
          session = this.stampSession(session, {
            status: Status.SUCCESS,
            endTime: new Date().toISOString(),
          });
          eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
            process: 'agent-task',
            success: true,
            iterations: session.stepCount,
            durationMs: Date.now() - new Date(session.startTime).getTime(),
          });
          return session;
        }

        // Execute the tool
        const result = await this.executeTool(toolCall);

        // Emit tool execution event for TUI
        eventBus.emit(EventTypes.PROCESS_PROGRESS, 'LLMModeAgent', {
          process: 'agent-task',
          current: session.stepCount,
          total: maxSteps,
          stage: `executed ${toolCall.tool}`,
          message: this.formatToolProgressMessage(toolCall.tool, result),
          thought: toolCall.thought,
        });
        
        // Record tool result
        session.messages.push({
          role: 'tool',
          content: this.formatToolResultMessage(toolCall.tool, result),
          toolResult: result,
        });

        if (this.shouldStopAfterSuccessfulVerification(session, toolCall, result)) {
          Logger.info('LLMModeAgent', `Auto-completing bounded run after successful ${toolCall.tool}`);
          await clearRunState();
          session = this.stampSession(session, {
            status: Status.SUCCESS,
            endTime: new Date().toISOString(),
          });
          eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
            process: 'agent-task',
            success: true,
            reason: `Verified success reached via ${toolCall.tool}` ,
            iterations: session.stepCount,
            durationMs: Date.now() - new Date(session.startTime).getTime(),
          });
          return session;
        }

        // Check for critical failures
        if (toolCall.tool === 'runBuild' && !result.success) {
          Logger.error('LLMModeAgent', 'Build failed - entering reflection mode');
          
          // Try to fix the error
          const fixed = await this.attemptErrorRecovery(session, result);
          
          if (!fixed) {
            // Rollback if we have backups
            if (session.backups.length > 0) {
              Logger.debug('LLMModeAgent', 'Rolling back changes...');
              await this.rollback(session);
              session = this.stampSession(session, { status: Status.ROLLED_BACK });
            } else {
              session = this.stampSession(session, { status: Status.FAILED });
            }
            
            // Log failure
            failureLogger.log({
              model: this.llmClient['config']?.model || 'llm-agent',
              domain: 'harness-llm',
              prompt: task.description,
              error: `Build failed after ${session.stepCount} steps: ${result.error}`,
              errorType: 'validation',
              duration: Date.now() - new Date(session.startTime).getTime(),
            });

            eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
              process: 'agent-task',
              success: false,
              reason: 'Build failed',
              iterations: session.stepCount,
              durationMs: Date.now() - new Date(session.startTime).getTime(),
            });

            return session;
          }
        }

        // Brief pause to show progress
        await new Promise(r => setTimeout(r, 100));
      }

      // Loop ended without explicit completion via 'complete' tool.
      // Diagnose seats never auto-succeed without params.plan.
      if (!parseFailure && this.isDiagnoseOnlyTask(session.task)) {
        const planOk = typeof session.diagnosePlan === 'string' && session.diagnosePlan.trim().length >= 200;
        Logger.error(
          'LLMModeAgent',
          planOk
            ? `Diagnose loop ended without complete tool after ${session.stepCount} steps (plan was captured earlier — unexpected)`
            : `Diagnose seat ended without complete(params.plan) after ${session.stepCount} steps`,
        );
        await clearRunState();
        session = this.stampSession(session, {
          status: planOk ? Status.SUCCESS : Status.FAILED,
          exitReason: planOk ? 'diagnose-plan-delivered' : 'diagnose-missing-plan',
          endTime: new Date().toISOString(),
        });
        eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
          process: 'agent-task',
          success: planOk,
          reason: planOk
            ? 'diagnose-plan-delivered'
            : 'diagnose-missing-plan: complete with params.plan ≥200 chars required',
          iterations: session.stepCount,
          durationMs: Date.now() - new Date(session.startTime).getTime(),
        });
        return session;
      }

      // Only bounded runs that actually completed meaningful successful
      // inspection work should classify as bounded-no-change successes.
      if (!parseFailure && this.shouldClassifyAsBoundedNoChangeSuccess(session)) {
        Logger.debug('LLMModeAgent', `Treating TUI inspection-only run as no-change success after ${session.stepCount} steps`);
        await clearRunState();
        session = this.stampSession(session, {
          status: Status.SUCCESS,
          exitReason: 'bounded-no-change',
          endTime: new Date().toISOString(),
        });

        eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
          process: 'agent-task',
          success: true,
          reason: 'bounded-no-change: inspection complete, no mutations needed',
          iterations: session.stepCount,
          durationMs: Date.now() - new Date(session.startTime).getTime(),
        });

        return session;
      }

      // Distinguish between parse failure (FAILED) and natural completion.
      if (parseFailure) {

        // LLM response couldn't be parsed - this is a real failure
        Logger.error('LLMModeAgent', session.lastPlanError ? `${session.lastPlanError} after ${session.stepCount} steps` : `Failed to parse LLM response after ${session.stepCount} steps`);
        if (session.backups.length === 0) {
          await this.persistSuspendedRunState(session, maxSteps);
        }
        session = this.stampSession(session, {
          status: Status.FAILED,
          endTime: new Date().toISOString(),
        });

        eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
          process: 'agent-task',
          success: false,
          reason: session.lastPlanError || 'Failed to parse LLM response',
          iterations: session.stepCount,
          durationMs: Date.now() - new Date(session.startTime).getTime(),
        });

        // Rollback if needed
        if (session.backups.length > 0) {
          await this.rollback(session);
          session = this.stampSession(session, { status: Status.ROLLED_BACK });
        }
      } else if (session.backups.length === 0) {
        if (this.isBoundedInspectionRun(session)) {
          Logger.error('LLMModeAgent', `Bounded run ended before meaningful successful inspection after ${session.stepCount} steps`);
          session = this.stampSession(session, {
            status: Status.FAILED,
            endTime: new Date().toISOString(),
          });

          eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
            process: 'agent-task',
            success: false,
            reason: 'Bounded run ended before meaningful successful inspection',
            iterations: session.stepCount,
            durationMs: Date.now() - new Date(session.startTime).getTime(),
          });

          return session;
        }

        // Natural loop completion with no mutations — not success for diagnose
        // (diagnose handled above). Mutation seats: inspection-only no-change.
        Logger.debug('LLMModeAgent', `Inspection complete after ${session.stepCount} steps, no mutations needed`);
        await clearRunState();
        session = this.stampSession(session, {
          status: Status.SUCCESS,
          exitReason: 'bounded-no-change',
          endTime: new Date().toISOString(),
        });

        eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
          process: 'agent-task',
          success: true,
          reason: 'bounded-no-change: inspection complete, no mutations needed',
          iterations: session.stepCount,
          durationMs: Date.now() - new Date(session.startTime).getTime(),
        });
      } else {
        // Mutations were made but task didn't complete - checkpoint and suspend for resume
        Logger.warn('LLMModeAgent', `Max steps (${maxSteps}) reached with incomplete changes - suspending for resume`);

        await this.persistSuspendedRunState(session, maxSteps);

        session = this.stampSession(session, {
          status: Status.SUSPENDED,
          endTime: new Date().toISOString(),
        });

        eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
          process: 'agent-task',
          success: false,
          reason: `Suspended after ${session.stepCount} steps - run can be resumed`,
          iterations: session.stepCount,
          durationMs: Date.now() - new Date(session.startTime).getTime(),
        });
      }

      return session;

    } catch (error) {
      Logger.error('LLMModeAgent', `Unexpected error: ${error}`);
      session = this.stampSession(session, {
        status: Status.FAILED,
        endTime: new Date().toISOString(),
      });

      eventBus.emit(EventTypes.PROCESS_END, 'LLMModeAgent', {
        process: 'agent-task',
        success: false,
        reason: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        iterations: session.stepCount,
      });

      if (session.backups.length > 0) {
        await this.rollback(session);
        session = this.stampSession(session, { status: Status.ROLLED_BACK });
      }

      failureLogger.log({
        model: this.llmClient['config']?.model || 'llm-agent',
        domain: 'harness-llm',
        prompt: task.description,
        error: formatError('LLMModeAgent', error),
        errorType: 'generation',
        duration: Date.now() - new Date(session.startTime).getTime(),
      });

      return session;
    }
    } finally {
      const finished = this.currentSession ?? session;
      if (!finished.endTime) {
        this.stampSession(finished, {
          endTime: new Date().toISOString(),
          ...(finished.status === Status.RUNNING ? { status: Status.FAILED } : {}),
        });
      }
      await this.emitPassComplete(this.currentSession ?? finished);
    }
  }

  /**
   * `usage` undefined with `threw` means the call threw: it ran, so it counts as a call with unknown usage.
   * Convention (same as OpenAIProvider and codex): outputTokens already includes thinkingTokens, so
   * reasoning is a reported subset and total = prompt + completion, never adding reasoning again.
   */
  private recordPlanUsage(session: LLMSession | undefined, usage: PlanningLLMResult['usage']): void {
    if (!session) return;
    const sum = session.llmUsage ??= { prompt: 0, completion: 0, reasoning: null, total: 0, calls: 0, callsWithUnknownUsage: 0 };
    sum.calls++;
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      sum.callsWithUnknownUsage++;
      return;
    }
    sum.prompt += usage.inputTokens;
    sum.completion += usage.outputTokens;
    if (usage.thinkingTokens !== undefined) sum.reasoning = (sum.reasoning ?? 0) + usage.thinkingTokens;
    sum.total = sum.prompt + sum.completion;
  }

  /**
   * Get LLM's planned tool call
   */
  private async getLLMPlan(session: LLMSession): Promise<ToolCall | null> {
    // Consume any rendered-artifact screenshots: they ride along with the next
    // planning call as image input when the harness model is vision-capable.
    const visionInputs = this.consumePendingVisionInputs(session);
    const callStartedAt = Date.now();
    await this.emitHarnessLane('harness.call.start', {
      verdict: 'start',
      payload: {
        phase: 'plan',
        step: session.stepCount,
      },
    });

    const rateLimitResult = await rateLimiter.execute(this.llmRateLimitOperation(session), async (): Promise<PlanningLLMResult> => {
      const systemPrompt = session.messages.find(m => m.role === 'system')?.content || getSelfImprovePrompt();
      // Build conversation context
      let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = session.messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.role === 'user' ? m.content :
                   m.role === 'assistant' ? JSON.stringify(m.toolCall) :
                   (m.toolResult ? JSON.stringify(m.toolResult) : m.content),
        }));

      // Compact if conversation is getting long
      if (this.compactor.needsCompaction(messages)) {
        messages = await this.compactor.compact(messages);
        Logger.debug('LLMModeAgent', `Compacted conversation from ${session.messages.length} to ${messages.length} messages`);
      }

      messages = this.budgetPlanningMessages(messages);
      const conversation = messages.map(m => `${m.role}: ${m.content}`).join('\n\n---\n\n');

      // Call LLM
      const llmConfig = this.llmClient.getConfig();
      if (resolvePromptTier(llmConfig.model, llmConfig.provider) === 'compact')
        Logger.warn('LLMModeAgent', `Agentic planning requires full-tier prompts; model "${llmConfig.model}" resolved compact, proceeding with full prompt.`);
      const planMaxTokens = this.planningMaxTokens(session);
      let response: PlanningLLMResponse;
      try {
        response = await this.llmClient.complete({
          systemPrompt,
          prompt: conversation + '\n\nWhat is your next tool call? Respond with JSON only.',
          maxTokens: planMaxTokens,
          temperature: 0.2, // Low temperature for deterministic tool calls
          imageInputs: visionInputs,
          jsonMode: true,
        }) as PlanningLLMResponse;
      } catch (error) {
        this.recordPlanUsage(session, undefined);
        throw error;
      }
      this.recordPlanUsage(session, response.usage);

      if (response.success === false) {
        return { failure: this.formatPlanningFailure(response), provider: response.provider, model: response.model };
      }

      return {
        text: response.text ?? '',
        usage: response.usage,
        provider: response.provider,
        model: response.model,
      };
    });

    // Exactly one harness.call.end per harness.call.start (success only after parse).
    let callEndEmitted = false;
    const emitCallEnd = async (
      success: boolean,
      usage?: PlanningLLMResult['usage'],
      errorClass?: string,
    ) => {
      if (callEndEmitted) return;
      callEndEmitted = true;
      await this.emitHarnessLane('harness.call.end', {
        verdict: success ? 'success' : 'failure',
        latencyMs: Date.now() - callStartedAt,
        payload: {
          phase: 'plan',
          step: session.stepCount,
          success,
          latencyMs: Date.now() - callStartedAt,
          ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage?.thinkingTokens !== undefined ? { thinkingTokens: usage.thinkingTokens } : {}),
          ...(errorClass ? { errorClass } : {}),
        },
      });
    };

    if (!rateLimitResult.result?.text) {
      const failureReason = rateLimitResult.rateLimited
        ? (rateLimitResult.error || 'Rate limit hit for LLM call')
        : (rateLimitResult.result?.failure || rateLimitResult.error || 'LLM call failed before producing a response');
      if (this.currentSession) {
        this.currentSession.lastPlanError = /timeout|aborted/i.test(failureReason)
          ? `failureClass=provider-timeout: ${failureReason}`
          : failureReason;
      }
      Logger.error('LLMModeAgent', failureReason);

      // finish_reason=length with empty content is retryable once with a higher budget
      // (K3 high-reasoning + maxTokens:2000 previously ate the whole completion on thinking).
      const retryable = /rate limit|429|529|overload|timeout|502|503|504|upstream|temporar|finish_reason=length|no usable content/i.test(failureReason);
      if (retryable) {
        Logger.warn('LLMModeAgent', `Retrying transient planning failure once: ${failureReason}`);
        await new Promise(resolve => setTimeout(resolve, 750));
        const retryResult = await rateLimiter.execute(this.llmRateLimitOperation(session), async (): Promise<PlanningLLMResult> => {
          const systemPrompt = session.messages.find(m => m.role === 'system')?.content || getSelfImprovePrompt();
          let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = session.messages
            .filter(m => m.role !== 'system')
            .map(m => ({
              role: m.role as 'system' | 'user' | 'assistant',
              content: m.role === 'user' ? m.content :
                       m.role === 'assistant' ? JSON.stringify(m.toolCall) :
                       (m.toolResult ? JSON.stringify(m.toolResult) : m.content),
            }));
          if (this.compactor.needsCompaction(messages)) {
            messages = await this.compactor.compact(messages);
          }
          messages = this.budgetPlanningMessages(messages);
          const conversation = messages.map(m => `${m.role}: ${m.content}`).join('\n\n---\n\n');
          const planMaxTokens = Math.max(this.planningMaxTokens(session), 16384);
          let response: PlanningLLMResponse;
          try {
            response = await this.llmClient.complete({
              systemPrompt,
              prompt: conversation + '\n\nWhat is your next tool call? Respond with JSON only.',
              maxTokens: planMaxTokens,
              temperature: 0.2,
              imageInputs: visionInputs,
              jsonMode: true,
            }) as PlanningLLMResponse;
          } catch (error) {
            this.recordPlanUsage(session, undefined);
            throw error;
          }
          this.recordPlanUsage(session, response.usage);
          if (response.success === false) {
            return { failure: this.formatPlanningFailure(response), provider: response.provider, model: response.model };
          }
          return {
            text: response.text ?? '',
            usage: response.usage,
            provider: response.provider,
            model: response.model,
          };
        });
        if (retryResult.result?.text) {
          if (this.currentSession) this.currentSession.lastPlanError = undefined;
          rateLimitResult.result = retryResult.result;
        } else {
          const retryReason = retryResult.result?.failure || retryResult.error || failureReason;
          if (this.currentSession) this.currentSession.lastPlanError = retryReason;
          await emitCallEnd(false, undefined, 'tool_error');
          return null;
        }
      } else {
        await emitCallEnd(false, undefined, 'tool_error');
        return null;
      }
    }

    if (this.currentSession) {
      this.currentSession.lastPlanError = undefined;
    }

    const planUsage = rateLimitResult.result?.usage;

    // Parse JSON response — call.end success only after parse succeeds.
    try {
      // rateLimiter.execute() wraps the return in { result: T }, so the text is
      // in rateLimitResult.result (which is the string returned from fn above).
      let text = String(rateLimitResult.result.text);

      // Strip <think/>, <thinkContent/>, and similar reasoning wrappers
      // Models like MiniMax M2.7 wrap reasoning in these tags before the JSON
      text = splitThinking(text).answer.trim();

      // Extract JSON from markdown code blocks if present
      const jsonStr = pickCodeBlock(text, ['json'])?.body || text;

      const toolCall = await this.parseToolCallText(session, text);
      if (!toolCall) {
        await emitCallEnd(false, planUsage, 'parse_error');
        return null;
      }

      // CAPTURE HARNESS THINKING - this is the harness LLM's reasoning about fixing the system
      // This is DIFFERENT from generator thinking and must be kept separate
      thinkingRepository.storeHarnessThinking({
        model: this.llmClient.getConfig().model,
        thinking: toolCall.thought,
        context: 'adaptation',
      });

      // ANALYZE THINKING - feed the LLM's plan through the ThinkingAnalyzer
      // to detect patterns, suggest fixes, and extract learning insights
      try {
        const analysis = thinkingAnalyzer.analyze(
          {
            code: jsonStr,
            thinking: toolCall.thought,
            success: true,
          },
          toolCall.thought.slice(0, 200),
          'harness-llm',
          this.llmClient.getConfig().model,
        );

        // Store the analysis result for later retrieval via getRecentInsights
        this.storeAnalysis(analysis);
      } catch (analysisErr) {
        // Analysis failure must not break the agent loop
        Logger.warn('LLMModeAgent', `ThinkingAnalyzer failed: ${analysisErr}`);
      }

      await emitCallEnd(true, planUsage);
      return toolCall;
    } catch (e) {
      if (this.currentSession) {
        this.currentSession.lastPlanError = `Failed to parse LLM response: ${String(e)}`;
      }
      Logger.error('LLMModeAgent', `Failed to parse LLM response: ${e}`);
      Logger.error('LLMModeAgent', `Raw response: ${rateLimitResult.result.text}`);
      await emitCallEnd(false, planUsage, 'parse_error');
      return null;
    }
  }

  private async parseToolCallText(session: LLMSession, text: string): Promise<ToolCall | null> {
    const jsonStr = pickCodeBlock(text, ['json'])?.body || text;
    const jsonText = this.extractFirstJsonObject(jsonStr);

    if (!jsonText) {
      // Deterministic near-JSON repair (GLM unquoted expectedResult, etc.) before LLM repair.
      const deterministic = repairToolCallFromText(text);
      if (deterministic && deterministic.tool !== 'unknown') {
        Logger.info('LLMModeAgent', `Deterministic tool-call repair recovered tool=${deterministic.tool}`);
        return deterministic;
      }

      // F19b: Kilo Opus 5 cannot use response_format; always attempt plain-text
      // repair (not only mutation tasks) before failing the plan step.
      const repaired = await this.repairPlainTextToolCall(text);
      if (repaired) return repaired;

      const implicitComplete = this.tryImplicitCompletion(session, text);
      if (implicitComplete) {
        Logger.debug('LLMModeAgent', 'Using implicit completion fallback for late-stage plain-text response');
        return implicitComplete;
      }
      if (this.currentSession) {
        this.currentSession.lastPlanError = 'failureClass=json-parse: Failed to parse LLM response';
      }
      Logger.error('LLMModeAgent', 'No JSON object found in response');
      return null;
    }

    try {
      const parsed = JSON.parse(jsonText);
      return {
        thought: parsed.thought || 'No thought provided',
        tool: parsed.tool || 'unknown',
        params: parsed.params || {},
        expectedResult: parsed.expectedResult || 'No expectation set',
      };
    } catch {
      // GLM-style semi-JSON: fix bare string fields then re-parse / extract tool+params.
      const deterministic = repairToolCallFromText(text);
      if (deterministic && deterministic.tool !== 'unknown') {
        Logger.info('LLMModeAgent', `Deterministic tool-call repair after JSON.parse failure tool=${deterministic.tool}`);
        return deterministic;
      }
      const repaired = await this.repairPlainTextToolCall(text);
      if (repaired) return repaired;
      if (this.currentSession) {
        this.currentSession.lastPlanError = 'failureClass=json-parse: Failed to parse LLM response';
      }
      return null;
    }
  }

  private async repairPlainTextToolCall(text: string): Promise<ToolCall | null> {
    if (text.trim().length === 0) return null;
    try {
      let response: PlanningLLMResponse | undefined;
      try {
        response = await this.llmClient.complete({
          systemPrompt: 'Convert the previous agent response into one valid Sinter tool-call JSON object. Return JSON only.',
          prompt: `Previous response:
${text.slice(0, 4000)}

Return exactly one JSON object with keys thought, tool, params, expectedResult. Use only an allowed tool such as readFile, search, applyEdit, writeFile, runTests, runBuild, typeCheck, or complete.`,
          maxTokens: 800,
          temperature: 0,
          jsonMode: true,
        }) as PlanningLLMResponse | undefined;
      } catch (error) {
        this.recordPlanUsage(this.currentSession, undefined);
        throw error;
      }
      this.recordPlanUsage(this.currentSession, response?.usage);
      // Treat missing/undefined success as non-repair (tests + flaky providers).
      if (!response || response.success === false || !response.text) return null;

      const cleaned = splitThinking(response.text).answer.trim();
      const jsonText = this.extractFirstJsonObject(cleaned);
      if (!jsonText) return null;
      const parsed = JSON.parse(jsonText);
      return {
        thought: parsed.thought || 'Recovered plain-text tool plan',
        tool: parsed.tool || 'unknown',
        params: parsed.params || {},
        expectedResult: parsed.expectedResult || 'Recovered next tool call',
      };
    } catch {
      return null;
    }
  }

  private budgetPlanningMessages<T extends { role: 'system' | 'user' | 'assistant'; content: string }>(messages: T[]): T[] {
    let remaining = LLMModeAgent.PLANNING_PROMPT_BUDGET;
    const omitted = '[omitted planning context: prompt budget exhausted; newest context preserved; use readFile/search for needed detail]';
    const budgeted = messages.map(message => ({ ...message, content: omitted }));
    if (messages.length === 0) return budgeted;

    // The first message is the task itself. Filling newest-first evicted it
    // after ~3 file reads, and live terra/sol runs then spent their inspection
    // budget hunting a task they could no longer see ("the task text is omitted").
    const task = this.truncatePlanningContent(messages[0].content, LLMModeAgent.PLANNING_TASK_LIMIT, 'head');
    budgeted[0] = { ...messages[0], content: task };
    remaining -= task.length;

    for (let index = messages.length - 1; index >= 1; index--) {
      if (remaining <= 0) break;

      const limit = Math.min(LLMModeAgent.PLANNING_MESSAGE_LIMIT, remaining);
      const content = this.truncatePlanningContent(messages[index].content, limit, 'tail');
      remaining -= content.length;
      budgeted[index] = { ...messages[index], content };
    }

    return budgeted;
  }

  private truncatePlanningContent(content: string, limit: number, preserve: 'head' | 'tail' = 'head'): string {
    if (content.length <= limit) return content;
    const omitted = content.length - limit;
    const marker = `\n... [truncated planning context: ${omitted} chars omitted; use readFile/search for missing detail]`;
    if (limit <= marker.length) return marker.slice(0, limit);
    const keep = limit - marker.length;
    if (preserve === 'tail') return `${marker}\n${content.slice(content.length - keep)}`;
    return `${content.slice(0, keep)}${marker}`;
  }

  private formatPlanningFailure(response: PlanningLLMResponse): string {
    const responseBody = response.responseBody ?? response.body;
    const fields = [
      response.error || 'LLM call failed before producing a response',
      response.provider ? `provider=${response.provider}` : undefined,
      response.model ? `model=${response.model}` : undefined,
      response.endpoint ? `endpoint=${response.endpoint}` : undefined,
      typeof response.statusCode === 'number' ? `status=${response.statusCode}` : undefined,
      typeof response.retryable === 'boolean' ? `retryable=${response.retryable}` : undefined,
      responseBody !== undefined ? `body=${this.safeStringify(responseBody)}` : undefined,
    ].filter((field): field is string => Boolean(field));
    return fields.join(' | ');
  }

  private safeStringify(value: unknown): string {
    if (typeof value === 'string') return value.slice(0, 1000);
    try {
      return JSON.stringify(value).slice(0, 1000);
    } catch {
      return String(value).slice(0, 1000);
    }
  }

  private llmRateLimitOperation(session: LLMSession): string {
    return session.task.id.startsWith('tui-self-')
      ? `tuiLlmCall:${session.task.id}`
      : 'llmCall';
  }

  /**
   * Drain rendered-artifact screenshots captured since the last planning call.
   *
   * Vision-capable harness models (e.g. Kimi K3) receive them as image input.
   * For text-only models the screenshots are dropped LOUDLY: a warn log plus a
   * degraded failure record, so a silent "the harness can see but didn't look"
   * state is impossible. The tool result message still carries the render
   * logs/errors, so the model keeps a text-only diagnosis path.
   */
  private consumePendingVisionInputs(session: LLMSession): ProviderImageInput[] | undefined {
    if (this.pendingVisionImages.length === 0) return undefined;
    const images = this.pendingVisionImages;
    this.pendingVisionImages = [];

    const model = this.llmClient.getConfig().model || 'unknown';
    if (CapabilityRegistry.supportsVision(model)) {
      return images;
    }

    Logger.warn(
      'LLMModeAgent',
      `Harness model "${model}" is text-only; dropping ${images.length} rendered screenshot(s). Visual evidence unavailable - diagnose from renderArtifact logs/errors.`,
    );
    failureLogger.log({
      model,
      domain: 'harness-llm',
      prompt: session.task.description.slice(0, 500),
      error: `[render-degraded] harness model "${model}" cannot accept image input; ${images.length} rendered screenshot(s) dropped`,
      errorType: 'degraded',
      duration: 0,
    });
    return undefined;
  }

  /**
   * Keep multi-hundred-KB base64 screenshots out of the text transcript: the
   * planning prompt is char-budgeted, and the image reaches the model through
   * the vision channel instead. The placeholder states where the pixels went.
   */
  private redactRenderArtifactResult(result: ToolResult): ToolResult {
    const data = result.data as RenderArtifactResult | undefined;
    if (!data?.screenshot && !data?.lateScreenshot) return result;

    const model = this.llmClient.getConfig().model || 'unknown';
    const visionCapable = CapabilityRegistry.supportsVision(model);
    const redactShot = (shot: RenderArtifactScreenshot) => ({
      ...shot,
      dataBase64: visionCapable
        ? `[omitted from transcript: ${Math.round(shot.dataBase64.length / 1024)}KB ${shot.mimeType} attached as image input to the next planning call]`
        : `[omitted from transcript: harness model "${model}" is text-only; screenshot dropped - use errors/logs to diagnose]`,
    });

    return {
      ...result,
      data: {
        ...data,
        screenshot: data.screenshot ? redactShot(data.screenshot) : undefined,
        lateScreenshot: data.lateScreenshot ? redactShot(data.lateScreenshot) : undefined,
      },
    };
  }

  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  private tryImplicitCompletion(session: LLMSession, text: string): ToolCall | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Diagnose seats: free-form markdown implementation specs count as complete(params.plan).
    // GLM/Grok often emit the plan body without wrapping JSON tool-call after the deadline nudge.
    if (
      this.isDiagnoseOnlyTask(session.task)
      && this.hasConcreteSuccessfulInspection(session)
      && trimmed.length >= 200
      && !/^\s*\{/.test(trimmed)
    ) {
      return {
        thought: 'Implicit diagnose plan from free-form model response',
        tool: 'complete',
        params: { plan: trimmed },
        expectedResult: 'Deliver architect diagnose plan for implementers',
      };
    }

    const hasMutation = session.backups.length > 0;
    const completionLike = /(?:task\s+complete|inspection\s+is\s+complete|diagnostic\s+(?:is\s+)?complete|returning\s+(?:the\s+)?final\s+(?:diagnostic\s+)?report|final\s+report|fix\s+is\s+complete|providing\s+final\s+report|all\s+\d*\s*tests?\s+pass|tests?\s+pass(?:ed)?|done\b)/i.test(trimmed);
    if (!completionLike) return null;

    if (!hasMutation) {
      const readOnlyDiagnostic = /(?:read-only|do not modify|do not edit|no file changes|without modifying files)/i.test(session.task.description);
      if (!readOnlyDiagnostic || !this.hasConcreteSuccessfulInspection(session)) return null;
      return {
        thought: trimmed.slice(0, 400),
        tool: 'complete',
        params: {},
        expectedResult: 'Finish the read-only inspection task',
      };
    }

    const buildPassed = this.hasSuccessfulTool(session, 'runBuild');
    if (!buildPassed) return null;

    const testsPassed = this.hasSuccessfulTool(session, 'runTests');

    if (!testsPassed && !/tests?\s+pass(?:ed)?/i.test(trimmed)) return null;

    return {
      thought: trimmed.slice(0, 400),
      tool: 'complete',
      params: {},
      expectedResult: 'Finish the verified task',
    };
  }

  private hasSuccessfulTool(session: LLMSession, toolName: string): boolean {
    for (let i = 0; i < session.messages.length - 1; i++) {
      const message = session.messages[i];
      const next = session.messages[i + 1];
      if (message.toolCall?.tool === toolName && next.toolResult?.success) {
        return true;
      }
    }
    return false;
  }

  private formatPreflightExcerpt(content: string): string {
    if (content.length <= LLMModeAgent.PREFLIGHT_EXCERPT_LIMIT) return content;
    return `${content.slice(0, LLMModeAgent.PREFLIGHT_EXCERPT_LIMIT)}\n... [truncated preflight excerpt; call readFile for full contents]`;
  }

  private formatToolResultMessage(tool: string, result: ToolResult): string {
    const base = JSON.stringify(result);
    if (!this.currentSession) return base;
    if (!result.success) {
      const focusGateRecoveryHint = this.formatFocusGateRecoveryHint(tool, result, this.currentSession);
      const message = focusGateRecoveryHint ? `${base}\n\n${focusGateRecoveryHint}` : base;
      return this.appendFocusStatusHint(message, this.currentSession);
    }
    if (tool !== 'readFile') return this.appendFocusStatusHint(base, this.currentSession);

    const data = result.data as { truncated?: boolean; endLine?: number } | undefined;
    if (!data?.truncated || typeof data.endLine !== 'number') return this.appendFocusStatusHint(base, this.currentSession);

    return this.appendFocusStatusHint(
      `${base}\n\nPagination hint: this readFile result is truncated. Continue the same file with offset=${data.endLine} instead of rereading from the top. If you only need a specific method, symbol, or error location inside this file, use search with path set to the current file before reading more pages.`,
      this.currentSession,
    );
  }

  private formatFocusGateRecoveryHint(tool: string, result: ToolResult, session: LLMSession): string | null {
    if (!result.error?.startsWith('Focus gate:') || !this.isFocusGateActive(session) || !session.activeFocusFile) {
      return null;
    }

    const nextPrimary = this.nextPrimaryFile(session);
    if (tool === 'readFile' && nextPrimary) {
      if (session.focusInspectionBudgetRemaining > 0) {
        return `Focus recovery hint: stay on ${session.activeFocusFile} for ${session.focusInspectionBudgetRemaining} more explicit read${session.focusInspectionBudgetRemaining === 1 ? '' : 's'} before advancing. If you decide this focus is wrong after that, call readFile with path=${nextPrimary} to advance intentionally.`;
      }
      return `Focus recovery hint: if you reject ${session.activeFocusFile}, call readFile with path=${nextPrimary} to advance to the next primary file.`;
    }

    if (tool === 'search') {
      return `Focus recovery hint: keep search pinned to path=${session.activeFocusFile}. If you need another primary file, advance there first with readFile.`;
    }

    return null;
  }

  private formatToolProgressMessage(tool: string, result: ToolResult): string {
    if (result.success) return `${tool} succeeded`;
    const full = this.currentSession ? this.formatToolResultMessage(tool, result) : JSON.stringify(result);
    const compact = full.replace(/\s+/g, ' ').trim();
    return `${tool} failed: ${compact.slice(0, 220)}`;
  }

  private getInitialPreflightFiles(session: LLMSession): string[] {
    if (session.activeFocusFile) return [session.activeFocusFile];
    if (session.task.primaryFiles && session.task.primaryFiles.length > 0) return [session.task.primaryFiles[0]];
    return session.task.workingSet ? [session.task.workingSet[0]] : [];
  }

  private initializeFocusState(session: LLMSession): void {
    if (!this.isBoundedInspectionRun(session) || !session.task.primaryFiles?.length) return;
    session.activeFocusIndex = 0;
    session.activeFocusFile = session.task.primaryFiles[0];
    session.focusInspectionBudgetRemaining = 2;
    session.focusStatus = 'unresolved';
    session.focusAdjacentFileUsed = false;
    session.focusDecision = undefined;
    session.focusDecisionAt = undefined;
  }

  private appendFocusStatusHint(content: string, session: LLMSession): string {
    if (!this.isFocusGateActive(session) || !session.activeFocusFile) return content;
    const nextPrimary = this.nextPrimaryFile(session);
    const verificationHint = this.formatPreferredVerificationHint(session.task);
    return `${content}\n\nFocus gate: active focus=${session.activeFocusFile}; remaining focus reads=${session.focusInspectionBudgetRemaining}; focus status=${session.focusStatus}.${nextPrimary ? ` If you reject this focus, move to next primary file: ${nextPrimary}.` : ' No additional primary files remain after this focus.'}${verificationHint ? ` ${verificationHint}` : ''}`;
  }

  private isFocusGateActive(session: LLMSession): boolean {
    // Diagnose/plan seats need free inspection across the compound loop; mutation focus gates block that.
    if (this.isDiagnoseOnlyTask(session.task)) return false;
    return this.isBoundedInspectionRun(session) && !!session.task.primaryFiles?.length;
  }

  private normalizeToolCallForFocusGate(toolCall: ToolCall): ToolCall {
    const session = this.currentSession;
    if (!session || !this.isFocusGateActive(session) || session.focusStatus !== 'unresolved') {
      return toolCall;
    }

    if (toolCall.tool === 'readFile' && session.activeFocusFile) {
      const requestedPath = typeof toolCall.params?.path === 'string' ? toolCall.params.path : undefined;
      const nextPrimary = this.nextPrimaryFile(session);
      const canAdvanceToNextPrimary = !!requestedPath && !!nextPrimary && requestedPath === nextPrimary && session.focusInspectionBudgetRemaining <= 0;
      const isAllowedSecondary = !!requestedPath && !!session.task.secondaryFiles?.includes(requestedPath) && !session.focusAdjacentFileUsed;
      if (!requestedPath || (!canAdvanceToNextPrimary && !isAllowedSecondary && requestedPath !== session.activeFocusFile)) {
        return {
          ...toolCall,
          params: {
            ...(toolCall.params || {}),
            path: session.activeFocusFile,
          },
        };
      }
    }

    if (toolCall.tool === 'search' && session.activeFocusFile) {
      return {
        ...toolCall,
        params: {
          ...(toolCall.params || {}),
          path: session.activeFocusFile,
        },
      };
    }

    return toolCall;
  }

  private nextPrimaryFile(session: LLMSession): string | undefined {
    const primaryFiles = session.task.primaryFiles || [];
    return primaryFiles[session.activeFocusIndex + 1];
  }

  private advanceFocus(session: LLMSession, filePath: string): void {
    const primaryFiles = session.task.primaryFiles || [];
    const nextIndex = primaryFiles.indexOf(filePath);
    if (nextIndex === -1) return;
    session.activeFocusIndex = nextIndex;
    session.activeFocusFile = filePath;
    session.focusInspectionBudgetRemaining = 1;
    session.focusStatus = 'unresolved';
    session.focusAdjacentFileUsed = false;
    session.focusDecision = 'reject';
    session.focusDecisionAt = new Date().toISOString();
  }

  private validateFocusGate(toolCall: ToolCall): string | null {
    const session = this.currentSession;
    if (!session || !this.isFocusGateActive(session) || session.focusStatus !== 'unresolved') return null;

    const tool = toolCall.tool;
    if (tool === 'applyEdit' || tool === 'writeFile' || tool === 'runBuild' || tool === 'runTests' || tool === 'typeCheck' || tool === 'complete') {
      return null;
    }

    const requestedPath = typeof toolCall.params?.path === 'string' ? toolCall.params.path : undefined;
    const nextPrimary = this.nextPrimaryFile(session);

    if (tool === 'readFile') {
      if (requestedPath === session.activeFocusFile) {
        if (session.focusInspectionBudgetRemaining > 0) return null;
        return `Focus gate: inspection budget exhausted for ${session.activeFocusFile}. Apply an edit, run verification, or move to the next primary file${nextPrimary ? `: ${nextPrimary}` : ''}.`;
      }
      if (requestedPath && nextPrimary && requestedPath === nextPrimary && session.focusInspectionBudgetRemaining <= 0) {
        this.advanceFocus(session, requestedPath);
        return null;
      }
      if (requestedPath && session.task.secondaryFiles?.includes(requestedPath) && !session.focusAdjacentFileUsed) {
        session.focusAdjacentFileUsed = true;
        return null;
      }
      return `Focus gate: stay on ${session.activeFocusFile} until you edit, verify, or explicitly advance to the next primary file${nextPrimary ? ` (${nextPrimary})` : ''}.`;
    }

    if (tool === 'search') {
      if (requestedPath === session.activeFocusFile) return null;
      if (requestedPath && session.task.secondaryFiles?.includes(requestedPath) && !session.focusAdjacentFileUsed) {
        session.focusAdjacentFileUsed = true;
        return null;
      }
      return `Focus gate: search must stay inside the active focus file ${session.activeFocusFile}${nextPrimary ? ` or advance to ${nextPrimary} after exhausting focus reads` : ''}.`;
    }

    if (tool === 'listDir') {
      return `Focus gate: broad repo exploration is blocked while focus remains unresolved on ${session.activeFocusFile}.`;
    }

    return null;
  }

  private updateFocusStateAfterTool(toolCall: ToolCall, result: ToolResult): void {
    const session = this.currentSession;
    if (!session || !this.isFocusGateActive(session)) return;

    if (!result.success) return;

    if (toolCall.tool === 'readFile' && typeof toolCall.params?.path === 'string' && toolCall.params.path === session.activeFocusFile && session.focusInspectionBudgetRemaining > 0) {
      session.focusInspectionBudgetRemaining -= 1;
      return;
    }

    if (toolCall.tool === 'applyEdit' || toolCall.tool === 'writeFile' || toolCall.tool === 'runBuild' || toolCall.tool === 'runTests' || toolCall.tool === 'typeCheck' || toolCall.tool === 'complete') {
      session.focusStatus = 'committed';
      session.focusDecision = 'resolve';
      session.focusDecisionAt = new Date().toISOString();
    }
  }

  private formatVerificationTargetPrompt(task: LLMTask): string {
    if (!task.verificationTargets?.length) return '';
    const preferred = task.verificationTargets
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((target) => `${target.tool}${target.pattern ? ` (${target.pattern})` : ''}: ${target.reason}`)
      .join('\n- ');
    return `\nPreferred verification targets after a mutation:\n- ${preferred}\nPrefer the first applicable verification target before broader verification discovery.`;
  }

  private formatPreferredVerificationHint(task: LLMTask): string {
    if (!task.verificationTargets?.length) return '';
    const target = task.verificationTargets.slice().sort((a, b) => a.priority - b.priority)[0];
    return `Preferred next verification: ${target.tool}${target.pattern ? ` (${target.pattern})` : ''}.`;
  }

  /**
   * Execute a tool call
   */
  private async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    toolCall = this.normalizeToolCallForFocusGate(toolCall);
    const { tool, params, thought } = toolCall;

    const authorityReceipt = await this.authorizeToolCall(tool, params);
    if (authorityReceipt?.decision === 'deny') {
      return {
        success: false,
        error: `Experiment authority denied ${tool}: ${authorityReceipt.reason}`,
        data: { authorityReceipt },
      };
    }

    Logger.debug('LLMModeAgent', `${thought}`);
    Logger.debug('LLMModeAgent', `Executing: ${tool}(${JSON.stringify(params)})`);

    telemetryWrapper.setContext({
      taskId: this.currentSession?.task.id,
      iteration: this.currentSession?.stepCount,
    });

    // Hard block: diagnose/plan seats must not spend credits on product mutations.
    if (
      this.currentSession
      && this.isDiagnoseOnlyTask(this.currentSession.task)
      && (tool === 'applyEdit' || tool === 'writeFile' || tool === 'createBackup' || tool === 'restoreBackup')
    ) {
      return {
        success: false,
        error:
          'Diagnose gate: mutations forbidden. Allowed: readFile, search, searchCode, listDir, gitStatus, gitLog, gitDiff, typeCheck, runBuild, runTests, runFocusedTests, runLint, lsp, astValidate, importGuard, complete(params.plan).',
      };
    }

    const focusGateError = this.validateFocusGate(toolCall);
    if (focusGateError) {
      Logger.warn('LLMModeAgent', focusGateError);
      return { success: false, error: focusGateError };
    }

    const startedAt = Date.now();
    const rateLimitResult = await rateLimiter.execute(
      tool === 'readFile' || tool === 'executeSkill' || tool === 'searchCode' || tool === 'searchDocs' || tool === 'gitLog' || tool === 'gitDiff'
        ? 'fileRead'
        : tool === 'writeFile' || tool === 'applyEdit'
          ? 'fileWrite'
          : tool === 'runBuild' || tool === 'renderArtifact'
            ? 'buildRun'
            : 'testRun',
      async () => {
        switch (tool) {
          case 'readFile': {
            // Track explored path for resume context
            if (params.path && typeof params.path === 'string') {
              this.currentSession?.exploredPaths.add(params.path);
            }
            return readFileTool.execute(params);
          }
          
          case 'writeFile': {
            // Track file extension for language-aware verification
            this.trackModifiedExtension(params.path as string);
            const writeResult = await writeFileTool.execute(params);
            // Track mutated file for resume context only after a successful write.
            if (writeResult.success && params.path && typeof params.path === 'string') {
              this.currentSession?.mutatedFiles.add(params.path);
              this.currentSession?.successfulMutatedFiles.add(params.path);
            }
            return writeResult;
          }
          
          case 'applyEdit': {
            // Create backup first
            const backupResult = await createBackupTool.execute({ path: params.path });
            if (backupResult.success && backupResult.data?.backupPath) {
              this.currentSession?.backups.push(backupResult.data.backupPath as string);
            }
            // Track file extension for language-aware verification
            this.trackModifiedExtension(params.path as string);
            const editResult = await applyEditTool.execute(params);
            // Track mutated file for resume context only after a successful edit.
            if (editResult.success && params.path && typeof params.path === 'string') {
              this.currentSession?.mutatedFiles.add(params.path);
              this.currentSession?.successfulMutatedFiles.add(params.path);
            }
            return editResult;
          }
          
          case 'runBuild': {
            // Language-aware verification: skip build if only non-code files were modified
            if (!this.needsCodeVerification()) {
              Logger.info('LLMModeAgent', 'Skipping runBuild - only non-code files modified (.md, .json, .css, .html, .yaml)');
              return {
                success: true,
                data: { skipped: true, reason: 'Only non-code files modified' },
                duration: 0
              };
            }
            const buildResult = await runBuildTool.execute(params);
            this.recordVerificationResult('build', buildResult);
            return buildResult;
          }
          
          case 'runTests': {
            const testResult = await runTestsTool.execute(params);
            this.recordVerificationResult('test', testResult);
            return testResult;
          }

          case 'listSkills': {
            const r = await listSkillsTool.execute(params);
            return r;
          }
          case 'attachImage': {
            const r = await attachImageTool.execute(params);
            if (r.success && r.data?.attachment) {
              // Stage for the next vision hop (drained in pendingVisionImages consumer).
              const att = r.data.attachment;
              try {
                const { toProviderImageInput } = await import('../../media/ImageAttachment.js');
                const img = toProviderImageInput(att);
                this.pendingVisionImages.push({ mimeType: img.mimeType, dataBase64: img.dataBase64 });
              } catch {
                /* attach still succeeds without vision payload */
              }
            }
            return r;
          }
          case 'executeSkill': {
            const skillResult = await executeSkillTool.execute(params);
            // Truncate skill bodies in the transcript so K3/Kilo context does not explode.
            if (skillResult.success && skillResult.data && typeof skillResult.data === 'object') {
              const data = skillResult.data as {
                skill?: { name?: string; content?: string; description?: string; path?: string };
              };
              if (data.skill && typeof data.skill.content === 'string' && data.skill.content.length > 2400) {
                const name = data.skill.name || 'skill';
                data.skill = {
                  ...data.skill,
                  content:
                    `${data.skill.content.slice(0, 2400)}\n\n…[skill body truncated for planning context; `
                    + `follow method headers in ${name}; do not re-executeSkill for the full body]`,
                };
              }
            }
            return skillResult;
          }
          
          case 'restoreBackup':
            return restoreBackupTool.execute(params);
          
          case 'createBackup': {
            const result = await createBackupTool.execute(params);
            if (result.success && result.data?.backupPath) {
              this.currentSession?.backups.push(result.data.backupPath as string);
            }
            return result;
          }

          case 'search':
            return searchTool.execute(params);
          case 'searchCode':
            return searchCodeTool.execute(params);
          case 'searchDocs':
            return searchDocsTool.execute(params);
          case 'listDir':
            return listDirTool.execute(params);
          case 'typeCheck': {
            const typecheckResult = await typeCheckTool.execute(params);
            this.recordVerificationResult('typecheck', typecheckResult);
            return typecheckResult;
          }
          case 'npm':
            return npmTool.execute(params);
          case 'runLint':
            return runLintTool.execute(params);
          case 'runFocusedTests': {
            const focusedResult = await runFocusedTestsTool.execute(params);
            this.recordVerificationResult('test', focusedResult);
            return focusedResult;
          }
          case 'lsp':
            return lspTool.execute(params);
          case 'astValidate':
            return astValidatorTool.execute(params);
          case 'importGuard':
            return importGuardTool.execute(params);
          case 'gitStatus':
            return gitStatusTool.execute(params);
          case 'gitLog':
            return gitLogTool.execute(params);
          case 'gitDiff':
            return gitDiffTool.execute(params);
          case 'renderArtifact': {
            const renderResult = await renderArtifactTool.execute(params);
            // Stash the screenshot for the next planning call's vision input,
            // then redact the base64 from the returned result: every transcript
            // path (tool message + toolResult serialization in getLLMPlan) must
            // keep multi-hundred-KB base64 out of the char-budgeted prompt.
            const renderData = renderResult.data as RenderArtifactResult | undefined;
            if (renderResult.success && renderData?.screenshot?.dataBase64) {
              this.pendingVisionImages.push({
                mimeType: renderData.screenshot.mimeType,
                dataBase64: renderData.screenshot.dataBase64,
                width: renderData.screenshot.width,
                height: renderData.screenshot.height,
                label: 'rendered-artifact',
              });
            }
            return this.redactRenderArtifactResult(renderResult);
          }

          default:
            return { success: false, error: unknownToolMessage(tool) };
        }
      }
    );

    const result = rateLimitResult.result || {
      success: false,
      error: rateLimitResult.error || 'Rate limit exceeded',
    };

    Logger.debug('LLMModeAgent', `Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    if (result.error) {
      Logger.debug('LLMModeAgent', `Error: ${result.error.substring(0, 200)}`);
    }

    // Honest selfCheckUsage / rotation metrics (toolsUsed must survive session export).
    if (this.currentSession) {
      if (!this.currentSession.toolsUsed) this.currentSession.toolsUsed = [];
      this.currentSession.toolsUsed.push(tool);
    }

    this.updateFocusStateAfterTool(toolCall, result);

    // Additive harness.action + harness.step executed (#400 F2). Fail-open.
    const argsHash = hashToolArgs(params);
    const durationMs = Date.now() - startedAt;
    const errorClass = result.success ? undefined : classifyToolError(result.error);
    const outcome = result.success ? 'success' : 'failure';
    await this.emitHarnessLane('harness.action', {
      verdict: outcome,
      latencyMs: durationMs,
      inputHash: argsHash,
      payload: {
        tool,
        argsHash,
        outcome,
        ...(errorClass ? { errorClass } : {}),
        durationMs,
      },
    });
    await this.emitHarnessLane('harness.step', {
      verdict: outcome,
      latencyMs: durationMs,
      inputHash: argsHash,
      payload: {
        phase: 'executed',
        step: this.currentSession?.stepCount ?? 0,
        tool,
        argsHash,
        outcome,
        ...(errorClass ? { errorClass } : {}),
        durationMs,
      },
    });

    return result;
  }

  private async authorizeToolCall(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ExperimentAuthorityReceipt | undefined> {
    const session = this.currentSession;
    const policy = session?.task.experimentAuthority;
    if (!session || !policy) return undefined;
    const receipt = await authorizeExperimentRequest(
      policy,
      requestFromToolCall(tool, params),
    );
    session.authorityReceipts.push(receipt);
    return receipt;
  }

  private isVerificationTool(tool: string): boolean {
    return tool === 'runBuild' || tool === 'runTests' || tool === 'runFocusedTests' || tool === 'typeCheck';
  }

  private isBoundedInspectionRun(session: LLMSession): boolean {
    return this.isBoundedInspectionTask(session.task);
  }

  private isBoundedInspectionTask(task: LLMTask): boolean {
    // Diagnose/plan seats are free inspection + complete(params.plan). They must not
    // hit the mutation-oriented "bounded inspection success with no edit" exit.
    if (this.isDiagnoseOnlyTask(task)) return false;
    return task.id.startsWith('tui-self-') ||
      task.completionPolicy === 'stop_after_verification';
  }

  /** Last step a bounded run may plan before shouldStopForBoundedInspection ends a mutation-free run. */
  private boundedEditDeadlineStep(maxSteps: number): number {
    return Math.ceil(maxSteps / 2);
  }

  /**
   * Once per bounded run with no mutation yet: warn before the bounded-inspection guardrail
   * fires. Without it the model never learns the guardrail exists (crsi/team turn 1, 2026-11-16:
   * Sol read 12/24 and 10/20 steps, then was cut off with no edit on all three self-improve tasks).
   */
  private maybeInjectEditDeadline(session: LLMSession, maxSteps: number): void {
    if (!this.isBoundedInspectionRun(session) || session.task.requiresMutation !== true) return;
    if (session.stepCount < 2) return;
    if (session.mutatedFiles.size > 0) return;
    const last = this.boundedEditDeadlineStep(maxSteps);
    const left = last - session.stepCount + 1;
    if (left > 3 || left < 1) return;
    const marker = 'EDIT DEADLINE';
    if (session.messages.some(m => typeof m.content === 'string' && m.content.includes(marker))) return;
    session.messages.push({
      role: 'user',
      content:
        `${marker} (step ${session.stepCount}/${maxSteps}): no applyEdit/writeFile has landed yet. ` +
        `This run stops after step ${last} unless one does: ${left} planning step${left === 1 ? '' : 's'} left, this one included. ` +
        `Stop inspecting. Make your best scoped edit now with applyEdit or writeFile, then verify it.`,
    });
    Logger.info('LLMModeAgent', `${marker} injected at step ${session.stepCount}/${maxSteps} (last=${last})`);
  }

  private isMeaningfulInspectionTool(tool: string): boolean {
    return tool === 'readFile' ||
      tool === 'listDir' ||
      tool === 'search' ||
      tool === 'gitStatus' ||
      tool === 'gitLog' ||
      tool === 'gitDiff' ||
      tool === 'renderArtifact' ||
      tool === 'lsp' ||
      tool === 'astValidate' ||
      tool === 'importGuard';
  }

  private hasConcreteSuccessfulInspection(session: LLMSession): boolean {
    for (let i = 0; i < session.messages.length - 1; i++) {
      const message = session.messages[i];
      const next = session.messages[i + 1];
      if (!message.toolCall || !next.toolResult?.success) continue;
      if (message.toolCall.tool === 'search') continue;
      if (!this.isMeaningfulInspectionTool(message.toolCall.tool)) continue;
      return true;
    }
    return false;
  }

  private shouldClassifyAsBoundedNoChangeSuccess(session: LLMSession): boolean {
    if (!this.isBoundedInspectionRun(session)) return false;
    if (session.task.requiresMutation === true) return false;
    if (session.mutatedFiles.size > 0 || session.backups.length > 0) return false;
    return this.hasConcreteSuccessfulInspection(session);
  }

  private shouldStopAfterSuccessfulVerification(session: LLMSession, toolCall: ToolCall, result: ToolResult): boolean {
    const tool = toolCall.tool;
    if (session.task.completionPolicy !== 'stop_after_verification') return false;
    if (!this.isVerificationTool(tool)) return false;
    if (!result.success) return false;
    if ((result.data as { skipped?: boolean } | undefined)?.skipped) return false;
    const required = this.getRequiredVerificationTarget(session.task);
    if (required && !this.matchesVerificationTarget(toolCall, required)) return false;
    return session.mutatedFiles.size > 0;
  }

  private getRequiredVerificationTarget(task: LLMTask): NonNullable<LLMTask['verificationTargets']>[number] | undefined {
    return task.verificationTargets?.slice().sort((a, b) => a.priority - b.priority)[0];
  }

  private matchesVerificationTarget(toolCall: Pick<ToolCall, 'tool' | 'params'>, target: NonNullable<LLMTask['verificationTargets']>[number]): boolean {
    const toolMatches = toolCall.tool === target.tool || (target.tool === 'runTests' && toolCall.tool === 'runFocusedTests');
    if (!toolMatches) return false;
    if (!target.pattern) return true;
    if (target.tool === 'runTests' || target.tool === 'runFocusedTests') {
      const pattern = typeof toolCall.params?.pattern === 'string' ? toolCall.params.pattern : '';
      const path = typeof toolCall.params?.path === 'string' ? toolCall.params.path : '';
      const targets = Array.isArray(toolCall.params?.targets) ? toolCall.params.targets.join(' ') : '';
      return [pattern, path, targets].some((value) => value.includes(target.pattern!));
    }
    return true;
  }

  private hasSatisfiedRequiredVerification(session: LLMSession): boolean {
    const target = this.getRequiredVerificationTarget(session.task);
    if (!target) return true;
    for (let i = 0; i < session.messages.length - 1; i++) {
      const message = session.messages[i];
      const next = session.messages[i + 1];
      if (!message.toolCall || !next.toolResult?.success) continue;
      if (this.matchesVerificationTarget(message.toolCall, target)) return true;
    }
    return false;
  }

  private getVerificationGateError(session: LLMSession): string | null {
    if (session.mutatedFiles.size === 0 && session.backups.length === 0) return null;
    const target = this.getRequiredVerificationTarget(session.task);
    if (target) {
      // Explicit packet target: require that specific tool (+ pattern) first.
      if (this.hasSatisfiedRequiredVerification(session)) return null;
      return `Verification gate: run ${target.tool}${target.pattern ? ` (${target.pattern})` : ''} before completing this task.`;
    }
    // No packet target — default self-check (W2 deferred → W3 product):
    // mutation tasks must not complete without build/typecheck/test verification.
    // (hasSatisfiedRequiredVerification is true when target is absent; do not short-circuit.)
    if (session.task.requiresMutation === true && !this.hasSuccessfulSelfCheck(session)) {
      return 'Self-check gate: run typeCheck or runBuild after mutating files before completing this task.';
    }
    return null;
  }

  /** True if a verification tool succeeded after (or during) this mutation session. */
  private hasSuccessfulSelfCheck(session: LLMSession): boolean {
    return (
      this.hasSuccessfulTool(session, 'runBuild')
      || this.hasSuccessfulTool(session, 'typeCheck')
      || this.hasSuccessfulTool(session, 'runTests')
      || this.hasSuccessfulTool(session, 'runFocusedTests')
    );
  }

  private getCompletionGateError(session: LLMSession, completeParams?: Record<string, unknown>): string | null {
    return (
      this.getMutationGateError(session)
      || this.getDiagnosePlanGateError(session, completeParams)
      || this.getArtifactGateError(session)
      || this.getVerificationGateError(session)
    );
  }

  private getMutationGateError(session: LLMSession): string | null {
    if (session.task.forbidMutations === true) {
      if (session.mutatedFiles.size > 0 || session.successfulMutatedFiles.size > 0 || session.backups.length > 0) {
        return 'Diagnose gate: mutations are forbidden on this task. Do not applyEdit/writeFile. Put the full plan in complete params.plan and stop.';
      }
      return null;
    }
    if (session.task.requiresMutation !== true) return null;
    if (session.mutatedFiles.size > 0) return null;
    return 'Mutation gate: execute at least one successful writeFile/applyEdit before completing this self-improvement task.';
  }

  private isDiagnoseOnlyTask(task: LLMTask): boolean {
    return task.forbidMutations === true || task.kind === 'diagnose';
  }

  /**
   * Planning completion budget. Default 2000 is enough for a single tool-call JSON,
   * but K3/Kilo high-reasoning diagnose plans need far more — reasoning_content can
   * exhaust 2k with finish_reason=length and empty message content (observed W3 attempt1/2).
   */
  private planningMaxTokens(session: LLMSession): number {
    const env = Number.parseInt(process.env.LIMINAL_HARNESS_PLAN_MAX_TOKENS || '', 10);
    if (Number.isFinite(env) && env > 0) return env;

    const clientMax = this.llmClient.getConfig?.()?.maxTokens;
    if (this.isDiagnoseOnlyTask(session.task)) {
      // Full markdown implementation plan + room for reasoning_content.
      const floor = 32768;
      return typeof clientMax === 'number' && clientMax > floor ? clientMax : floor;
    }
    if (typeof clientMax === 'number' && clientMax > 2000) {
      // Raised client budget (e.g. batteries.mjs) — allow larger tool/plan steps, cap churn.
      return Math.min(clientMax, 8192);
    }
    return 2000;
  }

  /** Once per diagnose run: after inspection, stop recon and demand complete(params.plan). */
  private maybeInjectDiagnosePlanDeadline(session: LLMSession, maxSteps: number): void {
    if (!this.isDiagnoseOnlyTask(session.task)) return;
    if (!this.hasConcreteSuccessfulInspection(session)) return;
    const skillsLoaded = (session.toolsUsed || []).filter((t) => t === 'executeSkill').length > 0
      || session.messages.some((m) => m.toolCall?.tool === 'executeSkill');
    const reconTools = new Set(['search', 'searchCode', 'listDir', 'readFile', 'gitLog', 'gitDiff']);
    const reconCount = (session.toolsUsed || []).filter((t) => reconTools.has(t)).length;
    // Skills front-load context (K3/Kilo timeout risk): fire earlier and after ≤4 recon tools.
    const deadline = skillsLoaded
      ? Math.max(3, Math.min(6, Math.ceil(maxSteps * 0.15)))
      : Math.max(4, Math.ceil(maxSteps * 0.25));
    const reconCapHit = skillsLoaded && reconCount >= 4;
    if (!reconCapHit && session.stepCount < deadline) return;
    const marker = 'DIAGNOSE PLAN DEADLINE';
    if (session.messages.some(m => typeof m.content === 'string' && m.content.includes(marker))) return;
    session.messages.push({
      role: 'user',
      content:
        `${marker} (step ${session.stepCount}/${maxSteps}`
        + `${skillsLoaded ? '; skills already loaded' : ''}`
        + `${reconCapHit ? '; recon cap ≥4' : ''}): You already ran real inspection. ` +
        `Your NEXT tool call MUST be complete with params.plan = a FULL markdown implementation spec (≥200 chars) ` +
        `for Sol/Grok to implement later. Do NOT applyEdit/writeFile/createBackup. ` +
        `Do NOT executeSkill again. ` +
        `Dirty working-tree diffs are orchestrator WIP — ignore them; do not treat them as your mutation task. ` +
        `Plan for recursive compounding self-improvement: PROMPT → Sinter acts → Sinter improves itself ` +
        `(SelfImprovementRuntime ↔ FailureLogger/PatternDetector/HarnessMemory feed-forward, rotation batteries, wave-gate). ` +
        `Ranked items with evidence paths, acceptance tests, blast radius, rollback, anti-goals.`,
    });
    Logger.info('LLMModeAgent', `${marker} injected at step ${session.stepCount}/${maxSteps}`);
  }

  private getDiagnosePlanGateError(session: LLMSession, completeParams?: Record<string, unknown>): string | null {
    if (!this.isDiagnoseOnlyTask(session.task)) return null;
    // Require at least one successful inspection so "complete" is not empty cosplay.
    if (!this.hasConcreteSuccessfulInspection(session)) {
      return 'Diagnose gate: run real inspection (readFile/search/gitStatus/typeCheck/tests) before complete; then deliver params.plan.';
    }
    const plan = completeParams?.plan;
    if (typeof plan !== 'string' || plan.trim().length < 200) {
      return 'Diagnose gate: complete with params.plan as a full markdown implementation spec (≥200 chars). No code edits.';
    }
    return null;
  }

  private getRequiredArtifactPath(session: LLMSession): string | null {
    const description = session.task.description;
    const explicitGate = /Do not report success unless\s+`?([^\s`]+\.md)`?\s+was created(?:\s+or\s+overwritten)?/i.exec(description);
    if (explicitGate?.[1]) return explicitGate[1].trim();

    const artifactLine = /(?:artifact|Artifact)\s+(?:at|path):?\s*`?([^\s`]+\.md)`?/i.exec(description);
    return artifactLine?.[1]?.trim() || null;
  }

  private getArtifactGateError(session: LLMSession): string | null {
    const artifactPath = this.getRequiredArtifactPath(session);
    if (!artifactPath) return null;
    if (session.successfulMutatedFiles.has(artifactPath)) return null;
    return `Artifact gate: create or overwrite ${artifactPath} with writeFile before completing this task.`;
  }

  /**
   * Bounded-inspection guardrail: for bounded Bubble Tea self-improvement runs,
   * terminate deterministically if no mutation has happened after spending
   * more than 50% of the step budget on reconnaissance.
   */
  private shouldStopForBoundedInspection(session: LLMSession, maxSteps: number): boolean {
    if (this.isDiagnoseOnlyTask(session.task)) return false;
    if (!this.isBoundedInspectionRun(session)) return false;

    // Must have spent more than half the budget
    if (session.stepCount <= this.boundedEditDeadlineStep(maxSteps)) return false;

    if (session.mutatedFiles.size > 0) return false;
    // A failed edit can leave a backup. Keep it for recovery on optional runs,
    // but a required edit still has to land before its deadline.
    if (!session.task.requiresMutation && session.backups.length > 0) return false;

    // Must have already completed meaningful successful inspection work
    if (!this.hasConcreteSuccessfulInspection(session)) return false;

    return true;
  }

  private restoreSessionFromRunState(session: LLMSession, existingRunState: RunState): void {
    for (const path of existingRunState.exploredPaths) {
      session.exploredPaths.add(path);
    }
    for (const file of existingRunState.mutatedFiles) {
      session.mutatedFiles.add(file);
      session.successfulMutatedFiles.add(file);
    }
    if (existingRunState.lastVerification) {
      session.lastVerification = existingRunState.lastVerification;
    }
    if (existingRunState.lastPlanError) {
      session.lastPlanError = existingRunState.lastPlanError;
    }
    if (existingRunState.activeFocusFile) {
      session.activeFocusFile = existingRunState.activeFocusFile;
      session.activeFocusIndex = existingRunState.activeFocusIndex ?? 0;
      session.focusInspectionBudgetRemaining = existingRunState.focusInspectionBudgetRemaining ?? 0;
      session.focusStatus = existingRunState.focusStatus ?? 'unresolved';
      session.focusAdjacentFileUsed = existingRunState.focusAdjacentFileUsed ?? false;
      session.focusDecision = existingRunState.focusDecision;
      session.focusDecisionAt = existingRunState.focusDecisionAt;
    }
    session.stepCount = existingRunState.stepsCompleted;
  }

  private recordVerificationResult(type: 'build' | 'test' | 'typecheck', result: ToolResult): void {
    if (!this.currentSession) return;
    this.currentSession.lastVerification = {
      passed: result.success,
      type,
      error: result.error,
      timestamp: new Date().toISOString(),
    };
  }

  private deriveSuspensionPhase(session: LLMSession): SemanticBoundary {
    if (session.lastVerification) {
      return session.lastVerification.passed
        ? SemanticBoundary.VERIFICATION_FINISHED
        : SemanticBoundary.VERIFICATION_STARTED;
    }

    return session.mutatedFiles.size > 0
      ? SemanticBoundary.MUTATION_APPLIED
      : SemanticBoundary.INTERRUPTED;
  }

  private buildSuspendedRunState(
    session: LLMSession,
    maxSteps: number,
    workspaceFingerprint?: RunState['workspaceFingerprint'],
  ): RunState {
    const phase = this.deriveSuspensionPhase(session);

    return {
      runId: `run-${session.task.id}-${Date.now()}`,
      taskId: session.task.id,
      taskTitle: session.task.title,
      taskDescription: session.task.description,
      status: Status.SUSPENDED,
      phase,
      stepsCompleted: session.stepCount,
      maxSteps,
      continueUntilDone: false,
      startedAt: session.startTime,
      suspendedAt: new Date().toISOString(),
      exploredPaths: Array.from(session.exploredPaths),
      progressSummary: `Completed ${session.stepCount} steps. ${session.mutatedFiles.size} files mutated. Phase: ${phase}`,
      hadMutations: session.mutatedFiles.size > 0,
      mutationApplied: session.mutatedFiles.size > 0,
      mutatedFiles: Array.from(session.mutatedFiles),
      lastVerification: session.lastVerification,
      lastPlanError: session.lastPlanError,
      activeFocusFile: session.activeFocusFile,
      activeFocusIndex: session.activeFocusIndex,
      focusInspectionBudgetRemaining: session.focusInspectionBudgetRemaining,
      focusStatus: session.focusStatus,
      focusAdjacentFileUsed: session.focusAdjacentFileUsed,
      focusDecision: session.focusDecision,
      focusDecisionAt: session.focusDecisionAt,
      workspaceFingerprint,
    };
  }

  private async persistSuspendedRunState(session: LLMSession, maxSteps: number): Promise<void> {
    let workspaceFingerprint;
    try {
      workspaceFingerprint = await captureWorkspaceFingerprint();
    } catch (fpErr) {
      Logger.warn('LLMModeAgent', `Could not capture workspace fingerprint: ${fpErr}`);
    }

    try {
      await saveRunState(this.buildSuspendedRunState(session, maxSteps, workspaceFingerprint));
      Logger.info('LLMModeAgent', 'Run state saved for potential resume');
    } catch (saveErr) {
      Logger.error('LLMModeAgent', `Failed to save run state: ${saveErr}`);
    }
  }

  private trackModifiedExtension(filePath: string): void {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (ext) this.modifiedExtensions.add(ext);
  }

  private needsCodeVerification(): boolean {
    if (this.modifiedExtensions.size === 0) return true;
    const nonCodeOnly = ['md', 'txt', 'rst', 'json', 'jsonc', 'css', 'scss', 'less', 'sass', 'html', 'htm', 'svg', 'yaml', 'yml', 'toml'];
    return Array.from(this.modifiedExtensions).some((ext) => !nonCodeOnly.includes(ext));
  }

  /**
   * Attempt to recover from build errors
   */
  private async attemptErrorRecovery(session: LLMSession, buildError: ToolResult): Promise<boolean> {
    Logger.debug('LLMModeAgent', 'Attempting error recovery...');

    // Add reflection prompt
    session.messages.push({
      role: 'user',
      content: createReflectionPrompt(buildError.error || 'Unknown build error'),
    });

    // Give LLM 3 attempts to fix
    for (let i = 0; i < 3; i++) {
      Logger.debug('LLMModeAgent', `Recovery attempt ${i + 1}/3`);
      
      const toolCall = await this.getLLMPlan(session);
      if (!toolCall || toolCall.tool === 'complete') {
        return false;
      }

      session.messages.push({
        role: 'assistant',
        content: JSON.stringify(toolCall),
        toolCall,
      });

      const result = await this.executeTool(toolCall);
      session.messages.push({
        role: 'tool',
        content: JSON.stringify(result),
        toolResult: result,
      });

      if (toolCall.tool === 'runBuild' && result.success) {
        Logger.debug('LLMModeAgent', 'Recovery successful!');
        return true;
      }
    }

    Logger.debug('LLMModeAgent', 'Recovery failed after 3 attempts');
    return false;
  }

  /**
   * Rollback all changes
   */
  private async rollback(session: LLMSession): Promise<void> {
    Logger.debug('LLMModeAgent', `Rolling back ${session.backups.length} backups...`);
    
    for (const backupPath of [...session.backups].reverse()) {
      await rateLimiter.execute('fileWrite', async () => {
        return restoreBackupTool.execute({ backupPath });
      });
    }
    
    Logger.debug('LLMModeAgent', 'Rollback complete');
  }

  /**
   * Store a ThinkingAnalysis result and persist it via the repository
   */
  private storeAnalysis(analysis: import('../ThinkingAnalyzer.js').ThinkingAnalysis): void {
    this.analyses.push(analysis);

    // Persist analysis insights as harness thinking so they surface
    // in getRecentInsights() and getActionableItems()
    if (analysis.suggestedFix) {
      thinkingRepository.storeHarnessThinking({
        model: analysis.model,
        thinking: `[ThinkingAnalysis] ${analysis.learning}. Suggested fix: ${analysis.suggestedFix.description}`,
        context: 'improvement',
      });
    }
  }

  getSession(id: string): LLMSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): LLMSession[] {
    return Array.from(this.sessions.values());
  }

  getAnalyses(): import('../ThinkingAnalyzer.js').ThinkingAnalysis[] {
    return this.analyses;
  }

  generateReport(): string {
    const sessions = this.getAllSessions();
    const successful = sessions.filter(s => s.status === Status.SUCCESS).length;
    const failed = sessions.filter(s => s.status === Status.FAILED).length;
    const rolledBack = sessions.filter(s => s.status === Status.ROLLED_BACK).length;

    return `
# LLMModeAgent Report

Generated: ${new Date().toISOString()}

## Summary
- Total Tasks: ${sessions.length}
- Successful: ${successful}
- Failed: ${failed}
- Rolled Back: ${rolledBack}

## Sessions
${sessions.map(s => `
### ${s.task.id}: ${s.task.title}
- Status: ${s.status}${s.exitReason ? ` (${s.exitReason})` : ''}
- Steps: ${s.stepCount}
- LLM Calls: ${s.messages.filter(m => m.role === 'assistant').length}
- Backups: ${s.backups.length}
- Duration: ${s.endTime ? new Date(s.endTime).getTime() - new Date(s.startTime).getTime() : 'ongoing'}ms
`).join('')}
`.trim();
  }
}

export function createLLMModeAgent(llmClient: LLMClient): LLMModeAgent {
  return new LLMModeAgent(llmClient);
}
