import { describe, expect, it } from 'vitest';
import {
  MOTION_TEMPORAL_CONTRACT_IDS,
  MOTION_TEMPORAL_CONTRACTS,
  motionTemporalContractDigest,
  resolveMotionTemporalContract,
} from '../../../src/creative-intelligence/temporal/MotionTemporalContracts.js';
import { validateCreativePrincipleContract } from '../../../src/creative-intelligence/CreativeIntelligence.js';

describe('motion/temporal principle contracts', () => {
  it('exposes only hard contracts for the frozen motion/time manifest', () => {
    expect(MOTION_TEMPORAL_CONTRACT_IDS).toEqual(['temporal-arc', 'temporal-rhythm']);
    for (const id of MOTION_TEMPORAL_CONTRACT_IDS) {
      const contract = MOTION_TEMPORAL_CONTRACTS[id];
      expect(contract.status).toBe('hard');
      expect(contract.domain.domain).toBe('motion');
      expect(contract.domain.category).toBe('time-based-structure');
      expect(validateCreativePrincipleContract(contract)).toEqual(contract);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.identity)).toBe(true);
      expect(Object.isFrozen(contract.observablePerceptualEvidence)).toBe(true);
    }
  });

  it('resolves temporal-arc by id, name, and aliases', () => {
    expect(resolveMotionTemporalContract('temporal-arc')?.identity.id).toBe('temporal-arc');
    expect(resolveMotionTemporalContract('Temporal arc')?.identity.id).toBe('temporal-arc');
    expect(resolveMotionTemporalContract('arc over time')?.identity.id).toBe('temporal-arc');
    expect(resolveMotionTemporalContract('time arc')?.identity.id).toBe('temporal-arc');
  });

  it('resolves temporal-rhythm by id, name, and aliases', () => {
    expect(resolveMotionTemporalContract('temporal-rhythm')?.identity.id).toBe('temporal-rhythm');
    expect(resolveMotionTemporalContract('Temporal rhythm')?.identity.id).toBe('temporal-rhythm');
    expect(resolveMotionTemporalContract('pulse')?.identity.id).toBe('temporal-rhythm');
    expect(resolveMotionTemporalContract('beat pattern')?.identity.id).toBe('temporal-rhythm');
  });

  it('returns undefined for unknown principles', () => {
    expect(resolveMotionTemporalContract('chiaroscuro')).toBeUndefined();
    expect(resolveMotionTemporalContract('contrast')).toBeUndefined();
  });

  it('produces a stable, distinct digest per contract', () => {
    const arc = motionTemporalContractDigest(MOTION_TEMPORAL_CONTRACTS['temporal-arc']);
    const rhythm = motionTemporalContractDigest(MOTION_TEMPORAL_CONTRACTS['temporal-rhythm']);
    expect(arc).toMatch(/^[a-f0-9]{64}$/);
    expect(rhythm).toMatch(/^[a-f0-9]{64}$/);
    expect(arc).not.toBe(rhythm);
    expect(motionTemporalContractDigest(MOTION_TEMPORAL_CONTRACTS['temporal-arc'])).toBe(arc);
  });
});
