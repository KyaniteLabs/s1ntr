import { describe, expect, it } from 'vitest';
import { runMockBeautyBattery, technicalFromFixture, beautyFromFixture } from '../../../scripts/rotation/beauty-v1.mjs';

describe('beauty-v1', () => {
  it('keeps technical pass separate from beauty reject on letterbox', () => {
    expect(technicalFromFixture('hydra', { letterbox: true }).result).toBe('pass');
    expect(beautyFromFixture('hydra', { letterbox: true }).verdict).toBe('reject');
  });

  it('mock battery asserts technical ≠ beauty', () => {
    const s = runMockBeautyBattery('testsha');
    expect(s.ok).toBe(true);
    expect(s.assertsTechnicalNotBeauty).toBe(true);
    expect(s.receipts).toHaveLength(4);
  });
});
