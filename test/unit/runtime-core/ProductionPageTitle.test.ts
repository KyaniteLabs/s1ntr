import { describe, expect, it } from 'vitest';
import { PRODUCTION_PAGE_TITLE, wrapPlayable } from '../../../src/runtime-core/LiminalProductionEffects.js';

// v16 title-cards (2026-11-16): every wrapped HyperFrames/ASCII preview showed "Liminal Artwork".
describe('production page title', () => {
  for (const domain of ['textgen', 'p5', 'glsl'] as const) {
    it(`${domain}: the wrapped page never shows the old name`, () => {
      const code = domain === 'textgen' ? 'a poem' : 'void setup(){}';
      const page = wrapPlayable(code, domain, []);
      expect(page).not.toMatch(/Liminal Artwork/i);
    });
  }
  it('the title is the product name', () => {
    expect(PRODUCTION_PAGE_TITLE).toBe('S1NTR');
    expect(wrapPlayable('a poem', 'textgen', [])).toContain('S1NTR');
  });
});
