/**
 * Extracted from TuiBridgeService.ts: operator input, pending actions, cancellation and product mode.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { ModeAwareRouter, type ModeConfig, PRODUCT_MODES, type ProductMode } from '../../agent/ProductMode.js';
import { ConversationManager } from '../../chat/ConversationManager.js';
import type { LLMClient } from '../../llm/LLMClient.js';
import { dispatchCommand } from '../CommandDispatcher.js';
import { buildCreativeIntentBrief, emitCreativeClarification, emitIntentBrief, emitReasoningTrace } from '../CreativeIntentHelpers.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { TuiInputRequest, TuiPendingAction, TuiRunExecutor } from '../types.js';
import { logBridge } from './bridgeHelpers.js';
import { isGenerationRequest, isOperatorInspectionRequest, isSelfImprovementRequest } from './requestClassification.js';
import { getRetiredDraftTestAdapter } from './retiredDraftAdapter.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function submitInput(host: TuiBridgeService, sessionId: string, input: TuiInputRequest, llm?: LLMClient): Promise<{ reviewRequired: boolean }> {
    // Cancel any in-flight stream for this session
    host.cancelStream(sessionId);

    host.sessions.update(sessionId, { mode: input.mode });
    const selfImprovement = isSelfImprovementRequest(input.text);
    const creativeGeneration = isGenerationRequest(input.text);

    // Slash-command dispatch (extracted to CommandDispatcher)
    const commandResult = await dispatchCommand(host.commandCtx, sessionId, input.text, llm);
    if (commandResult) return commandResult;
    // Studio routing: classify intent via IntentRouter with mode biasing
    const modeConfig = host.modeRegistry.getMode(sessionId);
    const classifier = new ModeAwareRouter(host.router, () => modeConfig);
    const baseClassification = classifier.classify(input.text);
    const classification = input.clientIntent === 'creative'
      ? {
          ...baseClassification,
          intent: 'creative' as const,
          confidence: 'high' as const,
          topic: baseClassification.topic ?? 'generate',
        }
      : isOperatorInspectionRequest(input.text)
      ? {
          ...baseClassification,
          intent: 'engineering' as const,
          confidence: 'high' as const,
          topic: baseClassification.topic ?? 'inspect',
        }
      : baseClassification;

    logBridge('input.received', {
      sessionId,
      mode: input.mode,
      intent: input.clientIntent,
      studioIntent: classification.intent,
      studioConfidence: classification.confidence,
      topic: classification.topic,
      selfImprovement,
      creativeGeneration,
      chars: input.text.length,
    });

    if (input.clientIntent === 'action' || input.mode === 'action') {
      const pendingAction: TuiPendingAction = {
        id: `action-${Date.now()}`,
        title: input.text.slice(0, 60),
        description: input.text,
        prompt: input.text,
        route: 'operator',
        kind: 'llm',
        requiresConfirmation: true,
        createdAt: new Date().toISOString(),
      };
      const status = host.sessions.update(sessionId, {
        mode: 'action',
        trust: { level: 'review-required', label: 'Review required before mutation' },
        pendingAction,
      });
      host.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
      host.emit(sessionId, { type: 'status.updated', sessionId, status });
      logBridge('input.routed', { sessionId, route: 'action.review_required' });
      return { reviewRequired: true };
    }

    // Get or create conversation manager for this session
    let conversation = host.conversations.get(sessionId);
    if (!conversation) {
      conversation = new ConversationManager();
      conversation.startNewSession();
      host.conversations.set(sessionId, conversation);
    }

    // Record user message in conversation history
    conversation.appendMessage('user', input.text);

    // Step 2: Route via StudioAgent classification
    host.emit(sessionId, { type: 'response.started', sessionId });

    const routeStart = Date.now();
    const handleError = (err: unknown) => {
      const config = llm?.getConfig();
      host.emit(sessionId, host.errorEvent(sessionId, err, {
        provider: config?.baseUrl ? host.providerLabelFromBaseUrl(config.baseUrl) : undefined,
        model: config?.model,
        endpoint: config?.baseUrl,
      }));
    };

    const emitSessionTurn = (delegatedTo: string, responseContent?: string, extras?: { executor?: TuiRunExecutor; artifactRefs?: string[]; taskRefs?: string[] }) => {
      const turnId = `turn-${Date.now()}`;
      const durationMs = Date.now() - routeStart;
      host.emit(sessionId, {
        type: 'session.turn',
        sessionId,
        turnId,
        intent: classification.intent,
        delegatedTo,
        durationMs,
        ...extras,
      });

      // Record turn in session graph
      const graph = host.sessionGraphs.get(sessionId);
      if (graph) {
        graph.recordTurn({
          turnId,
          input: input.text,
          intent: classification.intent,
          delegatedTo,
          response: responseContent ?? '',
          durationMs,
          artifactRefs: extras?.artifactRefs,
          taskRefs: extras?.taskRefs,
        });
      }
    };

    if (!llm) {
      // Fallback: echo without LLM
      host.emit(sessionId, { type: 'response.delta', sessionId, delta: input.text });
      host.emit(sessionId, { type: 'response.completed', sessionId, content: input.text });
      host.emit(sessionId, { type: 'response.committed', sessionId, content: input.text });
      conversation.appendMessage('assistant', input.text);
      emitSessionTurn('echo', input.text);
      host.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: host.sessions.update(sessionId, {
          mode: input.mode,
          activeTask: input.text.slice(0, 60),
        }),
      });
      return { reviewRequired: false };
    }

    // Route based on StudioAgent intent classification
    // Autonomy gating: check if the action kind requires review at current level
    switch (classification.intent) {
      case 'creative': {
        const intentBrief = buildCreativeIntentBrief(input.text);
        emitIntentBrief(host.intentCtx, sessionId, intentBrief);
        emitReasoningTrace(host.intentCtx, sessionId, {
          phase: 'analysis',
          thought: intentBrief.shouldClarify
            ? 'Prompt is underspecified; asking for missing requirements before generation.'
            : 'Prompt has enough concrete intent to prepare generation.',
          detail: intentBrief.requirements.join(' | '),
          source: 'harness',
        });
        if (intentBrief.shouldClarify) {
          emitCreativeClarification(host.intentCtx, sessionId, intentBrief, conversation);
          emitSessionTurn('clarification', intentBrief.questions.join('\n'));
          break;
        }

        if (input.clientIntent === 'creative') {
          logBridge('input.routed', { sessionId, route: 'workbench.creative', confidence: classification.confidence });
          const useRetiredTestSeam = process.env.NODE_ENV === 'test'
            && Boolean(getRetiredDraftTestAdapter()) && !host.productCreateCommand;
          const runCreative = useRetiredTestSeam
            ? host.streamDraftGeneration(sessionId, input.text, conversation, llm, input)
            : host.streamGovernedProductCreate(sessionId, input.text, conversation, input);
          runCreative
            .then(() => emitSessionTurn(useRetiredTestSeam ? 'draft-generator' : 'product-command'))
            .catch(handleError);
          break;
        }

        const actionKind = 'creative' as const;
        if (host.autonomyController.requiresReview(actionKind, sessionId)) {
          const pendingAction: TuiPendingAction = {
            id: `action-${Date.now()}`,
            title: input.text.slice(0, 60),
            description: `Creative: ${input.text}`,
            prompt: input.text,
            route: 'creative',
            kind: 'llm',
            requiresConfirmation: true,
            createdAt: new Date().toISOString(),
            ...(input.creativePreferences || input.guidanceAnswers
              ? { creativeOptions: { creativePreferences: input.creativePreferences, guidanceAnswers: input.guidanceAnswers } }
              : {}),
          };
          const status = host.sessions.update(sessionId, {
            mode: 'action',
            trust: { level: 'review-required', label: `Autonomy: ${host.autonomyController.getConfig(sessionId).label} — creative needs review` },
            pendingAction,
          });
          host.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
          host.emit(sessionId, { type: 'status.updated', sessionId, status });
          return { reviewRequired: true };
        }
        logBridge('input.routed', { sessionId, route: 'studio.creative', confidence: classification.confidence });
        host.streamGovernedProductCreate(sessionId, input.text, conversation, input)
          .then(() => emitSessionTurn('product-command'))
          .catch(handleError);
        break;
      }

      case 'engineering': {
        const actionKind = 'engineering' as const;
        if (host.autonomyController.requiresReview(actionKind, sessionId)) {
          const pendingAction: TuiPendingAction = {
            id: `action-${Date.now()}`,
            title: input.text.slice(0, 60),
            description: `Engineering: ${input.text}`,
            prompt: input.text,
            route: 'engineering',
            kind: 'structured',
            requiresConfirmation: true,
            createdAt: new Date().toISOString(),
          };
          const status = host.sessions.update(sessionId, {
            mode: 'action',
            trust: { level: 'review-required', label: `Autonomy: ${host.autonomyController.getConfig(sessionId).label} — engineering needs review` },
            pendingAction,
          });
          host.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
          host.emit(sessionId, { type: 'status.updated', sessionId, status });
          return { reviewRequired: true };
        }
        logBridge('input.routed', { sessionId, route: 'studio.engineering', confidence: classification.confidence });
        host.streamEngineeringTask(sessionId, input.text, conversation, llm)
          .then(() => emitSessionTurn('engineering-agent', undefined, { executor: 'llm-mode-agent' }))
          .catch(handleError);
        break;
      }

      case 'hybrid': {
        const actionKind = 'engineering' as const;
        if (host.autonomyController.requiresReview(actionKind, sessionId)) {
          const pendingAction: TuiPendingAction = {
            id: `action-${Date.now()}`,
            title: input.text.slice(0, 60),
            description: `Hybrid: ${input.text}`,
            prompt: input.text,
            route: 'hybrid',
            kind: 'llm',
            requiresConfirmation: true,
            createdAt: new Date().toISOString(),
          };
          const status = host.sessions.update(sessionId, {
            mode: 'action',
            trust: { level: 'review-required', label: `Autonomy: ${host.autonomyController.getConfig(sessionId).label} — hybrid needs review` },
            pendingAction,
          });
          host.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
          host.emit(sessionId, { type: 'status.updated', sessionId, status });
          return { reviewRequired: true };
        }
        logBridge('input.routed', { sessionId, route: 'studio.hybrid', confidence: classification.confidence });
        host.streamHybridTask(sessionId, input.text, conversation, llm, input)
          .then(() => emitSessionTurn('product-command', undefined,
            { executor: 'product-command' }))
          .catch(handleError);
        break;
      }

      case 'direct':
      default:
        logBridge('input.routed', { sessionId, route: 'studio.direct', confidence: classification.confidence });
        host.streamDirectChat(sessionId, input.text, conversation, llm)
          .then(() => emitSessionTurn('llm-chat'))
          .catch(handleError);
        break;
    }

    return { reviewRequired: false };
  }

// eslint-disable-next-line @typescript-eslint/require-await
export async function confirmAction(host: TuiBridgeService, sessionId: string, actionId: string, llm?: LLMClient): Promise<void> {
    const currentStatus = host.getStatus(sessionId);
    if (!currentStatus.pendingAction || currentStatus.pendingAction.id !== actionId) {
      throw new Error(`Pending action ${actionId} not found`);
    }
    const pendingAction = currentStatus.pendingAction;
    const nextStatus = host.sessions.update(sessionId, {
      mode: 'confirm',
      pendingAction: undefined,
      trust: { level: 'confirmed', label: 'Operator confirmed mutation' },
    });
    host.emit(sessionId, { type: 'action.confirmed', sessionId, actionId });
    host.emit(sessionId, { type: 'status.updated', sessionId, status: nextStatus });

    if (!llm) return;

    const approvedText = (pendingAction.prompt ?? pendingAction.description.replace(/^(Operator|Engineering|Hybrid|Creative):\s*/i, '')).trim();
    if (!approvedText) return;
    const route = pendingAction.route ?? host.inferPendingActionRoute(pendingAction.description);

    let conversation = host.conversations.get(sessionId);
    if (!conversation) {
      conversation = new ConversationManager();
      conversation.startNewSession();
      host.conversations.set(sessionId, conversation);
    }

    host.emit(sessionId, { type: 'response.started', sessionId });
    const routeStart = Date.now();
    const runApproved = route === 'creative'
      ? host.streamGovernedProductCreate(sessionId, approvedText, conversation, pendingAction.creativeOptions ?? {})
      : route === 'hybrid'
        ? host.streamHybridTask(sessionId, approvedText, conversation, llm)
        : host.streamEngineeringTask(sessionId, approvedText, conversation, llm);

    runApproved
      .then(() => {
        host.emit(sessionId, {
          type: 'session.turn',
          sessionId,
          turnId: `turn-${Date.now()}`,
          intent: route === 'creative' ? 'creative' : route === 'hybrid' ? 'hybrid' : 'engineering',
          delegatedTo: route === 'creative' ? 'product-command'
            : route === 'hybrid' ? 'product-command' : 'engineering-agent',
          executor: route === 'creative' || route === 'hybrid'
            ? 'product-command' : 'llm-mode-agent',
          durationMs: Date.now() - routeStart,
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        host.emit(sessionId, { type: 'activity.updated', sessionId, message: `Task failed: ${message}` });
        host.emit(sessionId, {
          type: 'error',
          sessionId,
          message,
        });
      });
  }

export function inferPendingActionRoute(_host: TuiBridgeService, description: string): NonNullable<TuiPendingAction['route']> {
    if (/^Creative:/i.test(description)) return 'creative';
    if (/^Hybrid:/i.test(description)) return 'hybrid';
    return 'engineering';
  }

export function cancelAction(host: TuiBridgeService, sessionId: string, actionId: string): void {
    const currentStatus = host.getStatus(sessionId);
    if (!currentStatus.pendingAction || currentStatus.pendingAction.id !== actionId) {
      throw new Error(`Pending action ${actionId} not found`);
    }
    const nextStatus = host.sessions.update(sessionId, {
      mode: 'chat',
      pendingAction: undefined,
      trust: { level: 'untrusted', label: 'Generated code is untrusted by default' },
    });
    host.emit(sessionId, { type: 'action.cancelled', sessionId, actionId });
    host.emit(sessionId, { type: 'status.updated', sessionId, status: nextStatus });
  }

export function cancelRun(host: TuiBridgeService, sessionId: string): void {
    host.cancelStream(sessionId);
    const status = host.sessions.get(sessionId);
    if (!status) {
      throw new Error(`Unknown TUI session: ${sessionId}`);
    }
    host.emit(sessionId, {
      type: 'generation.cancelled',
      sessionId,
      reason: 'operator-stop',
      cancelledAt: new Date().toISOString(),
      message: 'Generation stopped by operator.',
    });
    host.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
    host.emit(sessionId, {
      type: 'status.updated',
      sessionId,
      status: host.sessions.update(sessionId, {
        mode: 'chat',
        activeTask: 'Generation stopped',
      }),
    });
    host.failRun(sessionId, 'Generation stopped by operator.', 'cancelled');
  }

/**
 * Set the product mode for a session.
 * Emits mode.product_changed event for the TUI to render the mode badge.
 */
export function setProductMode(host: TuiBridgeService, sessionId: string, mode: ProductMode): ModeConfig {
    const config = host.modeRegistry.setMode(sessionId, mode);
    const modeInfo = PRODUCT_MODES[mode];

    logBridge('mode.changed', { sessionId, mode, label: modeInfo.label });

    host.emit(sessionId, {
      type: 'mode.product_changed',
      sessionId,
      mode,
      label: modeInfo.label,
      description: modeInfo.description,
    });

    return config;
  }
