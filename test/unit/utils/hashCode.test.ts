import { describe, expect, it } from 'vitest';
import { hashCode } from '../../../src/utils/hashCode.js';

describe('hashCode', () => {
  it('returns 0 for the empty string', () => {
    expect(hashCode('')).toBe(0);
  });

  it('matches the known 31-multiplier string hash values', () => {
    expect(hashCode('a')).toBe(97);
    expect(hashCode('abc')).toBe(96354);
  });

  it('is deterministic and order sensitive', () => {
    expect(hashCode('particles')).toBe(hashCode('particles'));
    expect(hashCode('ab')).not.toBe(hashCode('ba'));
  });

  it('wraps to a signed 32-bit integer for long inputs', () => {
    const h = hashCode('the quick brown fox jumps over the lazy dog'.repeat(8));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(-2147483648);
    expect(h).toBeLessThanOrEqual(2147483647);
  });
});
