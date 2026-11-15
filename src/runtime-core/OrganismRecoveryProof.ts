import { createHash } from 'node:crypto';

export const ORGANISM_LINEAGE_STAGES = Object.freeze([
  'brief', 'create', 'observation', 'review', 'stores', 'dream', 'transfer',
  'consolidate', 'knowledge-application', 'later-outcome',
] as const);
export type OrganismLineageStage = typeof ORGANISM_LINEAGE_STAGES[number];

export interface OrganismLineageNode {
  readonly stage: OrganismLineageStage;
  readonly digest: string;
  readonly parentDigest: string | null;
}
export interface RestartProbe {
  readonly transition: string;
  readonly duplicateEffects: number;
  readonly splitVerdict: boolean;
  readonly budgetBefore: number;
  readonly budgetAfter: number;
  readonly forgedCompletion: boolean;
}
export interface RetainedEvidenceRoot {
  readonly digest: string;
  readonly state: 'active' | 'admitted' | 'challenged' | 'rollbackable' | 'expired';
  readonly retained: boolean;
}
export interface OrganismRecoveryProofInput {
  readonly restartProbes: readonly RestartProbe[];
  readonly lineage: readonly OrganismLineageNode[];
  readonly signer: { historicalVerified: boolean; revokedNewSigningBlocked: boolean };
  readonly evidenceRoots: readonly RetainedEvidenceRoot[];
  readonly staticCensus: readonly string[];
  readonly liveCensus: readonly string[];
  readonly releasePredicates: Readonly<Record<string, boolean>>;
}

const HEX = /^[a-f0-9]{64}$/;
const digest = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

export function proveOrganismRecovery(input: OrganismRecoveryProofInput): Readonly<{
  schema: 'sinter.organism-recovery-proof'; schemaVersion: 1;
  status: 'healthy' | 'unhealthy'; blockers: readonly string[];
  releaseReady: boolean; receiptDigest: string;
}> {
  const blockers: string[] = [];
  const expectedTransitions = ORGANISM_LINEAGE_STAGES.slice(1).map((stage, index) =>
    `${ORGANISM_LINEAGE_STAGES[index]}->${stage}`);
  if (JSON.stringify(input.restartProbes.map(probe => probe.transition).sort())
    !== JSON.stringify([...expectedTransitions].sort())) blockers.push('restart-probes-incomplete');
  for (const probe of input.restartProbes) {
    if (!probe.transition.trim() || probe.duplicateEffects !== 0
      || probe.splitVerdict || probe.forgedCompletion
      || probe.budgetAfter > probe.budgetBefore) {
      blockers.push(`restart-unsafe:${probe.transition || 'unknown'}`);
    }
  }
  if (input.lineage.length !== ORGANISM_LINEAGE_STAGES.length) {
    blockers.push('lineage-incomplete');
  } else input.lineage.forEach((node, index) => {
    const prior = input.lineage[index - 1];
    if (node.stage !== ORGANISM_LINEAGE_STAGES[index] || !HEX.test(node.digest)
      || node.parentDigest !== (prior?.digest ?? null)) {
      blockers.push(`lineage-unhealthy:${node.stage}`);
    }
  });
  if (!input.signer.historicalVerified || !input.signer.revokedNewSigningBlocked) {
    blockers.push('signer-lifecycle-unhealthy');
  }
  if (input.evidenceRoots.some(root => root.state !== 'expired'
    && (!root.retained || !HEX.test(root.digest)))) blockers.push('evidence-root-orphaned');
  const staticSet = [...new Set(input.staticCensus)].sort();
  const liveSet = [...new Set(input.liveCensus)].sort();
  if (!staticSet.length || JSON.stringify(staticSet) !== JSON.stringify(liveSet)) {
    blockers.push('runtime-census-mismatch');
  }
  const releaseReady = Object.keys(input.releasePredicates).length > 0
    && Object.values(input.releasePredicates).every(Boolean);
  if (!releaseReady) blockers.push('creative-release-predicate-missing');
  const body = { schema: 'sinter.organism-recovery-proof' as const, schemaVersion: 1 as const,
    status: blockers.length ? 'unhealthy' as const : 'healthy' as const,
    blockers: Object.freeze(blockers), releaseReady };
  return Object.freeze({ ...body, receiptDigest: digest({ ...input, ...body }) });
}
