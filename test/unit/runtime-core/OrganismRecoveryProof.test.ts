import { describe, expect, it } from 'vitest';
import {
  ORGANISM_LINEAGE_STAGES,
  proveOrganismRecovery,
  type OrganismRecoveryProofInput,
} from '../../../src/runtime-core/OrganismRecoveryProof.js';

const SHA = (n: number) => n.toString(16).padStart(64, '0');
const valid = (): OrganismRecoveryProofInput => ({
  restartProbes: ORGANISM_LINEAGE_STAGES.slice(1).map((stage, index) => ({
    transition: `${ORGANISM_LINEAGE_STAGES[index]}->${stage}`,
    duplicateEffects: 0, splitVerdict: false,
    budgetBefore: 2, budgetAfter: 1, forgedCompletion: false,
  })),
  lineage: ORGANISM_LINEAGE_STAGES.map((stage, index) => ({
    stage, digest: SHA(index + 1), parentDigest: index ? SHA(index) : null,
  })),
  signer: { historicalVerified: true, revokedNewSigningBlocked: true },
  evidenceRoots: [{ digest: SHA(20), state: 'rollbackable', retained: true }],
  staticCensus: ['writer:a', 'reader:b'], liveCensus: ['reader:b', 'writer:a'],
  releasePredicates: { c0: true, portfolio: true, transfer: true },
});

describe('proveOrganismRecovery', () => {
  it('binds every transition and whole-organ lineage into one healthy receipt', () => {
    const proof = proveOrganismRecovery(valid());
    expect(proof.status).toBe('healthy');
    expect(proof.releaseReady).toBe(true);
    expect(proof.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed on crash duplication, partial lineage, orphaning, or missing truth', () => {
    const input = valid();
    const proof = proveOrganismRecovery({ ...input,
      restartProbes: [{ ...input.restartProbes[0]!, duplicateEffects: 1 }],
      lineage: input.lineage.slice(0, -1),
      evidenceRoots: [{ digest: SHA(20), state: 'active', retained: false }],
      liveCensus: ['reader:b'], releasePredicates: { c0: true, transfer: false } });
    expect(proof.status).toBe('unhealthy');
    expect(proof.releaseReady).toBe(false);
    expect(proof.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('restart-unsafe'), 'lineage-incomplete',
      'evidence-root-orphaned', 'runtime-census-mismatch',
      'creative-release-predicate-missing',
    ]));
  });
});
