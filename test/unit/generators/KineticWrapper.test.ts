import { describe, it, expect } from 'vitest';

import { KineticWrapper } from '../../../src/generators/kinetic/KineticWrapper.js';

describe('KineticWrapper', () => {
  it('wraps bare HTML body content in full document', () => {
    const result = KineticWrapper.wrap('<div>Hello</div>');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<html lang="en">');
    expect(result).toContain('<div>Hello</div>');
    expect(result).toContain('kinetic-canvas');
  });

  it('uses custom title when provided', () => {
    const result = KineticWrapper.wrap('<div>X</div>', { title: 'My Art' });
    expect(result).toContain('<title>My Art</title>');
  });

  it('defaults title to Kinetic Artwork', () => {
    const result = KineticWrapper.wrap('<div>X</div>');
    expect(result).toContain('<title>Kinetic Artwork</title>');
  });

  const POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'none'; font-src 'self';";
  const HEADERS = '<meta http-equiv="X-Frame-Options" content="DENY">'
    + '<meta http-equiv="X-Content-Type-Options" content="nosniff">'
    + '<meta http-equiv="Referrer-Policy" content="strict-origin-when-cross-origin">'
    + `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

  it('gives a full page the model wrote the network policy, first thing in its head', () => {
    const html = '<!DOCTYPE html><html><head><title>t</title><link rel="stylesheet" href="https://example.invalid/a.css"></head>'
      + '<body><div>X</div><script>fetch("https://example.invalid/y")</script></body></html>';
    expect(KineticWrapper.wrap(html)).toBe(html.replace('<head>', `<head>${HEADERS}`));
  });

  it('keeps the page layout as the model wrote it', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>Content</p></body></html>';
    expect(KineticWrapper.wrap(html)).toBe(`<html><head>${HEADERS}<style>p{color:red}</style></head><body><p>Content</p></body></html>`);
  });

  it('adds a head for the policy when the page has none', () => {
    expect(KineticWrapper.wrap('<!DOCTYPE html><html><body><div>X</div></body></html>'))
      .toBe(`<!DOCTYPE html><html><head>${HEADERS}</head><body><div>X</div></body></html>`);
    expect(KineticWrapper.wrap('<!DOCTYPE html><div>X</div>'))
      .toBe(`<!DOCTYPE html><head>${HEADERS}</head><div>X</div>`);
  });

  it('puts the policy ahead of a looser one the page brings itself', () => {
    const own = '<meta http-equiv="Content-Security-Policy" content="default-src *">';
    expect(KineticWrapper.wrap(`<html><head>${own}</head><body><div>X</div></body></html>`))
      .toBe(`<html><head>${HEADERS}${own}</head><body><div>X</div></body></html>`);
  });

  it('adds the policy once however often the page is wrapped', () => {
    const once = KineticWrapper.wrap('<html><head></head><body><div>X</div></body></html>');
    expect(KineticWrapper.wrap(once)).toBe(once);
    expect(once.split('Content-Security-Policy').length - 1).toBe(1);
  });

  it('includes security headers in wrapped output', () => {
    const result = KineticWrapper.wrap('<div>Test</div>');
    expect(result).toContain('X-Frame-Options');
    expect(result).toContain('X-Content-Type-Options');
    expect(result).toContain('Content-Security-Policy');
    expect(result).toContain('Referrer-Policy');
  });

  it('includes base reset styles', () => {
    const result = KineticWrapper.wrap('<div>Test</div>');
    expect(result).toContain('box-sizing: border-box');
    expect(result).toContain('overflow: hidden');
  });
});
