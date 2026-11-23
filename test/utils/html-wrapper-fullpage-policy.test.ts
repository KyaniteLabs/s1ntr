/**
 * FABLE-R3.7: a complete page the model wrote must carry the same network
 * policy a fragment of its medium carries, for every medium.
 */
import { describe, it, expect } from 'vitest';
import { HTMLWrapper } from '../../src/utils/htmlWrapper.js';
import { Domain } from '../../src/types/domains.js';

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>'
  + '<body><h1>x</h1><img src="https://outside.invalid/p.png" alt=""></body></html>';

function policies(html: string): string[] {
  return [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)].map(m => m[1]);
}

describe('full-page network policy', () => {
  const mediums = Object.values(Domain) as string[];

  it.each(mediums)('%s: a full page comes back with exactly one policy', (domain) => {
    const html = HTMLWrapper.wrap(PAGE, { domain: domain as never });
    const found = policies(html);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^default-src 'none';/);
    expect(found[0]).not.toMatch(/img-src[^;]*\*/);
  });

  it('keeps library grants when the renderer re-wraps a holospot playable (v9: blob worker blocked)', () => {
    const page = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
      + '<script type="module">import * as THREE from "three";\nimport { Holo, shotCamera } from "holospot";\n'
      + 'const holo = new Holo(renderer);</script></body></html>';
    const playable = HTMLWrapper.wrap(page, { domain: 'three', libraries: ['holospot'] });
    const rendered = HTMLWrapper.wrap(playable, { domain: 'three' });
    const found = policies(rendered);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/worker-src[^;]*blob:/);
    expect(rendered).toContain('"holospot": "/vendor/holospot/');
  });

  it('places the policy first in <head>, before anything the page loads', () => {
    const html = HTMLWrapper.wrap(PAGE, { domain: 'html' });
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<meta charset="utf-8">'));
    expect(policies(html)[0]).toContain("connect-src 'none'");
  });

  it('keeps the Strudel sample hosts on a Strudel full page', () => {
    const html = HTMLWrapper.wrap(PAGE, { domain: 'strudel' });
    expect(policies(html)[0]).toContain('connect-src \'self\' https://strudel.b-cdn.net https://raw.githubusercontent.com');
  });

  it('replaces a policy the page brought with Sinter\'s own', () => {
    const own = PAGE.replace('<title>', '\n<meta http-equiv="Content-Security-Policy" content="default-src *">\n<title>');
    const found = policies(HTMLWrapper.wrap(own, { domain: 'p5' }));
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('default-src *');
  });

  it('creates a head when the page has none', () => {
    const html = HTMLWrapper.wrap('<!DOCTYPE html><html><body><p>hi</p></body></html>', { domain: 'html' });
    expect(html).toMatch(/^<!DOCTYPE html><html><head><meta http-equiv="X-Content-Type-Options"/);
    expect(policies(html)).toHaveLength(1);
  });

  it('points a known CDN library at the shipped copy and drops its hash', () => {
    const cdn = PAGE.replace('</head>', '<script src="https://cdn.jsdelivr.net/npm/p5@1.9.0/lib/p5.min.js" integrity="sha384-abc" crossorigin="anonymous"></script></head>');
    const html = HTMLWrapper.wrap(cdn, { domain: 'p5' });
    expect(html).toContain('<script src="/vendor/p5/1.9.0/p5.min.js" crossorigin="anonymous"></script>');
    expect(html).not.toContain('integrity=');
  });

  it('leaves an unknown remote script for the policy to refuse', () => {
    const cdn = PAGE.replace('</head>', '<script src="https://unknown.invalid/x.js"></script></head>');
    expect(HTMLWrapper.wrap(cdn, { domain: 'p5' })).toContain('<script src="https://unknown.invalid/x.js"></script>');
  });

  it('leaves a page that already carries Sinter\'s shell to that shell', () => {
    const shelled = '<!DOCTYPE html><html><head><title>t</title></head><body data-tone-preview-shell="1"></body></html>';
    expect(policies(HTMLWrapper.wrap(shelled, { domain: 'html' }))).toHaveLength(0);
  });
});

describe('pass-through mediums without a document shell', () => {
  it.each(['html', 'dataviz', 'custom', 'meta'])('%s: a bare body still gets one policy ahead of its content', (domain) => {
    const html = HTMLWrapper.wrap('<div><img src="https://outside.invalid/p.png"></div>', { domain: domain as never });
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<div>'));
    expect(policies(html)).toHaveLength(1);
  });
});
