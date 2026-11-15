import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import * as revisionModule from '../../../src/creative-run/AttributableRevision.js';
import {
  createCanonicalCreativeArtifact,
  createAttributableRevisionSession,
  createIndependentBlindTreatmentPreference,
  assertAuthenticAttributableRevision,
  type ApplyAttributableRevisionOptions,
  type CausalIdentity,
  type CompileExperimentPlanOptions,
  type CriticContribution,
} from '../../../src/creative-run/AttributableRevision.js';
import { DurableCampaignClosureEvidenceRegistry } from '../../../src/creative-run/CampaignClosure.js';
import { createEnvelopeAuthority } from '../../../src/creative-run/OwnerQualityReview.js';
import {
  createBlindReviewSession,
  type BlindReviewJudgment,
  type CandidateEvidenceAssignment,
} from '../../../src/creative-run/BlindReviewEvidence.js';
import {
  buildCandidateManifest,
  type CandidateManifest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';
import { CreativeRunCoordinator } from '../../../src/creative-run/CreativeRunCoordinator.js';
import {
  FIGURE_GROUND_METRIC,
  FIGURE_GROUND_TARGET,
  WCAG_CONTRAST_METRIC,
} from '../../../src/creative-run/HtmlCssContrast.js';

const INTENT = 'A luminous field whose motion responds to a musical pulse and one accessible control.';
const BASELINE_HTML = '<!doctype html><html><head><title>candidate-1</title>'
  + '<style>body { color: #777777; background-color: #ffffff; }</style>'
  + '</head><body>A quiet field</body></html>';
const POST_HTML = BASELINE_HTML.replace('#777777', '#111111');

class MemoryEvidencePersistence {
  private readonly values = new Map<string, string>();
  async read(key: string) { return this.values.get(key) ?? null; }
  async write(key: string, value: string) { this.values.set(key, value); }
  async claim<T>(_key: string, work: () => Promise<T>) { return work(); }
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function contrastHtml(css: string, body = 'A quiet field'): string {
  return '<!doctype html><html><head><title>contrast fixture</title>'
    + `<style>${css}</style></head><body>${body}</body></html>`;
}

function identity(role: CausalIdentity['role'], suffix: string): CausalIdentity {
  return {
    role,
    provider: `provider-${suffix}`,
    model: `model-${suffix}`,
    pipe: `pipe-${suffix}`,
    effort: `effort-${suffix}`,
    contributionLineage: `lineage-${suffix}`,
    assignment: `assignment-${suffix}`,
  };
}

async function fixture(): Promise<CompileExperimentPlanOptions> {
  const thesis = buildCrossModalArtifact({ brief: INTENT, artifactId: 'revision-thesis' }).thesis;
  const generated = await buildCandidateManifest(INTENT, { creativeThesis: thesis });
  const candidates = generated.candidates.map((candidate, index) => {
    if (index !== 0) return candidate;
    const html = BASELINE_HTML.replace('candidate-1', candidate.id);
    return {
      ...candidate,
      artifact: { ...candidate.artifact, html, artifactDigest: sha(html).slice(0, 16) },
    };
  });
  const manifest = { ...generated, candidates } as CandidateManifest;
  const assignments: CandidateEvidenceAssignment[] = manifest.candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: ['visual', 'audio', 'motion', 'interaction'],
    generationIdentity: identity('generator', `generator-${index}`),
    crossModalArtifact: buildCrossModalArtifact({
      brief: INTENT,
      artifactId: `revision-cross-modal-${index}`,
      sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
      thesis,
    }),
  }));
  const session = createBlindReviewSession(manifest, assignments);
  const judgments: BlindReviewJudgment[] = session.packet.candidates.map((candidate) => ({
    blindId: candidate.blindId,
    outcome: 'pass',
    claims: candidate.media.map((media) => ({
      modality: media.modality,
      artifactDigest: candidate.artifactDigest,
      evidenceDigest: media.digest,
      claim: `${media.modality} exact evidence inspected`,
    })),
  }));
  const review = session.submitReview(session.packet, judgments);
  const unmasked = session.unmask();
  const candidate = session.packet.candidates[0]!;
  const claim = review.judgments[0]!.claims[0]!;
  const baselineHtml = BASELINE_HTML.replace('candidate-1', manifest.candidates[0]!.id);
  const postHtml = baselineHtml.replace('#777777', '#111111');
  const before = createCanonicalCreativeArtifact(
    baselineHtml, candidate.artifactDigest,
  ).analysis.contrastRatio;
  const after = createCanonicalCreativeArtifact(
    postHtml, candidate.artifactDigest,
  ).analysis.contrastRatio;
  const treatment = {
    id: 'increase-figure-ground',
    targetKind: 'principle' as const,
    targetId: FIGURE_GROUND_TARGET,
    before,
    after,
  };
  const critics: CriticContribution[] = [
    {
      id: 'specialist-contribution', identity: identity('specialist', 'specialist'),
      blindId: candidate.blindId, artifactDigest: candidate.artifactDigest,
      claims: [claim], treatment, priority: 2,
    },
    {
      id: 'holistic-contribution', identity: identity('holistic', 'holistic'),
      blindId: candidate.blindId, artifactDigest: candidate.artifactDigest,
      claims: [claim], treatment: { ...treatment, id: 'alternate-parameter',
        targetKind: 'parameter', targetId: 'density', before: 2, after: 3 }, priority: 1,
    },
  ];
  return {
    packet: session.packet, review, unmasked, critics,
    route: { provider: 'fixed-provider', model: 'fixed-model', pipe: 'fixed-pipe', effort: 'high' },
    runtime: { id: 'html-css-static-runtime', version: '1.0.0', seed: 'fixed-seed' },
    allowedDiffs: [`principles.${FIGURE_GROUND_TARGET}`],
    forbiddenDiffs: ['graphElements', 'parameters'],
    captureSchedule: [{ id: 'visual-final', atMs: 0, modality: 'visual' }],
    causalPredicate: { metricId: FIGURE_GROUND_METRIC, direction: 'increase', minimumDelta: 1 },
    hardFloors: [{ metricId: WCAG_CONTRAST_METRIC, minimum: 4.5 }],
  };
}

function validObserved(options: CompileExperimentPlanOptions): ApplyAttributableRevisionOptions {
  const candidate = options.packet.candidates[0]!;
  const postHtml = POST_HTML.replace('candidate-1', options.unmasked.mappings[0]!.candidateId);
  const postArtifact = createCanonicalCreativeArtifact(postHtml, candidate.artifactDigest);
  return {
    route: options.route,
    runtime: options.runtime,
    captureSchedule: options.captureSchedule,
    causalPredicate: options.causalPredicate,
    postArtifact,
    independentBlindPreference: createIndependentBlindTreatmentPreference(
      revisionModule.compileExperimentPlan(options), postArtifact,
      identity('specialist', 'independent-treatment-reviewer'), 'treatment-preferred',
    ),
  };
}

function changedIdentity(
  options: CompileExperimentPlanOptions,
  criticIndex: number,
  field: keyof CausalIdentity,
  value: string,
): CompileExperimentPlanOptions {
  const critics = structuredClone(options.critics) as CriticContribution[];
  critics[criticIndex] = {
    ...critics[criticIndex]!,
    identity: { ...critics[criticIndex]!.identity, [field]: value },
  };
  return { ...options, critics };
}

describe('AttributableRevision', () => {
  it('establishes one real HTML/CSS contrast improvement from exact artifact bytes', async () => {
    const options = await fixture();
    const session = new CreativeRunCoordinator().createAttributableRevisionSession(options);
    const receipt = session.apply(validObserved(options));

    expect(Object.isFrozen(session.plan)).toBe(true);
    expect(session.plan.baselineArtifact.analysis.foreground).toBe('#777777');
    expect(receipt.revisedState.principles[FIGURE_GROUND_TARGET]).toBeGreaterThan(18);
    expect(receipt.evidence[0]).toMatchObject({
      modality: 'visual',
      artifactDigest: receipt.revisedState.artifactDigest,
      slice: { foreground: '#111111', background: '#ffffff' },
    });
    expect(receipt.measurements.map((item) => item.metricId)).toEqual([
      FIGURE_GROUND_METRIC, WCAG_CONTRAST_METRIC,
    ]);
    expect(receipt.blindTreatmentPreferenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.improvementEstablished).toBe(true);
    expect(receipt.outcome).toBe('experiment-improved');
    expect(() => session.apply(validObserved(options))).toThrow(/ALREADY_CONSUMED/);
  });

  it('requires a sealed independent blind treatment preference for improvement', async () => {
    const options = await fixture();
    const observed = validObserved(options);
    const missing = createAttributableRevisionSession(options).apply({
      ...observed, independentBlindPreference: undefined,
    });
    expect(missing).toMatchObject({
      improvementEstablished: false,
      outcome: 'experiment-inconclusive',
      reasons: expect.arrayContaining(['blind-treatment-preference-missing']),
    });

    const tie = createIndependentBlindTreatmentPreference(
      revisionModule.compileExperimentPlan(options), observed.postArtifact,
      identity('holistic', 'independent-treatment-tie'), 'tie',
    );
    const tied = createAttributableRevisionSession(options).apply({
      ...observed, independentBlindPreference: tie,
    });
    expect(tied.outcome).toBe('experiment-inconclusive');
    expect(tied.reasons).toContain('blind-treatment-preference-tie');

    const baselinePreferred = createIndependentBlindTreatmentPreference(
      revisionModule.compileExperimentPlan(options), observed.postArtifact,
      identity('specialist', 'independent-treatment-baseline'), 'baseline-preferred',
    );
    expect(createAttributableRevisionSession(options).apply({
      ...observed, independentBlindPreference: baselinePreferred,
    }).outcome).toBe('experiment-regressed');
  });

  it('rejects a self-hashed revision receipt without host provenance', async () => {
    const options = await fixture();
    const session = createAttributableRevisionSession(options);
    const plan = session.plan;
    const receipt = createAttributableRevisionSession(options).apply(validObserved(options));
    const reloaded = structuredClone(receipt);

    expect(() => assertAuthenticAttributableRevision(plan, reloaded))
      .toThrow('ATTRIBUTABLE_REVISION_RECEIPT_PROVENANCE_INVALID');

    (reloaded as { outcome: 'experiment-regressed' }).outcome = 'experiment-regressed';
    expect(() => assertAuthenticAttributableRevision(plan, reloaded))
      .toThrow('ATTRIBUTABLE_REVISION_RECEIPT_PROVENANCE_INVALID');
  });

  it('persists a host-signed revision envelope that remains verifiable after restart', async () => {
    const options = await fixture();
    const session = createAttributableRevisionSession(options);
    const plan = session.plan;
    const observed = validObserved(options);
    const preference = createIndependentBlindTreatmentPreference(plan, observed.postArtifact,
      identity('specialist', 'independent'), 'treatment-preferred');
    const receipt = session.apply({ ...observed,
      independentBlindPreference: preference });
    const keys = generateKeyPairSync('ed25519');
    const authority = createEnvelopeAuthority({ keyId: 'closure-host',
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const persistence = new MemoryEvidencePersistence();
    const first = new DurableCampaignClosureEvidenceRegistry(persistence, authority, {} as never);
    await first.sealRevision({ id: 'revision-1', binding: { campaignRunId: 'run-1', manifestDigest: 'a'.repeat(64) },
      briefId: 'brief-1', plan, revision: receipt, blindPreference: preference });
    const restarted = new DurableCampaignClosureEvidenceRegistry(persistence, authority, {} as never);
    await expect(restarted.resolveRevision('revision-1')).resolves.toMatchObject({
      planDigest: plan.planDigest, treatmentId: plan.treatment.id,
      treatmentArtifactDigest: observed.postArtifact.artifactDigest,
    });
  });

  it('exposes no constructor or caller-authored evidence/metric mint', async () => {
    const options = await fixture();
    const authentic = revisionModule.compileExperimentPlan(options);
    const forged = structuredClone(authentic) as Record<string, unknown>;
    forged.critics = [];
    delete forged.planDigest;
    forged.planDigest = sha(JSON.stringify(forged));

    expect(revisionModule).not.toHaveProperty('AttributableRevisionSession');
    expect(revisionModule).not.toHaveProperty('canonicalCaptureEvidenceDigest');
    expect(revisionModule).not.toHaveProperty('evaluateCanonicalCapture');
    const session = createAttributableRevisionSession(options);
    const Constructor = (session as object).constructor as new (...args: unknown[]) => unknown;
    expect(() => new Constructor(forged)).toThrow(/PLAN_PROVENANCE_INVALID/);
    expect(() => new Constructor(authentic, Symbol('forged'))).toThrow(/PLAN_PROVENANCE_INVALID/);
  });

  it('requires the exact packet, review, and post-review unmask from one blind session', async () => {
    const options = await fixture();
    expect(() => createAttributableRevisionSession({
      ...options, unmasked: structuredClone(options.unmasked),
    })).toThrow(/UNMASK_PROVENANCE_INVALID/);
    expect(() => createAttributableRevisionSession({
      ...options, packet: structuredClone(options.packet),
    })).toThrow(/UNMASK_PROVENANCE_INVALID/);
    expect(() => createAttributableRevisionSession({
      ...options, review: structuredClone(options.review),
    })).toThrow(/UNMASK_PROVENANCE_INVALID/);
  });

  it.each(['provider', 'model', 'pipe', 'effort', 'contributionLineage', 'assignment'] as const)(
    'rejects %s overlap with generation lineage',
    async (field) => {
      const options = await fixture();
      const generator = options.unmasked.mappings[0]!.generationIdentity as Record<string, string>;
      expect(() => createAttributableRevisionSession(
        changedIdentity(options, 0, field, generator[field]!),
      )).toThrow(`IDENTITY_OVERLAP:${field}`);
    },
  );

  it('rejects missing identity dimensions and reviewer-to-reviewer overlap', async () => {
    const options = await fixture();
    expect(() => createAttributableRevisionSession(
      changedIdentity(options, 0, 'pipe', ''),
    )).toThrow(/IDENTITY_DIMENSION_MISSING:pipe/);
    expect(() => createAttributableRevisionSession(
      changedIdentity(options, 1, 'assignment', options.critics[0]!.identity.assignment),
    )).toThrow(/IDENTITY_OVERLAP:assignment/);
  });

  it('requires exactly one independent specialist and holistic critic', async () => {
    const options = await fixture();
    expect(() => createAttributableRevisionSession({ ...options, critics: [] }))
      .toThrow(/REQUIRES_SPECIALIST_AND_HOLISTIC_CRITICS/);
    const swapped = structuredClone(options.critics) as CriticContribution[];
    swapped[0] = { ...swapped[0]!, identity: { ...swapped[0]!.identity, role: 'holistic' } };
    expect(() => createAttributableRevisionSession({ ...options, critics: swapped }))
      .toThrow(/REQUIRES_SPECIALIST_AND_HOLISTIC_CRITICS/);
  });

  it('rejects tied priorities and missing or swapped critic evidence', async () => {
    const options = await fixture();
    const tied = structuredClone(options.critics) as CriticContribution[];
    tied[1] = { ...tied[1]!, priority: tied[0]!.priority };
    expect(() => createAttributableRevisionSession({ ...options, critics: tied }))
      .toThrow(/CRITIC_TREATMENT_TIE/);
    const missing = structuredClone(options.critics) as CriticContribution[];
    missing[0] = { ...missing[0]!, claims: [] };
    expect(() => createAttributableRevisionSession({ ...options, critics: missing }))
      .toThrow(/CRITIC_ARTIFACT_BINDING_MISMATCH/);
    const wrong = structuredClone(options.critics) as CriticContribution[];
    wrong[0] = { ...wrong[0]!, artifactDigest: 'wrong-artifact' };
    expect(() => createAttributableRevisionSession({ ...options, critics: wrong }))
      .toThrow(/CRITIC_ARTIFACT_BINDING_MISMATCH/);
    const swappedClaim = structuredClone(options.critics) as CriticContribution[];
    swappedClaim[0] = { ...swappedClaim[0]!, claims: [{
      ...swappedClaim[0]!.claims[0]!,
      evidenceDigest: options.packet.candidates[1]!.media[0]!.digest,
    }] };
    expect(() => createAttributableRevisionSession({ ...options, critics: swappedClaim }))
      .toThrow(/CRITIC_EVIDENCE_BINDING_MISMATCH/);
  });

  it('enforces the exact predeclared diff boundary and valid capture schedule', async () => {
    const options = await fixture();
    expect(() => createAttributableRevisionSession({
      ...options, allowedDiffs: ['principles.unrelated'],
    })).toThrow(/TREATMENT_DIFF_NOT_ALLOWED/);
    expect(() => createAttributableRevisionSession({
      ...options, forbiddenDiffs: [`principles.${FIGURE_GROUND_TARGET}`],
    })).toThrow(/TREATMENT_DIFF_NOT_ALLOWED/);
    expect(() => createAttributableRevisionSession({
      ...options, captureSchedule: [
        { id: 'duplicate', atMs: 0, modality: 'visual' },
        { id: 'duplicate', atMs: 1, modality: 'visual' },
      ],
    })).toThrow(/CAPTURE_SCHEDULE_INVALID/);
  });

  it('mints one exact artifact-bound capture per scheduled id/time/modality', async () => {
    const options = await fixture();
    const scheduled = { ...options, captureSchedule: [
      { id: 'visual-start', atMs: 0, modality: 'visual' as const },
      { id: 'visual-final', atMs: 4000, modality: 'visual' as const },
    ] };
    const receipt = createAttributableRevisionSession(scheduled).apply(validObserved(scheduled));
    expect(receipt.evidence.map(({ captureId, atMs, modality }) =>
      ({ captureId, atMs, modality }))).toEqual(scheduled.captureSchedule.map((capture) => ({
      captureId: capture.id, atMs: capture.atMs, modality: capture.modality,
    })));
    expect(new Set(receipt.evidence.map((item) => item.evidenceDigest)).size).toBe(2);
    expect(receipt.evidence.every((item) =>
      item.creativeDigest === validObserved(scheduled).postArtifact.creativeDigest)).toBe(true);
  });

  it('fails closed for unsupported treatment targets, metrics, and modalities', async () => {
    const options = await fixture();
    const critics = structuredClone(options.critics) as CriticContribution[];
    critics[1] = { ...critics[1]!, priority: 3 };
    expect(() => createAttributableRevisionSession({ ...options, critics }))
      .toThrow(/EXPERIMENT_TARGET_UNSUPPORTED/);
    expect(() => createAttributableRevisionSession({
      ...options,
      causalPredicate: { ...options.causalPredicate, metricId: 'clarity' },
    })).toThrow(/EXPERIMENT_METRIC_UNSUPPORTED/);
    expect(() => createAttributableRevisionSession({
      ...options,
      captureSchedule: [{ id: 'audio-final', atMs: 0, modality: 'audio' }],
    })).toThrow(/EXPERIMENT_CAPTURE_MODALITY_UNSUPPORTED/);
  });

  it.each([
    '<html><body>no style</body></html>',
    '<style>body { color: red; background-color: #fff; }</style><body></body>',
    '<style>body { color: #111; background: #fff; }</style><body></body>',
    '<style>body { color: var(--ink); background-color: #fff; }</style><body></body>',
    '<style>body { color: #111; background-color: #fff; color: #222; }</style><body></body>',
    '<style>body { color: #111; background-color: #fff; }</style><body style="color:#000"></body>',
    '<html><style media="print">body { color: #111; background-color: #fff; }</style><body></body></html>',
    '<html><style>body { color: #111; background-color: #fff; background: #000; }</style><body></body></html>',
    '<html><style>body { color: #111; background-color: #fff; } body.dark { color: #fff; }</style><body></body></html>',
    '<html><style>body { color: #111; background-color: #fff; }</style><body></body><script></script></html>',
  ])('rejects unsupported or unparseable HTML/CSS without inventing evidence', (html) => {
    expect(() => createCanonicalCreativeArtifact(html, 'source-digest'))
      .toThrow(/HTML_CSS_FIGURE_GROUND_UNSUPPORTED/);
  });

  it.each([
    ['opacity:0', 'body { color: #111; background-color: #fff; opacity:0; }', 'text'],
    ['background-image:linear-gradient',
      'body { color: #111; background-color: #fff; background-image:linear-gradient(#000,#000); }', 'text'],
    ['filter:brightness(0)',
      'body { color: #111; background-color: #fff; filter:brightness(0); }', 'text'],
    ['mix-blend-mode:difference',
      'body { color: #111; background-color: #fff; mix-blend-mode:difference; }', 'text'],
    ['visibility:hidden',
      'body { color: #111; background-color: #fff; visibility: hidden; }', 'text'],
    ['display:none', 'body { color: #111; background-color: #fff; display: none; }', 'text'],
    ['transform effect',
      'body { color: #111; background-color: #fff; transform: scale(0); }', 'text'],
    ['unknown layout declaration',
      'body { color: #111; background-color: #fff; margin: 0; }', 'text'],
    ['anchor override', 'body { color: #111; background-color: #fff; }', '<a href="#">text</a>'],
    ['font override', 'body { color: #111; background-color: #fff; }', '<font color="#fff">text</font>'],
    ['SVG paint', 'body { color: #111; background-color: #fff; }', '<svg><text>text</text></svg>'],
    ['canvas paint', 'body { color: #111; background-color: #fff; }', '<canvas></canvas>'],
    ['image paint', 'body { color: #111; background-color: #fff; }', '<img src="x">'],
    ['video paint', 'body { color: #111; background-color: #fff; }', '<video></video>'],
    ['audio element', 'body { color: #111; background-color: #fff; }', '<audio></audio>'],
    ['iframe paint', 'body { color: #111; background-color: #fff; }', '<iframe></iframe>'],
    ['custom element', 'body { color: #111; background-color: #fff; }', '<paint-layer></paint-layer>'],
    ['nested element', 'body { color: #111; background-color: #fff; }', '<span>text</span>'],
  ])('rejects Terra parser-spoof repro: %s', (_label, css, body) => {
    expect(() => createCanonicalCreativeArtifact(contrastHtml(css, body), 'source-digest'))
      .toThrow(/HTML_CSS_FIGURE_GROUND_UNSUPPORTED/);
  });

  it('derives state from bytes and rejects a cloned forged clear state', async () => {
    const options = await fixture();
    const observed = validObserved(options);
    const forged = structuredClone(observed.postArtifact);
    (forged.state.principles as Record<string, number>)[FIGURE_GROUND_TARGET] = 21;
    const receipt = createAttributableRevisionSession(options).apply({
      ...observed, postArtifact: forged,
    });
    expect(receipt.improvementEstablished).toBe(false);
    expect(receipt.reasons).toContain('post-artifact-witness-invalid');
  });

  it('does not treat inert comments or a score as causal improvement', async () => {
    const options = await fixture();
    const baseline = revisionModule.compileExperimentPlan(options).baselineArtifact;
    const commentOnly = createCanonicalCreativeArtifact(
      `${baseline.creativeBytes}\n<!-- unrelated bytes -->`, baseline.artifactDigest,
    );
    const receipt = createAttributableRevisionSession(options).apply({
      ...validObserved(options), postArtifact: commentOnly, score: 1,
    });
    expect(receipt.improvementEstablished).toBe(false);
    expect(receipt.reasons).toContain('unrelated-diff');
    expect(receipt.measurements[0]!.value).toBe(
      revisionModule.compileExperimentPlan(options).baselineMeasurements[0]!.value,
    );
  });

  it('rejects unchanged and retrograde contrast', async () => {
    const options = await fixture();
    const baseline = revisionModule.compileExperimentPlan(options).baselineArtifact;
    const unchanged = createCanonicalCreativeArtifact(
      baseline.creativeBytes, baseline.artifactDigest,
    );
    expect(createAttributableRevisionSession(options).apply({
      ...validObserved(options), postArtifact: unchanged,
    }).reasons).toContain('post-creative-artifact-unchanged');

    const retrogradeHtml = baseline.creativeBytes.replace('#777777', '#aaaaaa');
    const retrograde = createCanonicalCreativeArtifact(retrogradeHtml, baseline.artifactDigest);
    const receipt = createAttributableRevisionSession(options).apply({
      ...validObserved(options), postArtifact: retrograde,
    });
    expect(receipt.improvementEstablished).toBe(false);
    expect(receipt.reasons).toContain('unrelated-diff');
    expect(receipt.reasons).toContain('causal-predicate-not-met');
    expect(receipt.reasons).toContain(`hard-floor-regression:${WCAG_CONTRAST_METRIC}`);
  });

  it('ignores arbitrary caller evidence and derives its receipt from the post artifact', async () => {
    const options = await fixture();
    const observed = validObserved(options) as ApplyAttributableRevisionOptions & {
      evidence: unknown; measurements: unknown;
    };
    observed.evidence = [{ bytes: '~~~~~~~~~~~~~~~~', value: 1 }];
    observed.measurements = [{ metricId: FIGURE_GROUND_METRIC, value: 999 }];
    const receipt = createAttributableRevisionSession(options).apply(observed);
    expect(receipt.improvementEstablished).toBe(true);
    expect(receipt.measurements[0]!.value).toBeLessThan(21);
    expect(receipt.evidence[0]!.slice.foreground).toBe('#111111');
  });

  it.each([
    ['route-drift', (observed: ApplyAttributableRevisionOptions) => ({
      ...observed, route: { ...observed.route, model: 'changed-model' },
    })],
    ['runtime-drift', (observed: ApplyAttributableRevisionOptions) => ({
      ...observed, runtime: { ...observed.runtime, version: '2.0.0' },
    })],
    ['capture-schedule-drift', (observed: ApplyAttributableRevisionOptions) => ({
      ...observed, captureSchedule: [{ ...observed.captureSchedule[0]!, atMs: 1 }],
    })],
    ['causal-predicate-drift', (observed: ApplyAttributableRevisionOptions) => ({
      ...observed, causalPredicate: { ...observed.causalPredicate, minimumDelta: 2 },
    })],
  ] as const)('does not establish improvement after frozen %s', async (reason, alter) => {
    const options = await fixture();
    const receipt = createAttributableRevisionSession(options).apply(alter(validObserved(options)));
    expect(receipt.improvementEstablished).toBe(false);
    expect(receipt.reasons).toContain(reason);
  });

  it('rejects wrong lineage and forged envelopes', async () => {
    const options = await fixture();
    const observed = validObserved(options);
    const wrongLineage = createCanonicalCreativeArtifact(POST_HTML, 'unrelated-source');
    const lineageReceipt = createAttributableRevisionSession(options).apply({
      ...observed, postArtifact: wrongLineage,
    });
    expect(lineageReceipt.reasons).toContain('post-artifact-lineage-mismatch');

    const forged = structuredClone(observed.postArtifact);
    (forged as { creativeBytes: string }).creativeBytes = forged.creativeBytes.replace('#111111', '#000000');
    const forgedReceipt = createAttributableRevisionSession(options).apply({
      ...observed, postArtifact: forged,
    });
    expect(forgedReceipt.improvementEstablished).toBe(false);
    expect(forgedReceipt.reasons).toContain('post-artifact-witness-invalid');
  });
});
