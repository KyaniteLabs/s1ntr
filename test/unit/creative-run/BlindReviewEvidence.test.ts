import { describe, expect, it } from 'vitest';
import { buildCrossModalArtifact } from '../../../src/creative-intelligence/CrossModalArtifact.js';
import {
  createBlindReviewSession,
  type BlindReviewJudgment,
  type BlindReviewPacket,
  type CandidateEvidenceAssignment,
} from '../../../src/creative-run/BlindReviewEvidence.js';
import {
  buildCandidateManifest,
  type CandidateManifest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';

const INTENT = 'A luminous field whose motion responds to a musical pulse and one accessible control.';

async function fixture(options: { complete?: boolean; failed?: boolean } = {}) {
  const crossModalThesis = buildCrossModalArtifact({
    brief: INTENT,
    artifactId: 'cross-modal-thesis-source',
  }).thesis;
  const manifest = await buildCandidateManifest(INTENT, { creativeThesis: crossModalThesis });
  const assignments: CandidateEvidenceAssignment[] = manifest.candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    requiredModalities: options.complete === false
      ? ['visual', 'audio'] : ['visual', 'audio', 'motion', 'interaction'],
    generationIdentity: {
      provider: `private-provider-${index}`,
      model: `private-model-${index}`,
      assignment: `private-assignment-${index}`,
    },
    ...(options.complete === false ? {} : {
      crossModalArtifact: buildCrossModalArtifact({
        brief: INTENT,
        artifactId: `cross-modal-${index}`,
        sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
        thesis: manifest.creativeThesis,
      }),
    }),
    ...(options.failed && index === 1 ? { failure: 'canonical render failed' } : {}),
  }));
  return { manifest, assignments };
}

function completeJudgments(packet: BlindReviewPacket): BlindReviewJudgment[] {
  return packet.candidates.map((candidate) => ({
    blindId: candidate.blindId,
    outcome: 'pass',
    claims: candidate.requiredModalities.flatMap((modality) => {
      const media = candidate.media.find((item) => item.modality === modality);
      return media ? [{
        modality, artifactDigest: candidate.artifactDigest,
        evidenceDigest: media.digest, claim: `${modality} inspected`,
      }] : [];
    }),
  }));
}

describe('BlindReviewEvidence', () => {
  it('builds complete blinded packets from canonical candidate and cross-modal artifacts', async () => {
    const { manifest, assignments } = await fixture();
    const session = createBlindReviewSession(manifest, assignments);
    const serialized = JSON.stringify(session.packet);

    expect(session.packet.candidates).toHaveLength(manifest.candidates.length);
    expect(session.packet.candidates.every((candidate) => candidate.media.length === 4)).toBe(true);
    expect(session.packet.contactSheetHtml).toContain('data:text/html;base64,');
    expect(session.packet.playableMedia.some((entry) => entry.media.mimeType === 'audio/wav')).toBe(true);
    expect(serialized).not.toContain('private-provider');
    expect(serialized).not.toContain('private-model');
    expect(serialized).not.toContain('private-assignment');

    const review = session.submitReview(session.packet, completeJudgments(session.packet));
    expect(review.judgments.every((judgment) => judgment.outcome === 'pass')).toBe(true);
    const unmasked = session.unmask();
    expect(unmasked.boundary).toBe('post-review');
    expect(unmasked.mappings.map((mapping) => mapping.candidateId))
      .toEqual(manifest.candidates.map((candidate) => candidate.id));
  });

  it('keeps generation identity outside runtime-readable fields and rejects surface leaks', async () => {
    const { manifest, assignments } = await fixture();
    const session = createBlindReviewSession(manifest, assignments);
    const reflected = JSON.stringify(Object.getOwnPropertyDescriptors(session));

    expect(Reflect.ownKeys(session)).toEqual(['packet']);
    expect(reflected).not.toContain('private-provider');
    expect(reflected).not.toContain('private-model');
    expect(reflected).not.toContain('private-assignment');

    const leaked = structuredClone(assignments) as CandidateEvidenceAssignment[];
    leaked[0] = { ...leaked[0]!, failure: 'render failed on private-model-0' };
    expect(() => createBlindReviewSession(manifest, leaked))
      .toThrow(/GENERATION_IDENTITY_LEAK/);
  });

  it('makes judgments inconclusive when a required modality is missing', async () => {
    const { manifest, assignments } = await fixture({ complete: false });
    const session = createBlindReviewSession(manifest, assignments);
    const review = session.submitReview(session.packet, completeJudgments(session.packet));

    expect(review.judgments.every((judgment) => judgment.outcome === 'inconclusive')).toBe(true);
    expect(review.judgments[0]?.inconclusiveReasons).toContain('missing-audio-evidence');
  });

  it('rejects omitted candidates instead of silently narrowing the comparison set', async () => {
    const { manifest, assignments } = await fixture();
    expect(() => createBlindReviewSession(manifest, assignments.slice(1)))
      .toThrow(/CANDIDATE_SET_INCOMPLETE/);
  });

  it('rejects cross-artifact evidence swaps and tampered packets', async () => {
    const { manifest, assignments } = await fixture();
    const session = createBlindReviewSession(manifest, assignments);
    const judgments = completeJudgments(session.packet);
    const secondArtifactDigest = session.packet.candidates[1]!.artifactDigest;
    const swapped = judgments.map((judgment, index) => index === 0 ? {
      ...judgment,
      claims: judgment.claims.map((claim) => claim.modality === 'motion'
        ? { ...claim, artifactDigest: secondArtifactDigest }
        : claim),
    } : judgment);
    expect(session.packet.candidates[0]!.artifactDigest).not.toBe(secondArtifactDigest);
    expect(() => session.submitReview(session.packet, swapped)).toThrow(/ARTIFACT_MISMATCH/);

    const tampered = {
      ...session.packet,
      contactSheetHtml: `${session.packet.contactSheetHtml}tampered`,
    } as BlindReviewPacket;
    expect(() => session.submitReview(tampered, judgments)).toThrow(/PACKET_DIGEST_MISMATCH/);
  });

  it('rejects candidate canonical digest drift before issuing a packet', async () => {
    const { manifest, assignments } = await fixture();
    const corrupted = structuredClone(manifest) as CandidateManifest;
    const candidate = corrupted.candidates[0]!;
    (candidate.artifact as { artifactDigest: string }).artifactDigest = '0'.repeat(16);

    expect(() => createBlindReviewSession(corrupted, assignments))
      .toThrow(/CANDIDATE_CANONICAL_DIGEST_MISMATCH/);
  });

  it('derives playable audio from the exact canonical bytes', async () => {
    const { manifest, assignments } = await fixture();
    const mismatched = structuredClone(assignments) as CandidateEvidenceAssignment[];
    const crossModal = mismatched[0]!.crossModalArtifact!;
    (crossModal.audioArtifact as { playableDataUri: string }).playableDataUri =
      'data:audio/wav;base64,dGFtcGVyZWQ=';

    const session = createBlindReviewSession(manifest, mismatched);
    const audio = session.packet.candidates[0]!.media.find((media) => media.modality === 'audio')!;
    expect(audio.playableUri).toBe(
      `data:${crossModal.audioArtifact.mimeType};base64,${crossModal.audioArtifact.audioBase64}`,
    );
    expect(audio.playableUri).not.toContain('dGFtcGVyZWQ=');
  });

  it('rejects an explicitly unbound cross-modal artifact at the blind-review boundary', async () => {
    const { manifest, assignments } = await fixture();
    const unbound = structuredClone(assignments) as CandidateEvidenceAssignment[];
    unbound[0] = {
      ...unbound[0]!,
      crossModalArtifact: buildCrossModalArtifact({ brief: INTENT, thesis: manifest.creativeThesis }),
    };
    expect(unbound[0]!.crossModalArtifact!.sourceCandidateArtifactDigest).toBeNull();
    expect(() => createBlindReviewSession(manifest, unbound))
      .toThrow(/SOURCE_CANDIDATE_UNBOUND/);
  });

  it('rejects candidate-to-evidence swaps and altered cross-modal HTML', async () => {
    const { manifest, assignments } = await fixture();
    const swapped = structuredClone(assignments) as CandidateEvidenceAssignment[];
    const claimedSource = swapped[0]!.sourceCandidateArtifactDigest;
    swapped[0] = {
      ...swapped[0]!,
      crossModalArtifact: swapped[1]!.crossModalArtifact,
    };
    expect(swapped[0]!.sourceCandidateArtifactDigest).toBe(claimedSource);
    expect(swapped[0]!.crossModalArtifact!.sourceCandidateArtifactDigest).not.toBe(claimedSource);
    expect(() => createBlindReviewSession(manifest, swapped))
      .toThrow(/SOURCE_CANDIDATE_MISMATCH/);

    const altered = structuredClone(assignments) as CandidateEvidenceAssignment[];
    const crossModal = altered[0]!.crossModalArtifact!;
    (crossModal as { html: string }).html = `${crossModal.html}\n<!-- altered -->`;
    expect(() => createBlindReviewSession(manifest, altered))
      .toThrow(/canonical content/);
  });

  it('includes failed candidates and marks missing canonical media without substitution', async () => {
    const { manifest, assignments } = await fixture({ complete: false, failed: true });
    const session = createBlindReviewSession(manifest, assignments);
    const failed = session.packet.candidates[1]!;

    expect(failed.status).toBe('failed');
    expect(failed.failure).toBe('canonical render failed');
    expect(failed.missingModalities).toEqual(['audio']);
    expect(failed.media).toHaveLength(1);
    expect(failed.media[0]?.modality).toBe('visual');
    expect(session.packet.contactSheetHtml).toContain('failed: canonical render failed');
    expect(session.packet.contactSheetHtml).toContain('status: failed');
    expect(session.packet.contactSheetHtml).toContain('missing: audio');
    expect(session.packet.playableMedia).toHaveLength(manifest.candidates.length);
  });

  it('seals identity until review and refuses replayed unmask', async () => {
    const { manifest, assignments } = await fixture();
    const session = createBlindReviewSession(manifest, assignments);

    expect(() => session.unmask()).toThrow(/UNMASK_PREMATURE/);
    session.submitReview(session.packet, completeJudgments(session.packet));
    expect(session.unmask().mappings[0]?.generationIdentity.provider).toBe('private-provider-0');
    expect(() => session.unmask()).toThrow(/UNMASK_REPLAYED/);
  });
});
