import { createHash } from 'node:crypto';
import { DreamArchiveSourceAdmission } from '../../src/dreaming/research/DreamArchiveSourceAdmission.js';
import type { DreamRenderedEvidenceIssuer } from
  '../../src/dreaming/research/DreamResearchEvidence.js';
import type { ArchiveEntry } from '../../src/emergence/types.js';

export function admitDreamEntry(entry: ArchiveEntry,
  authority: DreamArchiveSourceAdmission,
  evidenceIssuer: DreamRenderedEvidenceIssuer): ArchiveEntry {
  const artifact = entry.dreamAdmission?.artifact
    ?? { domain: 'html' as const, prompt: entry.id, code: `<html>${entry.id}</html>` };
  const artifactDigest = createHash('sha256').update(artifact.code).digest('hex');
  const pixelFrames = ['fixture-early-frame', 'fixture-late-frame'].map(dataBase64 => ({
    mimeType: 'image/png', dataBase64,
    digest: createHash('sha256').update(dataBase64).digest('hex'),
  }));
  const evidence = { artifactDigest,
      playableDigest: 'b'.repeat(64), rendererEnvironmentDigest: 'c'.repeat(64),
      runtimeErrors: [], degraded: false, identityValid: true, digestMatched: true,
      frames: pixelFrames.map(frame => frame.digest), pixelFrames, temporalSamples: [],
      containment: { networkIsolated: true, permissionsDenied: true,
        resourceLimitsObserved: true, cleanupSucceeded: true, outputBytes: 1,
        assetDigests: [], runtimeDigest: 'f'.repeat(64), postRunCensus: { durationMs: 1,
          usedHeapBytes: 1, eventListeners: 0, eventsDispatched: 0, timers: 0,
          audioContexts: 0, pagesBefore: 0, pagesAfter: 0 } } };
  evidenceIssuer.attest(evidence);
  const capability = authority.authorize({ artifact, ownerAccepted: true,
    requiredModalities: ['visual'], evidence });
  authority.attach(entry, capability);
  return entry;
}
