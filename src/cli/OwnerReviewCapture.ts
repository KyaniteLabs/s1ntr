import { createHash } from 'node:crypto';
import type { RenderEvidence } from '../core/types/GenerationEvaluation.js';
import type { PhotosensitivityVerdict } from '../guardrails/FlashMeasure.js';
import type { OwnerCaptureInputs } from '../creative-run/OwnerQualityReview.js';
import { CREATIVE_PROOF_SCHEMA_VERSION, evaluateCreativeProof, type CreativeProofResult } from '../quality/CreativeProofGate.js';

type Asset = { readonly ref: string; readonly mimeType: string; readonly payload: string };
type Frame = NonNullable<RenderEvidence['screenshot']>;

export interface OwnerCapturedEvidence {
  readonly inputs: Partial<Pick<OwnerCaptureInputs,
    'timeSamples' | 'interactionTrace' | 'runtimeState' | 'clockEvents' | 'accessibility' | 'knownFailures'>>;
  readonly limitations: readonly string[];
  /**
   * CreativeProofGate verdict over the captured frames (bytes re-hashed). Only the technical claim is
   * requested: coordination and creative quality are never asserted from a capture (owner decides).
   */
  readonly proof?: CreativeProofResult;
}

/** Renders one finished HTML artifact and measures its flashes from the frames the screen shows. */
export interface OwnerCaptureRenderer {
  render(html: string): Promise<RenderEvidence>;
  measureFlash(html: string): Promise<PhotosensitivityVerdict | null>;
}

const json = (ref: string, value: unknown): Asset =>
  ({ ref, mimeType: 'application/json', payload: JSON.stringify(value) });

const frameSample = (ref: string, frame: Frame): Asset => json(ref, {
  mimeType: frame.mimeType, width: frame.width ?? null, height: frame.height ?? null,
  frameDigest: createHash('sha256').update(Buffer.from(frame.dataBase64, 'base64')).digest('hex'),
});

/**
 * Maps what a render of the candidate showed to the owner evidence classes.
 * A class the render did not observe is left out and named in `limitations`.
 */
export function ownerCaptureFromRender(
  candidateId: string, evidence: RenderEvidence, flash: PhotosensitivityVerdict | null,
): OwnerCapturedEvidence {
  const ref = (name: string) => `${candidateId}.capture.${name}`;
  const limitations: string[] = [];
  const knownFailures: string[] = [];
  const inputs: { -readonly [K in keyof OwnerCapturedEvidence['inputs']]: OwnerCapturedEvidence['inputs'][K] } = {};
  if (evidence.candidateFailure) {
    knownFailures.push(`candidate-render-failed: ${evidence.failure ?? 'no reason reported'}`);
  }
  const early = evidence.screenshot;
  if (evidence.infraUnavailable) limitations.push('render-infrastructure-unavailable');
  else if (evidence.rendered === false || !early) limitations.push('render-not-observed');
  if (!evidence.infraUnavailable && evidence.rendered !== false && early) {
    const late = evidence.lateScreenshot;
    inputs.timeSamples = [frameSample(ref('time.early'), early),
      ...(late ? [frameSample(ref('time.late'), late)] : [])];
    if (!late) limitations.push('late-frame-not-captured');
    inputs.runtimeState = json(ref('runtime'), {
      rendered: true, candidateFailure: evidence.candidateFailure, failure: evidence.failure ?? null,
      errors: evidence.errors ?? [], postRunCensus: evidence.containment?.postRunCensus ?? null,
      rendererEnvironmentDigest: evidence.rendererEnvironmentDigest ?? null, timingMs: evidence.timingMs,
    });
    inputs.clockEvents = json(ref('clock'), {
      timingMs: evidence.timingMs, framesCaptured: late ? 2 : 1,
    });
    if (evidence.interaction && evidence.interaction.actions > 0) {
      inputs.interactionTrace = json(ref('interaction'), {
        interaction: evidence.interaction, playback: evidence.playback ?? null,
      });
    } else limitations.push('interaction-not-observed');
  }
  if (flash?.measurement) {
    inputs.accessibility = json(ref('accessibility'), {
      check: 'photosensitivity-wcag-2.3.1', pass: flash.pass, issue: flash.issue,
      measurement: flash.measurement,
    });
    if (!flash.pass && flash.issue) knownFailures.push(flash.issue);
  } else limitations.push('accessibility-not-measured');
  const frames = [['time.early', early], ['time.late', evidence.lateScreenshot]]
    .filter((f): f is [string, Frame] => Boolean(f[1]) && inputs.timeSamples !== undefined);
  const bytesByRef = new Map(frames.map(([name, f]) => [ref(name), Buffer.from(f.dataBase64, 'base64')]));
  const proof = frames.length === 0 ? undefined : evaluateCreativeProof({
    schemaVersion: CREATIVE_PROOF_SCHEMA_VERSION,
    domains: [{ name: 'html', requiredModalities: ['visual'] }],
    evidence: frames.map(([name]) => ({
      ref: ref(name), kind: 'image' as const, modalities: ['visual' as const],
      sha256: createHash('sha256').update(bytesByRef.get(ref(name))!).digest('hex'),
      bytes: bytesByRef.get(ref(name))!.byteLength,
    })),
    verdicts: {
      technical: { status: evidence.candidateFailure ? 'fail' : 'pass', evidenceRefs: frames.map(([n]) => ref(n)) },
      coordination: { status: 'not-evaluated', evidenceRefs: [] },
      creativeQuality: { status: 'not-evaluated', evidenceRefs: [] },
    },
    requestedClaims: { technicalSuccess: true, coordinationImproved: false, creativeQualityImproved: false },
  }, { readEvidence: (r) => bytesByRef.get(r) ?? null });
  if (proof && proof.outcome === 'FAIL') limitations.push(`capture-proof-failed:${proof.violations.join(',')}`);
  return Object.freeze({ inputs: Object.freeze({ ...inputs, knownFailures }), limitations, ...(proof ? { proof } : {}) });
}

/** Captures per brief, then per candidate slot: slot ids repeat across briefs. */
export type OwnerCaptures = ReadonlyMap<string, ReadonlyMap<string, OwnerCapturedEvidence>>;

const NOT_RENDERED: RenderEvidence = Object.freeze({
  infraUnavailable: true, candidateFailure: false, timingMs: 0,
});

/** Renders each candidate's own HTML once. A renderer that throws leaves that candidate unobserved. */
export async function captureOwnerEvidence(
  candidates: readonly { readonly id: string; readonly artifact: { readonly html: string } }[],
  renderer: OwnerCaptureRenderer,
): Promise<ReadonlyMap<string, OwnerCapturedEvidence>> {
  const captured = new Map<string, OwnerCapturedEvidence>();
  for (const candidate of candidates) {
    if (captured.has(candidate.id)) throw new Error('OWNER_CAPTURE_DUPLICATE_CANDIDATE_ID');
    const html = candidate.artifact.html;
    const evidence = await Promise.resolve().then(() => renderer.render(html))
      .catch((): RenderEvidence => NOT_RENDERED);
    const flash = await Promise.resolve().then(() => renderer.measureFlash(html)).catch(() => null);
    captured.set(candidate.id, ownerCaptureFromRender(candidate.id, evidence, flash));
  }
  return captured;
}

/** The production renderer: HeadlessRenderer for the frames and interaction, the compositor screencast for flashes. */
export async function createProductionOwnerCaptureRenderer(): Promise<OwnerCaptureRenderer> {
  const [{ HeadlessRenderer }, { AccessibilityGuardrails }] = await Promise.all([
    import('../render/HeadlessRenderer.js'), import('../guardrails/AccessibilityGuardrails.js'),
  ]);
  const launched = await HeadlessRenderer.getInstance().initialize().then(() => true, () => false);
  if (!launched) return { render: () => Promise.resolve(NOT_RENDERED), measureFlash: () => Promise.resolve(null) };
  return {
    render: (html) => HeadlessRenderer.getInstance().renderWithEvidence(html, {
      domain: 'html', lateCaptureDelay: 3000, observeInteraction: true,
    }),
    measureFlash: async (html) => (await new AccessibilityGuardrails().check(html, 'html')).photosensitivity,
  };
}
