/**
 * Extracted from TuiBridgeService.ts: the governed product create stream.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { ConversationManager } from '../../chat/ConversationManager.js';
import { buildCreativeDomainRouteTruth } from '../CreativeDomainRouting.js';
import { buildCreativeIntentBrief, emitCreativePreferenceGuidance, emitPriorRunReceiptLink, promptForCreativeDomain } from '../CreativeIntentHelpers.js';
import { emitPreviewArtifacts } from '../PreviewService.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { TuiInputRequest } from '../types.js';
import { parseLoopsFlag, runGovernedLoops } from '../../cli/LiminalProductionLoops.js';

/**
 * Studio's quality label (Sol L3-12): a verdict the judge really gave (even a rejection below the admission
 * floor) is "scored"; only a missing or unusable verdict is "unscored"/"degraded". Rejection is not degradation.
 */
export function studioQualityState(evaluation: { scoreState?: 'unscored'; degraded: boolean; identityValid: boolean; admissionEligible: boolean }):
  'scored' | 'unscored' | 'degraded' {
  if (evaluation.scoreState === 'unscored') return 'unscored';
  if (evaluation.degraded || !evaluation.identityValid) return 'degraded';
  return 'scored';
}

export async function streamGovernedProductCreate(host: TuiBridgeService, sessionId: string, userText: string, conversation: ConversationManager, options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers' | 'loops'> = {}): Promise<void> {
    if (!host.productCreateCommand) throw new Error('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    const route = buildCreativeDomainRouteTruth(userText);
    emitCreativePreferenceGuidance(host.intentCtx, sessionId, userText, route.selectedDomain);
    emitPriorRunReceiptLink(host.intentCtx, sessionId, options);
    host.beginRun(sessionId, { kind: 'creative', label: 'Governed Create queued',
      executionMode: 'prove', executor: 'product-command' });
    try {
      host.transitionRun(sessionId, 'planning', { label: 'Minting governed Product Create' });
      host.emit(sessionId, { type: 'generation.route.selected', sessionId,
        domain: route.selectedDomain, domains: route.domains,
        requestedDomain: route.requestedDomain, selectedDomain: route.selectedDomain,
        promptDomainLocked: route.promptDomainLocked, source: route.source,
        startedAt: new Date().toISOString(), timeoutMinutes: 3, candidateCount: 1,
        executionMode: 'prove' });
      const priorArtifactExcerpt = options.creativePreferences?.priorRunReceipt != null
        ? await host.resolvePriorArtifactExcerpt(options.creativePreferences.priorRunReceipt)
        : undefined;
      const providerPrompt = promptForCreativeDomain(userText, route.selectedDomain,
        false, buildCreativeIntentBrief(userText), { ...options, priorArtifactExcerpt });
      const createOnce = async (prompt: string, maximum = 2) => {
        const command = await host.productCreateCommand!({ prompt,
          domain: route.selectedDomain, layers: [`${route.selectedDomain}-composition`],
          maxTransportAttempts: maximum });
        host.transitionRun(sessionId, 'generating', { label: 'Executing governed Product Create' });
        const created = await host.productCommandPort().submitCreate('studio', command);
        if (created.kind !== 'create') throw new Error('LIMINAL_STUDIO_CREATE_INVALID');
        return { projection: created, artifact: await host.productCommandPort().verifiedArtifact(command.idempotencyKey) };
      };
      // Improvement loops (same module as `generate --loops`): each loop is its own governed Create; loop k+1 edits loop k
      // using its accepted code and the judge's critique. No run folder here, so the carry is in memory.
      const loopCount = options.loops === undefined ? 1 : parseLoopsFlag(options.loops);
      let created: Awaited<ReturnType<typeof createOnce>>;
      if (loopCount > 1) {
        const run = await runGovernedLoops({ request: providerPrompt, domain: route.selectedDomain, loops: loopCount,
          providerCallsPerLoop: 2, log: (line) => host.emit(sessionId, { type: 'activity.updated', sessionId, message: line }),
          generateOne: async ({ prompt, providerCallsMaximum }) => {
            const one = await createOnce(prompt, providerCallsMaximum);
            const ev = one.projection.result.evaluation;
            const real = ev.admissionEligible === true;
            return { score: real ? ev.score : null, critique: ev.reasoning ?? '',
              providerCalls: one.projection.result.attempts.consumed, model: one.projection.result.roles.generator, payload: one,
              prior: { source: one.artifact.source, score: real ? ev.score : null, critique: ev.reasoning ?? '',
                rejectionReasons: [...(ev.rejectionReasons ?? [])], frames: [], artifactDirectory: '' } };
          } });
        if (!run.best) throw new Error('LOOPS_NO_SCORED_ARTIFACT: no loop produced a scored artifact');
        host.emit(sessionId, { type: 'activity.updated', sessionId,
          message: `Loops: ${run.manifest.records.map((r) => `r${r.loop}=${r.status === 'failed' ? 'FAILED' : r.score === null ? 'unscored' : r.score.toFixed(2)}${r.best ? '*' : ''}`).join(' ')} (* best)` });
        created = run.best.payload as typeof created;
      } else {
        created = await createOnce(providerPrompt);
      }
      const { projection, artifact } = created;
      host.emit(sessionId, { type: 'response.delta', sessionId, delta: artifact.source });
      host.emit(sessionId, { type: 'response.completed', sessionId, content: artifact.source });
      host.emit(sessionId, { type: 'response.committed', sessionId, content: artifact.source });
      const evaluation = projection.result.evaluation;
      const qualityState = studioQualityState(evaluation);
      const failureClasses = ['none', 'render', 'validator', 'parse', 'scorer',
        'infra', 'legacy'] as const;
      const failureClass = failureClasses.includes(evaluation.failureClass as never)
        ? evaluation.failureClass as typeof failureClasses[number]
        : evaluation.admissionEligible ? 'none' : 'infra';
      host.emit(sessionId, { type: 'generation.reasoning_trace', sessionId,
        phase: 'generation', source: 'generator', model: projection.result.roles.generator,
        thought: `Generated by ${projection.result.roles.generator} through governed Product Create.` });
      host.emit(sessionId, { type: 'generation.reasoning_trace', sessionId,
        phase: 'evaluation', source: 'evaluator', model: projection.result.roles.evaluator,
        thought: `Rendered evidence evaluated by ${projection.result.roles.evaluator}.`,
        detail: evaluation.admissionEligible ? 'admission-eligible' : 'admission-ineligible' });
      host.emit(sessionId, { type: 'generation.complete', sessionId, iterations: 1,
        finalScore: projection.result.evaluation.score, duration: 0,
        model: projection.result.roles.generator, reason: 'governed-product-create',
        qualityState, executionMode: 'prove',
        evaluationConfidence: evaluation.confidence
          ?? (evaluation.admissionEligible ? 1 : 0), evaluationFailureClass: failureClass });
      host.emit(sessionId, { type: 'generation.cognitive_receipt', sessionId,
        lineageId: projection.result.lineageId, loop: 'creative', receipts: [
          { organ: 'evaluation', status: evaluation.admissionEligible ? 'observed' : 'unavailable',
            detail: evaluation.admissionEligible
              ? `Verified rendered evaluation admitted from ${evaluation.evaluatorIdentity}.`
              : qualityState === 'scored'
                ? `Rendered evaluation scored ${evaluation.score.toFixed(2)} and was not admitted: ${evaluation.rejectionReasons.join(', ') || 'below the admission floor'}.`
                : `Rendered evaluation unavailable for admission (${failureClass}): ${evaluation.unscoredReason ?? (evaluation.rejectionReasons.join(', ') || 'ineligible')}.` },
          { organ: 'immune-truth', status: 'observed', detail: evaluation.admissionEligible
            ? 'Verified rendered scored output from the governed Product Create projection.'
            : qualityState === 'scored'
              ? 'Scored but not admitted: presenting the artifact with its real score and rejection reasons.'
              : 'Degraded mode: presenting the artifact without a real fitness score.' },
        ] });
      await emitPreviewArtifacts(host.previewCtx, sessionId, artifact.source,
        route.selectedDomain, route);
      conversation.appendMessage('assistant', artifact.source);
      host.completeRun(sessionId, { label: 'Governed Create complete',
        model: projection.result.roles.generator });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      host.emit(sessionId, host.errorEvent(sessionId, error));
      host.failRun(sessionId, message);
      throw error;
    }
  }
