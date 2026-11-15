/**
 * Extracted from TuiBridgeService.ts: the retired draft generation stream and best-of-N candidates.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { ConversationManager } from '../../chat/ConversationManager.js';
import { creativeThesisPromptContext } from '../../creative-intelligence/CreativeIntelligence.js';
import { GeneratorHarnessTools } from '../../generators/GeneratorHarnessTools.js';
import type { LLMClient } from '../../llm/LLMClient.js';
import { Logger } from '../../utils/Logger.js';
import { buildCreativeDomainRouteTruth } from '../CreativeDomainRouting.js';
import { buildCreativeIntentBrief, type CreativeIntentBrief, describeStrictDomainMismatch, domainCorrectionPrompt, emitCreativeClarification, emitCreativePreferenceGuidance, emitIntentBrief, emitPriorRunReceiptLink, emitReasoningTrace, promptForCreativeDomain, scoreContentAdherence } from '../CreativeIntentHelpers.js';
import { injectPreparedGeneration } from '../PostGenerationCognitiveWriter.js';
import { emitPreviewArtifacts } from '../PreviewService.js';
import { summarizeReasoningTrace } from '../TraceSummarizer.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { TuiInputRequest } from '../types.js';
import { creativeIdentityFields, logBridge } from './bridgeHelpers.js';
import { resolveDraftCandidateTimeoutMinutes } from './requestClassification.js';
import { getRetiredDraftTestAdapter, type RetiredDraftGenerator, type RetiredDraftResult } from './retiredDraftAdapter.js';

/** Retained only as an explicit fail-closed compatibility boundary. */
export async function streamDraftGeneration(host: TuiBridgeService, sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient, options: Pick<TuiInputRequest, 'maxIterations' | 'candidateCount' | 'minQualityScore' | 'timeoutMinutes' | 'creativePreferences' | 'guidanceAnswers' | 'idempotencyKey'> = {}): Promise<void> {
    if (!getRetiredDraftTestAdapter()) throw new Error('RETIRED_DRAFT_TEST_ADAPTER_REQUIRED');
    const controller = new AbortController();
    host.activeStreams.set(sessionId, controller);

    let config = llm.getConfig();
    const sessionStatus = host.sessions.get(sessionId);
    const coordinatorRun = host.startCreativeRun(
      sessionId,
      userText,
      config.baseUrl ? host.providerLabelFromBaseUrl(config.baseUrl) : sessionStatus?.provider,
      config.model,
      options.idempotencyKey,
    );
    const creativeThesis = host.requireCreativeThesis(coordinatorRun);
    const creativeIdentity = creativeIdentityFields(coordinatorRun);
    let effectiveModel = sessionStatus?.roles?.generator?.model || config.model || 'unknown';
    let resolvedEffectiveModel = false;
    const resolver = (llm as LLMClient & { resolveEffectiveModel?: () => Promise<string> }).resolveEffectiveModel;
    if (typeof resolver === 'function') {
      try {
        effectiveModel = await resolver.call(llm);
        config = llm.getConfig();
        resolvedEffectiveModel = true;
      } catch (err) {
        Logger.info('TuiBridgeService', `Effective model preflight failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const provider = config.baseUrl ? host.providerLabelFromBaseUrl(config.baseUrl) : sessionStatus?.provider || 'unknown';
    if (resolvedEffectiveModel) {
      host.publishResolvedGeneratorModel(sessionId, provider, config.baseUrl, effectiveModel);
    }
    const harnessModelName = resolvedEffectiveModel
      ? effectiveModel
      : sessionStatus?.roles?.harness?.model || config.model || 'unknown';
    const generatorModelName = resolvedEffectiveModel
      ? effectiveModel
      : sessionStatus?.roles?.generator?.model || harnessModelName;
    // Studio owns the operator-visible timeout; the bridge only bounds it so draft runs cannot hang forever.
    const timeoutMinutes = Math.min(30, Math.max(1, Number(options.timeoutMinutes) || 1));
    // Draft is best-of-N: the GUI asks for a few candidates and we keep the
    // strongest, so a single bad roll never reaches the canvas. Clamped to [1,3]
    // to bound parallel provider load on the fast-preview path.
    const candidateCount = Math.min(3, Math.max(1, Math.floor(Number(options.candidateCount)) || 1));
    const generationStartedAt = Date.now();
    const intentBrief = buildCreativeIntentBrief(userText);
    const run = host.beginRun(sessionId, {
      kind: 'creative',
      label: 'Creative draft queued',
      executionMode: 'draft',
      model: generatorModelName,
      provider,
      runId: coordinatorRun.rootRunId,
    });

    try {
      host.transitionRun(sessionId, 'planning', { label: 'Reading prompt and choosing draft route' });
      host.emit(sessionId, {
        type: 'activity.updated',
        sessionId,
        message: 'Generating a first artifact before quality scoring.',
      });
      emitIntentBrief(host.intentCtx, sessionId, intentBrief);
      emitReasoningTrace(host.intentCtx, sessionId, {
        phase: 'analysis',
        thought: 'Fast generation is prioritizing the first visible artifact before quality scoring.',
        detail: intentBrief.requirements.join(' | '),
        model: harnessModelName,
        source: 'harness',
      });

      if (intentBrief.shouldClarify) {
        emitCreativeClarification(host.intentCtx, sessionId, intentBrief, conversation);
        await host.finishCreativeRun(sessionId, 'failed');
        return;
      }

      const routeTruth = buildCreativeDomainRouteTruth(userText);
      const domainPlan = routeTruth.domains;
      emitCreativePreferenceGuidance(host.intentCtx, sessionId, userText, routeTruth.selectedDomain);
      host.emit(sessionId, {
        type: 'generation.route.selected',
        sessionId,
        domain: routeTruth.selectedDomain,
        domains: domainPlan,
        requestedDomain: routeTruth.requestedDomain,
        selectedDomain: routeTruth.selectedDomain,
        promptDomainLocked: routeTruth.promptDomainLocked,
        source: routeTruth.source,
        startedAt: new Date(generationStartedAt).toISOString(),
        timeoutMinutes,
        candidateCount,
        executionMode: 'draft',
      });
      host.emitDomainTruth(sessionId, routeTruth);
      emitPriorRunReceiptLink(host.intentCtx, sessionId, options);
      const lineageReady = host.cognitiveWriter.beginGenerationLineage({
        lineageId: run.runId,
        sessionId,
        userText,
        domain: routeTruth.selectedDomain,
        executionMode: 'draft',
      });
      const memoryReceiptsPromise = lineageReady.then(() =>
        host.cognitiveWriter.prepareGeneration({
          sessionId,
          lineageId: run.runId,
          userText,
          domain: routeTruth.selectedDomain,
        })
      );
      host.emit(sessionId, {
        type: 'generation.domain_plan',
        sessionId,
        domains: domainPlan,
        requestedDomain: routeTruth.requestedDomain,
        selectedDomain: routeTruth.selectedDomain,
        promptDomainLocked: routeTruth.promptDomainLocked,
        source: routeTruth.source,
        startedAt: new Date(generationStartedAt).toISOString(),
        timeoutMinutes,
        candidateCount,
        executionMode: 'draft',
      });
      void memoryReceiptsPromise.then((memoryPreparation) => {
        host.emit(sessionId, {
          type: 'generation.cognitive_receipt',
          sessionId,
          lineageId: run.runId,
          loop: 'creative',
          receipts: [
            { organ: 'perception', status: 'observed', detail: `Captured ${intentBrief.requirements.length} requirement(s) from the prompt.` },
            { organ: 'intuition', status: 'observed', detail: `Generation route selected ${domainPlan.join(' -> ')}.` },
            ...memoryPreparation.receipts,
            { organ: 'evaluation', status: 'pending', detail: 'Quality scoring is deferred until the artist asks to polish.' },
          ],
        });
      }).catch((error) => {
        Logger.warn('TuiBridgeService', `Lineage memory receipt failed for ${run.runId}:`, error);
      });

      let result: RetiredDraftResult | undefined;
      let activeDomain = domainPlan[0];
      let lastError: unknown;
      const priorArtifactExcerpt = options.creativePreferences?.priorRunReceipt != null
        ? await host.resolvePriorArtifactExcerpt(options.creativePreferences.priorRunReceipt)
        : undefined;

      for (let attempt = 0; attempt < domainPlan.length; attempt++) {
        const attemptStartedAt = Date.now();
        const domain = domainPlan[attempt];
        activeDomain = domain;
        const baseAttemptPrompt = `${promptForCreativeDomain(userText, domain, attempt > 0, intentBrief, {
          ...options,
          priorArtifactExcerpt,
        })}\n\n${creativeThesisPromptContext(creativeThesis)}`;
        const preparation = host.cognitiveWriter.getPreparedGeneration(domain, sessionId);
        const preparedRequest = injectPreparedGeneration(baseAttemptPrompt, preparation);
        const requestReceiptReady = host.cognitiveWriter.recordGeneratorRequest({
          lineageId: run.runId,
          preparation,
          request: preparedRequest,
        });
        const attemptPrompt = preparedRequest.prompt;
        void requestReceiptReady.then((requestReceipt) => {
          host.emit(sessionId, {
            type: 'generation.cognitive_receipt',
            sessionId,
            lineageId: run.runId,
            loop: 'creative',
            receipts: [requestReceipt],
          });
        }).catch((error) => {
          Logger.warn('TuiBridgeService', `Generator request receipt failed for ${run.runId}:`, error);
        });

        host.emit(sessionId, {
          type: 'generation.attempt.started',
          sessionId,
          domain,
          attempt: attempt + 1,
          attemptTotal: domainPlan.length,
          startedAt: new Date(attemptStartedAt).toISOString(),
          timeoutMinutes,
          candidateCount,
          executionMode: 'draft',
        });
        host.transitionRun(sessionId, 'generating', {
          label: `Generating ${domain} draft`,
          model: generatorModelName,
          provider,
        });
        emitReasoningTrace(host.intentCtx, sessionId, {
          phase: 'generation',
          thought: `Calling ${generatorModelName} for a fast ${domain} generation.`,
          detail: 'Fast generation skips evaluator scoring and repair so preview can appear immediately.',
          model: generatorModelName,
          source: 'harness',
        });

        try {
          const orchestrator = getRetiredDraftTestAdapter()!.create(domain);
          // Best-of-N: fire candidateCount generations in parallel and keep the
          // strongest by the retired static draft path,
          // so a broken or truncated roll never reaches the canvas.
          // K3 needs its proven five-minute Wave 4 generation window; other
          // models retain the three-minute fast-path cap.
          const draftCandidateTimeoutMinutes = resolveDraftCandidateTimeoutMinutes(
            timeoutMinutes,
            generatorModelName,
          );
          const best = await host.generateBestDraftCandidate(
            orchestrator,
            attemptPrompt,
            domain,
            candidateCount,
            controller,
            generatorModelName,
            sessionId,
            draftCandidateTimeoutMinutes,
            intentBrief.userRequest,
          );
          let attemptResult = best.result;
          if (best.stopped || !attemptResult) {
            host.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
            return;
          }
          if (attemptResult.needsClarification) {
            const clarificationBrief: CreativeIntentBrief = {
              userRequest: intentBrief.userRequest,
              requirements: intentBrief.requirements,
              missingDetails: intentBrief.missingDetails,
              questions: attemptResult.clarifyingQuestions.map((question) => question.question),
              shouldClarify: true,
              reason: `Generation needs clarification for ${domain}.`,
            };
            emitCreativeClarification(host.intentCtx, sessionId, clarificationBrief, conversation);
            await host.finishCreativeRun(sessionId, 'failed');
            return;
          }
          if (!attemptResult.code?.trim()) {
            throw new Error('Generation produced no code');
          }
          if (controller.signal.aborted) {
            host.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
            return;
          }
          const mismatch = describeStrictDomainMismatch(attemptResult.code, domain, domainPlan);
          if (mismatch) {
            host.emit(sessionId, {
              type: 'activity.updated',
              sessionId,
              message: `${mismatch}; retrying ${domain} without changing domains.`,
            });
            host.transitionRun(sessionId, 'repairing', {
              label: `Repairing ${domain} domain mismatch`,
              model: generatorModelName,
              provider,
            });
            const correctionPrompt = domainCorrectionPrompt(attemptPrompt, domain, mismatch);
            const retryController = new AbortController();
            const unlinkRetryAbort = host.linkDraftAttemptToRun(controller.signal, retryController);
            const retryPromise = orchestrator.generate(correctionPrompt, correctionPrompt, true, retryController.signal);
            retryPromise.catch((err) => {
              if (!retryController.signal.aborted) {
                const message = err instanceof Error ? err.message : String(err);
                logBridge('generation.draft.domain_retry_failed', { sessionId, generatorModel: generatorModelName, message });
              }
            });
            let retryResult: RetiredDraftResult | undefined;
            try {
              retryResult = await host.awaitDraftAttempt(retryPromise, controller, retryController, timeoutMinutes);
            } finally {
              unlinkRetryAbort();
            }
            if (!retryResult) {
              host.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
              return;
            }
            if (retryResult.needsClarification) {
              attemptResult = retryResult;
            } else if (retryResult.code?.trim()) {
              attemptResult = retryResult;
            }
          }
          if (attemptResult.needsClarification) {
            const clarificationBrief: CreativeIntentBrief = {
              userRequest: intentBrief.userRequest,
              requirements: intentBrief.requirements,
              missingDetails: intentBrief.missingDetails,
              questions: attemptResult.clarifyingQuestions.map((question) => question.question),
              shouldClarify: true,
              reason: `Generation needs clarification for ${domain}.`,
            };
            emitCreativeClarification(host.intentCtx, sessionId, clarificationBrief, conversation);
            await host.finishCreativeRun(sessionId, 'failed');
            return;
          }
          const retryMismatch = describeStrictDomainMismatch(attemptResult.code, domain, domainPlan);
          if (retryMismatch) throw new Error(retryMismatch);
          if (attemptResult.thinking) {
            const summary = summarizeReasoningTrace(attemptResult.thinking, 'generator');
            emitReasoningTrace(host.intentCtx, sessionId, {
              source: 'generator',
              phase: 'generator-thinking',
              thought: summary.summary,
              detail: summary.details.join(' | ') || attemptResult.thinking.slice(0, 600),
              model: attemptResult.model || generatorModelName,
            });
          }
          result = attemptResult;
          break;
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : String(err);
          const nextDomain = domainPlan[attempt + 1];
          host.emit(sessionId, {
            type: 'generation.attempt.failed',
            sessionId,
            domain,
            attempt: attempt + 1,
            attemptTotal: domainPlan.length,
            error: message,
            duration: Date.now() - attemptStartedAt,
            ...host.failureProvenance(err, { provider, model: generatorModelName }),
          });
          host.emit(sessionId, {
            type: 'activity.updated',
            sessionId,
            message: nextDomain
              ? `${domain} did not finish: ${message}. Trying ${nextDomain} next.`
              : `${domain} did not finish: ${message}. No backup medium completed, so recovery choices are available.`,
          });
          host.transitionRun(sessionId, 'repairing', {
            label: nextDomain ? `Trying ${nextDomain} after ${domain} draft failure` : `Recovery needed after ${domain} draft failure`,
            model: generatorModelName,
            provider,
          });
          if (controller.signal.aborted) throw err;
        }
      }

      if (!result || result.needsClarification) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'All generation attempts failed'));
      }

      host.emit(sessionId, { type: 'response.delta', sessionId, delta: result.code });
      host.emit(sessionId, { type: 'response.completed', sessionId, content: result.code });
      host.emit(sessionId, { type: 'response.committed', sessionId, content: result.code });
      host.emit(sessionId, {
        type: 'response.metadata',
        sessionId,
        model: result.model || generatorModelName,
        duration: Date.now() - generationStartedAt,
      });

      const codeContent = host.extractCodeContent(result.code);
      if (codeContent) {
        host.emit(sessionId, { type: 'preview.started', sessionId, previewType: 'code' });
        host.emit(sessionId, { type: 'preview.content', sessionId, content: codeContent, previewType: 'code', ...creativeIdentity });
      }

      conversation.appendMessage('assistant', `Generated artifact ready:\n\n${result.code}`);
      host.emit(sessionId, {
        type: 'generation.complete',
        sessionId,
        iterations: 1,
        finalScore: 0,
        duration: Date.now() - generationStartedAt,
        model: result.model || generatorModelName,
        reason: 'generated artifact ready (unscored)',
        qualityState: 'unscored',
        executionMode: 'draft',
        ...creativeIdentity,
      });
      await lineageReady;
      const writeBack = await host.cognitiveWriter.writeBackGeneration({
        sessionId,
        lineageId: run.runId,
        userText,
        domain: activeDomain,
        code: result.code,
        finalScore: 0,
        iterations: 1,
        model: result.model || generatorModelName,
        reason: 'generated artifact ready (unscored)',
        executionMode: 'draft',
        evaluationStatus: 'unavailable',
        evaluationDetail: 'Initial generation intentionally did not run evaluator scoring.',
      });
      host.registerOwnerArtifact(sessionId, run.runId, writeBack);
      host.emit(sessionId, {
        type: 'generation.cognitive_receipt',
        sessionId,
        lineageId: run.runId,
        loop: 'creative',
        receipts: [
          { organ: 'perception', status: 'observed', detail: 'Prompt and generated artifact were captured in the session transcript.' },
          { organ: 'intuition', status: 'observed', detail: `Generation route completed through ${activeDomain}.` },
          { organ: 'evaluation', status: 'unavailable', detail: 'Initial generation intentionally did not run evaluator scoring.' },
          { organ: 'immune-truth', status: 'observed', detail: 'Initial artifact is labeled unscored instead of presented as finished output.' },
          ...writeBack.receipts,
        ],
      });
      host.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: host.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: 'Generated artifact ready',
          model: result.model || generatorModelName,
        }),
      });
      host.transitionRun(sessionId, 'rendering', {
        label: 'Rendering draft preview artifact',
        model: result.model || generatorModelName,
        provider,
      });
      await emitPreviewArtifacts(host.previewCtx, sessionId, result.code, activeDomain, routeTruth, creativeThesis);
      host.completeRun(sessionId, {
        label: 'Creative draft complete',
        model: result.model || generatorModelName,
        provider,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const provenance = host.failureProvenance(err, { provider, model: generatorModelName, endpoint: config.baseUrl });
      host.emit(sessionId, {
        type: 'activity.updated',
        sessionId,
        message: `Generation stopped before a usable artifact: ${message}. Try again, polish safely, or switch medium.`,
      });
      host.failRun(sessionId, message, 'failed', {
        label: 'Creative draft needs recovery',
        model: generatorModelName,
        provider,
        ...(typeof provenance.retryable === 'boolean' ? { retryable: provenance.retryable } : {}),
      });
      throw err;
    } finally {
      host.activeStreams.delete(sessionId);
    }
  }

/**
 * Draft best-of-N. Fires `candidateCount` generations of the same domain in
 * Historical draft helper; unreachable after governed Create retirement.
 * deliberately skips the slow, paid vision evaluator, so selection is a free
 * heuristic — its job is to drop the broken/truncated roll, not to pick the
 * prettiest (that is Polish's job via the real evaluator). Behaviour for
 * candidateCount === 1 is identical to a single generate call. Failure modes
 * fall through to the caller's existing handling: a clarification result still
 * surfaces, an all-rejected batch rethrows so the next fallback domain runs,
 * and an operator stop returns `{ stopped: true }`.
 */
export async function generateBestDraftCandidate(host: TuiBridgeService, orchestrator: RetiredDraftGenerator, prompt: string, domain: string, candidateCount: number, runController: AbortController, generatorModelName: string, sessionId: string, timeoutMinutes: number, userRequest: string = ''): Promise<{ result: RetiredDraftResult | undefined; stopped: boolean }> {
    void domain;
    const n = Math.min(3, Math.max(1, Math.floor(candidateCount) || 1));
    // Once one candidate is usable, wait at most this long for the rest before
    // proceeding with the best-so-far — so a stalled provider call can't hold the
    // whole batch hostage when we already have a good artifact to show.
    const DRAFT_STRAGGLER_GRACE_MS = 7000;
    // Spread the candidates with the SAME diversity prompting the prove path uses
    // (RalphLoop), so best-of-N selects among genuinely different attempts instead
    // of near-clones that differ only by sampling temperature.
    const harnessTools = new GeneratorHarnessTools({ seededRandom: Math.random });
    const attemptControllers: AbortController[] = [];
    const runOne = async (index: number) => {
      const candidatePrompt = n > 1 ? harnessTools.buildDiversityPrompt(prompt, index, n) : prompt;
      const attemptController = new AbortController();
      attemptControllers[index] = attemptController;
      const unlink = host.linkDraftAttemptToRun(runController.signal, attemptController);
      const generationPromise = orchestrator.generate(candidatePrompt, candidatePrompt, true, attemptController.signal);
      generationPromise.catch((err) => {
        if (!attemptController.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          logBridge('generation.draft.background_failed', { sessionId, generatorModel: generatorModelName, message });
        }
      });
      try {
        return await host.awaitDraftAttempt(generationPromise, runController, attemptController, timeoutMinutes);
      } finally {
        unlink();
      }
    };

    if (n === 1) {
      const result = await runOne(0);
      return { result, stopped: result === undefined && runController.signal.aborted };
    }

    type DraftResult = RetiredDraftResult;
    const isUsable = (r: DraftResult | undefined): r is Extract<DraftResult, { needsClarification: false }> =>
      r !== undefined && !r.needsClarification && Boolean(r.code?.trim());

    // Best-of-N must NOT block on a straggler. Promise.allSettled waited for the
    // SLOWEST candidate, so one stalled provider call (parallel requests the model
    // queues server-side) held the whole batch for the full per-candidate timeout
    // — the user saw "still working" for minutes even when other candidates had
    // already succeeded. Instead: collect candidates as they land; once one is
    // usable, give the rest a short grace, then proceed with the best so far.
    const results: (DraftResult | undefined)[] = [];
    let firstRejection: unknown;
    const tasks = Array.from({ length: n }, (_, index) =>
      runOne(index).then(
        (r) => { results.push(r); },
        (err) => { if (firstRejection === undefined) firstRejection = err; },
      ),
    );
    await new Promise<void>((resolve) => {
      let finished = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let pending = n;
      const finish = () => { if (!finished) { finished = true; if (grace) clearTimeout(grace); resolve(); } };
      for (const task of tasks) {
        void task.then(() => {
          pending -= 1;
          if (pending === 0) finish();
          else if (!grace && results.some(isUsable)) grace = setTimeout(finish, DRAFT_STRAGGLER_GRACE_MS);
        });
      }
    });

    // Abandon any stragglers still in flight so they stop occupying the provider.
    if (!runController.signal.aborted) {
      for (const c of attemptControllers) if (c && !c.signal.aborted) c.abort();
    }
    if (runController.signal.aborted) return { result: undefined, stopped: true };

    // Prefer fully-generated candidates and keep the highest-scoring one. Score
    // Historical ordering is retained only for restart-compatible source shape;
    // among candidates of comparable quality the one that better honors what the
    // user asked for wins — without letting a noisy adherence signal override a
    // clearly better artifact.
    const defined = results.filter((r): r is DraftResult => r !== undefined);
    const generated = defined.filter(isUsable);
    if (generated.length > 0) {
      const scoreOf = (code: string) =>
        (getRetiredDraftTestAdapter()?.score(code, domain) ?? 0)
          + (userRequest ? 0.1 * scoreContentAdherence(code, userRequest) : 0);
      let best = generated[0];
      let bestScore = scoreOf(best.code);
      for (let i = 1; i < generated.length; i++) {
        const candidateScore = scoreOf(generated[i].code);
        if (candidateScore > bestScore) {
          best = generated[i];
          bestScore = candidateScore;
        }
      }
      return { result: best, stopped: false };
    }

    // No usable candidate: surface a clarification if one came back, else the
    // first result (carries the error), else rethrow so the caller falls back.
    const clarify = defined.find((r) => r.needsClarification);
    if (clarify) return { result: clarify, stopped: false };
    if (defined.length > 0) return { result: defined[0], stopped: false };
    if (firstRejection !== undefined) throw firstRejection;
    return { result: undefined, stopped: runController.signal.aborted };
  }

export async function awaitDraftAttempt<T>(_host: TuiBridgeService, generationPromise: Promise<T>, runController: AbortController, attemptController: AbortController, timeoutMinutes: number): Promise<T | undefined> {
    const runSignal = runController.signal;
    if (runSignal.aborted) return undefined;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = () => {};
    const interruptPromise = new Promise<undefined>((resolve, reject) => {
      const onAbort = () => resolve(undefined);
      runSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => runSignal.removeEventListener('abort', onAbort);
      timeoutId = setTimeout(() => {
        const timeoutError = new Error(`Generation timed out after ${timeoutMinutes} minute${timeoutMinutes === 1 ? '' : 's'}`);
        attemptController.abort(timeoutError);
        reject(timeoutError);
        // Attempt timeouts fail only this candidate. Stop still uses the run
        // controller, while this abort prevents stale local model calls from
        // occupying the provider after the UI has moved to recovery/fallback.
      }, timeoutMinutes * 60_000);
    });

    try {
      return await Promise.race([generationPromise, interruptPromise]);
    } finally {
      removeAbortListener();
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

export function linkDraftAttemptToRun(_host: TuiBridgeService, runSignal: AbortSignal, attemptController: AbortController): () => void {
    if (runSignal.aborted) {
      attemptController.abort(runSignal.reason);
      return () => {};
    }
    const onAbort = () => attemptController.abort(runSignal.reason);
    runSignal.addEventListener('abort', onAbort, { once: true });
    return () => runSignal.removeEventListener('abort', onAbort);
  }
