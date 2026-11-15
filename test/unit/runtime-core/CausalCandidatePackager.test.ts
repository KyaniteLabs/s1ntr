import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  packageOwnerControlledCandidate,
  parseOwnerControlledCandidate,
  type CausalCandidateInput,
} from '../../../src/runtime-core/CausalCandidatePackager.js';
import {
  createCausalCandidateGateReceipt,
  parseCausalCandidateGateReceipt,
  type CausalCandidateGateReceipt,
} from '../../../src/runtime-core/Wave5GateReceipt.js';

const receiptPath = path.resolve(
  'docs/agents/waves/receipts/wave-5-W5-11-causal-candidate.json',
);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sealedDigest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

describe('CausalCandidatePackager', () => {
  let receipt: CausalCandidateGateReceipt;
  let input: CausalCandidateInput;

  beforeAll(async () => {
    receipt = parseCausalCandidateGateReceipt(
      JSON.parse(await fs.readFile(receiptPath, 'utf8')),
    );
    input = {
      contract: {
        version: 1,
        loop: 'autoresearch',
        experimentId: receipt.candidate.experimentId,
        lineageId: receipt.candidate.lineageId,
        state: 'observe',
        stage: 'shadow',
        sourceMutationRequested: true,
        budgets: receipt.prerequisites.sealedReview.prerequisite.budgets,
      },
      candidate: receipt.prerequisites.sealedReview.approved,
      restoredFailure: receipt.prerequisites.sealedReview.vetoed,
      configuration: receipt.candidate.configuration,
      decisionRule: receipt.candidate.decisionRule,
      trials: receipt.candidate.trials,
      diff: receipt.candidate.diff,
      verificationRefs: receipt.candidate.verificationRefs,
      artifactComparisonRefs: receipt.candidate.artifactComparisonRefs,
    };
  });

  it('packages a reviewed candidate for owner control', () => {
    const candidate = packageOwnerControlledCandidate(structuredClone(input));
    expect(candidate.status).toBe('awaiting-owner');
    expect(candidate.allowedAction).toBe('request-owner-merge');
    expect(candidate.analysis.improved).toBe(true);
    expect(candidate.analysis.sampleVariance).toBeGreaterThanOrEqual(0);
    expect(parseOwnerControlledCandidate(candidate)).toEqual(candidate);
  });

  it('rejects a hard-floor regression', () => {
    const invalid = structuredClone(input);
    invalid.trials[0].treatmentMetrics.technical = 0;
    expect(() => packageOwnerControlledCandidate(invalid))
      .toThrow(/HARD_FLOOR_REGRESSION/);
  });

  it('rejects unmatched seed evidence', () => {
    const invalid = structuredClone(input);
    delete invalid.trials[0].seed;
    expect(() => packageOwnerControlledCandidate(invalid))
      .toThrow(/SEED_INVALID/);
  });

  it('rejects a control/treatment configuration mismatch', () => {
    const invalid = structuredClone(input);
    invalid.trials[0].treatmentConfigurationDigest = 'a'.repeat(64);
    expect(() => packageOwnerControlledCandidate(invalid))
      .toThrow(/CONFIGURATION_MISMATCH/);
  });

  it('fails the gate when packaged identity is decoupled from sealed review', () => {
    const forged = structuredClone(input);
    forged.candidate.review.author.provider = 'forged-provider';
    const { receiptDigest: _discard, ...unsigned } = forged.candidate.review;
    forged.candidate.review.receiptDigest = sealedDigest(unsigned);
    const candidate = packageOwnerControlledCandidate(forged);
    const gate = createCausalCandidateGateReceipt({
      generatedAt: receipt.generatedAt,
      prerequisites: receipt.prerequisites,
      candidate,
      failClosedCases: receipt.failClosedCases,
      evidenceRefs: receipt.evidenceRefs,
    });
    expect(gate.outcome).toBe('FAIL');
    expect(gate.checks.reviewerApprovedCandidate).toBe(false);
  });

  it('fails the gate when packaged diff is decoupled from sealed review', () => {
    const forged = structuredClone(input);
    forged.candidate.experiment.changedPaths = ['src/forged.ts'];
    forged.diff.paths = ['src/forged.ts'];
    forged.diff.digest = 'b'.repeat(64);
    const gate = createCausalCandidateGateReceipt({
      generatedAt: receipt.generatedAt,
      prerequisites: receipt.prerequisites,
      candidate: packageOwnerControlledCandidate(forged),
      failClosedCases: receipt.failClosedCases,
      evidenceRefs: receipt.evidenceRefs,
    });
    expect(gate.outcome).toBe('FAIL');
    expect(gate.checks.evidenceComplete).toBe(false);
  });

  it('rejects a tampered package', () => {
    const tampered = structuredClone(receipt.candidate);
    tampered.analysis.meanEffect = 10;
    expect(() => parseOwnerControlledCandidate(tampered))
      .toThrow(/digest mismatch/);
  });
});
