import { describe, expect, it } from 'vitest';
import { productPurposeForRole } from '../../../src/llm/LLMClient.js';
import { tourProductRuntimeRoot } from '../../../src/runtime-core/TourProductTransport.js';

describe('tour product transport', () => {
  it('maps every product role to a grant purpose', () => {
    expect(productPurposeForRole('generator')).toBe('generation');
    expect(productPurposeForRole('evaluator')).toBe('evaluation');
    expect(productPurposeForRole('studio')).toBe('studio');
    expect(productPurposeForRole('harness')).toBe('harness');
  });

  it('pins the tour runtime under the wave stamp', () => {
    expect(tourProductRuntimeRoot({
      LIMINAL_WAVE_STAMP: '2026-08-13T00-00-00',
      LIMINAL_TOUR_WAVE: '2',
    }, '/tmp/liminal')).toBe('/tmp/liminal/.quality/tour/wave-2/2026-08-13T00-00-00/product-runtime');
  });
});
