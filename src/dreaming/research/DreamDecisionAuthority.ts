import type { DreamComparisonOutcome, DreamTransferOutcome } from './DreamResearchTypes.js';

export interface DreamComparisonCapability { readonly kind: 'dream-rendered-comparison' }
export interface DreamTransferCapability { readonly kind: 'dream-rendered-transfer' }
interface Comparison { aggregateId: string; outcome: DreamComparisonOutcome; reason: string;
  baselineEvidenceDigest: string; variantEvidenceDigests: string[];
  variantArtifactDigests: string[] }
interface Transfer { aggregateId: string; outcome: DreamTransferOutcome;
  treatmentEvidenceDigest: string; controlEvidenceDigest: string;
  treatmentArtifactDigest: string; controlArtifactDigest: string }

export interface DreamDecisionIssuer {
  issueComparison(value: Comparison): DreamComparisonCapability;
  issueTransfer(value: Transfer): DreamTransferCapability;
}
export interface DreamDecisionResolver {
  comparison(capability: DreamComparisonCapability, aggregateId: string): Comparison;
  transfer(capability: DreamTransferCapability, aggregateId: string): Transfer;
}

export function createDreamDecisionAuthority(): {
  issuer: DreamDecisionIssuer; resolver: DreamDecisionResolver } {
  const comparisons = new WeakMap<object, Comparison>();
  const transfers = new WeakMap<object, Transfer>();
  const issuer: DreamDecisionIssuer = Object.freeze({
    issueComparison(value: Comparison) {
      const capability = Object.freeze({ kind: 'dream-rendered-comparison' as const });
      comparisons.set(capability, Object.freeze({ ...value })); return capability;
    },
    issueTransfer(value: Transfer) {
      const capability = Object.freeze({ kind: 'dream-rendered-transfer' as const });
      transfers.set(capability, Object.freeze({ ...value })); return capability;
    },
  });
  const resolver: DreamDecisionResolver = Object.freeze({
    comparison(capability: DreamComparisonCapability, aggregateId: string) {
      const value = comparisons.get(capability);
      if (!value || value.aggregateId !== aggregateId) {
        throw new Error('DREAM_COMPARISON_CAPABILITY_INVALID');
      }
      return value;
    },
    transfer(capability: DreamTransferCapability, aggregateId: string) {
      const value = transfers.get(capability);
      if (!value || value.aggregateId !== aggregateId) {
        throw new Error('DREAM_TRANSFER_CAPABILITY_INVALID');
      }
      return value;
    },
  });
  return { issuer, resolver };
}
