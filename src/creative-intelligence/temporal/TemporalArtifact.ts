import { createHash } from 'node:crypto';
import {
  MOTION_TEMPORAL_CONTRACTS,
  type MotionTemporalPrincipleId,
} from './MotionTemporalContracts.js';
import {
  applyBoundedTemporalRevision,
  buildTemporalEvidence,
  temporalEvidenceDigest,
  type TemporalClockIdentity,
  type TemporalEvidence,
  type TemporalEvidenceBuildOptions,
  type TemporalRevisionApplyResult,
  type TemporalRevisionOperator,
  type TemporalSample,
  type TemporalSamplingSchedule,
} from './TemporalEvidence.js';
import {
  compileCreativeThesis,
  creativeThesisIdentity,
  embedCreativeThesisIdentity,
  projectCreativePrinciple,
  validateCreativeThesis,
  type CreativeThesis,
  type CreativeThesisIdentity,
} from '../CreativeIntelligence.js';

export const TEMPORAL_ARTIFACT_SCHEMA = 'sinter.temporal-artifact' as const;
export const TEMPORAL_ARTIFACT_VERSION = 1 as const;

/**
 * A revision apply request. The builder refuses to apply a revision whose
 * bound exceeds the operator's declared bound — the "bounded" half of
 * "bounded temporal revision."
 */
export interface TemporalArtifactRevisionRequest {
  readonly revisionId: string;
  readonly bound: number;
}

/**
 * Options for building a temporal artifact. The artifact is no-spend:
 * no provider reservation is consulted; the artifact is built deterministically
 * from the compiled thesis, principle, schedule, and clock.
 *
 * The builder compiles a Creative Thesis from `brief` (using the canonical
 * `compileCreativeThesis`) and refuses to build when that thesis is unsupported
 * or its principle is not a motion/time principle. Pass `thesis` to override
 * the compiled thesis (e.g. when a coordinator has already compiled one).
 */
export interface TemporalArtifactOptions {
  readonly brief: string;
  readonly thesis?: CreativeThesis;
  readonly artifactId?: string;
  readonly clock?: TemporalClockIdentity;
  readonly schedule?: Partial<TemporalSamplingSchedule>;
  readonly revisions?: readonly TemporalRevisionOperator[];
  readonly revisionApplications?: readonly TemporalArtifactRevisionRequest[];
  readonly sampleGenerator?: TemporalEvidenceBuildOptions['sampleGenerator'];
}

/**
 * Canonical revision operators that match the frozen motion/temporal contracts.
 * The builder applies these only when a matching request is supplied; they are
 * exposed as the canonical, contract-bound revisions callers should reuse.
 */
export const DEFAULT_TEMPORAL_REVISIONS: readonly TemporalRevisionOperator[] = Object.freeze([
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'refine-arc',
    kind: 'refine-arc' as const,
    label: 'Refine arc',
    description: 'Subdivide the arc into additional intermediate samples while preserving first and last sample identity.',
    boundedBy: 'sample-count' as const,
    bound: 16,
  }),
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'phase-shift',
    kind: 'phase-shift' as const,
    label: 'Phase shift',
    description: 'Rotate the sample order by a bounded number of samples.',
    boundedBy: 'sample-count' as const,
    bound: 4,
  }),
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'compress',
    kind: 'compress' as const,
    label: 'Compress',
    description: 'Reduce the visible sample count by a bounded amount while preserving the first and last sample.',
    boundedBy: 'sample-count' as const,
    bound: 4,
  }),
]);

/**
 * The recorded outcome of one revision apply. The `before/after` evidence lets
 * callers prove the revision produced an observable change in the artifact.
 * The entry is intentionally flat (`revisionId`/`bound` at the top level) so
 * callers and tests can audit the revision without reaching into the request.
 */
export interface TemporalArtifactRevisionLogEntry {
  readonly revisionId: string;
  readonly bound: number;
  readonly request: TemporalArtifactRevisionRequest;
  readonly apply: TemporalRevisionApplyResult;
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

export interface TemporalArtifact {
  readonly schema: typeof TEMPORAL_ARTIFACT_SCHEMA;
  readonly schemaVersion: typeof TEMPORAL_ARTIFACT_VERSION;
  readonly artifactId: string;
  readonly thesisId: string;
  readonly principleId: MotionTemporalPrincipleId;
  readonly contractVersion: number;
  readonly projectionDigest: string;
  readonly thesisIdentity: CreativeThesisIdentity;
  readonly brief: string;
  readonly html: string;
  readonly thesis: CreativeThesis;
  readonly evidence: TemporalEvidence;
  readonly revisions: readonly TemporalArtifactRevisionLogEntry[];
  readonly revisionLog: readonly TemporalArtifactRevisionLogEntry[];
  readonly evidenceDigest: string;
  readonly samplesDigest: string;
  readonly artifactDigest: string;
  readonly clockFingerprint: string;
  readonly observedChange: TemporalEvidence['observedChange'];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isMotionTemporalPrincipleId(id: string): id is MotionTemporalPrincipleId {
  return id === 'temporal-arc' || id === 'temporal-rhythm';
}

/**
 * Compile a Creative Thesis for the brief, then verify it carries a supported
 * motion/time principle. Throws "supported thesis" if the thesis is unsupported
 * — that message is the contract callers and tests rely on for the fail-closed
 * path.
 */
function compileMotionTemporalThesis(brief: string, supplied?: CreativeThesis): {
  thesis: CreativeThesis;
  principleId: MotionTemporalPrincipleId;
  contractVersion: number;
  projectionDigest: string;
} {
  const thesis = supplied ?? compileCreativeThesis(brief);
  const validated = validateCreativeThesis(thesis);
  if (validated.disposition !== 'supported') {
    throw new Error('Temporal artifact requires a supported Creative Thesis; unsupported briefs cannot govern a time-based artifact');
  }
  const principle = validated.principles.find((item) => item.disposition !== 'unsupported');
  if (!principle) throw new Error('Creative Thesis has no supported principle');
  const principleId = principle.contractIdentity.principleId;
  if (!isMotionTemporalPrincipleId(principleId)) {
    throw new Error(`Temporal artifact requires a motion/time principle; found '${principleId}'`);
  }
  return {
    thesis: validated,
    principleId,
    contractVersion: principle.contractIdentity.contractVersion,
    projectionDigest: principle.contractIdentity.projectionDigest,
  };
}

function assertContractProjection(principleId: MotionTemporalPrincipleId, projectionDigest: string): void {
  const contract = MOTION_TEMPORAL_CONTRACTS[principleId];
  const expected = digest(projectCreativePrinciple(contract));
  if (expected !== projectionDigest) {
    throw new Error(`Temporal artifact projection digest mismatch for ${principleId} (expected ${expected.slice(0, 12)}, got ${projectionDigest.slice(0, 12)})`);
  }
}

function sampleListLabel(index: number, total: number): string {
  if (index === 0) return 'First sample';
  if (index === total - 1) return 'Last sample';
  return `Sample ${index + 1}`;
}

function renderSchedule(schedule: TemporalSamplingSchedule): string {
  return [
    `<tr><th scope="row">schedule id</th><td>${htmlEscape(schedule.id)}</td></tr>`,
    `<tr><th scope="row">unit</th><td>${htmlEscape(schedule.unit)}</td></tr>`,
    `<tr><th scope="row">declared sample count</th><td>${schedule.sampleCount}</td></tr>`,
    `<tr><th scope="row">declared interval</th><td>${schedule.interval}</td></tr>`,
    `<tr><th scope="row">declared first t</th><td>${schedule.firstT}</td></tr>`,
    `<tr><th scope="row">declared last t</th><td>${schedule.lastT}</td></tr>`,
  ].join('');
}

function renderObservedSamples(samples: readonly TemporalSample[]): string {
  return samples
    .map((sample, index) => {
      const listLabel = sampleListLabel(index, samples.length);
      return `<tr class="temporal-sample"><td>${htmlEscape(sample.id)}</td><td>${sample.t}</td><td>${htmlEscape(sample.unit)}</td><td>${sample.value}</td><td>${htmlEscape(listLabel)}</td></tr>`;
    })
    .join('');
}

function renderRevisionLog(revisions: readonly TemporalArtifactRevisionLogEntry[]): string {
  if (revisions.length === 0) {
    return '<p>No bounded temporal revision was applied to this artifact.</p>';
  }
  return revisions
    .map((entry) => {
      const op = entry.apply.appliedRevision;
      return [
        `<section class="sinter-temporal-revision" data-revision-id="${htmlEscape(op.id)}" data-revision-kind="${htmlEscape(op.kind)}" data-bound="${entry.request.bound}">`,
        `<h3>Applied revision: ${htmlEscape(op.label)} (${htmlEscape(op.id)})</h3>`,
        `<p>Kind: ${htmlEscape(op.kind)}. Declared bound: ${op.bound}. Requested bound: ${entry.request.bound}. Previous sample count: ${entry.apply.previousRevisionCount}. Resulting sample count: ${entry.apply.evidence.samples.length}.</p>`,
        `<p>Revised (not observed) change: firstValue=${entry.apply.evidence.revisedChange?.firstValue}, lastValue=${entry.apply.evidence.revisedChange?.lastValue}, delta=${entry.apply.evidence.revisedChange?.delta}.</p>`,
        `<p>Evidence digest before: <code>${entry.beforeDigest}</code>. Evidence digest after: <code>${entry.afterDigest}</code>.</p>`,
        `</section>`,
      ].join('');
    })
    .join('');
}

function assembleHtml(args: {
  thesis: CreativeThesis;
  thesisIdentity: CreativeThesisIdentity;
  brief: string;
  principleId: MotionTemporalPrincipleId;
  evidence: TemporalEvidence;
  revisions: readonly TemporalArtifactRevisionLogEntry[];
}): string {
  const { thesis, thesisIdentity, brief, principleId, evidence, revisions } = args;
  const observedChangeRow = evidence.observedChange;
  const clockMeta = `<meta name="sinter-temporal-clock-id" content="${htmlEscape(evidence.clock.clockId)}"><meta name="sinter-temporal-clock-fingerprint" content="${htmlEscape(evidence.clock.fingerprint)}"><meta name="sinter-temporal-schedule-id" content="${htmlEscape(evidence.schedule.id)}">`;
  const head = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${htmlEscape(`Sinter temporal artifact — ${principleId}`)}</title>`,
    clockMeta,
    '<style>',
    'body{font-family:system-ui,Segoe UI,sans-serif;background:#0b0d10;color:#f4f6fb;margin:0;padding:32px;}',
    'main{max-width:920px;margin:0 auto;}',
    'table{border-collapse:collapse;width:100%;margin:16px 0;}',
    'th,td{border:1px solid #243b55;padding:8px 10px;text-align:left;font-size:14px;}',
    'th{background:#10141b;color:#9fb4d0;text-transform:uppercase;font-size:11px;letter-spacing:.08em;}',
    'section{margin:24px 0;padding:16px;border:1px solid #243b55;border-radius:8px;background:#0f1419;}',
    'code{background:#10141b;padding:2px 6px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
    '.sinter-temporal-stage{height:160px;border:1px dashed #2c4768;border-radius:8px;display:flex;align-items:flex-end;padding:8px;gap:4px;background:#06080b;}',
    '.sinter-temporal-stage .bar{flex:1;background:linear-gradient(0deg,#27e0ff,#0470a8);border-radius:3px 3px 0 0;}',
    '</style>',
    '</head>',
    '<body>',
  ].join('');
  const stageBars = evidence.samples
    .map((sample) => {
      const height = Math.max(4, Math.round(Math.abs(sample.value) * 100));
      return `<div class="bar" title="${htmlEscape(sample.id)} t=${sample.t} value=${sample.value}" style="height:${height}%"></div>`;
    })
    .join('');
  const body = [
    '<main>',
    `<h1>Sinter temporal artifact — ${htmlEscape(principleId)}</h1>`,
    `<p class="sinter-temporal-brief">Brief: ${htmlEscape(brief)}</p>`,
    '<section class="sinter-temporal-stage" aria-label="Observed temporal arc">',
    stageBars,
    '</section>',
    '<section>',
    '<h2>Artifact identity</h2>',
    '<table>',
    `<tr><th scope="row">artifact id</th><td>${htmlEscape(evidence.artifactId)}</td></tr>`,
    `<tr><th scope="row">thesis id</th><td>${htmlEscape(thesisIdentity.thesisId)}</td></tr>`,
    `<tr><th scope="row">principle id</th><td>${htmlEscape(thesisIdentity.principleId)}</td></tr>`,
    `<tr><th scope="row">contract version</th><td>${thesisIdentity.contractVersion}</td></tr>`,
    `<tr><th scope="row">projection digest</th><td><code>${thesisIdentity.projectionDigest}</code></td></tr>`,
    `<tr><th scope="row">evidence digest</th><td><code>${temporalEvidenceDigest(evidence)}</code></td></tr>`,
    '</table>',
    '</section>',
    '<section>',
    '<h2>Clock identity</h2>',
    '<table>',
    `<tr><th scope="row">clock id</th><td>${htmlEscape(evidence.clock.clockId)}</td></tr>`,
    `<tr><th scope="row">clock algorithm</th><td>${htmlEscape(evidence.clock.clockAlgorithm)}</td></tr>`,
    `<tr><th scope="row">clock epoch</th><td>${htmlEscape(evidence.clock.epoch)}</td></tr>`,
    `<tr><th scope="row">resolution ns</th><td>${evidence.clock.resolutionNs}</td></tr>`,
    `<tr><th scope="row">clock fingerprint</th><td><code>${evidence.clock.fingerprint}</code></td></tr>`,
    '</table>',
    '</section>',
    '<section>',
    '<h2>Declared sampling schedule (target)</h2>',
    '<table>',
    renderSchedule(evidence.schedule),
    '</table>',
    '</section>',
    '<section>',
    '<h2>Observed samples (measurement)</h2>',
    '<table>',
    '<thead><tr><th>sample id</th><th>t</th><th>unit</th><th>value</th><th>label</th></tr></thead>',
    '<tbody>',
    renderObservedSamples(evidence.samples),
    '</tbody>',
    '</table>',
    '</section>',
    '<section>',
    '<h2>Observed change over time</h2>',
    '<table>',
    `<tr><th scope="row">first value</th><td>${observedChangeRow.firstValue}</td></tr>`,
    `<tr><th scope="row">last value</th><td>${observedChangeRow.lastValue}</td></tr>`,
    `<tr><th scope="row">delta</th><td>${observedChangeRow.delta}</td></tr>`,
    `<tr><th scope="row">observed at sample</th><td>${observedChangeRow.observedAtSample}</td></tr>`,
    '</table>',
    '</section>',
    '<section>',
    '<h2>Bounded temporal revision</h2>',
    renderRevisionLog(revisions),
    '</section>',
    '<section>',
    '<h2>Revision log</h2>',
    revisions.length === 0
      ? '<p>No revision was applied to this artifact.</p>'
      : `<p>${revisions.length} revision(s) applied. Each entry is bound to a contract-declared operator and a bounded sample count.</p>`,
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');
  const html = head + body;
  return embedCreativeThesisIdentity(html, thesis);
}

function samplesDigest(samples: readonly TemporalSample[]): string {
  const material = JSON.stringify(samples.map((sample) => ({
    id: sample.id, t: sample.t, unit: sample.unit, value: sample.value, label: sample.label,
  })));
  return digest(material);
}

/**
 * Build a no-spend deterministic time-based artifact bound to a supported
 * motion/temporal principle. Throws if the thesis is unsupported, the principle
 * is not a motion/time principle, or the projection digest does not match the
 * canonical projection of the frozen contract.
 */
export function buildTemporalArtifact(options: TemporalArtifactOptions): TemporalArtifact {
  if ((options.revisionApplications?.length ?? 0) > 1) {
    throw new Error('Temporal artifact permits at most one revision');
  }
  const { thesis, principleId, contractVersion, projectionDigest } = compileMotionTemporalThesis(options.brief, options.thesis);
  assertContractProjection(principleId, projectionDigest);
  const thesisIdentity = creativeThesisIdentity(thesis);
  const artifactIdSeed = `${thesisIdentity.thesisId}|${principleId}|${contractVersion}|${projectionDigest}|${options.brief}`;
  const artifactId = options.artifactId ?? `temporal-artifact-${digest(artifactIdSeed).slice(0, 24)}`;
  const baseEvidence = buildTemporalEvidence({
    artifactId,
    thesisId: thesisIdentity.thesisId,
    principleId,
    contractVersion,
    projectionDigest,
    clock: options.clock,
    schedule: options.schedule,
    revisions: options.revisions,
    sampleGenerator: options.sampleGenerator,
  });
  const revisionLog: TemporalArtifactRevisionLogEntry[] = [];
  let evidence = baseEvidence;
  for (const request of options.revisionApplications ?? []) {
    const before = temporalEvidenceDigest(evidence);
    const apply = applyBoundedTemporalRevision({ evidence, revisionId: request.revisionId, bound: request.bound });
    const after = temporalEvidenceDigest(apply.evidence);
    evidence = apply.evidence;
    revisionLog.push({ revisionId: request.revisionId, bound: request.bound, request, apply, beforeDigest: before, afterDigest: after });
  }
  const html = assembleHtml({
    thesis,
    thesisIdentity,
    brief: options.brief,
    principleId,
    evidence,
    revisions: revisionLog,
  });
  const evidenceDigest = temporalEvidenceDigest(evidence);
  const samples = samplesDigest(evidence.samples);
  const artifactMaterial = JSON.stringify({
    schema: TEMPORAL_ARTIFACT_SCHEMA,
    schemaVersion: TEMPORAL_ARTIFACT_VERSION,
    artifactId,
    thesisId: thesisIdentity.thesisId,
    principleId,
    contractVersion,
    projectionDigest,
    evidenceDigest,
    samplesDigest: samples,
    revisionLog: revisionLog.map((entry) => ({
      revisionId: entry.request.revisionId,
      bound: entry.request.bound,
      beforeDigest: entry.beforeDigest,
      afterDigest: entry.afterDigest,
    })),
  });
  const artifactDigest = digest(artifactMaterial);
  return Object.freeze({
    schema: TEMPORAL_ARTIFACT_SCHEMA,
    schemaVersion: TEMPORAL_ARTIFACT_VERSION,
    artifactId,
    thesisId: thesisIdentity.thesisId,
    principleId,
    contractVersion,
    projectionDigest,
    thesisIdentity,
    brief: options.brief,
    html,
    thesis,
    evidence,
    revisions: Object.freeze(revisionLog),
    revisionLog: Object.freeze(revisionLog),
    evidenceDigest,
    samplesDigest: samples,
    artifactDigest,
    clockFingerprint: evidence.clock.fingerprint,
    observedChange: evidence.observedChange,
  });
}
