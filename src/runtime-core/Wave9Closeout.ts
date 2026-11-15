/**
 * W9C-09: Wave 9 closeout — release root extension for creative campaign evidence.
 *
 * Extends the Wave 8 release root with six residual-closure attestations:
 * 1. beauty-judgment (rubric-scored candidates)
 * 2. multi-node-graphs (≥4 node composition graphs)
 * 3. studio-driven-execution (campaign run through Studio UI)
 * 4. revision-improvement (≥2/3 briefs show blind improvement)
 * 5. transfer-experiment (treatment vs control, no surface copy)
 * 6. dream-loop-closure (recommendation lineage-bound to generation)
 *
 * The Wave 8 16-conjunct gate is preserved; Wave 9 adds new conjuncts
 * without modifying existing ones.
 */

export const WAVE9_RESIDUAL_KINDS = [
  'beauty-judgment',
  'multi-node-graphs',
  'studio-driven-execution',
  'revision-improvement',
  'transfer-experiment',
  'dream-loop-closure',
] as const;

export type Wave9ResidualKind = typeof WAVE9_RESIDUAL_KINDS[number];

export interface Wave9ResidualAttestation {
  readonly kind: Wave9ResidualKind;
  readonly closed: boolean;
  readonly evidenceDigest: string;
  readonly detail: string;
}

export interface Wave9CreativeCampaignReceipt {
  readonly schema: 'sinter.wave9-creative-campaign';
  readonly schemaVersion: 1;
  readonly campaignRunId: string;
  readonly residuals: readonly Wave9ResidualAttestation[];
  readonly receiptDigest: string;
}

export interface Wave9GateReport {
  readonly allResidualsClosed: boolean;
  readonly openResiduals: readonly Wave9ResidualKind[];
  readonly residualSummary: Record<string, boolean>;
}

/** Validate that a Wave 9 receipt has all six residual attestations. */
export function validateWave9Receipt(receipt: Wave9CreativeCampaignReceipt): string[] {
  const failures: string[] = [];
  for (const kind of WAVE9_RESIDUAL_KINDS) {
    const attestation = receipt.residuals.find((r) => r.kind === kind);
    if (!attestation) {
      failures.push(`missing-residual:${kind}`);
    } else if (!attestation.closed) {
      failures.push(`residual-not-closed:${kind}`);
    } else if (!attestation.evidenceDigest || attestation.evidenceDigest.length !== 64) {
      failures.push(`invalid-evidence-digest:${kind}`);
    }
  }
  return failures;
}

/** Evaluate the Wave 9 gate from a receipt. */
export function evaluateWave9Gate(receipt: Wave9CreativeCampaignReceipt | undefined): Wave9GateReport {
  if (!receipt) {
    return {
      allResidualsClosed: false,
      openResiduals: [...WAVE9_RESIDUAL_KINDS],
      residualSummary: Object.fromEntries(WAVE9_RESIDUAL_KINDS.map((k) => [k, false])),
    };
  }
  const summary = Object.fromEntries(
    WAVE9_RESIDUAL_KINDS.map((kind) => {
      const attestation = receipt.residuals.find((r) => r.kind === kind);
      return [kind, attestation?.closed ?? false];
    }),
  );
  const open = WAVE9_RESIDUAL_KINDS.filter((kind) => !summary[kind]);
  return {
    allResidualsClosed: open.length === 0,
    openResiduals: open,
    residualSummary: summary,
  };
}

/** Create a Wave 9 receipt from residual attestations. */
export function createWave9Receipt(
  campaignRunId: string,
  residuals: readonly Wave9ResidualAttestation[],
): Wave9CreativeCampaignReceipt {
  const sortedResiduals = [...residuals].sort((a, b) =>
    WAVE9_RESIDUAL_KINDS.indexOf(a.kind) - WAVE9_RESIDUAL_KINDS.indexOf(b.kind));
  return Object.freeze({
    schema: 'sinter.wave9-creative-campaign',
    schemaVersion: 1 as const,
    campaignRunId,
    residuals: Object.freeze(sortedResiduals),
    receiptDigest: 'pending',
  });
}
