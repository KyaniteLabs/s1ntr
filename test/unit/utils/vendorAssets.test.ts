/**
 * Vendor integrity contract (issue #924).
 *
 * Zero CDN fallback means a missing or tampered vendor file must fail LOUD
 * here — at build/test time — never as a blank canvas at render time.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  VENDOR_ASSETS,
  isVendorAssetPath,
  readVendorAsset,
  vendorRoot,
  inlineVendorAssets,
  RUNTIME_FETCHED_ASSETS,
  fetchPinnedRuntimeAsset,
} from '../../../src/utils/vendorAssets.js';
import { HTMLWrapper } from '../../../src/utils/htmlWrapper.js';

const vendorManifestPath = fileURLToPath(new URL('../../../vendor/manifest.json', import.meta.url));

interface ManifestAsset {
  id: string;
  file: string;
  url: string;
  version: string;
  sha256: string;
  bytes: number;
}

describe('vendor manifest integrity', () => {
  it('declares every registered VENDOR_ASSETS path on disk with matching sha256', async () => {
    const manifest = JSON.parse(await readFile(vendorManifestPath, 'utf8')) as { assets: ManifestAsset[] };
    const byPath = new Map(manifest.assets.map(a => [`/vendor/${a.file}`, a]));
    expect(manifest.assets.length).toBeGreaterThanOrEqual(10);

    for (const path of Object.values(VENDOR_ASSETS)) {
      const entry = byPath.get(path);
      expect(entry && `/vendor/${entry.file}`, `manifest missing entry for ${path}`).toBe(path);
      // The public tree ships without RUNTIME_FETCHED_ASSETS files (GSAP): there the CDN pin must equal the manifest pin.
      if (RUNTIME_FETCHED_ASSETS[path] && !existsSync(`${vendorRoot()}${entry!.file}`)) {
        expect(RUNTIME_FETCHED_ASSETS[path].sha256).toBe(entry!.sha256);
        continue;
      }
      const bytes = await readFile(`${vendorRoot()}${entry!.file}`);
      expect(bytes.length).toBe(entry!.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry!.sha256);
    }
  });

  it('resolves every registered path from disk (fail loud when missing)', async () => {
    for (const path of Object.values(VENDOR_ASSETS)) {
      // The public tree has no GSAP file. Reading it there would fetch the CDN; the stubbed-fetch test below covers that path.
      if (RUNTIME_FETCHED_ASSETS[path] && !existsSync(`${vendorRoot()}${path.slice('/vendor/'.length)}`)) continue;
      const body = await readVendorAsset(path);
      expect(body.length).toBeGreaterThan(path.endsWith(".js") ? 1000 : 0);
    }
  });

  it('pins every runtime-fetched asset to the manifest sha256', async () => {
    const manifest = JSON.parse(await readFile(vendorManifestPath, 'utf8')) as { assets: ManifestAsset[] };
    const byPath = new Map(manifest.assets.map(a => [`/vendor/${a.file}`, a]));
    expect(Object.keys(RUNTIME_FETCHED_ASSETS)).toEqual(['/vendor/gsap/3.15.0/gsap.min.js']);
    for (const [path, pin] of Object.entries(RUNTIME_FETCHED_ASSETS)) {
      expect(isVendorAssetPath(path), path).toBe(true);
      expect(pin.sha256, path).toBe(byPath.get(path)?.sha256);
      expect(pin.url, path).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3\.15\.0\/dist\/gsap\.min\.js$/);
    }
  });

  it('accepts runtime-fetched bytes only when they match the pin', async () => {
    const path = '/vendor/gsap/3.15.0/gsap.min.js';
    const body = 'pinned body';
    const answer = (text: string, status = 200) => (async () => new Response(text, { status })) as unknown as typeof fetch;
    // A tampered or wrong-version body is refused.
    await expect(fetchPinnedRuntimeAsset(path, answer(body))).rejects.toThrow(/does not match the pin/);
    await expect(fetchPinnedRuntimeAsset(path, answer('', 404))).rejects.toThrow(/HTTP 404/);
    await expect(fetchPinnedRuntimeAsset('/vendor/p5/1.9.0/p5.min.js', answer(body))).rejects.toThrow(/no runtime source/);
    // The vendored copy, where present, is exactly what the pin accepts.
    const local = `${vendorRoot()}gsap/3.15.0/gsap.min.js`;
    if (existsSync(local)) {
      const bytes = await readFile(local, 'utf8');
      await expect(fetchPinnedRuntimeAsset(path, answer(bytes))).resolves.toBe(bytes);
    }
  });

  it('rejects non-vendor and unregistered paths loudly', async () => {
    await expect(readVendorAsset('https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js'))
      .rejects.toThrow(/not a \/vendor\/ path/);
    await expect(readVendorAsset('/vendor/does/not/exist.js'))
      .rejects.toThrow(/unregistered vendored asset/);
    expect(isVendorAssetPath(VENDOR_ASSETS.p5)).toBe(true);
    expect(isVendorAssetPath(VENDOR_ASSETS.strudelClockworker)).toBe(true);
    expect(isVendorAssetPath(VENDOR_ASSETS.threeOrbitControls)).toBe(true);
    expect(isVendorAssetPath('/vendor/nope.js')).toBe(false);
  });

  it.each([
    '/vendor/../package.json', '/vendor/p5/../../package.json',
    '/vendor/%2e%2e/package.json', '/vendor/..\\package.json',
    '/vendor/manifest.json', '/vendor/p5/1.9.0/p5.min.js?extra=1',
  ])('rejects an unregistered or escaping asset before inlining (%s)', async (path) => {
    await expect(readVendorAsset(path)).rejects.toThrow(/unregistered vendored asset/);
    await expect(inlineVendorAssets(`<script src="${path}"></script>`))
      .rejects.toThrow(/unregistered vendored asset/);
  });

  it('rejects traversal inside a wrapped preview frame', async () => {
    const html = HTMLWrapper.wrap('<!doctype html><html><head>'
      + '<script src="/vendor/../package.json"></script></head><body>'
      + '<div data-composition-id="test"></div></body></html>', { domain: 'hyperframes' });
    expect(html).toContain('srcdoc=');
    await expect(inlineVendorAssets(html)).rejects.toThrow(/unregistered vendored asset/);
  });
});

describe('wrapped artifacts carry zero CDN references (#924)', () => {
  const CDN_URL_RE = /https?:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//g;

  function assertNoCdn(html: string, label: string): void {
    const hits = html.match(CDN_URL_RE);
    expect(hits, `${label} still references CDNs: ${hits?.join(', ')}`).toBeNull();
  }

  it('p5 wrapper', () => {
    const html = HTMLWrapper.wrap('function setup(){createCanvas(200,200);} function draw(){background(0);}', { domain: 'p5' });
    assertNoCdn(html, 'p5');
    expect(html).toContain('src="/vendor/p5/1.9.0/p5.min.js"');
  });

  it('three wrapper import map', () => {
    const html = HTMLWrapper.wrap('const s = new THREE.Scene();', { domain: 'three' });
    assertNoCdn(html, 'three');
    expect(html).toContain('"/vendor/three/0.160.0/three.module.js"');
    // Addon prefix mappings were dropped: imports into examples/jsm are banned
    // by generator validation, and an unserved mapping would fail silently.
    expect(html).not.toContain('three/addons/');
  });

  it('tone, hydra, and strudel wrappers', () => {
    const tone = HTMLWrapper.wrap('Tone.Transport.start();', { domain: 'tone' });
    assertNoCdn(tone, 'tone');
    expect(tone).toContain('src="/vendor/tone/14.8.49/Tone.js"');

    const hydra = HTMLWrapper.wrap('osc(10).out(o0); render(o0);', { domain: 'hydra' });
    assertNoCdn(hydra, 'hydra');
    expect(hydra).toContain('src="/vendor/hydra-synth/1.3.10/hydra-synth.js"');

    const strudel = HTMLWrapper.wrap('s("bd hh").cpm(120);', { domain: 'strudel' });
    assertNoCdn(strudel, 'strudel');
    expect(strudel).toContain('src="/vendor/strudel-web/1.3.0/strudel-web.js"');
    // Sample banks stay remote until vendored (sized follow-up on #924).
    expect(strudel).toContain('strudel.b-cdn.net');
  });

  it('every CSP meta in wrapped output allows scripts from the local origin only', () => {
    const html = HTMLWrapper.wrap('function setup(){createCanvas(10,10);}', { domain: 'p5' });
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'");
    expect(csp).not.toMatch(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com/);
  });
});

describe('inlineVendorAssets (embedded render path)', () => {
  it.each(['"', "'"])('loads pinned GSAP inside the HyperFrames preview iframe (quote=%s)', async (quote) => {
    const source = '<!doctype html><html><head>'
      + `<script src=${quote}${VENDOR_ASSETS.gsap}${quote}></script></head><body>`
      + '<div data-composition-id="layers" class="clip">Layers</div>'
      + '<script>window.__timelines={layers:gsap.timeline({paused:true})};</script>'
      + '</body></html>';
    const wrapped = HTMLWrapper.wrap(source, { domain: 'hyperframes' });
    const digests: string[] = [];
    const inlined = await inlineVendorAssets(wrapped, digest => digests.push(digest));
    const srcdoc = inlined.match(/\bsrcdoc="([^"]*)"/)?.[1] ?? '';
    expect(srcdoc).not.toContain('/vendor/gsap/');
    expect(srcdoc).toContain('GSAP');
    expect(srcdoc).toContain('window.__timelines');
    expect(digests).toContain(createHash('sha256')
      .update(await readVendorAsset(VENDOR_ASSETS.gsap)).digest('hex'));
  });

  it('inlines vendored script tags as script bodies', async () => {
    const html = '<html><body><script src="/vendor/p5/1.9.0/p5.min.js"></script><script>window.__ok = typeof window.p5;</script></body></html>';
    const inlined = await inlineVendorAssets(html);
    expect(inlined).not.toContain('src="/vendor/');
    expect(inlined).toContain('window.__ok');
    // p5 bundle body must be present inline
    expect(inlined.length).toBeGreaterThan(500_000);
  });

  it('rewrites import map entries to data: URLs and drops vendor prefix mappings', async () => {
    const html = `<html><head>
      <script type="importmap">{"imports":{"three":"/vendor/three/0.160.0/three.module.js","three/addons/":"/vendor/three/0.160.0/examples/jsm/","other":"https://example.com/x.js"}}</script>
    </head><body></body></html>`;
    const inlined = await inlineVendorAssets(html);
    expect(inlined).toMatch(/"three":"data:text\/javascript;base64,/);
    expect(inlined).not.toContain('"three/addons/"');
    expect(inlined).toContain('"other":"https://example.com/x.js"');
  });

  it('leaves non-vendor script tags untouched', async () => {
    const html = '<html><body><script src="https://example.com/x.js"></script></body></html>';
    expect(await inlineVendorAssets(html)).toBe(html);
  });

  it('reports the sha256 digest of every inlined vendored script (pinned-runtime evidence)', async () => {
    // Regression: the embedded render path inlines /vendor/ script tags, so no
    // network request ever reaches the route-level fallback — without digest
    // reporting here, RENDER_PINNED_RUNTIME_ASSET_REQUIRED fired on every
    // correctly vendored piece (#924 regression, fleet scoring stall).
    const expected = createHash('sha256')
      .update(await readVendorAsset(VENDOR_ASSETS.p5)).digest('hex');
    const html = '<html><body>'
      + '<script src="/vendor/p5/1.9.0/p5.min.js"></script>'
      + '<script src="/vendor/tone/14.8.49/Tone.js"></script>'
      + '</body></html>';
    const digests: string[] = [];
    const inlined = await inlineVendorAssets(html, (digest) => digests.push(digest));
    expect(inlined).not.toContain('src="/vendor/');
    expect(digests).toHaveLength(2);
    expect(digests[0]).toBe(expected);
    expect(digests[1]).toHaveLength(64);
  });

  it('reports digests for import map entries rewritten to data: URLs', async () => {
    const expected = createHash('sha256')
      .update(await readVendorAsset(VENDOR_ASSETS.threeModule)).digest('hex');
    const html = '<html><head>'
      + '<script type="importmap">{"imports":{"three":"/vendor/three/0.160.0/three.module.js","three/addons/":"/vendor/three/0.160.0/examples/jsm/"}}</script>'
      + '</head><body></body></html>';
    const digests: string[] = [];
    await inlineVendorAssets(html, (digest) => digests.push(digest));
    // The exact mapping reports once; the dropped prefix mapping reports nothing.
    expect(digests).toEqual([expected]);
  });

  it('reports nothing when the page carries no vendored reference', async () => {
    const html = '<html><body><script src="https://example.com/x.js"></script></body></html>';
    const digests: string[] = [];
    const inlined = await inlineVendorAssets(html, (digest) => digests.push(digest));
    expect(inlined).toBe(html);
    expect(digests).toEqual([]);
  });
});
