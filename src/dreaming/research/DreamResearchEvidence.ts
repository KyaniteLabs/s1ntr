import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RenderEvidence } from '../../core/types/GenerationEvaluation.js';
import type { DreamModality } from './DreamResearchTypes.js';

export interface DreamObservedEvidence {
  artifactDigest: string;
  playableDigest: string;
  rendererEnvironmentDigest: string;
  runtimeErrors: readonly string[];
  degraded: boolean;
  identityValid: boolean;
  digestMatched: boolean;
  frames: readonly string[];
  /** Raw rendered pixels for evaluator vision; receipts persist only their digests. */
  pixelFrames: readonly Readonly<{ mimeType: string; dataBase64: string; digest: string }>[];
  temporalSamples: readonly string[];
  audio?: { controlsAccessible: boolean; started: boolean; peakAmplitude: number };
  interaction?: { actions: number; stateChanged: boolean };
  layerAblations?: readonly string[];
  /** Host-signed only when the production authority is configured for restart recovery. */
  durableAttestation?: string;
  containment?: { networkIsolated: boolean; permissionsDenied: boolean;
    resourceLimitsObserved: boolean; cleanupSucceeded: boolean; outputBytes: number;
    assetDigests: readonly string[]; runtimeDigest: string;
    postRunCensus: { durationMs: number; usedHeapBytes: number | null;
      eventListeners: number; eventsDispatched: number; timers: number;
      audioContexts: number; pagesBefore: number; pagesAfter: number } };
}

export interface DreamRenderedEvidenceIssuer {
  attest(evidence: DreamObservedEvidence): void;
}

export interface DreamRenderedEvidenceResolver {
  assertAttested(evidence: DreamObservedEvidence): void;
}

/** Process-local capability boundary: copied or reconstructed evidence is never rendered authority. */
export function createDreamRenderedEvidenceAuthority(durableSecret?: string): {
  issuer: DreamRenderedEvidenceIssuer; resolver: DreamRenderedEvidenceResolver } {
  const attestations = new WeakMap<object, string>();
  const evidenceDigest = (evidence: DreamObservedEvidence) => {
    const { durableAttestation: _attestation, ...body } = evidence;
    return contentDigest(JSON.stringify(body));
  };
  const signature = (evidence: DreamObservedEvidence) => durableSecret
    ? createHmac('sha256', durableSecret).update(evidenceDigest(evidence)).digest('hex') : undefined;
  return {
    issuer: Object.freeze({ attest(evidence: DreamObservedEvidence) {
      const durable = signature(evidence);
      if (durable) evidence.durableAttestation = durable;
      attestations.set(evidence, evidenceDigest(evidence));
    } }),
    resolver: Object.freeze({ assertAttested(evidence: DreamObservedEvidence) {
      const expected = signature(evidence);
      const durableValid = Boolean(expected && /^[a-f0-9]{64}$/.test(
        evidence.durableAttestation ?? '') && timingSafeEqual(
        Buffer.from(expected), Buffer.from(evidence.durableAttestation!)));
      if (!durableValid && attestations.get(evidence) !== evidenceDigest(evidence)) {
        throw new Error('DREAM_RENDERED_EVIDENCE_CAPABILITY_INVALID');
      }
    } }),
  };
}

const DIGEST = /^[a-f0-9]{64}$/;

export function validateDreamEvidence(evidence: DreamObservedEvidence,
  required: readonly DreamModality[]): string[] {
  const failures: string[] = [];
  const pixelFrames = evidence.pixelFrames ?? [];
  if (![evidence.artifactDigest, evidence.playableDigest,
    evidence.rendererEnvironmentDigest].every(value => DIGEST.test(value))) {
    failures.push('DREAM_EVIDENCE_DIGEST_INVALID');
  }
  if (evidence.degraded) failures.push('DREAM_EVIDENCE_DEGRADED');
  if (!evidence.identityValid) failures.push('DREAM_EVIDENCE_IDENTITY_INVALID');
  if (!evidence.digestMatched) failures.push('DREAM_EVIDENCE_DIGEST_MISMATCH');
  if (evidence.runtimeErrors.length > 0) failures.push('DREAM_RUNTIME_ERROR');
  if (!evidence.containment?.networkIsolated || !evidence.containment.permissionsDenied
    || !evidence.containment.resourceLimitsObserved || !evidence.containment.cleanupSucceeded) {
    failures.push('DREAM_CONTAINMENT_EVIDENCE_REQUIRED');
  }
  if (!evidence.containment || !DIGEST.test(evidence.containment.runtimeDigest)
    || !evidence.containment.assetDigests.every(value => DIGEST.test(value))
    || evidence.containment.postRunCensus.pagesBefore
      !== evidence.containment.postRunCensus.pagesAfter) {
    failures.push('DREAM_CONTAINMENT_CENSUS_INVALID');
  }
  if (required.includes('visual') && evidence.frames.length < 2) {
    failures.push('DREAM_VISUAL_EVIDENCE_REQUIRED');
  }
  if (required.includes('visual') && (pixelFrames.length < 2
    || pixelFrames.some(frame => !frame.dataBase64 || !frame.mimeType.startsWith('image/')
      || !DIGEST.test(frame.digest) || contentDigest(frame.dataBase64) !== frame.digest)
    || evidence.frames.some((digest, index) => pixelFrames[index]?.digest !== digest))) {
    failures.push('DREAM_PIXEL_EVIDENCE_INVALID');
  }
  if (required.includes('motion') && evidence.temporalSamples.length < 1) {
    failures.push('DREAM_MOTION_EVIDENCE_REQUIRED');
  }
  if (required.includes('audio')) {
    if (!evidence.audio?.controlsAccessible) failures.push('DREAM_AUDIO_CONTROLS_REQUIRED');
    if (!evidence.audio?.started) failures.push('DREAM_AUDIO_STARTED_REQUIRED');
    if (!(evidence.audio && evidence.audio.peakAmplitude > 0)) {
      failures.push('DREAM_AUDIO_SIGNAL_REQUIRED');
    }
  }
  if (required.includes('interaction')
    && !(evidence.interaction && evidence.interaction.actions > 0
      && evidence.interaction.stateChanged)) {
    failures.push('DREAM_INTERACTION_EVIDENCE_REQUIRED');
  }
  if (required.includes('multi-layer') && !evidence.layerAblations?.length) {
    failures.push('DREAM_LAYER_ABLATION_REQUIRED');
  }
  return failures;
}

export interface DreamEvaluatorIdentity {
  identityDigest: string;
  hostDigest: string;
}

export function validateEvaluatorIndependence(first: DreamEvaluatorIdentity,
  second: DreamEvaluatorIdentity): void {
  if (first.identityDigest === second.identityDigest || first.hostDigest === second.hostDigest) {
    throw new Error('DREAM_EVALUATOR_INDEPENDENCE_REQUIRED');
  }
}

export function validateEvaluatorManifests(identities: readonly DreamEvaluatorIdentity[],
  manifests: readonly string[]): void {
  if (identities.length !== manifests.length || identities.some(identity =>
    !manifests.includes(identity.identityDigest))) {
    throw new Error('DREAM_EVALUATOR_MANIFEST_MISMATCH');
  }
}

export interface DreamTransferIsolation {
  originContextDigest: string;
  controlContextDigest: string;
  treatmentContextDigest: string;
  findingDigest: string;
  controlFindingDigest: string | null;
  treatmentFindingDigest: string;
  holdoutAccessedBeforeProposal: boolean;
}

export type DreamTransferCommitmentProtocol = Omit<DreamTransferIsolation,
  'holdoutAccessedBeforeProposal'>;

export function validateTransferIsolation(value: DreamTransferIsolation): void {
  if (value.holdoutAccessedBeforeProposal) throw new Error('DREAM_HOLDOUT_LEAKED');
  if (value.controlContextDigest !== value.treatmentContextDigest) {
    throw new Error('DREAM_TRANSFER_CONTEXT_MISMATCH');
  }
  if (value.controlFindingDigest !== null
    || value.treatmentFindingDigest !== value.findingDigest) {
    throw new Error('DREAM_TRANSFER_FINDING_ASSIGNMENT_INVALID');
  }
  if (value.originContextDigest === value.controlContextDigest) {
    throw new Error('DREAM_TRANSFER_NOT_UNSEEN');
  }
}

function contentDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Receipt-safe digest: binds rendered pixels without persisting their raw bytes. */
export function dreamEvidenceReceiptDigest(evidence: DreamObservedEvidence): string {
  const { pixelFrames, ...body } = evidence;
  return contentDigest(JSON.stringify({ ...body,
    pixelFrames: pixelFrames.map(({ mimeType, digest }) => ({ mimeType, digest })) }));
}

export function observeRenderedDreamEvidence(input: {
  artifact: string;
  playable: string;
  expectedRendererEnvironmentDigest: string;
  expectedArtifactDigest?: string;
  expectedPlayableDigest?: string;
  render: RenderEvidence;
  layerAblations?: string[];
}): DreamObservedEvidence {
  const pixelFrames = [input.render.screenshot, input.render.lateScreenshot]
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .map(frame => ({ mimeType: frame.mimeType, dataBase64: frame.dataBase64,
      digest: contentDigest(frame.dataBase64) }));
  const frames = pixelFrames.map(frame => frame.digest);
  const artifactDigest = contentDigest(input.artifact);
  const playableDigest = contentDigest(input.playable);
  return { artifactDigest,
    playableDigest,
    rendererEnvironmentDigest: input.render.rendererEnvironmentDigest ?? '',
    runtimeErrors: [...(input.render.errors ?? [])],
    degraded: input.render.infraUnavailable || input.render.candidateFailure,
    identityValid: input.render.rendererEnvironmentDigest
      === input.expectedRendererEnvironmentDigest,
    digestMatched: (!input.expectedArtifactDigest
        || input.expectedArtifactDigest === artifactDigest)
      && (!input.expectedPlayableDigest || input.expectedPlayableDigest === playableDigest),
    frames, pixelFrames, temporalSamples: frames.slice(1),
    audio: input.render.audio ? { controlsAccessible: Boolean(input.render.playback?.controlsAccessible),
      started: Boolean(input.render.playback?.started),
      peakAmplitude: input.render.audio.peakAmplitude ?? 0 } : undefined,
    interaction: input.render.interaction, layerAblations: input.layerAblations,
    containment: { networkIsolated: input.render.containment?.networkIsolated === true,
      permissionsDenied: input.render.containment?.permissionsDenied === true,
      resourceLimitsObserved: input.render.containment?.timeoutEnforced === true
        && input.render.containment.outputLimitEnforced === true,
      cleanupSucceeded: input.render.containment?.cleanupSucceeded === true,
      outputBytes: input.render.containment?.outputBytes ?? 0,
      assetDigests: [...(input.render.containment?.assetDigests ?? [])],
      runtimeDigest: input.render.containment?.runtimeDigest ?? '',
      postRunCensus: input.render.containment?.postRunCensus
        ? { ...input.render.containment.postRunCensus }
        : { durationMs: 0, usedHeapBytes: null, eventListeners: 0,
          eventsDispatched: 0, timers: 0, audioContexts: 0,
          pagesBefore: -1, pagesAfter: -2 } } };
}
