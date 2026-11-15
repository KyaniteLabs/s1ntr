import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import {
  createCanonicalCreativeArtifact,
  createIndependentBlindTreatmentPreference,
  type CompileExperimentPlanOptions,
  type CriticContribution,
} from '../../../src/creative-run/AttributableRevision.js';
import type {
  BlindReviewJudgment, CandidateEvidenceAssignment,
} from '../../../src/creative-run/BlindReviewEvidence.js';
import {
  buildCandidateManifest, type CandidateManifest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';
import { CreativeRunCoordinator } from '../../../src/creative-run/CreativeRunCoordinator.js';
import { createArtistReviewSession } from '../../../src/creative-run/ArtistReviewExperience.js';
import { bootstrapCampaignClosureEvidenceAuthority,
  type CampaignClosurePersistence, type CampaignOwnerDecisionEvidence } from '../../../src/creative-run/CampaignClosure.js';
import { createCaptureAuthority, createEnvelopeAuthority } from '../../../src/creative-run/OwnerQualityReview.js';
import { formatArtistReviewState } from '../../../src/cli/ArtistReviewCli.js';
import { TuiBridgeServer } from '../../../src/tui-bridge/TuiBridgeServer.js';
import {
  TuiBridgeService,
  type BridgeHostAuthorityRegistry,
} from '../../../src/tui-bridge/TuiBridgeService.js';
import {
  FIGURE_GROUND_METRIC, FIGURE_GROUND_TARGET, WCAG_CONTRAST_METRIC,
} from '../../../src/creative-run/HtmlCssContrast.js';
import type {
  MutationCounters, OwnerAuthorityCapability, TrustedAuthorityAssertion,
} from '../../../src/creative-run/CreativeRunCoordinator.js';

const INTENT = 'A luminous field whose motion responds to a musical pulse.';
const NOW = '2026-08-01T12:00:00.000Z';
const BASELINE = '<!doctype html><html><head><title>candidate-1</title>'
  + '<style>body { color: #777777; background-color: #ffffff; }</style>'
  + '</head><body>A quiet field</body></html>';
const PROMOTION_TREATMENT = '<!doctype html><html><head><title>Aurora</title><style>'
  + 'body{color:#eaf4ff;background-color:#112244;display:grid;padding:24px;}'
  + 'section{width:70vw;height:60vh;transform:rotate(2deg);animation:tide 7s ease-in-out infinite;}'
  + '@keyframes tide{from{opacity:.4}to{opacity:1}}</style></head>'
  + '<body><section>Aurora tide opens into quiet blue space</section></body></html>';
const PROMOTION_CONTROL = '<!doctype html><html><head><title>Ember</title><style>'
  + 'body{color:#fff1dd;background-color:#553311;display:flex;margin:12px;}'
  + 'main{border-radius:50%;transition:opacity 2s linear;}</style></head>'
  + '<body><main><div>Amber stones gather around a warm center</div></main></body></html>';
const ZERO: MutationCounters = {
  tasteWrites: 0, modelTrainingWrites: 0, ruleWrites: 0, contextWrites: 0,
};
const KEYS = generateKeyPairSync('ed25519');
const PUBLIC_KEY = KEYS.publicKey.export({ format: 'pem', type: 'spki' }).toString();
let assertionNonce = 0;

class ClosurePersistence implements CampaignClosurePersistence {
  readonly records = new Map<string, string>();
  async read(key: string): Promise<string | null> { return this.records.get(key) ?? null; }
  async write(key: string, data: string): Promise<void> { this.records.set(key, data); }
  async claim<T>(_key: string, operation: () => Promise<T>): Promise<T> { return operation(); }
}

function assertion(role: 'owner' | 'issuer' | 'reviewer'): TrustedAuthorityAssertion {
  const body = {
    schema: 'sinter.application-authority-assertion' as const, schemaVersion: 1 as const,
    registryId: 'artist-review-registry', principalId: `${role}-principal`, role,
    issuedAt: '2026-08-01T11:00:00.000Z', expiresAt: '2026-08-02T11:00:00.000Z',
    nonce: `${role}-${assertionNonce += 1}`,
  };
  return { ...body, signatureBase64: sign(
    null, Buffer.from(JSON.stringify(body)), KEYS.privateKey,
  ).toString('base64') };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function identity(role: 'generator' | 'specialist' | 'holistic', id: string) {
  return {
    role, provider: `provider-${id}`, model: `model-${id}`, pipe: `pipe-${id}`,
    effort: `effort-${id}`, contributionLineage: `lineage-${id}`, assignment: `assignment-${id}`,
  } as const;
}

function judgments(
  candidates: readonly { readonly blindId: string; readonly artifactDigest: string;
    readonly media: readonly { readonly modality: 'visual' | 'audio' | 'motion' | 'interaction';
      readonly digest: string }[] }[],
): BlindReviewJudgment[] {
  return candidates.map((candidate) => ({
    blindId: candidate.blindId, outcome: 'pass',
    claims: candidate.media.map((media) => ({
      modality: media.modality, artifactDigest: candidate.artifactDigest,
      evidenceDigest: media.digest, claim: `${media.modality} exact evidence inspected`,
    })),
  }));
}

async function fixture(
  sessionId = 'studio-review-1',
  now: () => string = () => NOW,
  failedCandidate = false,
  transferFailure = false,
) {
  const coordinator = new CreativeRunCoordinator({
    now: () => NOW,
    ownerAuthority: { registryId: 'artist-review-registry', publicKeyPem: PUBLIC_KEY,
      applicationBoundary: 'test-application-boundary',
      ...(transferFailure ? { testOnlyTransactionFailure: 'after-mutation' as const } : {}) },
    transferCandidateGenerator: ({ arm }) => arm === 'treatment'
      ? PROMOTION_TREATMENT : PROMOTION_CONTROL,
  });
  const ownerCapability = coordinator.acceptOwnerAuthorityCapability(assertion('owner'));
  const issuerCapability = coordinator.acceptOwnerAuthorityCapability(assertion('issuer'));
  const reviewerCapability = coordinator.acceptOwnerAuthorityCapability(assertion('reviewer'));
  const thesis = buildCrossModalArtifact({ brief: INTENT, artifactId: 'review-thesis' }).thesis;
  const generated = await buildCandidateManifest(INTENT, { creativeThesis: thesis });
  const candidates = generated.candidates.map((candidate, index) => {
    if (index !== 0) return candidate;
    const html = BASELINE.replace('candidate-1', candidate.id);
    return { ...candidate, artifact: {
      ...candidate.artifact, html, artifactDigest: digest(html).slice(0, 16),
    } };
  });
  const manifest = { ...generated, candidates } as CandidateManifest;
  const assignments: CandidateEvidenceAssignment[] = manifest.candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: ['visual', 'audio', 'motion', 'interaction'],
    generationIdentity: identity('generator', `generator-${index}`),
    ...(failedCandidate && index === manifest.candidates.length - 1
      ? { failure: 'canonical render failed' } : {}),
    ...(failedCandidate && index === manifest.candidates.length - 1 ? {} : {
      crossModalArtifact: buildCrossModalArtifact({
        brief: INTENT, artifactId: `cross-modal-${index}`,
        sourceCandidateArtifactDigest: candidate.artifact.artifactDigest, thesis,
      }),
    }),
  }));
  const blind = coordinator.createBlindReviewSession(manifest, assignments);
  const review = blind.submitReview(blind.packet, judgments(blind.packet.candidates));
  const unmasked = blind.unmask();
  const evidence = blind.packet.candidates[0]!;
  const claim = review.judgments[0]!.claims[0]!;
  const baselineHtml = BASELINE.replace('candidate-1', manifest.candidates[0]!.id);
  const postHtml = baselineHtml.replace('#777777', '#111111');
  const before = createCanonicalCreativeArtifact(
    baselineHtml, evidence.artifactDigest,
  ).analysis.contrastRatio;
  const after = createCanonicalCreativeArtifact(
    postHtml, evidence.artifactDigest,
  ).analysis.contrastRatio;
  const treatment = {
    id: 'increase-figure-ground', targetKind: 'principle' as const,
    targetId: FIGURE_GROUND_TARGET, before, after,
  };
  const critics: CriticContribution[] = [
    { id: 'specialist', identity: identity('specialist', 'specialist'),
      blindId: evidence.blindId, artifactDigest: evidence.artifactDigest,
      claims: [claim], treatment, priority: 2 },
    { id: 'holistic', identity: identity('holistic', 'holistic'),
      blindId: evidence.blindId, artifactDigest: evidence.artifactDigest,
      claims: [claim], treatment: { ...treatment, id: 'density-alternative',
        targetKind: 'parameter', targetId: 'density', before: 2, after: 3 }, priority: 1 },
  ];
  const planOptions: CompileExperimentPlanOptions = {
    packet: blind.packet, review, unmasked, critics,
    route: { provider: 'fixed-provider', model: 'fixed-model', pipe: 'fixed-pipe', effort: 'high' },
    runtime: { id: 'html-css-static-runtime', version: '1.0.0', seed: 'fixed-seed' },
    allowedDiffs: [`principles.${FIGURE_GROUND_TARGET}`],
    forbiddenDiffs: ['graphElements', 'parameters'],
    captureSchedule: [{ id: 'visual-final', atMs: 0, modality: 'visual' }],
    causalPredicate: { metricId: FIGURE_GROUND_METRIC, direction: 'increase', minimumDelta: 1 },
    hardFloors: [{ metricId: WCAG_CONTRAST_METRIC, minimum: 4.5 }],
  };
  const revisionSession = coordinator.createAttributableRevisionSession(planOptions);
  const postArtifact = createCanonicalCreativeArtifact(postHtml, evidence.artifactDigest);
  const independentBlindPreference = createIndependentBlindTreatmentPreference(
    revisionSession.plan, postArtifact,
    identity('specialist', 'independent-treatment-reviewer'), 'treatment-preferred',
  );
  const revision = revisionSession.apply({
    route: planOptions.route, runtime: planOptions.runtime,
    captureSchedule: planOptions.captureSchedule, causalPredicate: planOptions.causalPredicate,
    postArtifact,
    independentBlindPreference,
  });
  const authority = coordinator.createOwnerLearningAuthoritySession({
    packet: blind.packet, review, unmasked,
    experimentPlan: revisionSession.plan, revisionReceipt: revision, now: () => NOW,
  });
  let nonce = 0;
  const artistBootstrap = {
    manifest, packet: blind.packet, review, unmasked,
    plan: revisionSession.plan, revision, authority, now,
    tokenSecret: Buffer.alloc(32, 7), nonce: () => `action-${nonce += 1}`,
  };
  const artist = createArtistReviewSession({ sessionId, ...artistBootstrap });
  const capabilities = { ownerCapability, issuerCapability };
  return {
    coordinator, artist, artistBootstrap, authority, capabilities, reviewerCapability,
    manifest, packet: blind.packet,
    review, unmasked, plan: revisionSession.plan, revision, independentBlindPreference,
  };
}

describe('ArtistReviewExperience', () => {
  it('uses exact canonical media and gives Studio and CLI one digest', async () => {
    const source = await fixture();
    const state = source.artist.state();
    const output = formatArtistReviewState(state);

    expect(Object.isFrozen(state)).toBe(true);
    expect(state.contactSheetHtml).toBe(source.packet.contactSheetHtml);
    expect(state.playableMedia).toBe(source.packet.playableMedia);
    expect(state.candidates.map((item) => item.artifactDigest))
      .toEqual(source.packet.candidates.map((item) => item.artifactDigest));
    expect(output).toContain(`State: v0 ${state.stateDigest}`);
    expect(output).toContain('THREE SEPARATE OWNER DECISIONS');
    expect(output).toContain('Storage boundary: artist-review transaction memory only');
  });

  it('constructs the authentic review during normal bridge session bootstrap', async () => {
    const source = await fixture('source-review');
    const service = new TuiBridgeService();
    const server = new TuiBridgeServer(service, { host: '127.0.0.1', port: 0 });
    try {
      expect(() => service.issueArtistReviewBootstrap({
        ...source.artistBootstrap,
        packet: { ...source.packet, packetDigest: 'caller-authored' },
      })).toThrow('BLIND_REVIEW_UNMASK_PROVENANCE_INVALID');
      const grant = service.issueArtistReviewBootstrap(source.artistBootstrap);
      await server.start();
      const created = await fetch(`${server.address}/api/tui/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistReviewGrant: grant }),
      });
      expect(created.status).toBe(201);
      const session = await created.json() as { sessionId: string };
      const state = service.getArtistReviewState(session.sessionId);

      expect(state.stateDigest).toBe(source.artist.state().stateDigest);
      const responseFromStudio = await fetch(
        `${server.address}/api/tui/session/${session.sessionId}/artist-review`,
      );
      expect(await responseFromStudio.json()).toMatchObject({ stateDigest: state.stateDigest });
      await service.submitInput(session.sessionId, { mode: 'chat', text: '/artist-review' });
      const response = service.getEvents(session.sessionId)
        .filter((event) => event.type === 'response.completed').at(-1);
      expect(response).toMatchObject({ type: 'response.completed' });
      expect(JSON.stringify(response)).toContain(`State: v0 ${state.stateDigest}`);

      const replay = await fetch(`${server.address}/api/tui/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistReviewGrant: grant }),
      });
      expect(replay.status).toBe(403);
      const fake = await fetch(`${server.address}/api/tui/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistReview: { packetDigest: 'caller-authored' } }),
      });
      expect(fake.status).toBe(400);
    } finally {
      await server.stop();
      service.destroy();
    }
  });

  it('drives staged transfer promotion through ordinary HTTP and CLI checkpoints', async () => {
    const source = await fixture('promotion-http');
    const authorizedSessions = new Set<string>();
    const actors = new Map([
      ['owner-auth', { principalId: 'owner-principal', role: 'owner' as const,
        capability: source.capabilities.ownerCapability }],
      ['issuer-auth', { principalId: 'issuer-principal', role: 'issuer' as const,
        capability: source.capabilities.issuerCapability }],
      ['reviewer-auth', { principalId: 'reviewer-principal', role: 'reviewer' as const,
        capability: source.reviewerCapability }],
    ]);
    const hostAuthorityRegistry: BridgeHostAuthorityRegistry = {
      resolveActor: ({ sessionId: claimedSession, credential }) =>
        authorizedSessions.has(claimedSession) ? actors.get(credential) : undefined,
    };
    const bridgeClock = { value: NOW };
    const service = new TuiBridgeService({
      creativeRunCoordinator: source.coordinator, hostAuthorityRegistry,
      now: () => bridgeClock.value,
    });
    const server = new TuiBridgeServer(service, { host: '127.0.0.1', port: 0 });
    try {
      const grant = service.issueArtistReviewBootstrap({
        ...source.artistBootstrap,
        promotionReviewerCapability: source.reviewerCapability,
        promotionRenderGate: false,
      });
      await server.start();
      const created = await fetch(`${server.address}/api/tui/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistReviewGrant: grant }),
      });
      const { sessionId } = await created.json() as { sessionId: string };
      authorizedSessions.add(sessionId);
      const otherGrant = service.issueArtistReviewBootstrap({
        ...source.artistBootstrap,
        promotionReviewerCapability: source.reviewerCapability,
        promotionRenderGate: false,
      });
      const otherCreated = await fetch(`${server.address}/api/tui/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistReviewGrant: otherGrant }),
      });
      const other = await otherCreated.json() as { sessionId: string };
      const crossSession = await fetch(
        `${server.address}/api/tui/session/${other.sessionId}/artist-review/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth',
            'X-Sinter-Issuer-Authorization': 'Bearer issuer-auth' },
          body: JSON.stringify({ action: { kind: 'learning', operation: 'stage',
            ruleId: FIGURE_GROUND_TARGET, expiresAt: '2026-08-02T11:00:00.000Z' } }),
        },
      );
      expect(crossSession.status).toBe(403);

      const pair = source.packet.candidates.slice(0, 2);
      const crossTokenIssued = await fetch(
        `${server.address}/api/tui/session/${sessionId}/artist-review/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ action: { kind: 'preference',
            blindIds: [pair[0]!.blindId, pair[1]!.blindId], outcome: 'tie' } }),
        },
      );
      const crossToken = await crossTokenIssued.json() as { token: string };
      const crossConsume = await fetch(
        `${server.address}/api/tui/session/${other.sessionId}/artist-review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ token: crossToken.token }),
        },
      );
      expect(crossConsume.status).toBe(403);

      const expiring = await fetch(
        `${server.address}/api/tui/session/${sessionId}/artist-review/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ action: { kind: 'preference',
            blindIds: [pair[0]!.blindId, pair[1]!.blindId], outcome: 'tie' } }),
        },
      );
      expect(expiring.status).toBe(201);
      const expiredCheckpoint = await expiring.json() as { token: string };
      bridgeClock.value = '2026-08-01T12:03:00.000Z';
      const expired = await fetch(`${server.address}/api/tui/session/${sessionId}/artist-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: 'Bearer owner-auth' },
        body: JSON.stringify({ token: expiredCheckpoint.token }),
      });
      expect(expired.status).toBe(403);
      bridgeClock.value = NOW;

      const missingAuth = await fetch(
        `${server.address}/api/tui/session/${sessionId}/artist-review/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: { kind: 'learning', operation: 'stage',
            ruleId: FIGURE_GROUND_TARGET, expiresAt: '2026-08-02T11:00:00.000Z' } }),
        },
      );
      expect(missingAuth.status).toBe(401);
      const wrongRole = await fetch(
        `${server.address}/api/tui/session/${sessionId}/artist-review/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer reviewer-auth',
            'X-Sinter-Issuer-Authorization': 'Bearer issuer-auth' },
          body: JSON.stringify({ action: { kind: 'learning', operation: 'stage',
            ruleId: FIGURE_GROUND_TARGET, expiresAt: '2026-08-02T11:00:00.000Z' } }),
        },
      );
      expect(wrongRole.status).toBe(403);
      const issueStage = () => fetch(
        `${server.address}/api/tui/session/${sessionId}/artist-review/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth',
            'X-Sinter-Issuer-Authorization': 'Bearer issuer-auth' },
          body: JSON.stringify({ action: { kind: 'learning', operation: 'stage',
            ruleId: FIGURE_GROUND_TARGET, expiresAt: '2026-08-02T11:00:00.000Z' } }),
        },
      );
      const issuedStage = await issueStage();
      expect(issuedStage.status).toBe(201);
      const missingStage = await issuedStage.json() as { token: string };
      const missingConsumptionAuth = await fetch(
        `${server.address}/api/tui/session/${sessionId}/artist-review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: missingStage.token }),
        },
      );
      expect(missingConsumptionAuth.status).toBe(403);
      expect(await missingConsumptionAuth.json()).toEqual({
        error: 'Artist review action could not be verified.',
      });

      const wrongStage = await (await issueStage()).json() as { token: string };
      const wrongConsumptionOwner = await fetch(
        `${server.address}/api/tui/session/${sessionId}/artist-review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer reviewer-auth' },
          body: JSON.stringify({ token: wrongStage.token }),
        },
      );
      expect(wrongConsumptionOwner.status).toBe(403);
      expect(await wrongConsumptionOwner.json()).toEqual({
        error: 'Artist review action could not be verified.',
      });

      const crossStage = await (await issueStage()).json() as { token: string };
      const crossStageConsumption = await fetch(
        `${server.address}/api/tui/session/${other.sessionId}/artist-review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ token: crossStage.token }),
        },
      );
      expect(crossStageConsumption.status).toBe(403);
      expect(await crossStageConsumption.json()).toEqual({
        error: 'Artist review action could not be verified.',
      });

      const correctStage = await issueStage();
      expect(correctStage.status).toBe(201);
      const { token: stageToken } = await correctStage.json() as { token: string };
      const staged = await fetch(`${server.address}/api/tui/session/${sessionId}/artist-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: 'Bearer owner-auth' },
        body: JSON.stringify({ token: stageToken }),
      });
      expect(await staged.json()).toMatchObject({
        accepted: true, state: { decisions: { learning: { status: 'staged' } } },
      });
      const replayStage = await fetch(`${server.address}/api/tui/session/${sessionId}/artist-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: 'Bearer owner-auth' },
        body: JSON.stringify({ token: stageToken }),
      });
      expect(replayStage.status).toBe(403);

      const hostileOpen = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion/open`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ treatmentHtml: '<html>caller evidence</html>' }),
        },
      );
      expect(hostileOpen.status).toBe(400);
      await service.submitInput(sessionId, {
        mode: 'chat', text: '/transfer-promotion open',
      });
      const cliOpen = service.getEvents(sessionId)
        .filter((event) => event.type === 'response.completed').at(-1);
      expect(JSON.stringify(cliOpen)).toContain('requires authenticated UI/API issuance');
      const opened = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion/open`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' }, body: '{}',
        },
      );
      expect(opened.status).toBe(200);
      const openState = await opened.json() as {
        status: string; packet: { candidates: Array<{
          blindId: string; media: Array<{ playableUri: string }>;
        }> };
      };
      expect(openState.status).toBe('review-open');
      const treatment = openState.packet.candidates.find((candidate) => {
        const outer = Buffer.from(candidate.media[0]!.playableUri.split(',')[1]!, 'base64').toString();
        return [...outer.matchAll(/data:text\/html;base64,([A-Za-z0-9+/=]+)/g)]
          .some((match) => Buffer.from(match[1]!, 'base64').toString().includes('Aurora tide'));
      });
      expect(treatment?.blindId).toMatch(/^blind-[a-f0-9]{24}$/);

      const wrongReviewer = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ kind: 'reviewer' }),
        },
      );
      expect(wrongReviewer.status).toBe(403);
      const issuedReviewer = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer reviewer-auth' },
          body: JSON.stringify({ kind: 'reviewer' }),
        },
      );
      expect(issuedReviewer.status).toBe(201);
      const { token: reviewerToken } = await issuedReviewer.json() as { token: string };
      const reviewed = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer reviewer-auth' },
          body: JSON.stringify({ token: reviewerToken, preferredBlindId: treatment!.blindId,
            claim: 'independent reviewer prefers the treatment' }),
        },
      );
      expect(await reviewed.json()).toMatchObject({ status: 'awaiting-owner' });

      const replayReview = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer reviewer-auth' },
          body: JSON.stringify({ token: reviewerToken, preferredBlindId: treatment!.blindId,
            claim: 'replay must fail' }),
        },
      );
      expect(replayReview.status).toBe(403);

      const issuedOwner = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ kind: 'owner' }),
        },
      );
      expect(issuedOwner.status).toBe(201);
      const { token: ownerToken } = await issuedOwner.json() as { token: string };
      const decided = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ token: ownerToken, preferredArtifact: 'treatment',
            claim: 'owner confirms the treatment on the unseen brief' }),
        },
      );
      expect(await decided.json()).toMatchObject({
        status: 'preferred', decision: { reason: 'TREATMENT_PREFERRED' },
      });
      expect(source.coordinator.ordinaryCreateContext().rules).toEqual({});

      const issuedPromote = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion/checkpoints`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ kind: 'promote' }),
        },
      );
      expect(issuedPromote.status).toBe(201);
      const { token: promoteToken } = await issuedPromote.json() as { token: string };
      const promoted = await fetch(
        `${server.address}/api/tui/session/${sessionId}/transfer-promotion`, {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer owner-auth' },
          body: JSON.stringify({ token: promoteToken }),
        },
      );
      expect(await promoted.json()).toMatchObject({
        status: 'promoted', receipt: { reason: 'PROMOTED' },
      });
      expect(source.coordinator.ordinaryCreateContext().rules)
        .toHaveProperty(FIGURE_GROUND_TARGET);

      await service.submitInput(sessionId, { mode: 'chat', text: '/transfer-promotion' });
      const cli = service.getEvents(sessionId)
        .filter((event) => event.type === 'response.completed').at(-1);
      expect(JSON.stringify(cli)).toContain('PREFERRED');
    } finally {
      await server.stop();
      service.destroy();
    }
  });

  it('shows failed candidates without synthetic substitution', async () => {
    const source = await fixture('studio-failure', () => NOW, true);
    const state = source.artist.state();
    const failed = state.candidates.find((candidate) => candidate.status === 'failed')!;

    expect(failed).toMatchObject({ failure: 'canonical render failed' });
    expect(failed.media).toBe(source.packet.candidates.at(-1)!.media);
    expect(failed.missingMedia).toEqual(['audio', 'motion', 'interaction']);
    expect(failed.review).toBe('inconclusive');
    expect(state.contactSheetHtml).toContain('canonical render failed');
    expect(state.readiness.reviewComplete).toBe(false);
  });

  it('keeps preference, release, and learning separate and rejects stale/replayed actions', async () => {
    const source = await fixture();
    const pair = source.packet.candidates.slice(0, 2);
    const preference = source.artist.issueActionToken({
      kind: 'preference', blindIds: [pair[0]!.blindId, pair[1]!.blindId],
      outcome: 'preferred', winnerBlindId: pair[0]!.blindId,
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    const mapping = source.unmasked.mappings[0]!;
    const evidence = source.packet.candidates.find((item) => item.blindId === mapping.blindId)!;
    const stale = source.artist.issueActionToken({
      kind: 'release', candidateId: mapping.candidateId,
      artifactDigest: evidence.artifactDigest, decision: 'release-worthy',
    }, source.capabilities, '2026-08-01T13:00:00.000Z');

    expect(source.artist.executeAction(preference).accepted).toBe(true);
    expect(source.artist.state().decisions).toMatchObject({
      preference: 'preferred', release: 'not-decided', learning: { status: 'not-requested' },
    });
    expect(source.artist.executeAction(preference).feedback).toContain('already used');
    expect(source.artist.executeAction(stale).feedback).toContain('review changed');
    const release = source.artist.issueActionToken({
      kind: 'release', candidateId: mapping.candidateId,
      artifactDigest: evidence.artifactDigest, decision: 'release-worthy',
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    expect(source.artist.executeAction(release).state.decisions).toMatchObject({
      preference: 'preferred', release: 'release-worthy', learning: { status: 'not-requested' },
    });
  });

  it('mints terminal closure proof only after both decisions and scopes it to its coordinator', async () => {
    const source = await fixture('closure-proof-source');
    const pair = source.packet.candidates.slice(0, 2);
    expect(() => source.artist.closureCheckpoint()).toThrow('ARTIST_REVIEW_CLOSURE_DECISIONS_INCOMPLETE');
    const preference = source.artist.issueActionToken({
      kind: 'preference', blindIds: [pair[0]!.blindId, pair[1]!.blindId],
      outcome: 'preferred', winnerBlindId: pair[0]!.blindId,
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    expect(source.artist.executeAction(preference).accepted).toBe(true);
    const mapping = source.unmasked.mappings[0]!;
    const candidate = source.packet.candidates.find((item) => item.blindId === mapping.blindId)!;
    const release = source.artist.issueActionToken({ kind: 'release', candidateId: mapping.candidateId,
      artifactDigest: candidate.artifactDigest, decision: 'release-worthy' }, source.capabilities,
    '2026-08-01T13:00:00.000Z');
    expect(source.artist.executeAction(release).accepted).toBe(true);
    const checkpoint = source.artist.closureCheckpoint();
    expect(source.coordinator.resolveOwnerClosureCheckpoint(checkpoint)).toEqual({});
    const other = await fixture('closure-proof-other');
    expect(() => other.coordinator.resolveOwnerClosureCheckpoint(checkpoint)).toThrow();
    expect(() => source.coordinator.resolveOwnerClosureCheckpoint({} as typeof checkpoint))
      .toThrow('ARTIST_REVIEW_CLOSURE_CHECKPOINT_INVALID');
  });

  it('derives a fresh blind baseline-versus-revision closure packet instead of reusing the three-candidate review', async () => {
    const source = await fixture('revision-decision-pair');
    const comparison = source.coordinator.createRevisionDecisionArtistReviewSession({
      sessionId: 'revision-decision-pair', plan: source.plan, revision: source.revision,
      independentBlindPreference: source.independentBlindPreference,
      now: () => NOW, tokenSecret: Buffer.alloc(32, 9), nonce: () => 'pair-action',
    });
    const state = comparison.state();
    expect(source.packet.candidates).toHaveLength(3);
    expect(state.candidates).toHaveLength(2);
    const treatment = state.candidates.find((candidate) =>
      candidate.artifactDigest === source.revision.revisedState.artifactDigest)!;
    const baseline = state.candidates.find((candidate) => candidate !== treatment)!;
    expect(new Set(state.candidates.map((candidate) => candidate.artifactDigest))).toEqual(new Set([
      source.plan.baselineArtifact.artifactDigest, source.revision.revisedState.artifactDigest,
    ]));
    const preference = comparison.issueActionToken({ kind: 'preference',
      blindIds: [baseline!.blindId, treatment.blindId], outcome: 'preferred',
      winnerBlindId: treatment.blindId }, source.capabilities, '2026-08-01T13:00:00.000Z');
    expect(comparison.executeAction(preference).accepted).toBe(true);
    const release = comparison.issueActionToken({ kind: 'release', candidateId: treatment.candidateId,
      artifactDigest: treatment.artifactDigest, decision: 'release-worthy' }, source.capabilities,
    '2026-08-01T13:00:00.000Z');
    expect(comparison.executeAction(release).accepted).toBe(true);
    expect(comparison.closureCheckpoint()).toEqual({});
  });

  it('delivers only host-authenticated terminal actions into the bridge campaign closure path', async () => {
    const source = await fixture('bridge-terminal-closure');
    const actors = new Map([['owner-auth', { principalId: 'owner-principal', role: 'owner' as const,
      capability: source.capabilities.ownerCapability }]]);
    const campaignService = {
      resolveRevisionDecisionInput: vi.fn(async () => ({ plan: source.plan,
        revision: source.revision, blindPreference: source.independentBlindPreference })),
      finalizeOwnerDecisionClosure: vi.fn(async () => ({ briefId: 'brief-a' })),
      closeCampaignClosure: vi.fn(async () => ({ status: 'passed' })),
    } as never;
    const bridge = new TuiBridgeService({ creativeRunCoordinator: source.coordinator, campaignService,
      hostAuthorityRegistry: { resolveActor: ({ credential }) => actors.get(credential) } });
    try {
      const session = bridge.createSession();
      const contexts = (bridge as unknown as { governedOwnerClosures: Map<string, unknown> }).governedOwnerClosures;
      contexts.set('campaign-bridge', { admission: {}, manifest: { briefs: [{ id: 'brief-a' }] },
        reviews: new Map([['brief-a', { closureContext: {} }]]), completedBriefIds: new Set() });
      const state = await bridge.startGovernedCampaignOwnerDecisionComparison(
        session.sessionId, 'owner-auth', {
          campaignRunId: 'campaign-bridge', briefId: 'brief-a', revisionEvidenceId: 'revision-a',
        },
      );
      const packet = state.candidates;
      const preference = bridge.issueArtistReviewActionCheckpoint(session.sessionId, 'owner-auth', {
        kind: 'preference', blindIds: [packet[0]!.blindId, packet[1]!.blindId],
        outcome: 'preferred', winnerBlindId: packet[0]!.blindId,
      });
      expect(bridge.executeArtistReviewAction(session.sessionId, preference.token, 'owner-auth').accepted).toBe(true);
      const release = bridge.issueArtistReviewReleaseCheckpoint(session.sessionId, 'owner-auth');
      expect(bridge.executeArtistReviewAction(session.sessionId, release.token, 'owner-auth').accepted).toBe(true);
      await expect(bridge.finalizeGovernedCampaignOwnerDecision(session.sessionId, 'owner-auth', {
        campaignRunId: 'campaign-bridge', briefId: 'brief-a',
      })).resolves.toMatchObject({ closed: true, closure: { status: 'passed' } });
      expect((campaignService as { finalizeOwnerDecisionClosure: ReturnType<typeof vi.fn> })
        .finalizeOwnerDecisionClosure).toHaveBeenCalledOnce();
      await expect(bridge.finalizeGovernedCampaignOwnerDecision(session.sessionId, 'wrong-auth', {
        campaignRunId: 'campaign-bridge', briefId: 'brief-a',
      })).rejects.toThrow('BRIDGE_HOST_ACTOR_ROLE_INVALID');
    } finally {
      bridge.destroy();
    }
  });

  it('rejects unknown, altered, copied, and cross-session tokens before mutation', async () => {
    const source = await fixture();
    const token = source.artist.issueActionToken({
      kind: 'learning', operation: 'stage', ruleId: FIGURE_GROUND_TARGET,
      expiresAt: '2026-08-02T11:00:00.000Z',
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    const [payload, signature] = token.split('.');
    const body = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as {
      action: { ruleId: string }; artifactDigest: string;
    };
    body.action.ruleId = 'different-rule';
    body.artifactDigest = 'different-artifact';
    const altered = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${signature}`;
    const other = await fixture('studio-review-2');

    expect(source.artist.executeAction('unknown-token').accepted).toBe(false);
    expect(source.artist.executeAction(altered).accepted).toBe(false);
    expect(other.artist.executeAction(token).feedback).toMatch(/copied|another review/);
    expect(source.authority.mutationCounters()).toEqual(ZERO);
    expect(other.authority.mutationCounters()).toEqual(ZERO);
    expect(source.artist.state().decisionVersion).toBe(0);
  });

  it('derives provenance from opaque capabilities and rejects hostile substitutes', async () => {
    const source = await fixture('authority-source');
    const foreign = await fixture('authority-foreign');
    const pair = source.packet.candidates.slice(0, 2);
    const action = {
      kind: 'preference' as const,
      blindIds: [pair[0]!.blindId, pair[1]!.blindId] as const,
      outcome: 'tie' as const,
    };

    expect(() => source.artist.issueActionToken(action, {
      ownerCapability: {} as OwnerAuthorityCapability,
    }, '2026-08-01T13:00:00.000Z')).toThrow('OWNER_AUTHORITY_CAPABILITY_PROVENANCE_INVALID');
    expect(() => source.artist.issueActionToken(action, {
      ownerCapability: foreign.capabilities.ownerCapability,
    }, '2026-08-01T13:00:00.000Z')).toThrow('OWNER_AUTHORITY_CAPABILITY_PROVENANCE_INVALID');

    const hostile = { ...source.capabilities, ownerAssertionDigest: 'caller-invented' };
    const token = source.artist.issueActionToken(
      action, hostile, '2026-08-01T13:00:00.000Z',
    );
    const body = Buffer.from(token.split('.')[0]!, 'base64url').toString();
    expect(body).toContain('authorityBindingDigest');
    expect(body).not.toContain('caller-invented');

    const mutable = { ownerCapability: source.capabilities.ownerCapability };
    const boundToken = source.artist.issueActionToken(
      action, mutable, '2026-08-01T13:00:00.000Z',
    );
    mutable.ownerCapability = foreign.capabilities.ownerCapability;
    expect(source.artist.executeAction(boundToken)).toMatchObject({
      accepted: false, state: { decisionVersion: 0 },
    });
    expect(source.authority.mutationCounters()).toEqual(ZERO);
  });

  it('rejects expired owner actions without changing versions', async () => {
    let now = NOW;
    const source = await fixture('studio-expiry', () => now);
    const pair = source.packet.candidates.slice(0, 2);
    const token = source.artist.issueActionToken({
      kind: 'preference', blindIds: [pair[0]!.blindId, pair[1]!.blindId], outcome: 'tie',
    }, source.capabilities, '2026-08-01T12:05:00.000Z');
    now = '2026-08-01T12:06:00.000Z';

    expect(source.artist.executeAction(token)).toMatchObject({
      accepted: false, feedback: expect.stringContaining('expired'),
      state: { decisionVersion: 0 },
    });
    expect(source.authority.mutationCounters()).toEqual(ZERO);
  });

  it('keeps staged and revoked learning provisional and in memory', async () => {
    const source = await fixture();
    const stage = source.artist.issueActionToken({
      kind: 'learning', operation: 'stage', ruleId: FIGURE_GROUND_TARGET,
      expiresAt: '2026-08-02T11:00:00.000Z',
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    const staged = source.artist.executeAction(stage).state;

    expect(staged.decisions.learning).toMatchObject({
      status: 'staged', persistenceBoundary: 'in-memory-transaction-only',
      laterEffect: 'Ordinary Create does not consume artist-review rules; no generation consumer is wired.',
    });
    expect(source.authority.mutationCounters()).toEqual(ZERO);
    const revoke = source.artist.issueActionToken({
      kind: 'learning', operation: 'revoke', ruleId: FIGURE_GROUND_TARGET,
      authorizationDigest: staged.details.learningAuthorization!,
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    expect(source.artist.executeAction(revoke).state.decisions.learning)
      .toMatchObject({ status: 'revoked', revocable: false });
    expect(source.authority.mutationCounters()).toEqual(ZERO);
  });

  it('reports a later effect only after a fresh transfer action', async () => {
    const source = await fixture();
    const stage = source.artist.issueActionToken({
      kind: 'learning', operation: 'stage', ruleId: FIGURE_GROUND_TARGET,
      expiresAt: '2026-08-02T11:00:00.000Z',
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    const staged = source.artist.executeAction(stage).state;
    const transfer = source.artist.issueActionToken({
      kind: 'learning', operation: 'transfer', ruleId: FIGURE_GROUND_TARGET,
      authorizationDigest: staged.details.learningAuthorization!,
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    const learned = source.artist.executeAction(transfer).state.decisions.learning;

    expect(learned.status).toBe('transferred');
    expect(learned.laterEffect).toContain(`${FIGURE_GROUND_TARGET}=`);
    expect(learned.laterEffect).toContain('ordinary Create does not consume it');
    expect(source.artist.state().readiness.learningReady).toBe(false);
    expect(source.authority.mutationCounters()).toMatchObject({ ruleWrites: 1, contextWrites: 1 });
  });

  it('reports a rolled-back transfer as blocked with no later effect', async () => {
    const source = await fixture('studio-blocked', () => NOW, false, true);
    const stage = source.artist.issueActionToken({
      kind: 'learning', operation: 'stage', ruleId: FIGURE_GROUND_TARGET,
      expiresAt: '2026-08-02T11:00:00.000Z',
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    const staged = source.artist.executeAction(stage).state;
    const transfer = source.artist.issueActionToken({
      kind: 'learning', operation: 'transfer', ruleId: FIGURE_GROUND_TARGET,
      authorizationDigest: staged.details.learningAuthorization!,
    }, source.capabilities, '2026-08-01T13:00:00.000Z');
    const blocked = source.artist.executeAction(transfer).state;

    expect(blocked.decisions.learning).toMatchObject({
      status: 'blocked',
      laterEffect: 'Ordinary Create does not consume artist-review rules; no generation consumer is wired.',
    });
    expect(blocked.readiness.learningReady).toBe(false);
    expect(source.authority.mutationCounters()).toEqual(ZERO);
  });
});
