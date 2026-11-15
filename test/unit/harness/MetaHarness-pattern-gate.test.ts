import { describe, expect, it } from 'vitest';
import { verifyPatternBeforeLearn } from '../../../src/harness/SelfImproveCompoundLoop.js';

/**
 * W9-L2-02: MetaHarness must use the same verify-before-learn gate for pattern harvest.
 * Full MetaHarnessIntegration is heavy to unit-test; gate function is the contract seam.
 */
describe('MetaHarness pattern learn gate (W9-L2-02)', () => {
  it('rejects harmful and empty pattern names', () => {
    expect(verifyPatternBeforeLearn({ name: 'harmful-wipe-repo' })).toBe('harmful-pattern-rejected');
    expect(verifyPatternBeforeLearn({ name: '' })).toBe('empty_pattern_name');
  });

  it('allows ordinary pattern names', () => {
    expect(verifyPatternBeforeLearn({ name: 'timeout-storm', description: 'provider timeout' })).toBeNull();
  });

  it('MetaHarnessIntegration source gates recordPatternOccurrence with verifyPatternBeforeLearn', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/harness/MetaHarnessIntegration.ts', 'utf8');
    expect(src).toContain('verifyPatternBeforeLearn');
    // both harvest sites call verify before recordPatternOccurrence
    const idxV = src.indexOf('verifyPatternBeforeLearn');
    const idxR = src.indexOf('recordPatternOccurrence');
    expect(idxV).toBeGreaterThan(0);
    expect(idxR).toBeGreaterThan(idxV);
    expect(src.includes('thinking-analysis')).toBe(true); // thinking path still present (not over-gated)
  });
});
