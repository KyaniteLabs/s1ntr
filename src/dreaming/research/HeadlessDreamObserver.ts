import { createHash } from 'node:crypto';
import type { HeadlessRenderer } from '../../render/HeadlessRenderer.js';
import { observeRenderedDreamEvidence,
  type DreamObservedEvidence, type DreamRenderedEvidenceIssuer } from './DreamResearchEvidence.js';
import type { DreamCreativeCandidate,
  DreamRenderedObserver } from './DreamRenderedExperimentExecutor.js';
import type { DreamExperimentPlan } from './DreamResearchTypes.js';

export class HeadlessDreamObserver implements DreamRenderedObserver {
  constructor(private readonly renderer: HeadlessRenderer,
    private readonly policy: { timeoutMs: number; maximumOutputBytes: number },
    private readonly evidenceIssuer: DreamRenderedEvidenceIssuer) {}

  async observe(candidate: DreamCreativeCandidate,
    plan: DreamExperimentPlan): Promise<DreamObservedEvidence> {
    const render = await this.renderer.renderWithEvidence(candidate.source, {
      domain: 'unknown', timeout: this.policy.timeoutMs, networkPolicy: 'isolated',
      keepPageOpen: false, maximumOutputBytes: this.policy.maximumOutputBytes,
      observeInteraction: plan.requiredModalities.includes('interaction') });
    const layerAblations = await this.observeAblations(candidate, plan);
    const evidence = observeRenderedDreamEvidence({ artifact: candidate.source,
      playable: candidate.source,
      expectedRendererEnvironmentDigest: plan.context.rendererEnvironmentDigest,
      render, layerAblations });
    this.evidenceIssuer.attest(evidence);
    return evidence;
  }

  private async observeAblations(candidate: DreamCreativeCandidate,
    plan: DreamExperimentPlan): Promise<string[] | undefined> {
    if (!plan.requiredModalities.includes('multi-layer')) return undefined;
    const digests: string[] = [];
    for (const ablation of candidate.layerAblations ?? []) {
      const receipt = await this.renderer.renderWithEvidence(ablation.source, {
        domain: 'unknown', timeout: this.policy.timeoutMs, networkPolicy: 'isolated',
        keepPageOpen: false, maximumOutputBytes: this.policy.maximumOutputBytes });
      if (!receipt.screenshot || !receipt.lateScreenshot || receipt.infraUnavailable
        || receipt.candidateFailure || receipt.errors?.length
        || receipt.rendererEnvironmentDigest !== plan.context.rendererEnvironmentDigest
        || !receipt.containment?.networkIsolated || !receipt.containment.cleanupSucceeded
        || !receipt.containment.runtimeDigest || !receipt.containment.assetDigests
        || receipt.containment.postRunCensus?.pagesBefore
          !== receipt.containment.postRunCensus?.pagesAfter) {
        throw new Error('DREAM_LAYER_ABLATION_EVIDENCE_INVALID');
      }
      digests.push(createHash('sha256').update(JSON.stringify({
        removedLayerId: ablation.removedLayerId, screenshot: receipt.screenshot,
        lateScreenshot: receipt.lateScreenshot })).digest('hex'));
    }
    return digests;
  }
}
