import { createHash } from 'node:crypto';
import type { CompostFragment, CompostProvenance, CompostTaint, Seed } from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const severity: Record<CompostTaint, number> = {
  accepted: 0, unknown: 1, rejected: 2, failed: 3,
};
export const compostContentDigest = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

export function highestCompostTaint(taints: readonly CompostTaint[]): CompostTaint {
  return taints.reduce((highest, value) =>
    severity[value] > severity[highest] ? value : highest, 'accepted');
}

type Ancestor = Pick<CompostFragment, 'content' | 'metadata' | 'provenance'>
  | Pick<Seed, 'content' | 'provenance'>;

export function deriveCompostProvenance(ancestors: readonly Ancestor[]): CompostProvenance {
  const digests = new Set<string>();
  const taints: CompostTaint[] = [];
  for (const ancestor of ancestors) {
    const metadataDigest = 'metadata' in ancestor ? ancestor.metadata.hash : undefined;
    digests.add(metadataDigest && DIGEST.test(metadataDigest)
      ? metadataDigest : compostContentDigest(ancestor.content));
    for (const digest of ancestor.provenance?.ancestorDigests ?? []) {
      if (!DIGEST.test(digest)) throw new Error('COMPOST_ANCESTOR_DIGEST_INVALID');
      digests.add(digest);
    }
    taints.push(ancestor.provenance?.taint ?? 'unknown');
  }
  return Object.freeze({ ancestorDigests: Object.freeze([...digests].sort()) as unknown as string[],
    taint: highestCompostTaint(taints), qualityAuthority: false as const });
}

export function normalizeCompostProvenance(value: Ancestor): CompostProvenance {
  if (value.provenance) return deriveCompostProvenance([value]);
  return Object.freeze({ ancestorDigests: [compostContentDigest(value.content)],
    taint: 'unknown', qualityAuthority: false });
}

export interface DerivedCompostObservation {
  readonly status: 'raw-observation';
  readonly sourceProvenance: CompostProvenance;
  readonly renderedEvidence: undefined;
  readonly decisionEvidence: undefined;
}

/** A derivative must earn rendered and decision evidence as a new observation. */
export function beginDerivedCompostObservation(source: Ancestor): DerivedCompostObservation {
  return Object.freeze({ status: 'raw-observation',
    sourceProvenance: normalizeCompostProvenance(source),
    renderedEvidence: undefined, decisionEvidence: undefined });
}
