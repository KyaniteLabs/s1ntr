import { describe, expect, it } from 'vitest';
import { toComposeDomain, buildComposeRequestBody } from '../../gui/src/components/LayersComposer';

/**
 * Pure logic behind the Studio Layers composer: medium mapping (so a base layer
 * prefilled from the current work lands on a valid composition medium) and the
 * /api/compose request normalization.
 */
describe('LayersComposer logic', () => {
  describe('toComposeDomain', () => {
    it('maps the Studio shader id (glsl) to the composition medium (shader)', () => {
      expect(toComposeDomain('glsl')).toBe('shader');
    });

    it('passes through media the composer supports', () => {
      expect(toComposeDomain('three')).toBe('three');
      expect(toComposeDomain('hydra')).toBe('hydra');
      expect(toComposeDomain('strudel')).toBe('strudel');
    });

    it('falls back to p5 for media that cannot be a layer (kinetic, svg, empty)', () => {
      expect(toComposeDomain('kinetic')).toBe('p5');
      expect(toComposeDomain('svg')).toBe('p5');
      expect(toComposeDomain('')).toBe('p5');
      expect(toComposeDomain(undefined)).toBe('p5');
    });
  });

  describe('buildComposeRequestBody', () => {
    it('trims prompts and strips blend/opacity from the base layer', () => {
      const body = buildComposeRequestBody([
        { domain: 'three', prompt: '  a moonlit bay  ', blendMode: 'screen', opacity: 0.5 },
      ]);
      expect(body).toEqual({ layers: [{ domain: 'three', prompt: 'a moonlit bay' }] });
    });

    it('keeps blend and opacity only on layers stacked on top', () => {
      const body = buildComposeRequestBody([
        { domain: 'three', prompt: 'base bay' },
        { domain: 'shader', prompt: '  fog  ', blendMode: 'screen', opacity: 0.6 },
      ]);
      expect(body.layers).toEqual([
        { domain: 'three', prompt: 'base bay' },
        { domain: 'shader', prompt: 'fog', blendMode: 'screen', opacity: 0.6 },
      ]);
    });

    it('omits blend/opacity when an overlay layer does not set them', () => {
      const body = buildComposeRequestBody([
        { domain: 'p5', prompt: 'base' },
        { domain: 'ascii', prompt: 'glints' },
      ]);
      expect(body.layers[1]).toEqual({ domain: 'ascii', prompt: 'glints' });
    });

    it('keeps the base AS-IS via code (not regenerated) while overlays use prompts', () => {
      const body = buildComposeRequestBody([
        { domain: 'p5', prompt: 'ignored fallback', code: 'function setup(){ createCanvas(400,400); }' },
        { domain: 'shader', prompt: 'fog', blendMode: 'screen' },
      ]);
      // Base sends its code (kept as-is), NOT a prompt to regenerate.
      expect(body.layers[0]).toEqual({ domain: 'p5', code: 'function setup(){ createCanvas(400,400); }', prompt: '' });
      expect(body.layers[1]).toEqual({ domain: 'shader', prompt: 'fog', blendMode: 'screen' });
    });
  });
});
