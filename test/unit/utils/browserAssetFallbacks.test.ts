import { describe, expect, it } from 'vitest';
import { P5_CDN, P5_SOUND_CDN } from '../../../src/constants/index.js';
import { getLocalP5ScriptForUrl, getPinnedBrowserAssetForUrl, vendorPathForUrl, unservedScriptUrls } from '../../../src/utils/browserAssetFallbacks.js';
import { HTMLWrapper } from '../../../src/utils/htmlWrapper.js';

describe('browser asset fallbacks', () => {
  it('fulfills canonical p5 and p5.sound cdnjs URLs from local package assets', async () => {
    await expect(getLocalP5ScriptForUrl(P5_CDN)).resolves.toContain('p5.js');
    await expect(getLocalP5ScriptForUrl(P5_SOUND_CDN)).resolves.toContain('p5.sound');
  });

  it('keeps the legacy addons p5.sound cdnjs path offline-safe', async () => {
    const localScript = await getLocalP5ScriptForUrl(
      'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/addons/p5.sound.min.js',
    );

    expect(localScript).toContain('p5.sound');
  });

  it('ignores unrelated cdnjs assets', async () => {
    await expect(
      getLocalP5ScriptForUrl('https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js'),
    ).resolves.toBeNull();
  });
});

describe('D3 v7 CDN spellings resolve to the vendored bundle', () => {
  it('serves the vendored d3 7.9.0 for every common v7 CDN URL', async () => {
    const vendored = await getPinnedBrowserAssetForUrl('/vendor/d3/7.9.0/d3.min.js');
    for (const url of [
      'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js',
      'https://cdn.jsdelivr.net/npm/d3@7.8.5/dist/d3.min.js',
      'https://unpkg.com/d3@7',
      'https://d3js.org/d3.v7.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js',
    ]) {
      expect((await getPinnedBrowserAssetForUrl(url))?.digest, url).toBe(vendored?.digest);
    }
  });

  it('does not map other D3 majors or unrelated hosts', async () => {
    for (const url of [
      'https://d3js.org/d3.v5.min.js',
      'https://cdn.jsdelivr.net/npm/d3@6/dist/d3.min.js',
      'https://evil.example/d3@7/dist/d3.min.js',
      'not a url',
    ]) {
      expect(await getPinnedBrowserAssetForUrl(url), url).toBeNull();
    }
  });
});

// glm v16-loop-ridgeline (preflight 2026-11-16) loaded culori from jsdelivr;
// the page CSP blocked it and the piece died on "culori is not defined".
describe('CDN URLs for vendored script libraries resolve to /vendor', () => {
  it('maps the CDN spellings models write for culori, the d3 add-ons and the other script libraries', () => {
    const cases: Array<[string, string]> = [
      ['https://cdn.jsdelivr.net/npm/culori@4/dist/culori.min.js', '/vendor/culori/4.0.2/culori.min.js'],
      ['https://unpkg.com/culori@4.0.1', '/vendor/culori/4.0.2/culori.min.js'],
      ['https://cdn.jsdelivr.net/npm/d3-delaunay@6', '/vendor/d3-delaunay/6.0.4/d3-delaunay.min.js'],
      ['https://cdn.jsdelivr.net/npm/d3-geo@3.1.0/dist/d3-geo.min.js', '/vendor/d3-geo/3.1.1/d3-geo.min.js'],
      ['https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.20.0/matter.min.js', '/vendor/matter-js/0.20.0/matter.min.js'],
      ['https://cdnjs.cloudflare.com/ajax/libs/twgl.js/7.0.0/twgl-full.min.js', '/vendor/twgl/7.0.0/twgl-full.js'],
      ['https://unpkg.com/roughjs@4.6.6/bundled/rough.js', '/vendor/roughjs/4.6.6/rough.js'],
    ];
    for (const [url, local] of cases) expect(vendorPathForUrl(url), url).toBe(local);
  });

  it('leaves other API lines, ESM builds, unpinned URLs and other hosts on the CDN', () => {
    for (const url of [
      'https://cdn.jsdelivr.net/npm/culori@3/dist/culori.min.js',
      'https://cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js',
      'https://cdn.jsdelivr.net/npm/culori@4/+esm',
      'https://unpkg.com/culori@4/bundled/culori.mjs',
      'https://cdn.jsdelivr.net/npm/culori',
      'https://evil.example/npm/culori@4/dist/culori.min.js',
    ]) {
      expect(vendorPathForUrl(url), url).toBeNull();
    }
  });

  it('rewrites the script tag in the wrapped page, so the CSP allows it', () => {
    const page = HTMLWrapper.wrap('<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/culori@4/dist/culori.min.js" integrity="sha384-x"></script></head><body></body></html>', 'html');
    expect(page).toContain('<script src="/vendor/culori/4.0.2/culori.min.js">');
    expect(page).not.toContain('cdn.jsdelivr.net');
  });

  it('serves the vendored bytes for those URLs', async () => {
    const vendored = await getPinnedBrowserAssetForUrl('/vendor/culori/4.0.2/culori.min.js');
    expect((await getPinnedBrowserAssetForUrl('https://cdn.jsdelivr.net/npm/culori@4'))?.digest).toBe(vendored?.digest);
  });
});

// v2r1: 12 runs died on a CDN script the page CSP blocked.
describe('remaining CDN spellings from v2r1 resolve to /vendor', () => {
  it('maps d3js.org/d3.min.js (latest = v7) and three build URLs on jsdelivr/unpkg', () => {
    expect(vendorPathForUrl('https://d3js.org/d3.min.js')).toBe('/vendor/d3/7.9.0/d3.min.js');
    expect(vendorPathForUrl('https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js'))
      .toBe('/vendor/three/0.160.0/three.module.js');
    expect(vendorPathForUrl('https://unpkg.com/three@0.160.0/build/three.min.js'))
      .toBe('/vendor/three/r128/three.min.js');
  });

  it('does not map look-alike hosts or other three majors of the module build', () => {
    expect(vendorPathForUrl('https://cdnjs.cloudjs.tld/dist/culori.min.js')).toBeNull();
    expect(vendorPathForUrl('https://evil.example/three@0.160/build/three.module.js')).toBeNull();
    expect(vendorPathForUrl('https://cdn.jsdelivr.net/npm/three@0.150.0/build/three.module.js')).toBeNull();
  });
});

describe('unservedScriptUrls', () => {
  it('lists external scripts that no vendored copy can stand in for, and ignores served ones', () => {
    const html = `<script src="https://d3js.org/d3.min.js"></script>
<script src='/vendor/p5/1.9.0/p5.min.js'></script>
<script src="https://cdnjs.cloudjs.tld/dist/culori.min.js"></script>
<script>const a = "https://example.com/x.js";</script>`;
    expect(unservedScriptUrls(html)).toEqual(['https://cdnjs.cloudjs.tld/dist/culori.min.js']);
  });
});

describe('GSAP 3 CDN spellings resolve to the vendored bundle', () => {
  it('serves the vendored gsap 3.15.0 for pinned and floating 3.x CDN URLs', async () => {
    const vendored = await getPinnedBrowserAssetForUrl('/vendor/gsap/3.15.0/gsap.min.js');
    expect(vendored?.digest).toMatch(/^[a-f0-9]{64}$/);
    for (const url of [
      'https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js',
      'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js',
      'https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js',
      'https://unpkg.com/gsap@3.12.2/dist/gsap.js',
      'https://unpkg.com/gsap@3.12.2',
      'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js',
    ]) {
      expect((await getPinnedBrowserAssetForUrl(url))?.digest, url).toBe(vendored?.digest);
    }
  });

  it('does not map GSAP 2, plugins or unrelated hosts', async () => {
    for (const url of [
      'https://cdnjs.cloudflare.com/ajax/libs/gsap/2.1.3/TweenMax.min.js',
      'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js',
      'https://unpkg.com/gsap@3.12.5/index.js',
      'https://evil.example/npm/gsap@3/dist/gsap.min.js',
    ]) {
      expect(await getPinnedBrowserAssetForUrl(url), url).toBeNull();
    }
  });
});
