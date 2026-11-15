import { describe, expect, it } from 'vitest';
import { isFailureStatus } from '../../../src/harness/SelfImproveCompoundLoop.js';

describe('self-improve outcome classification', () => {
  it('treats suspended and cancelled runs as failures', () => {
    expect(isFailureStatus('suspended')).toBe(true);
    expect(isFailureStatus('cancelled')).toBe(true);
    expect(isFailureStatus('failed')).toBe(true);
    expect(isFailureStatus('rolled_back')).toBe(true);
  });

  it('does not treat completed/success runs as failures', () => {
    expect(isFailureStatus('success')).toBe(false);
    expect(isFailureStatus('completed')).toBe(false);
  });
});
