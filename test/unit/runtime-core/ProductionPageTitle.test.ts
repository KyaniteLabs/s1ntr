import { describe, expect, it } from 'vitest';
import { PRODUCTION_PAGE_TITLE, wrapPlayable } from '../../../src/runtime-core/LiminalProductionEffects.js';

// v16 title-cards (2026-11-16): every wrapped HyperFrames/ASCII preview showed "Liminal Artwork".
describe('production page title', () => {
  const hyperframes = '<div id="stage" data-composition-id="c"><div class="clip" data-start="0" data-duration="5">S1NTR</div></div>';
  for (const domain of ['hyperframes', 'textgen', 'p5', 'glsl'] as const) {
    it(`${domain}: the wrapped page never shows the old name`, () => {
      const code = domain === 'hyperframes' ? hyperframes : domain === 'textgen' ? 'a poem' : 'void setup(){}';
      const page = wrapPlayable(code, domain, []);
      expect(page).not.toMatch(/Liminal Artwork/i);
    });
  }
  it('the title is the product name', () => {
    expect(PRODUCTION_PAGE_TITLE).toBe('S1NTR');
    expect(wrapPlayable(hyperframes, 'hyperframes', [])).toContain('S1NTR');
  });
});
