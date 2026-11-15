import { createHash } from 'node:crypto';
import { assertAuthenticBlindReviewEvidence } from './BlindReviewEvidence.js';
import type {
  BlindReviewPacket,
  BlindReviewRecord,
  GenerationIdentity,
  ReviewClaim,
  ReviewModality,
  UnmaskedReview,
} from './BlindReviewEvidence.js';
import {
  analyzeHtmlCssContrast,
  FIGURE_GROUND_METRIC,
  FIGURE_GROUND_TARGET,
  WCAG_CONTRAST_METRIC,
  type HtmlCssContrastAnalysis,
} from './HtmlCssContrast.js';

export {
  FIGURE_GROUND_METRIC,
  FIGURE_GROUND_TARGET,
  WCAG_CONTRAST_METRIC,
} from './HtmlCssContrast.js';

export const EXPERIMENT_PLAN_SCHEMA = 'sinter.attributable-experiment-plan' as const;
export const EXPERIMENT_PLAN_VERSION = 1 as const;

export type CriticRole = 'specialist' | 'holistic';
export type TreatmentTargetKind = 'principle' | 'graph-element' | 'parameter';
export type RevisionScalar = string | number | boolean;

export interface CausalIdentity {
  readonly role: 'generator' | CriticRole;
  readonly provider: string;
  readonly model: string;
  readonly pipe: string;
  readonly effort: string;
  readonly contributionLineage: string;
  readonly assignment: string;
}

export interface DeclaredTreatment {
  readonly id: string;
  readonly targetKind: TreatmentTargetKind;
  readonly targetId: string;
  readonly before: RevisionScalar;
  readonly after: RevisionScalar;
}

export interface CriticContribution {
  readonly id: string;
  readonly identity: CausalIdentity;
  readonly blindId: string;
  readonly artifactDigest: string;
  readonly claims: readonly ReviewClaim[];
  readonly treatment: DeclaredTreatment;
  readonly priority: number;
}

export interface CreativeRevisionState {
  readonly artifactDigest: string;
  readonly principles: Readonly<Record<string, RevisionScalar>>;
  readonly graphElements: Readonly<Record<string, RevisionScalar>>;
  readonly parameters: Readonly<Record<string, RevisionScalar>>;
}

export interface CreativeRevisionSnapshot {
  readonly principles: Readonly<Record<string, RevisionScalar>>;
  readonly graphElements: Readonly<Record<string, RevisionScalar>>;
  readonly parameters: Readonly<Record<string, RevisionScalar>>;
}

export interface FrozenRoute {
  readonly provider: string;
  readonly model: string;
  readonly pipe: string;
  readonly effort: string;
}

export interface FrozenRuntime {
  readonly id: string;
  readonly version: string;
  readonly seed: string;
}

export interface CapturePoint {
  readonly id: string;
  readonly atMs: number;
  readonly modality: ReviewModality;
}

export interface CausalPredicate {
  readonly metricId: string;
  readonly direction: 'increase' | 'decrease';
  readonly minimumDelta: number;
}

export interface DeterministicMeasurementReceipt {
  readonly metricId: string;
  readonly value: number;
  readonly artifactDigest: string;
  readonly evidenceDigest: string;
  readonly captureId: string;
  readonly evaluatorId: 'sinter-html-css-contrast-evaluator';
  readonly evaluatorVersion: 1;
  readonly algorithm: 'wcag-2.1-relative-luminance-contrast-ratio';
  readonly receiptDigest: string;
}

export interface HardFloor {
  readonly metricId: string;
  readonly minimum: number;
}

export interface CompileExperimentPlanOptions {
  readonly packet: BlindReviewPacket;
  readonly review: BlindReviewRecord;
  readonly unmasked: UnmaskedReview;
  readonly critics: readonly CriticContribution[];
  readonly route: FrozenRoute;
  readonly runtime: FrozenRuntime;
  readonly allowedDiffs: readonly string[];
  readonly forbiddenDiffs: readonly string[];
  readonly captureSchedule: readonly CapturePoint[];
  readonly causalPredicate: CausalPredicate;
  readonly hardFloors: readonly HardFloor[];
}

export interface ExperimentPlan {
  readonly schema: typeof EXPERIMENT_PLAN_SCHEMA;
  readonly schemaVersion: typeof EXPERIMENT_PLAN_VERSION;
  readonly packetDigest: string;
  readonly candidateSetDigest: string;
  readonly reviewDigest: string;
  readonly unmaskAuditDigest: string;
  readonly blindId: string;
  readonly candidateId: string;
  readonly baselineArtifact: CanonicalCreativeArtifactEnvelope;
  readonly baselineState: CreativeRevisionState;
  readonly baselineEvidence: readonly CanonicalPostEvidence[];
  readonly baselineMeasurements: readonly DeterministicMeasurementReceipt[];
  readonly route: FrozenRoute;
  readonly runtime: FrozenRuntime;
  readonly allowedDiffs: readonly string[];
  readonly forbiddenDiffs: readonly string[];
  readonly captureSchedule: readonly CapturePoint[];
  readonly causalPredicate: CausalPredicate;
  readonly hardFloors: readonly HardFloor[];
  readonly critics: readonly CriticContribution[];
  readonly treatment: DeclaredTreatment;
  readonly planDigest: string;
}

export interface CanonicalPostEvidence {
  readonly captureId: string;
  readonly atMs: number;
  readonly modality: 'visual';
  readonly artifactDigest: string;
  readonly creativeDigest: string;
  readonly extractorId: HtmlCssContrastAnalysis['extractorId'];
  readonly extractorVersion: HtmlCssContrastAnalysis['extractorVersion'];
  readonly slice: Readonly<Pick<HtmlCssContrastAnalysis,
  'foreground' | 'background' | 'contrastRatio'>>;
  readonly evidenceDigest: string;
}

export interface CanonicalCreativeArtifactEnvelope {
  readonly schema: 'sinter.canonical-creative-artifact';
  readonly version: 1;
  readonly creativeBytes: string;
  readonly creativeDigest: string;
  readonly artifactDigest: string;
  readonly sourceArtifactDigest: string;
  readonly state: CreativeRevisionSnapshot;
  readonly analysis: HtmlCssContrastAnalysis;
  readonly stateDigest: string;
  readonly envelopeDigest: string;
}

export interface ApplyAttributableRevisionOptions {
  readonly route: FrozenRoute;
  readonly runtime: FrozenRuntime;
  readonly captureSchedule: readonly CapturePoint[];
  readonly causalPredicate: CausalPredicate;
  readonly postArtifact: CanonicalCreativeArtifactEnvelope;
  readonly independentBlindPreference?: IndependentBlindTreatmentPreference;
  readonly score?: number;
}

export type ExperimentOutcome =
  | 'experiment-improved'
  | 'experiment-inconclusive'
  | 'experiment-regressed';

export type BlindTreatmentPreferenceOutcome =
  | 'treatment-preferred'
  | 'baseline-preferred'
  | 'tie';

/** A sealed independent, blinded comparison of the canonical treatment and baseline. */
export interface IndependentBlindTreatmentPreference {
  readonly planDigest: string;
  readonly treatmentArtifactDigest: string;
  readonly reviewer: CausalIdentity;
  readonly outcome: BlindTreatmentPreferenceOutcome;
  readonly receiptDigest: string;
}

export interface AttributableRevisionReceipt {
  readonly planDigest: string;
  readonly treatmentId: string;
  readonly revisedState: CreativeRevisionState;
  readonly evidence: readonly CanonicalPostEvidence[];
  readonly measurements: readonly DeterministicMeasurementReceipt[];
  /** Present for every authentic blind comparison, including tie and baseline preference. */
  readonly blindTreatmentPreferenceDigest?: string;
  readonly outcome: ExperimentOutcome;
  readonly improvementEstablished: boolean;
  readonly reasons: readonly string[];
  readonly receiptDigest: string;
}

const IDENTITY_FIELDS = [
  'role', 'provider', 'model', 'pipe', 'effort', 'contributionLineage', 'assignment',
] as const;
const AUTHENTIC_PLANS = new WeakSet<object>();
const AUTHENTIC_ARTIFACTS = new WeakSet<object>();
const AUTHENTIC_MEASUREMENTS = new WeakSet<object>();
const AUTHENTIC_REVISION_RECEIPTS = new WeakSet<object>();
const AUTHENTIC_TREATMENT_PREFERENCES = new WeakSet<object>();
const REVISION_ARTIFACTS = new WeakMap<object, Readonly<{
  baseline: CanonicalCreativeArtifactEnvelope;
  treatment: CanonicalCreativeArtifactEnvelope;
}>>();
const SESSION_FACTORY_CAPABILITY = Symbol('attributable-revision-session-factory');

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactDigest(value: string): string {
  return sha256(value).slice(0, 16);
}

const METRIC_ALGORITHMS = {
  [FIGURE_GROUND_METRIC]: 'wcag-2.1-relative-luminance-contrast-ratio',
  [WCAG_CONTRAST_METRIC]: 'wcag-2.1-relative-luminance-contrast-ratio',
} as const;

function canonicalEvidenceDigest(evidence: Omit<CanonicalPostEvidence, 'evidenceDigest'>): string {
  return sha256(JSON.stringify(evidence));
}

function deriveCapture(
  artifact: CanonicalCreativeArtifactEnvelope,
  capture: CapturePoint,
): CanonicalPostEvidence {
  if (capture.modality !== 'visual') throw new Error('EXPERIMENT_CAPTURE_MODALITY_UNSUPPORTED');
  const body = {
    captureId: capture.id,
    atMs: capture.atMs,
    modality: capture.modality,
    artifactDigest: artifact.artifactDigest,
    creativeDigest: artifact.creativeDigest,
    extractorId: artifact.analysis.extractorId,
    extractorVersion: artifact.analysis.extractorVersion,
    slice: {
      foreground: artifact.analysis.foreground,
      background: artifact.analysis.background,
      contrastRatio: artifact.analysis.contrastRatio,
    },
  };
  return freeze({ ...body, evidenceDigest: canonicalEvidenceDigest(body) });
}

function evaluateDerivedCapture(
  metricId: string,
  evidence: CanonicalPostEvidence,
): DeterministicMeasurementReceipt {
  const algorithm = METRIC_ALGORITHMS[metricId as keyof typeof METRIC_ALGORITHMS];
  if (!algorithm) throw new Error(`EXPERIMENT_METRIC_UNSUPPORTED:${metricId}`);
  const body = {
    metricId,
    value: evidence.slice.contrastRatio,
    artifactDigest: evidence.artifactDigest,
    evidenceDigest: evidence.evidenceDigest,
    captureId: evidence.captureId,
    evaluatorId: 'sinter-html-css-contrast-evaluator' as const,
    evaluatorVersion: 1 as const,
    algorithm,
  };
  const receipt = freeze({ ...body, receiptDigest: sha256(JSON.stringify(body)) });
  AUTHENTIC_MEASUREMENTS.add(receipt);
  return receipt;
}

function orderedRecord(
  record: Readonly<Record<string, RevisionScalar>>,
): Record<string, RevisionScalar> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

/** The only canonical post-treatment artifact representation accepted by apply(). */
export function serializeCreativeRevisionState(state: CreativeRevisionSnapshot): string {
  return JSON.stringify({
    schema: 'sinter.creative-revision-state',
    version: 1,
    principles: orderedRecord(state.principles),
    graphElements: orderedRecord(state.graphElements),
    parameters: orderedRecord(state.parameters),
  });
}

export function createCanonicalCreativeArtifact(
  creativeBytes: string,
  sourceArtifactDigest: string,
): CanonicalCreativeArtifactEnvelope {
  if (!creativeBytes || !sourceArtifactDigest.trim()) throw new Error('CREATIVE_ARTIFACT_WITNESS_INCOMPLETE');
  const analysis = analyzeHtmlCssContrast(creativeBytes);
  const state = freeze({
    principles: { [FIGURE_GROUND_TARGET]: analysis.contrastRatio },
    graphElements: {},
    parameters: {},
  });
  const canonicalState = serializeCreativeRevisionState(state);
  const body = {
    schema: 'sinter.canonical-creative-artifact' as const,
    version: 1 as const,
    creativeBytes,
    creativeDigest: sha256(creativeBytes),
    artifactDigest: artifactDigest(creativeBytes),
    sourceArtifactDigest,
    state,
    analysis,
    stateDigest: sha256(canonicalState),
  };
  const envelope = freeze({ ...body, envelopeDigest: sha256(JSON.stringify(body)) });
  AUTHENTIC_ARTIFACTS.add(envelope);
  return envelope;
}

interface DerivedDiff {
  readonly path: string;
  readonly before?: RevisionScalar;
  readonly after?: RevisionScalar;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function requireText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function assertIdentity(identity: CausalIdentity, expectedRole: CausalIdentity['role']): void {
  if (identity.role !== expectedRole) throw new Error(`CRITIC_ROLE_INVALID:${expectedRole}`);
  for (const field of IDENTITY_FIELDS) {
    if (typeof identity[field] !== 'string' || !identity[field].trim()) {
      throw new Error(`IDENTITY_DIMENSION_MISSING:${field}`);
    }
  }
}

function generationIdentity(identity: GenerationIdentity): CausalIdentity {
  const complete = { role: identity.role, provider: identity.provider, model: identity.model,
    pipe: identity.pipe, effort: identity.effort,
    contributionLineage: identity.contributionLineage, assignment: identity.assignment };
  for (const field of IDENTITY_FIELDS) {
    if (typeof complete[field] !== 'string' || !complete[field]!.trim()) {
      throw new Error(`IDENTITY_DIMENSION_MISSING:${field}`);
    }
  }
  if (complete.role !== 'generator') throw new Error('GENERATION_ROLE_INVALID');
  return complete as CausalIdentity;
}

function assertIndependent(identities: readonly CausalIdentity[]): void {
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      for (const field of IDENTITY_FIELDS) {
        if (identities[left]![field].trim().toLowerCase()
          === identities[right]![field].trim().toLowerCase()) {
          throw new Error(`IDENTITY_OVERLAP:${field}`);
        }
      }
    }
  }
}

/**
 * Seals a blinded treatment comparison before it is admitted into an experiment receipt.
 * The reviewer must be independent from both criticism contributors.
 */
export function createIndependentBlindTreatmentPreference(
  plan: ExperimentPlan,
  treatment: CanonicalCreativeArtifactEnvelope,
  reviewer: CausalIdentity,
  outcome: BlindTreatmentPreferenceOutcome,
): IndependentBlindTreatmentPreference {
  if (!AUTHENTIC_PLANS.has(plan) || planDigest(plan) !== plan.planDigest) {
    throw new Error('BLIND_TREATMENT_PREFERENCE_PLAN_PROVENANCE_INVALID');
  }
  if (reviewer.role !== 'specialist' && reviewer.role !== 'holistic') {
    throw new Error('BLIND_TREATMENT_PREFERENCE_ROLE_INVALID');
  }
  assertIdentity(reviewer, reviewer.role);
  for (const critic of plan.critics) {
    for (const field of IDENTITY_FIELDS.filter((field) => field !== 'role')) {
      if (critic.identity[field].trim().toLowerCase() === reviewer[field].trim().toLowerCase()) {
        throw new Error(`IDENTITY_OVERLAP:${field}`);
      }
    }
  }
  assertAuthenticCanonicalArtifact(treatment);
  const body = {
    planDigest: plan.planDigest,
    treatmentArtifactDigest: treatment.artifactDigest,
    reviewer: freeze({ ...reviewer }),
    outcome,
  };
  const preference = freeze({ ...body, receiptDigest: sha256(JSON.stringify(body)) });
  AUTHENTIC_TREATMENT_PREFERENCES.add(preference);
  return preference;
}

function treatmentPath(treatment: DeclaredTreatment): string {
  if (treatment.targetKind !== 'principle' || treatment.targetId !== FIGURE_GROUND_TARGET) {
    throw new Error('EXPERIMENT_TARGET_UNSUPPORTED');
  }
  return `principles.${FIGURE_GROUND_TARGET}`;
}

function packetDigest(packet: BlindReviewPacket): string {
  return sha256(JSON.stringify({
    schema: packet.schema,
    version: packet.version,
    candidateSetDigest: packet.candidateSetDigest,
    candidates: packet.candidates,
    contactSheetHtml: packet.contactSheetHtml,
    playableMedia: packet.playableMedia,
  }));
}

function assertSealedEvidence(options: CompileExperimentPlanOptions): void {
  assertAuthenticBlindReviewEvidence(options.packet, options.review, options.unmasked);
  if (packetDigest(options.packet) !== options.packet.packetDigest) {
    throw new Error('EXPERIMENT_PACKET_DIGEST_MISMATCH');
  }
  if (options.review.packetDigest !== options.packet.packetDigest
    || options.unmasked.packetDigest !== options.packet.packetDigest
    || options.unmasked.reviewDigest !== options.review.reviewDigest) {
    throw new Error('EXPERIMENT_REVIEW_BINDING_MISMATCH');
  }
  const reviewDigest = sha256(JSON.stringify({
    packetDigest: options.review.packetDigest,
    judgments: options.review.judgments,
  }));
  if (reviewDigest !== options.review.reviewDigest) throw new Error('EXPERIMENT_REVIEW_DIGEST_MISMATCH');
  const audit = { boundary: options.unmasked.boundary, packetDigest: options.unmasked.packetDigest,
    reviewDigest: options.unmasked.reviewDigest, mappings: options.unmasked.mappings };
  if (sha256(JSON.stringify(audit)) !== options.unmasked.auditDigest) {
    throw new Error('EXPERIMENT_UNMASK_DIGEST_MISMATCH');
  }
}

function sameClaim(left: ReviewClaim, right: ReviewClaim): boolean {
  return left.modality === right.modality && left.artifactDigest === right.artifactDigest
    && left.evidenceDigest === right.evidenceDigest && left.claim === right.claim;
}

function selectTreatment(critics: readonly CriticContribution[]): DeclaredTreatment {
  const highest = Math.max(...critics.map((critic) => critic.priority));
  if (!Number.isFinite(highest)) throw new Error('CRITIC_PRIORITY_INVALID');
  const winners = critics.filter((critic) => critic.priority === highest);
  if (winners.length !== 1) throw new Error('CRITIC_TREATMENT_TIE');
  return winners[0]!.treatment;
}

function assertCritics(options: CompileExperimentPlanOptions): {
  blindId: string; candidateId: string; treatment: DeclaredTreatment;
} {
  const specialist = options.critics.filter((critic) => critic.identity.role === 'specialist');
  const holistic = options.critics.filter((critic) => critic.identity.role === 'holistic');
  if (options.critics.length !== 2 || specialist.length !== 1 || holistic.length !== 1) {
    throw new Error('EXPERIMENT_REQUIRES_SPECIALIST_AND_HOLISTIC_CRITICS');
  }
  assertIdentity(specialist[0]!.identity, 'specialist');
  assertIdentity(holistic[0]!.identity, 'holistic');
  const blindIds = new Set(options.critics.map((critic) => critic.blindId));
  if (blindIds.size !== 1) throw new Error('CRITIC_CANDIDATE_DISAGREEMENT');
  const blindId = options.critics[0]!.blindId;
  const candidate = options.packet.candidates.find((item) => item.blindId === blindId);
  const mapping = options.unmasked.mappings.find((item) => item.blindId === blindId);
  const judgment = options.review.judgments.find((item) => item.blindId === blindId);
  if (!candidate || !mapping || !judgment || judgment.outcome === 'inconclusive') {
    throw new Error('CRITIC_EVIDENCE_MISSING');
  }
  const generator = generationIdentity(mapping.generationIdentity);
  assertIndependent([generator, specialist[0]!.identity, holistic[0]!.identity]);
  for (const critic of options.critics) {
    if (critic.artifactDigest !== candidate.artifactDigest || critic.claims.length === 0) {
      throw new Error('CRITIC_ARTIFACT_BINDING_MISMATCH');
    }
    for (const claim of critic.claims) {
      const media = candidate.media.find((item) => item.modality === claim.modality);
      if (!media || claim.artifactDigest !== candidate.artifactDigest
        || claim.evidenceDigest !== media.digest
        || !judgment.claims.some((recorded) => sameClaim(recorded, claim))) {
        throw new Error('CRITIC_EVIDENCE_BINDING_MISMATCH');
      }
    }
  }
  return { blindId, candidateId: mapping.candidateId, treatment: selectTreatment(options.critics) };
}

function valueAt(state: CreativeRevisionState, treatment: DeclaredTreatment): RevisionScalar | undefined {
  return state.principles[treatment.targetId];
}

function assertFreezeInputs(
  options: CompileExperimentPlanOptions,
  artifact: BlindReviewPacket['candidates'][number],
  baselineArtifact: CanonicalCreativeArtifactEnvelope,
  treatment: DeclaredTreatment,
): void {
  for (const value of [...Object.values(options.route), ...Object.values(options.runtime)]) {
    requireText(value, 'EXPERIMENT_ROUTE_RUNTIME_INCOMPLETE');
  }
  if (baselineArtifact.artifactDigest !== artifact.artifactDigest
    && baselineArtifact.sourceArtifactDigest !== artifact.artifactDigest) {
    throw new Error('EXPERIMENT_BASELINE_ARTIFACT_MISMATCH');
  }
  requireText(treatment.id, 'TREATMENT_ID_REQUIRED');
  const path = treatmentPath(treatment);
  const baselineState = { ...baselineArtifact.state, artifactDigest: baselineArtifact.artifactDigest };
  if (valueAt(baselineState, treatment) !== treatment.before
    || treatment.before === treatment.after) throw new Error('TREATMENT_BASELINE_MISMATCH');
  if (!options.allowedDiffs.includes(path)
    || options.forbiddenDiffs.some((forbidden) => path === forbidden || path.startsWith(`${forbidden}.`))) {
    throw new Error('TREATMENT_DIFF_NOT_ALLOWED');
  }
  if (options.captureSchedule.length === 0
    || new Set(options.captureSchedule.map((capture) => capture.id)).size !== options.captureSchedule.length
    || options.captureSchedule.some((capture) => !capture.id.trim()
      || !Number.isFinite(capture.atMs) || capture.atMs < 0)) {
    throw new Error('CAPTURE_SCHEDULE_INVALID');
  }
  if (options.captureSchedule.some((capture) => capture.modality !== 'visual')) {
    throw new Error('EXPERIMENT_CAPTURE_MODALITY_UNSUPPORTED');
  }
  const predicate = options.causalPredicate;
  if (!predicate.metricId.trim() || !Number.isFinite(predicate.minimumDelta)
    || predicate.minimumDelta <= 0) throw new Error('CAUSAL_PREDICATE_INVALID');
  const requestedMetrics = [predicate.metricId, ...options.hardFloors.map((floor) => floor.metricId)];
  if (requestedMetrics.some((metricId) => !(metricId in METRIC_ALGORITHMS))) {
    throw new Error('EXPERIMENT_METRIC_UNSUPPORTED');
  }
  if (options.hardFloors.length === 0
    || new Set(options.hardFloors.map((floor) => floor.metricId)).size !== options.hardFloors.length
    || options.hardFloors.some((floor) => !floor.metricId.trim() || !Number.isFinite(floor.minimum))) {
    throw new Error('HARD_FLOORS_INVALID');
  }
}

function deriveEvidenceBundle(
  artifact: CanonicalCreativeArtifactEnvelope,
  schedule: readonly CapturePoint[],
  metricIds: readonly string[],
): { evidence: readonly CanonicalPostEvidence[];
  measurements: readonly DeterministicMeasurementReceipt[] } {
  const evidence = schedule.map((capture) => deriveCapture(artifact, capture));
  const uniqueMetrics = [...new Set(metricIds)];
  const measurementCapture = evidence[0];
  if (!measurementCapture) throw new Error('CAPTURE_SCHEDULE_INVALID');
  const measurements = uniqueMetrics.map((metricId) =>
    evaluateDerivedCapture(metricId, measurementCapture));
  return freeze({ evidence, measurements });
}

function visualArtifactBytes(artifact: BlindReviewPacket['candidates'][number]): string {
  const media = artifact.media.find((item) => item.modality === 'visual');
  if (!media) throw new Error('BASELINE_CREATIVE_ARTIFACT_MISSING');
  const separator = media.playableUri.indexOf(',');
  if (!media.playableUri.startsWith('data:') || separator < 0) {
    throw new Error('BASELINE_CREATIVE_ARTIFACT_INVALID');
  }
  const metadata = media.playableUri.slice(0, separator);
  const payload = media.playableUri.slice(separator + 1);
  const bytes = metadata.endsWith(';base64')
    ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
  // Campaign actuals retain the full source-byte digest; candidate manifests
  // retain the compact canonical digest. Both name the exact same bytes.
  if (sha256(bytes) !== media.digest
    || (artifactDigest(bytes) !== artifact.artifactDigest && sha256(bytes) !== artifact.artifactDigest)) {
    throw new Error('BASELINE_CREATIVE_ARTIFACT_DIGEST_MISMATCH');
  }
  return bytes;
}

export function compileExperimentPlan(options: CompileExperimentPlanOptions): ExperimentPlan {
  assertSealedEvidence(options);
  const selected = assertCritics(options);
  const artifact = options.packet.candidates.find((item) => item.blindId === selected.blindId)!;
  const baselineArtifact = createCanonicalCreativeArtifact(
    visualArtifactBytes(artifact),
    artifact.artifactDigest,
  );
  assertFreezeInputs(options, artifact, baselineArtifact, selected.treatment);
  const baselineState = freeze({
    ...baselineArtifact.state,
    artifactDigest: baselineArtifact.artifactDigest,
  });
  const baseline = deriveEvidenceBundle(
    baselineArtifact,
    options.captureSchedule,
    [options.causalPredicate.metricId, ...options.hardFloors.map((floor) => floor.metricId)],
  );
  const body = {
    schema: EXPERIMENT_PLAN_SCHEMA,
    schemaVersion: EXPERIMENT_PLAN_VERSION,
    packetDigest: options.packet.packetDigest,
    candidateSetDigest: options.packet.candidateSetDigest,
    reviewDigest: options.review.reviewDigest,
    unmaskAuditDigest: options.unmasked.auditDigest,
    blindId: selected.blindId,
    candidateId: selected.candidateId,
    baselineArtifact,
    baselineState,
    baselineEvidence: baseline.evidence,
    baselineMeasurements: baseline.measurements,
    route: options.route,
    runtime: options.runtime,
    allowedDiffs: options.allowedDiffs,
    forbiddenDiffs: options.forbiddenDiffs,
    captureSchedule: options.captureSchedule,
    causalPredicate: options.causalPredicate,
    hardFloors: options.hardFloors,
    critics: options.critics,
    treatment: selected.treatment,
  };
  const plan = freeze({ ...body, planDigest: sha256(JSON.stringify(body)) });
  AUTHENTIC_PLANS.add(plan);
  return plan;
}

function deriveDiffs(plan: ExperimentPlan, post: CreativeRevisionSnapshot): readonly DerivedDiff[] {
  const diffs: DerivedDiff[] = [];
  const collections = ['principles', 'graphElements', 'parameters'] as const;
  for (const collection of collections) {
    const baseline = plan.baselineState[collection];
    const observed = post[collection];
    const keys = new Set([...Object.keys(baseline), ...Object.keys(observed)]);
    for (const key of [...keys].sort()) {
      if (baseline[key] !== observed[key]) {
        diffs.push({ path: `${collection}.${key}`, before: baseline[key], after: observed[key] });
      }
    }
  }
  return freeze(diffs);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function planDigest(plan: ExperimentPlan): string {
  const { planDigest: _digest, ...body } = plan;
  return sha256(JSON.stringify(body));
}

/** Internal trust boundary for downstream governed-learning stages. */
export function assertAuthenticAttributableRevision(
  plan: ExperimentPlan,
  receipt: AttributableRevisionReceipt,
): void {
  const { receiptDigest, ...body } = receipt;
  if (!AUTHENTIC_PLANS.has(plan) || planDigest(plan) !== plan.planDigest) {
    throw new Error('EXPERIMENT_PLAN_PROVENANCE_INVALID');
  }
  if (!AUTHENTIC_REVISION_RECEIPTS.has(receipt)
    || sha256(JSON.stringify(body)) !== receiptDigest
    || receipt.planDigest !== plan.planDigest
    || receipt.treatmentId !== plan.treatment.id
    || receipt.improvementEstablished !== (receipt.outcome === 'experiment-improved')) {
    throw new Error('ATTRIBUTABLE_REVISION_RECEIPT_PROVENANCE_INVALID');
  }
}

/** Verify the independent blind preference that an attributable revision consumed. */
export function assertAuthenticIndependentBlindTreatmentPreference(
  plan: ExperimentPlan,
  receipt: AttributableRevisionReceipt,
  preference: IndependentBlindTreatmentPreference,
): void {
  assertAuthenticAttributableRevision(plan, receipt);
  const { receiptDigest, ...body } = preference;
  const artifacts = resolveAuthenticRevisionArtifacts(plan, receipt);
  if (!AUTHENTIC_TREATMENT_PREFERENCES.has(preference)
    || sha256(JSON.stringify(body)) !== receiptDigest
    || preference.planDigest !== plan.planDigest
    || preference.treatmentArtifactDigest !== artifacts.treatment.artifactDigest
    || receipt.blindTreatmentPreferenceDigest !== preference.receiptDigest) {
    throw new Error('INDEPENDENT_BLIND_TREATMENT_PREFERENCE_PROVENANCE_INVALID');
  }
}

/** Internal causal witness for the transfer-promotion experiment. */
export function resolveAuthenticRevisionArtifacts(
  plan: ExperimentPlan,
  receipt: AttributableRevisionReceipt,
): Readonly<{
  baseline: CanonicalCreativeArtifactEnvelope;
  treatment: CanonicalCreativeArtifactEnvelope;
}> {
  assertAuthenticAttributableRevision(plan, receipt);
  const artifacts = REVISION_ARTIFACTS.get(receipt);
  if (!artifacts || artifacts.baseline !== plan.baselineArtifact) {
    throw new Error('ATTRIBUTABLE_REVISION_ARTIFACT_WITNESS_INVALID');
  }
  assertAuthenticCanonicalArtifact(artifacts.baseline);
  assertAuthenticCanonicalArtifact(artifacts.treatment);
  return artifacts;
}

/** Internal trust boundary verifying a canonical artifact envelope's provenance. */
export function assertAuthenticCanonicalArtifact(
  artifact: CanonicalCreativeArtifactEnvelope,
): void {
  const { envelopeDigest, ...body } = artifact;
  if (!AUTHENTIC_ARTIFACTS.has(artifact)
    || sha256(JSON.stringify(body)) !== envelopeDigest
    || sha256(artifact.creativeBytes) !== artifact.creativeDigest
    || artifactDigest(artifact.creativeBytes) !== artifact.artifactDigest) {
    throw new Error('CANONICAL_ARTIFACT_PROVENANCE_INVALID');
  }
}

function validateInvariants(plan: ExperimentPlan, observed: ApplyAttributableRevisionOptions): string[] {
  const reasons: string[] = [];
  if (planDigest(plan) !== plan.planDigest) reasons.push('plan-digest-drift');
  if (!sameValue(observed.route, plan.route)) reasons.push('route-drift');
  if (!sameValue(observed.runtime, plan.runtime)) reasons.push('runtime-drift');
  if (!sameValue(observed.captureSchedule, plan.captureSchedule)) reasons.push('capture-schedule-drift');
  if (!sameValue(observed.causalPredicate, plan.causalPredicate)) reasons.push('causal-predicate-drift');
  return reasons;
}

function validateDiff(plan: ExperimentPlan, observed: ApplyAttributableRevisionOptions): string[] {
  const path = treatmentPath(plan.treatment);
  const diffs = deriveDiffs(plan, observed.postArtifact.state);
  if (diffs.length !== 1) return ['unrelated-diff'];
  const diff = diffs[0]!;
  if (plan.forbiddenDiffs.some((forbidden) => diff.path === forbidden
    || diff.path.startsWith(`${forbidden}.`))) return ['forbidden-diff'];
  const exact = diff.path === path && diff.before === plan.treatment.before
    && diff.after === plan.treatment.after;
  if (!exact || !plan.allowedDiffs.includes(diff.path)) return ['unrelated-diff'];
  return [];
}

function validateCanonicalEvidence(
  plan: ExperimentPlan,
  observed: ApplyAttributableRevisionOptions,
): string[] {
  const reasons: string[] = [];
  const post = observed.postArtifact;
  const { envelopeDigest, ...body } = post;
  const authentic = AUTHENTIC_ARTIFACTS.has(post)
    && sha256(JSON.stringify(body)) === envelopeDigest
    && sha256(post.creativeBytes) === post.creativeDigest
    && artifactDigest(post.creativeBytes) === post.artifactDigest
    && sha256(serializeCreativeRevisionState(post.state)) === post.stateDigest;
  if (!authentic) reasons.push('post-artifact-witness-invalid');
  if (post.sourceArtifactDigest !== plan.baselineArtifact.artifactDigest) {
    reasons.push('post-artifact-lineage-mismatch');
  }
  if (post.creativeDigest === plan.baselineArtifact.creativeDigest) {
    reasons.push('post-creative-artifact-unchanged');
  }
  return reasons;
}

function measurementFor(
  measurements: readonly DeterministicMeasurementReceipt[],
  metricId: string,
): DeterministicMeasurementReceipt | undefined {
  const matches = measurements.filter((measurement) => measurement.metricId === metricId);
  return matches.length === 1 ? matches[0] : undefined;
}

function measurementIsBound(
  plan: ExperimentPlan,
  artifact: CanonicalCreativeArtifactEnvelope,
  evidence: readonly CanonicalPostEvidence[],
  measurement: DeterministicMeasurementReceipt | undefined,
): measurement is DeterministicMeasurementReceipt {
  const baseline = plan.baselineMeasurements.find((item) => item.metricId === measurement?.metricId);
  return Boolean(measurement && baseline && AUTHENTIC_MEASUREMENTS.has(measurement)
    && Number.isFinite(measurement.value)
    && measurement.artifactDigest === artifact.artifactDigest
    && measurement.evaluatorId === baseline.evaluatorId
    && measurement.evaluatorVersion === baseline.evaluatorVersion
    && measurement.algorithm === baseline.algorithm
    && evidence.some((capture) => capture.artifactDigest === measurement.artifactDigest
      && capture.evidenceDigest === measurement.evidenceDigest
      && capture.captureId === measurement.captureId));
}

function validateCausalResult(
  plan: ExperimentPlan,
  artifact: CanonicalCreativeArtifactEnvelope,
  evidence: readonly CanonicalPostEvidence[],
  measurements: readonly DeterministicMeasurementReceipt[],
): string[] {
  const reasons: string[] = [];
  const predicate = plan.causalPredicate;
  const requiredMetrics = new Set([predicate.metricId, ...plan.hardFloors.map((floor) => floor.metricId)]);
  if (measurements.length !== requiredMetrics.size
    || new Set(measurements.map((item) => item.metricId)).size !== requiredMetrics.size
    || measurements.some((item) => !requiredMetrics.has(item.metricId))) {
    reasons.push('measurement-set-invalid');
  }
  const baseline = plan.baselineMeasurements.find((item) => item.metricId === predicate.metricId)!;
  const result = measurementFor(measurements, predicate.metricId);
  if (!measurementIsBound(plan, artifact, evidence, result)) {
    return [...reasons, 'causal-evidence-missing'];
  }
  const delta = predicate.direction === 'increase'
    ? result.value - baseline.value : baseline.value - result.value;
  if (delta < predicate.minimumDelta) reasons.push('causal-predicate-not-met');
  for (const floor of plan.hardFloors) {
    const measure = measurementFor(measurements, floor.metricId);
    if (!measurementIsBound(plan, artifact, evidence, measure) || measure.value < floor.minimum) {
      reasons.push(`hard-floor-regression:${floor.metricId}`);
    }
  }
  return reasons;
}

function authenticBlindTreatmentPreference(
  plan: ExperimentPlan,
  postArtifact: CanonicalCreativeArtifactEnvelope,
  preference: IndependentBlindTreatmentPreference,
): boolean {
  const { receiptDigest, ...body } = preference;
  return AUTHENTIC_TREATMENT_PREFERENCES.has(preference)
    && sha256(JSON.stringify(body)) === receiptDigest
    && preference.planDigest === plan.planDigest
    && preference.treatmentArtifactDigest === postArtifact.artifactDigest;
}

function validateBlindTreatmentPreference(
  plan: ExperimentPlan,
  postArtifact: CanonicalCreativeArtifactEnvelope,
  preference: IndependentBlindTreatmentPreference | undefined,
): string[] {
  if (!preference) return ['blind-treatment-preference-missing'];
  if (!authenticBlindTreatmentPreference(plan, postArtifact, preference)) {
    return ['blind-treatment-preference-invalid'];
  }
  if (preference.outcome === 'tie') return ['blind-treatment-preference-tie'];
  if (preference.outcome === 'baseline-preferred') return ['blind-treatment-preference-baseline'];
  return [];
}

function experimentOutcome(reasons: readonly string[]): ExperimentOutcome {
  if (reasons.length === 0) return 'experiment-improved';
  if (reasons.includes('blind-treatment-preference-baseline')
    || reasons.includes('causal-predicate-not-met')
    || reasons.some((reason) => reason.startsWith('hard-floor-regression:'))) {
    return 'experiment-regressed';
  }
  return 'experiment-inconclusive';
}

export interface AttributableRevisionSession {
  readonly plan: ExperimentPlan;
  apply(observed: ApplyAttributableRevisionOptions): AttributableRevisionReceipt;
}

class AttributableRevisionSessionImpl implements AttributableRevisionSession {
  readonly plan: ExperimentPlan;
  #consumed = false;

  constructor(plan: ExperimentPlan, capability: symbol) {
    if (capability !== SESSION_FACTORY_CAPABILITY || !AUTHENTIC_PLANS.has(plan)) {
      throw new Error('EXPERIMENT_PLAN_PROVENANCE_INVALID');
    }
    if (planDigest(plan) !== plan.planDigest) throw new Error('EXPERIMENT_PLAN_DIGEST_MISMATCH');
    this.plan = freeze(plan);
  }

  apply(observed: ApplyAttributableRevisionOptions): AttributableRevisionReceipt {
    if (this.#consumed) throw new Error('ATTRIBUTABLE_REVISION_ALREADY_CONSUMED');
    this.#consumed = true;
    const derived = deriveEvidenceBundle(
      observed.postArtifact,
      this.plan.captureSchedule,
      [this.plan.causalPredicate.metricId, ...this.plan.hardFloors.map((floor) => floor.metricId)],
    );
    const reasons = [
      ...validateInvariants(this.plan, observed),
      ...validateDiff(this.plan, observed),
      ...validateCanonicalEvidence(this.plan, observed),
      ...validateCausalResult(
        this.plan, observed.postArtifact, derived.evidence, derived.measurements,
      ),
      ...validateBlindTreatmentPreference(
        this.plan, observed.postArtifact, observed.independentBlindPreference,
      ),
    ];
    const revised = freeze({
      ...observed.postArtifact.state,
      artifactDigest: observed.postArtifact.artifactDigest,
    });
    const outcome = experimentOutcome(reasons);
    const blindTreatmentPreferenceDigest = observed.independentBlindPreference
      && authenticBlindTreatmentPreference(
        this.plan, observed.postArtifact, observed.independentBlindPreference,
      )
      ? observed.independentBlindPreference.receiptDigest : undefined;
    const body = {
      planDigest: this.plan.planDigest,
      treatmentId: this.plan.treatment.id,
      revisedState: revised,
      evidence: derived.evidence,
      measurements: derived.measurements,
      ...(blindTreatmentPreferenceDigest ? { blindTreatmentPreferenceDigest } : {}),
      outcome,
      improvementEstablished: outcome === 'experiment-improved',
      reasons: freeze(reasons),
    };
    const receipt = freeze({ ...body, receiptDigest: sha256(JSON.stringify(body)) });
    AUTHENTIC_REVISION_RECEIPTS.add(receipt);
    REVISION_ARTIFACTS.set(receipt, freeze({
      baseline: this.plan.baselineArtifact,
      treatment: observed.postArtifact,
    }));
    return receipt;
  }
}

export function createAttributableRevisionSession(
  options: CompileExperimentPlanOptions,
): AttributableRevisionSession {
  return new AttributableRevisionSessionImpl(
    compileExperimentPlan(options), SESSION_FACTORY_CAPABILITY,
  );
}
