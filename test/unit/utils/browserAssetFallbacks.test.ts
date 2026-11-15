import { describe, expect, it } from 'vitest';
import { P5_CDN, P5_SOUND_CDN } from '../../../src/constants/index.js';
import { getLocalP5ScriptForUrl, getPinnedBrowserAssetForUrl } from '../../../src/utils/browserAssetFallbacks.js';

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
