import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';
import {
  extractLayerHtml,
  renderLayerPng,
} from '../../../src/composition/LayerPngExporter.js';

describe('transparent composition layer PNG export', () => {
  const previousGate = process.env.SINTER_COMPOSITE_GATE;

  afterEach(() => {
    if (previousGate === undefined) delete process.env.SINTER_COMPOSITE_GATE;
    else process.env.SINTER_COMPOSITE_GATE = previousGate;
  });

  it('rejects the opaque-capable base layer', () => {
    expect(() => extractLayerHtml('', 0)).toThrow(/non-base layer index/);
  });

  it('rejects unavailable and audio layers', () => {
    expect(() => extractLayerHtml('', 2)).toThrow(/layer 2 is unavailable/);
    const encoded = Buffer.from('<html></html>').toString('base64');
    const audio = `<iframe data-layer-index="1" data-domain="tone" src="data:text/html;base64,${encoded}"></iframe>`;
    expect(() => extractLayerHtml(audio, 1)).toThrow(/is not visual/);
  });

  it('rejects a visual layer without embedded renderable HTML', () => {
    const iframe = '<iframe data-layer-index="1" data-domain="p5"></iframe>';
    expect(() => extractLayerHtml(iframe, 1)).toThrow(/no renderable HTML/);
  });

  it('rejects a detected opaque foreground', async () => {
    process.env.SINTER_COMPOSITE_GATE = '0';
    const result = await CompositionOrchestrator.compose({
      layers: [
        { domain: 'p5', prompt: 'base', code: 'function setup(){background(0);}' },
        { domain: 'p5', prompt: 'bad foreground', code: 'function setup(){background(255);}' },
      ],
    });

    expect(() => extractLayerHtml(result.html, 1))
      .toThrow(/violates the transparent foreground contract/);
  });

  it('renders transparent and subject pixels from a foreground p5 layer', async () => {
    process.env.SINTER_COMPOSITE_GATE = '0';
    const result = await CompositionOrchestrator.compose({
      layers: [
        {
          domain: 'p5',
          prompt: 'base',
          code: 'function setup(){createCanvas(64,64);background(0);}',
        },
        {
          domain: 'p5',
          prompt: 'foreground',
          code: [
            'function setup(){',
            'createCanvas(64,64);clear();noStroke();',
            'fill(255,40,80,255);rect(20,20,24,24);',
            '}',
          ].join(''),
        },
      ],
    });

    const layerHtml = extractLayerHtml(result.html, 1);
    expect(layerHtml).toContain('data-sinter-composition-foreground');

    const png = await renderLayerPng(result.html, 1);
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = Array.from(
      { length: info.width * info.height },
      (_, index) => data[(index * info.channels) + 3],
    );

    expect(alpha).toContain(0);
    expect(alpha.some(value => value > 0)).toBe(true);
  }, 30_000);
});
