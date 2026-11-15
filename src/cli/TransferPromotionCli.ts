import type { TransferPromotionDecision, TransferPromotionReceipt } from '../creative-run/TransferPromotionGate.js';

export interface TransferPromotionSurface {
  readonly freeze: { readonly freezeDigest: string; readonly ruleId: string;
    readonly applicability: string; readonly experimentalScope: string };
  evaluate(input: unknown): TransferPromotionDecision;
  promote(decision: TransferPromotionDecision, capabilities: unknown): TransferPromotionReceipt;
}

function lines(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : `- ${empty}`;
}

export function formatTransferPromotionDecision(decision: TransferPromotionDecision): string {
  const comparison = decision.comparison;
  const copied = comparison.copiedDimensions.length > 0
    ? comparison.copiedDimensions.join(', ')
    : 'none';
  return [
    'TRANSFER PROMOTION',
    `Decision: ${decision.status} (${decision.reason})`,
    `Freeze: ${decision.freezeDigest}`,
    `Decided at: ${decision.decidedAt}`,
    `Storage boundary: session memory only`,
    '',
    'TREATMENT vs CONTROL',
    `Treatment artifact: ${comparison.treatmentArtifactDigest}`,
    `Control artifact: ${comparison.controlArtifactDigest}`,
    `Copied dimensions: ${copied}`,
    `Copying detected: ${comparison.copyingDetected ? 'yes' : 'no'}`,
    `Blinded review: ${comparison.blindedReviewOutcome}`,
    `Owner review: ${comparison.ownerReviewOutcome}`,
    `Evidence supports treatment: ${comparison.evidenceSupportsTreatment ? 'yes' : 'no'}`,
    '',
    'SIMILARITY FINGERPRINTS',
    lines(
      ['palette', 'motif', 'geometry', 'rhythm', 'source', 'graph-topology'].map(
        (dimension) => `${dimension}: treatment ${comparison.treatmentFingerprint.dimensions[dimension as keyof typeof comparison.treatmentFingerprint.dimensions].slice(0, 8)} control ${comparison.controlFingerprint.dimensions[dimension as keyof typeof comparison.controlFingerprint.dimensions].slice(0, 8)}`,
      ),
      'none',
    ),
    '',
    'AUDIT DETAILS',
    `Decision digest: ${decision.decisionDigest}`,
    `Comparison digest: ${comparison.comparisonDigest}`,
    `Persistence boundary: ${decision.persistenceBoundary}`,
  ].join('\n');
}

export function formatTransferPromotionReceipt(receipt: TransferPromotionReceipt): string {
  return [
    'TRANSFER PROMOTION RECEIPT',
    `Status: ${receipt.status} (${receipt.reason})`,
    `Freeze: ${receipt.freezeDigest}`,
    `Decision: ${receipt.decisionDigest}`,
    `Owner: ${receipt.owner.id}`,
    `Source: ${receipt.source.id}`,
    `Promoted at: ${receipt.promotedAt}`,
    `Storage boundary: session memory only`,
    `Promotion digest: ${receipt.promotionDigest}`,
  ].join('\n');
}

export function runTransferPromotionCli(
  surface: TransferPromotionSurface,
  command: 'evaluate' | 'promote',
  payload?: unknown,
): string {
  if (command === 'evaluate') {
    const decision = surface.evaluate(payload);
    return formatTransferPromotionDecision(decision);
  }
  if (command === 'promote' && payload) {
    const { decision, capabilities } = payload as {
      decision: TransferPromotionDecision;
      capabilities: unknown;
    };
    const receipt = surface.promote(decision, capabilities);
    return formatTransferPromotionReceipt(receipt);
  }
  return `Freeze: ${surface.freeze.freezeDigest}\nRule: ${surface.freeze.ruleId}\nApplicability: ${surface.freeze.applicability}\nExperimental scope: ${surface.freeze.experimentalScope}`;
}
