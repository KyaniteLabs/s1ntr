import { createHash } from 'node:crypto';
import type { ArchiveEntry } from '../../emergence/types.js';
import { validateDreamEvidence, type DreamObservedEvidence,
  type DreamRenderedEvidenceResolver } from './DreamResearchEvidence.js';
import type { DreamModality } from './DreamResearchTypes.js';

export interface DreamArchiveSourceCapability { readonly kind: 'dream-archive-source' }
const admissions = new WeakMap<object, { authority: DreamArchiveSourceAdmission;
  admission: NonNullable<ArchiveEntry['dreamAdmission']> }>();

/** Host-only bridge from accepted rendered evidence to Gardener source eligibility. */
export class DreamArchiveSourceAdmission {
  private readonly admittedEntries = new WeakSet<ArchiveEntry>();
  constructor(private readonly renderedEvidence: DreamRenderedEvidenceResolver) {}

  authorize(input: { artifact: NonNullable<ArchiveEntry['dreamAdmission']>['artifact'];
    evidence: DreamObservedEvidence; requiredModalities: DreamModality[];
    ownerAccepted: boolean }): DreamArchiveSourceCapability {
    if (!input.ownerAccepted) throw new Error('DREAM_SOURCE_OWNER_ACCEPTANCE_REQUIRED');
    this.renderedEvidence.assertAttested(input.evidence);
    const failures = validateDreamEvidence(input.evidence, input.requiredModalities);
    if (failures.length > 0) throw new Error(failures.join(','));
    const artifactDigest = createHash('sha256').update(input.artifact.code).digest('hex');
    if (artifactDigest !== input.evidence.artifactDigest) {
      throw new Error('DREAM_SOURCE_ARTIFACT_DIGEST_MISMATCH');
    }
    const capability = Object.freeze({ kind: 'dream-archive-source' as const });
    admissions.set(capability, { authority: this,
      admission: Object.freeze({ admissionEligible: true,
        artifactDigest, evidenceDigest: digest(input.evidence), artifact: input.artifact }) });
    return capability;
  }

  resolve(capability?: DreamArchiveSourceCapability):
    NonNullable<ArchiveEntry['dreamAdmission']> | undefined {
    const binding = capability ? admissions.get(capability) : undefined;
    return binding?.authority === this ? binding.admission : undefined;
  }

  attach(entry: ArchiveEntry, capability: DreamArchiveSourceCapability): void {
    const admission = this.resolve(capability);
    if (!admission) throw new Error('DREAM_SOURCE_CAPABILITY_INVALID');
    entry.dreamAdmission = admission;
    this.admittedEntries.add(entry);
  }

  isAdmitted(entry: ArchiveEntry): boolean {
    return this.admittedEntries.has(entry);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
