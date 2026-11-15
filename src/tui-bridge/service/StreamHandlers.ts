/**
 * Extracted from TuiBridgeService.ts: direct chat, engineering and hybrid stream handlers and formatting helpers.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { STUDIO_SYSTEM_PROMPT } from '../../agent/StudioAgent.js';
import { ConversationManager } from '../../chat/ConversationManager.js';
import { detectProviderLabel } from '../../config/ProviderRuntime.js';
import { type BusEvent, eventBus, EventTypes } from '../../core/EventBus.js';
import { createLLMModeAgent, type LLMSession } from '../../harness/agent/index.js';
import type { LLMClient } from '../../llm/LLMClient.js';
import { describeStatusLifecycle, formatStatusEvidenceLines, formatStatusNextAction, formatStatusRiskLine } from '../../types/status.js';
import { normalizePath } from '../../utils/normalizePath.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { TuiInputRequest } from '../types.js';
import { logBridge } from './bridgeHelpers.js';
import { PRIOR_ARTIFACT_EXCERPT_MAX_CHARS } from './constants.js';
import { TUI_SYSTEM_PROMPT } from './requestClassification.js';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Stream a direct chat response from the LLM.
 * Uses STUDIO_SYSTEM_PROMPT for the creative-first persona.
 * No autonomy gating — direct chat is read-only.
 */
export async function streamDirectChat(host: TuiBridgeService, sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient): Promise<void> {
    const controller = new AbortController();
    host.activeStreams.set(sessionId, controller);

    const config = llm.getConfig();
    const modelName = config.model || 'unknown';
    const provider = config.baseUrl ? host.providerLabelFromBaseUrl(config.baseUrl) : 'unknown';
    const startTime = Date.now();
    logBridge('direct.started', { sessionId, model: modelName, chars: userText.length });
    host.beginRun(sessionId, {
      kind: 'chat',
      label: 'Direct chat',
      model: modelName,
      provider,
    });
    host.transitionRun(sessionId, 'generating', { label: 'Streaming direct chat response' });

    try {
      // Build conversation context from history (same pattern as streamChatResponse)
      const conversationContext = conversation.getConversationContext({ excludeLatest: true });
      const fullPrompt = conversationContext
        ? `${conversationContext}user: ${userText}`
        : userText;

      const response = await llm.generate(STUDIO_SYSTEM_PROMPT, fullPrompt, controller.signal);

      const content = response.code || response.explanation || '';
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      const chunks = host.chunkString(content, 50);
      let fullContent = '';
      for (const chunk of chunks) {
        fullContent += chunk;
        host.emit(sessionId, { type: 'response.delta', sessionId, delta: chunk });
        await new Promise(r => setTimeout(r, 10));
      }

      host.emit(sessionId, { type: 'response.completed', sessionId, content: fullContent });
      host.emit(sessionId, { type: 'response.committed', sessionId, content: fullContent });
      conversation.appendMessage('assistant', fullContent);

      host.emit(sessionId, {
        type: 'response.metadata',
        sessionId,
        model: modelName,
        duration: Date.now() - startTime,
      });

      host.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: host.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: 'Direct chat',
          model: modelName,
        }),
      });
      host.completeRun(sessionId, { label: 'Direct chat complete', model: modelName, provider });

      logBridge('direct.completed', { sessionId, model: modelName, duration: Date.now() - startTime });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      host.failRun(sessionId, message);
      host.emit(sessionId, host.errorEvent(sessionId, err, { provider, model: modelName, endpoint: config.baseUrl }));
      throw err;
    } finally {
      host.activeStreams.delete(sessionId);
    }
  }

/**
 * Read a bounded excerpt of the prior artifact for revision prompts.
 * Confines the read to `.omx/proof` (where preview/cognition receipts write;
 * production receipts emit absolute `.omx/proof/live-previews/...`).
 * Rejects `..` segments, absolute/relative escapes, and symlink escapes. Never throws.
 */
export async function resolvePriorArtifactExcerpt(_host: TuiBridgeService, priorRunReceipt: unknown, maxChars = PRIOR_ARTIFACT_EXCERPT_MAX_CHARS): Promise<string | undefined> {
    try {
      if (!priorRunReceipt || typeof priorRunReceipt !== 'object' || Array.isArray(priorRunReceipt)) {
        return undefined;
      }
      const artifact = (priorRunReceipt as { artifact?: unknown }).artifact;
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        return undefined;
      }
      const rawPath = (artifact as { path?: unknown }).path;
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return undefined;
      }
      const trimmed = rawPath.trim();
      // Attacker-controllable via unauthenticated session input — fail closed.
      // Reject `..` in the raw string before any resolution (defense in depth).
      if (trimmed.split(/[/\\]/).includes('..')) {
        return undefined;
      }

      const repoRoot = process.cwd();
      let candidate: string;
      if (path.isAbsolute(trimmed)) {
        // Absolute receipts (PreviewService) are allowed only if realpath stays in-repo.
        candidate = path.normalize(trimmed);
      } else {
        let subPath = trimmed.replace(/\\/g, '/');
        if (subPath.startsWith('./')) {
          subPath = subPath.slice(2);
        }
        if (!subPath || subPath.startsWith('/') || subPath.split('/').includes('..')) {
          return undefined;
        }
        candidate = normalizePath(repoRoot, subPath);
      }

      let rootReal: string;
      let resolvedReal: string;
      try {
        // Root is .omx/proof, not the repo root: receipt artifact paths are
        // proof artifacts, and anything wider would expose arbitrary repo files.
        rootReal = realpathSync(path.join(repoRoot, '.omx', 'proof'));
        resolvedReal = realpathSync(candidate);
      } catch {
        return undefined;
      }
      const rel = path.relative(rootReal, resolvedReal);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined;
      }

      const content = await fs.readFile(resolvedReal, 'utf8');
      if (content.length <= maxChars) return content;
      return `${content.slice(0, maxChars)}\n// …(truncated)`;
    } catch {
      return undefined;
    }
  }

/**
 * Stream a chat response with conversation history and telemetry
 */
export async function streamChatResponse(host: TuiBridgeService, sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient, systemPrompt?: string): Promise<void> {
    const controller = new AbortController();
    host.activeStreams.set(sessionId, controller);

    const startTime = Date.now();
    const config = llm.getConfig();
    const modelName = config.model || 'unknown';
    logBridge('chat.started', { sessionId, model: modelName, chars: userText.length });

    try {
      // Build conversation context from history
      const conversationContext = conversation.getConversationContext({ excludeLatest: true });

      const fullPrompt = conversationContext
        ? `${conversationContext}user: ${userText}`
        : userText;

      let fullContent = '';
      const effectivePrompt = systemPrompt ?? TUI_SYSTEM_PROMPT;
      for await (const chunk of llm.stream(effectivePrompt, fullPrompt, controller.signal)) {
        fullContent += chunk;
        host.emit(sessionId, { type: 'response.delta', sessionId, delta: chunk });
      }
      if (!fullContent.trim()) {
        throw new Error('Empty response from LLM stream');
      }

      const duration = Date.now() - startTime;

      host.emit(sessionId, { type: 'response.completed', sessionId, content: fullContent });
      host.emit(sessionId, { type: 'response.committed', sessionId, content: fullContent });

      // Emit telemetry
      host.emit(sessionId, {
        type: 'response.metadata',
        sessionId,
        model: modelName,
        duration,
      });

      // Record assistant response in conversation
      conversation.appendMessage('assistant', fullContent);

      // Detect code in response and emit preview events for TUI
      const codeContent = host.extractCodeContent(fullContent);
      if (codeContent) {
        host.emit(sessionId, { type: 'preview.started', sessionId, previewType: 'code' });
        host.emit(sessionId, { type: 'preview.content', sessionId, content: codeContent, previewType: 'code' });
      }

      host.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: host.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: fullContent.slice(0, 60),
          model: modelName,
        }),
      });
      logBridge('chat.completed', { sessionId, model: modelName, duration, chars: fullContent.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      host.emit(sessionId, host.errorEvent(sessionId, err, { model: modelName, endpoint: config.baseUrl }));
      logBridge('chat.failed', { sessionId, model: modelName, error: message });
      throw err;
    } finally {
      host.activeStreams.delete(sessionId);
    }
  }

/**
 * Stream an engineering task through the LLMModeAgent with task lifecycle events.
 */
export async function streamEngineeringTask(host: TuiBridgeService, sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient): Promise<void> {
    const controller = new AbortController();
    host.activeStreams.set(sessionId, controller);

    const config = llm.getConfig();
    const modelName = config.model || 'unknown';
    const provider = config.baseUrl ? host.providerLabelFromBaseUrl(config.baseUrl) : 'unknown';
    const liveTaskDescription = host.withLiveSessionContext(sessionId, userText, config);
    const maxSteps = Number(process.env.LIMINAL_TUI_AGENT_MAX_STEPS || 20);
    const agent = createLLMModeAgent(llm);
    const taskId = `studio-eng-${Date.now()}`;

    // Emit task lifecycle events
    host.beginRun(sessionId, {
      kind: 'engineering',
      label: `Engineering task queued: ${userText.slice(0, 60)}`,
      executor: 'llm-mode-agent',
      model: modelName,
      provider,
    });
    host.transitionRun(sessionId, 'planning', { label: 'Planning engineering task' });
    host.emit(sessionId, { type: 'task.queued', sessionId, taskId, description: userText.slice(0, 120) });
    host.emit(sessionId, { type: 'activity.updated', sessionId, message: `Engineering task queued: ${userText.slice(0, 60)}` });

    const listener = (event: BusEvent) => {
      if (event.source !== 'LLMModeAgent') return;
      if (event.type === EventTypes.PROCESS_START || event.type === EventTypes.PROCESS_PROGRESS) {
        const message = event.data.message || event.data.stage || 'working';
        host.emitOperatorProgress(sessionId, event);
        const stage = typeof event.data.stage === 'string' ? event.data.stage : '';
        if (stage.includes('verification') || stage.includes('runBuild') || stage.includes('runTests')) {
          host.transitionRun(sessionId, 'evaluating', { label: String(message), model: modelName, provider });
        } else if (stage.startsWith('planned ')) {
          host.transitionRun(sessionId, 'planning', { label: String(message), model: modelName, provider });
        } else if (stage.startsWith('executed ')) {
          host.transitionRun(sessionId, 'generating', { label: String(message), model: modelName, provider });
        }
        host.emit(sessionId, { type: 'activity.updated', sessionId, message: String(message) });
        host.emitLiveNarration(sessionId, String(message));
      }
      if (event.type === EventTypes.PROCESS_END) {
        const message = event.data.success ? 'Task complete' : `Task failed: ${String(event.data.reason || 'unknown')}`;
        host.emit(sessionId, { type: 'activity.updated', sessionId, message });
        host.emitLiveNarration(sessionId, message);
      }
    };

    eventBus.onEvent(listener);
    logBridge('engineering.started', { sessionId, taskId, model: modelName, maxSteps });

    try {
      host.emit(sessionId, { type: 'task.started', sessionId, taskId });
      host.transitionRun(sessionId, 'generating', { label: 'Executing engineering task', model: modelName, provider });

      const session = await agent.executeTask({
        id: taskId,
        title: `Studio engineering: ${userText.slice(0, 60)}`,
        description: liveTaskDescription,
        maxSteps,
        approved: true,
      });

      const fullContent = host.formatAgentSession(session);
      for (const chunk of host.chunkString(fullContent, 80)) {
        host.emit(sessionId, { type: 'response.delta', sessionId, delta: chunk });
        await new Promise(r => setTimeout(r, 5));
      }
      host.emit(sessionId, { type: 'response.completed', sessionId, content: fullContent });
      host.emit(sessionId, { type: 'response.committed', sessionId, content: fullContent });
      conversation.appendMessage('assistant', fullContent);

      const duration = new Date(session.endTime || new Date().toISOString()).getTime() - new Date(session.startTime).getTime();
      const lifecycle = describeStatusLifecycle(session.status, session.lastPlanError, {
        lastVerification: session.lastVerification,
        mutatedFiles: Array.from(session.mutatedFiles),
      });
      host.emit(sessionId, { type: 'response.metadata', sessionId, model: modelName, duration });
      host.emit(sessionId, { type: 'task.completed', sessionId, taskId, success: lifecycle.succeeded, durationMs: duration });

      host.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: host.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: `Engineering ${session.status}`,
          model: modelName,
        }),
      });
      if (lifecycle.succeeded) {
        host.completeRun(sessionId, {
          label: 'Engineering task complete',
          model: modelName,
          provider,
          agentStatus: session.status,
          resumable: lifecycle.resumable,
          retryable: lifecycle.retryable,
          nextAction: lifecycle.nextAction,
        });
      } else if (lifecycle.resumable) {
        host.suspendRun(
          sessionId,
          session.lastPlanError || `Engineering ${session.status}`,
          {
            label: 'Engineering suspended - resumable',
            lastPlanError: session.lastPlanError,
            agentStatus: session.status,
            resumable: true,
            retryable: lifecycle.retryable,
            nextAction: lifecycle.nextAction,
            model: modelName,
            provider,
          },
        );
      } else {
        host.failRun(
          sessionId,
          session.lastPlanError || `Engineering ${session.status}`,
          'failed',
          {
            label: `Engineering ${session.status}`,
            lastPlanError: session.lastPlanError,
            agentStatus: session.status,
            resumable: false,
            retryable: lifecycle.retryable,
            nextAction: lifecycle.nextAction,
            model: modelName,
            provider,
          },
        );
      }

      logBridge('engineering.completed', {
        sessionId,
        taskId,
        status: session.status,
        steps: session.stepCount,
        tools: host.agentToolsUsed(session),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      host.failRun(sessionId, message);
      throw err;
    } finally {
      eventBus.offEvent(listener);
      host.activeStreams.delete(sessionId);
    }
  }

export function withLiveSessionContext(host: TuiBridgeService, sessionId: string, userText: string, config: ReturnType<LLMClient['getConfig']>): string {
    const status = host.getStatus(sessionId);
    const runtimeProvider = config.baseUrl
      ? host.providerLabelFromBaseUrl(config.baseUrl)
      : status.provider || 'unknown';
    const runtimeModel = config.model || status.model || 'unknown';
    const lines = [
      userText,
      '',
      'Live Bubble Tea session context:',
      `- sessionId: ${sessionId}`,
      `- status.provider: ${status.provider || 'unknown'}`,
      `- status.model: ${status.model || 'unknown'}`,
      `- runtime.provider: ${runtimeProvider}`,
      `- runtime.model: ${runtimeModel}`,
      `- runtime.baseUrl: ${config.baseUrl || 'unknown'}`,
      '',
      'Treat this context as live bridge-provided evidence for the current TUI session provider/model.',
    ];
    return lines.join('\n');
  }

export function providerLabelFromBaseUrl(_host: TuiBridgeService, baseUrl: string): string {
    const label = detectProviderLabel(baseUrl);
    return label === 'llm' ? 'unknown' : label;
  }

export function emitOperatorProgress(host: TuiBridgeService, sessionId: string, event: BusEvent): void {
    const current = typeof event.data.current === 'number' ? event.data.current : undefined;
    const total = typeof event.data.total === 'number' ? event.data.total : undefined;
    const stage = typeof event.data.stage === 'string' ? event.data.stage : '';
    const message = typeof event.data.message === 'string' ? event.data.message : stage;

    if (current != null || total != null) {
      host.emit(sessionId, {
        type: 'phase.changed',
        sessionId,
        phase: host.phaseForProcessStage(stage),
        stepCurrent: current,
        stepTotal: total,
        objective: message,
      });
    }

    if (stage.startsWith('planned ')) {
      const toolName = stage.slice('planned '.length).trim();
      if (!toolName) return;
      if (toolName === 'complete') return;
      const thought = (typeof event.data.thought === 'string' && event.data.thought)
        || message.replace(new RegExp(`^${toolName}:\\s*`), '');
      host.emit(sessionId, {
        type: 'tool.started',
        sessionId,
        toolName,
        thought,
        displayLabel: thought || toolName,
        stepNum: current,
      });
      return;
    }

    if (stage.startsWith('executed ')) {
      const toolName = stage.slice('executed '.length).trim();
      if (!toolName) return;
      const failed = /\bfailed\b/i.test(message);
      host.emit(sessionId, {
        type: 'tool.completed',
        sessionId,
        toolName,
        resultSummary: message,
        success: !failed,
        stepNum: current,
      });
    }
  }

export function phaseForProcessStage(_host: TuiBridgeService, stage: string): string {
    if (stage.includes('verification') || stage.includes('typeCheck') || stage.includes('runBuild') || stage.includes('runTests')) return 'Verify';
    if (stage.startsWith('executed ')) return 'Inspect';
    if (stage.startsWith('planned ')) return 'Plan';
    return 'Plan';
  }

/**
 * Stream a hybrid task: creative generation followed by engineering verification.
 */
export async function streamHybridTask(host: TuiBridgeService, sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient, options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'> = {}): Promise<void> {
    // Phase 1: Creative generation
    host.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Starting creative generation...' });
    await host.streamGovernedProductCreate(sessionId, userText, conversation, options);

    // Phase 2: Engineering verification
    host.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Verifying with engineering agent...' });
    await host.streamEngineeringTask(sessionId, `Verify and improve the creative output for: ${userText}`, conversation, llm);
  }

export function cancelStream(host: TuiBridgeService, sessionId: string): void {
    const controller = host.activeStreams.get(sessionId);
    if (controller) {
      controller.abort();
      host.activeStreams.delete(sessionId);
    }
  }

/** Extract code from markdown fences or detect raw code patterns */
export function extractCodeContent(_host: TuiBridgeService, content: string): string | null {
    // Try markdown fence extraction
    const fenceMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();

    // Detect raw code patterns (function declarations, const assignments)
    if (/\bfunction\s+\w+/.test(content) || /\bconst\s+\w+\s*=\s*\(.*\)\s*=>/.test(content)) {
      return content.trim();
    }

    return null;
  }

export function formatAgentSession(host: TuiBridgeService, session: LLMSession): string {
    const lifecycle = describeStatusLifecycle(session.status, session.lastPlanError, {
      lastVerification: session.lastVerification,
      mutatedFiles: Array.from(session.mutatedFiles),
    });
    const duration = session.endTime
      ? new Date(session.endTime).getTime() - new Date(session.startTime).getTime()
      : Date.now() - new Date(session.startTime).getTime();
    const toolLines = session.messages
      .filter((m) => m.toolCall)
      .map((m) => {
        const mIndex = session.messages.indexOf(m);
        const result = mIndex >= 0
          ? session.messages.slice(mIndex + 1).find((candidate) => candidate.role === 'tool' && candidate.toolResult)
          : undefined;
        return `- ${m.toolCall?.tool}: ${m.toolCall?.thought}${result?.toolResult ? ` (${result.toolResult.success ? 'ok' : 'failed'})` : ''}`;
      })
      .slice(-12);
    const touchedFiles = Array.from(session.mutatedFiles);
    const filesChanged = session.status === 'rolled_back' ? [] : touchedFiles;
    const rolledBackFiles = session.status === 'rolled_back' ? touchedFiles : [];
    const testTools = new Set(['runTests', 'runFocusedTests']);
    const otherVerificationTools = new Set(['typeCheck', 'runBuild']);
    const testsRun = session.messages
      .filter((m) => m.toolCall && testTools.has(m.toolCall.tool))
      .map((m) => `- ${m.toolCall?.tool}`);
    const otherVerificationRun = session.messages
      .filter((m) => m.toolCall && otherVerificationTools.has(m.toolCall.tool))
      .map((m) => `- ${m.toolCall?.tool}`);
    const verdict = session.status === 'success'
      ? 'The engineering run completed successfully.'
      : lifecycle.resumable
        ? 'The engineering run is suspended with a checkpoint and can be resumed.'
      : session.status === 'failed' || session.status === 'rolled_back'
        ? 'The engineering run did not complete successfully.'
        : 'The engineering run completed with unresolved issues.';
    const evidence = [
      `- Task: ${session.task.title}`,
      `- Steps: ${session.stepCount}`,
      `- Duration: ${duration}ms`,
      `- Tools used: ${host.agentToolsUsed(session).join(', ') || 'none'}`,
      ...formatStatusEvidenceLines(lifecycle),
    ];

    return [
      `Status: ${session.status}`,
      `Verdict:`,
      verdict,
      `Evidence:`,
      evidence.join('\n'),
      `Files changed:`,
      filesChanged.length > 0
        ? filesChanged.map((file) => `- ${file}`).join('\n')
        : rolledBackFiles.length > 0
          ? `- none (rolled back ${rolledBackFiles.length} touched file${rolledBackFiles.length === 1 ? '' : 's'})`
          : '- none',
      `Tests run:`,
      testsRun.length > 0 ? testsRun.join('\n') : '- none recorded',
      `Other verification:`,
      otherVerificationRun.length > 0 ? otherVerificationRun.join('\n') : '- none recorded',
      ...(session.lastPlanError ? [
        `Last planning failure:`,
        session.lastPlanError,
      ] : []),
      `Remaining risks:`,
      formatStatusRiskLine(lifecycle),
      `Recommended next action:`,
      session.status === 'success'
        ? '- Review the diff and merge if the changes match intent.'
        : `- ${formatStatusNextAction(lifecycle.nextAction)}`,
      '',
      `Supporting tool trace:`,
      toolLines.length > 0 ? toolLines.join('\n') : '- no tool calls recorded',
    ].join('\n');
  }

export function agentToolsUsed(_host: TuiBridgeService, session: LLMSession): string[] {
    return Array.from(new Set(
      session.messages
        .map((m) => m.toolCall?.tool)
        .filter((tool): tool is string => Boolean(tool))
    ));
  }

/** Split string into chunks for streaming effect */
export function chunkString(_host: TuiBridgeService, str: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < str.length; i += chunkSize) {
      chunks.push(str.slice(i, i + chunkSize));
    }
    return chunks;
  }

export function emitLiveNarration(host: TuiBridgeService, sessionId: string, message: string): void {
    if (!message.trim()) return;
    host.emit(sessionId, {
      type: 'response.delta',
      sessionId,
      delta: `${message}\n`,
    });
  }
