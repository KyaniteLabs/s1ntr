import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateDreamEvidence, validateEvaluatorIndependence,
  validateTransferIsolation, observeRenderedDreamEvidence, dreamEvidenceReceiptDigest,
} from '../../../src/dreaming/research/DreamResearchEvidence.js';

describe('Dream research evidence admission', () => {
  const digest = (char: string) => char.repeat(64);
  const pixelFrames = ['early', 'late'].map(dataBase64 => ({ mimeType: 'image/png', dataBase64,
    digest: createHash('sha256').update(dataBase64).digest('hex') }));
  const base = { artifactDigest: digest('a'), playableDigest: digest('b'),
    rendererEnvironmentDigest: digest('c'), runtimeErrors: [], degraded: false,
    identityValid: true, digestMatched: true, frames: pixelFrames.map(frame => frame.digest),
    pixelFrames,
    temporalSamples: [digest('f')], audio: undefined, interaction: undefined,
    containment: { networkIsolated: true, permissionsDenied: true,
      resourceLimitsObserved: true, cleanupSucceeded: true, outputBytes: 1,
      assetDigests: [], runtimeDigest: digest('7'), postRunCensus: { durationMs: 1,
        usedHeapBytes: 1, eventListeners: 0, eventsDispatched: 0, timers: 0,
        audioContexts: 0, pagesBefore: 0, pagesAfter: 0 } } };

  it('requires capability-derived evidence and fails closed', () => {
    expect(validateDreamEvidence(base, ['visual', 'motion'])).toEqual([]);
    expect(validateDreamEvidence({ ...base, temporalSamples: [] }, ['motion']))
      .toContain('DREAM_MOTION_EVIDENCE_REQUIRED');
    expect(validateDreamEvidence({ ...base, degraded: true }, ['visual']))
      .toContain('DREAM_EVIDENCE_DEGRADED');
    expect(validateDreamEvidence({ ...base,
      containment: { ...base.containment, runtimeDigest: '' } }, ['visual']))
      .toContain('DREAM_CONTAINMENT_CENSUS_INVALID');
    expect(validateDreamEvidence({ ...base, audio: { controlsAccessible: true,
      started: true, peakAmplitude: 0 } }, ['audio'])).toContain('DREAM_AUDIO_SIGNAL_REQUIRED');
  });

  it('keeps raw pixels evaluator-visible while receipts bind their exact digests', () => {
    const tampered = { ...base, pixelFrames: base.pixelFrames.map((frame, index) =>
      index === 0 ? { ...frame, dataBase64: 'different-pixels' } : frame) };
    expect(dreamEvidenceReceiptDigest(tampered)).toBe(dreamEvidenceReceiptDigest(base));
    expect(validateDreamEvidence(tampered, ['visual'])).toContain('DREAM_PIXEL_EVIDENCE_INVALID');
  });

  it('marks historical evidence without pixel bytes non-admissible instead of crashing', () => {
    const { pixelFrames: _removed, ...historical } = base;
    expect(validateDreamEvidence(historical as never, ['visual']))
      .toContain('DREAM_PIXEL_EVIDENCE_INVALID');
  });

  it('rejects pseudo-independent evaluators and transfer leakage', () => {
    const reviewer = { identityDigest: digest('1'), hostDigest: digest('2') };
    expect(() => validateEvaluatorIndependence(reviewer, reviewer))
      .toThrow('DREAM_EVALUATOR_INDEPENDENCE_REQUIRED');
    expect(() => validateTransferIsolation({ originContextDigest: digest('3'),
      controlContextDigest: digest('4'), treatmentContextDigest: digest('4'),
      findingDigest: digest('5'), controlFindingDigest: null,
      treatmentFindingDigest: digest('5'), holdoutAccessedBeforeProposal: true }))
      .toThrow('DREAM_HOLDOUT_LEAKED');
  });

  it('binds early late runtime and audible render evidence', () => {
    const observed = observeRenderedDreamEvidence({ artifact: '<html>work</html>',
      playable: '<html>work</html>', expectedRendererEnvironmentDigest: digest('c'),
      render: { timingMs: 10, infraUnavailable: false, candidateFailure: false,
        rendererEnvironmentDigest: digest('c'),
        screenshot: { mimeType: 'image/png', dataBase64: Buffer.from('early').toString('base64') },
        lateScreenshot: { mimeType: 'image/png', dataBase64: Buffer.from('late').toString('base64') },
        errors: [], audio: { success: true, peakAmplitude: 0.2 },
        playback: { controlsAccessible: true, started: true },
        containment: { networkIsolated: true, permissionsDenied: true,
          cleanupSucceeded: true, blockedRequests: 0, routeInstalled: true,
          timeoutEnforced: true, outputLimitEnforced: true, outputBytes: 17,
          assetDigests: [], runtimeDigest: digest('7'), postRunCensus: { durationMs: 10,
            usedHeapBytes: 1, eventListeners: 0, eventsDispatched: 0, timers: 0,
            audioContexts: 1, pagesBefore: 0, pagesAfter: 0 } } } });
    expect(observed.frames).toHaveLength(2);
    expect(observed.temporalSamples).toHaveLength(1);
    expect(validateDreamEvidence(observed, ['visual', 'motion', 'audio'])).toEqual([]);
  });

  it('requires interaction and exact layer-ablation observations by modality', () => {
    expect(validateDreamEvidence({ ...base, interaction: { actions: 0,
      stateChanged: false } }, ['interaction']))
      .toContain('DREAM_INTERACTION_EVIDENCE_REQUIRED');
    expect(validateDreamEvidence({ ...base, layerAblations: [] }, ['multi-layer']))
      .toContain('DREAM_LAYER_ABLATION_REQUIRED');
    expect(validateDreamEvidence({ ...base, interaction: { actions: 2,
      stateChanged: true }, layerAblations: [digest('9')] },
    ['interaction', 'multi-layer'])).toEqual([]);
  });
});
