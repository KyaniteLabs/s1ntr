import { describe, expect, it } from 'vitest';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { toPreviewHtml } from '../../../src/tui-bridge/PreviewService.js';

describe('preview creative identity', () => {
  it('embeds the verified thesis identity in delivered preview HTML', () => {
    const thesis = compileCreativeThesis('A restrained field opens into luminous release.');
    const html = toPreviewHtml('<html><head></head><body><canvas></canvas></body></html>', 'p5', thesis);
    expect(html).toContain(`data-creative-thesis-id="${thesis.thesisId}"`);
    expect(html).toContain('data-creative-principle-id="contrast"');
    expect(html).toContain('data-creative-contract-version="1"');
    expect(html).toContain(`data-creative-projection-digest="${thesis.principles[0].contractIdentity.projectionDigest}"`);
  });

  it('does not invent identity for a legacy preview without a thesis', () => {
    expect(toPreviewHtml('<html><body>legacy</body></html>', 'html'))
      .not.toContain('data-creative-thesis-id');
  });
});
