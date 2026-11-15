import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DreamArchiveSourceAdmission } from
  '../../../src/dreaming/research/DreamArchiveSourceAdmission.js';
import { createDreamRenderedEvidenceAuthority } from
  '../../../src/dreaming/research/DreamResearchEvidence.js';
import type { ArchiveEntry } from '../../../src/emergence/types.js';

const digest = (char: string) => char.repeat(64);

describe('DreamArchiveSourceAdmission', () => {
  it('admits only the exact owner-accepted rendered artifact', () => {
    const renderedEvidence = createDreamRenderedEvidenceAuthority();
    const authority = new DreamArchiveSourceAdmission(renderedEvidence.resolver);
    const code = '<html>accepted</html>';
    const artifactDigest = 'bd62b7360596dbf0340fbab966f6962eb8351cf8747833bfcae35975d28c3478';
    const pixelFrames = ['early', 'late'].map(dataBase64 => ({ mimeType: 'image/png', dataBase64,
      digest: createHash('sha256').update(dataBase64).digest('hex') }));
    const evidence = { artifactDigest, playableDigest: digest('b'),
      rendererEnvironmentDigest: digest('c'), runtimeErrors: [], degraded: false,
      identityValid: true, digestMatched: true, frames: pixelFrames.map(frame => frame.digest),
      pixelFrames,
      temporalSamples: [], containment: { networkIsolated: true, permissionsDenied: true,
        resourceLimitsObserved: true, cleanupSucceeded: true, outputBytes: 1,
        assetDigests: [], runtimeDigest: digest('7'), postRunCensus: { durationMs: 1,
          usedHeapBytes: 1, eventListeners: 0, eventsDispatched: 0, timers: 0,
          audioContexts: 0, pagesBefore: 0, pagesAfter: 0 } } };
    expect(() => authority.authorize({ artifact: { domain: 'html', prompt: 'p', code },
      evidence, requiredModalities: ['visual'], ownerAccepted: true }))
      .toThrow('DREAM_RENDERED_EVIDENCE_CAPABILITY_INVALID');
    renderedEvidence.issuer.attest(evidence);
    const capability = authority.authorize({ artifact: { domain: 'html', prompt: 'p', code },
      evidence, requiredModalities: ['visual'], ownerAccepted: true });
    expect(authority.resolve(capability)).toMatchObject({ admissionEligible: true,
      artifactDigest });
    const entry = { id: 'entry' } as ArchiveEntry;
    authority.attach(entry, capability);
    expect(authority.isAdmitted(entry)).toBe(true);
    expect(authority.isAdmitted({ ...entry })).toBe(false);
    expect(new DreamArchiveSourceAdmission(createDreamRenderedEvidenceAuthority().resolver)
      .resolve(capability)).toBeUndefined();
    expect(() => authority.authorize({ artifact: { domain: 'html', prompt: 'p', code },
      evidence: { ...evidence }, requiredModalities: ['visual'], ownerAccepted: true }))
      .toThrow('DREAM_RENDERED_EVIDENCE_CAPABILITY_INVALID');
    expect(() => authority.authorize({ artifact: { domain: 'html', prompt: 'p', code },
      evidence, requiredModalities: ['visual'], ownerAccepted: false }))
      .toThrow('DREAM_SOURCE_OWNER_ACCEPTANCE_REQUIRED');
  });
});
