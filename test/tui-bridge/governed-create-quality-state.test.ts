import { describe, expect, it } from 'vitest';
import { studioQualityState } from '../../src/tui-bridge/service/GovernedCreate.js';

const base = { degraded: false, identityValid: true, admissionEligible: false };

describe('Studio quality label (Sol L3-12)', () => {
  it('calls a real rejection scored, not degraded', () => {
    expect(studioQualityState(base)).toBe('scored');
    expect(studioQualityState({ ...base, admissionEligible: true })).toBe('scored');
  });
  it('keeps unscored and degraded for missing or unusable verdicts', () => {
    expect(studioQualityState({ ...base, scoreState: 'unscored', degraded: true })).toBe('unscored');
    expect(studioQualityState({ ...base, degraded: true })).toBe('degraded');
    expect(studioQualityState({ ...base, identityValid: false })).toBe('degraded');
  });
});
