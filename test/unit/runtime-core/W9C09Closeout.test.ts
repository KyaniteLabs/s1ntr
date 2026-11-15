import { describe, expect, it } from 'vitest';
import {
  WAVE9_RESIDUAL_KINDS,
  validateWave9Receipt,
  evaluateWave9Gate,
  createWave9Receipt,
  type Wave9ResidualAttestation,
} from '../../../src/runtime-core/Wave9Closeout.js';

const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);

function makeAttestation(kind: string, closed = true): Wave9ResidualAttestation {
  return { kind: kind as Wave9ResidualAttestation['kind'], closed, evidenceDigest: DIGEST('a'), detail: `${kind} evidence` };
}

function fullReceipt(closed = true): ReturnType<typeof createWave9Receipt> {
  return createWave9Receipt('w9-test', WAVE9_RESIDUAL_KINDS.map((k) => makeAttestation(k, closed)));
}

describe('W9C-09: Wave 9 closeout — release root extension', () => {
  it('defines exactly six residual kinds', () => {
    expect(WAVE9_RESIDUAL_KINDS.length).toBe(6);
  });

  it('includes all six Wave 8 residuals', () => {
    const kinds = [...WAVE9_RESIDUAL_KINDS];
    expect(kinds).toContain('beauty-judgment');
    expect(kinds).toContain('multi-node-graphs');
    expect(kinds).toContain('studio-driven-execution');
    expect(kinds).toContain('revision-improvement');
    expect(kinds).toContain('transfer-experiment');
    expect(kinds).toContain('dream-loop-closure');
  });

  it('validates a complete receipt with all six closed', () => {
    const receipt = fullReceipt(true);
    const failures = validateWave9Receipt(receipt);
    expect(failures).toEqual([]);
  });

  it('fails validation when a residual is missing', () => {
    const residuals = WAVE9_RESIDUAL_KINDS.slice(0, 5).map((k) => makeAttestation(k));
    const receipt = createWave9Receipt('w9', residuals);
    const failures = validateWave9Receipt(receipt);
    expect(failures).toContain('missing-residual:dream-loop-closure');
  });

  it('fails validation when a residual is not closed', () => {
    const residuals = WAVE9_RESIDUAL_KINDS.map((k) => makeAttestation(k, k !== 'transfer-experiment'));
    const receipt = createWave9Receipt('w9', residuals);
    const failures = validateWave9Receipt(receipt);
    expect(failures).toContain('residual-not-closed:transfer-experiment');
  });

  it('evaluates gate as all-closed when all six are closed', () => {
    const receipt = fullReceipt(true);
    const report = evaluateWave9Gate(receipt);
    expect(report.allResidualsClosed).toBe(true);
    expect(report.openResiduals).toEqual([]);
  });

  it('evaluates gate with open residuals when some are not closed', () => {
    const residuals = WAVE9_RESIDUAL_KINDS.map((k) => makeAttestation(k, k === 'beauty-judgment'));
    const receipt = createWave9Receipt('w9', residuals);
    const report = evaluateWave9Gate(receipt);
    expect(report.allResidualsClosed).toBe(false);
    expect(report.openResiduals.length).toBe(5);
    expect(report.residualSummary['beauty-judgment']).toBe(true);
  });

  it('evaluates gate as all-open when receipt is undefined', () => {
    const report = evaluateWave9Gate(undefined);
    expect(report.allResidualsClosed).toBe(false);
    expect(report.openResiduals.length).toBe(6);
  });

  it('creates frozen receipt objects', () => {
    const receipt = fullReceipt(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt.schema).toBe('sinter.wave9-creative-campaign');
    expect(receipt.schemaVersion).toBe(1);
  });
});
