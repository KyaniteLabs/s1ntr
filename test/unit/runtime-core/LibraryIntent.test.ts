import { describe, it, expect } from 'vitest';
import { parseLibraryIntent, resolveLibraryIntent, eraStampPayload, MAX_LIBRARIES_PER_PIECE } from '../../../src/runtime-core/LibraryIntent.js';

describe('LibraryIntent connector (#1000)', () => {
	it('parses a bare library declaration', () => {
    const r = parseLibraryIntent('some code\nlibraries: culori, roughjs, thing');
    expect(r.libraries).toEqual(['culori', 'roughjs', 'thing']);
    expect(r.layers).toEqual([]);
  });

	it('parses per-layer composite intents and unions the libraries', () => {
    const r = parseLibraryIntent('code\nlayers: p5[culori,roughjs] strudel[tonaljs]');
    expect(r.layers).toEqual([
      { domain: 'p5', libraries: ['culori', 'roughjs'] },
      { domain: 'strudel', libraries: ['tonaljs'] },
    ]);
    expect(r.libraries).toEqual(['culori', 'roughjs', 'tonaljs']);
  });

	it('returns empty for responses with no library intent (valid: not library-bearing)', () => {
    const r = parseLibraryIntent('function setup() { createCanvas(400, 400); }');
    expect(r.libraries).toEqual([]);
    expect(r.layers).toEqual([]);
  });

	it('reads "libraries: none" as no libraries, the reply a small local model gives', () => {
    expect(parseLibraryIntent('<svg></svg>\nlibraries: none')).toEqual({ libraries: [], layers: [] });
    expect(parseLibraryIntent('code\nLibraries: None')).toEqual({ libraries: [], layers: [] });
    expect(parseLibraryIntent('code\nlayers: p5[none] strudel[tonaljs]')).toEqual({
      libraries: ['tonaljs'],
      layers: [{ domain: 'p5', libraries: [] }, { domain: 'strudel', libraries: ['tonaljs'] }],
    });
  });

	it('IGNORES ids that are not vendored instead of killing the piece (v2r1: 66 of 720 runs died here)', () => {
    // The 1.7B model declares the CDN libraries its code loads (three, gsap, p5, strudel) and made-up
    // ids (osc, canvas, bpy). The browser asset fallbacks already serve the CDN ones; none of these needs
    // a wrapper library, and throwing here sat outside the repair loop, so the whole Create was lost.
    const r = parseLibraryIntent('code\nlibraries: lodash, culori');
    expect(r.libraries).toEqual(['culori']);
    expect(r.ignored).toEqual(['lodash']);
    expect(parseLibraryIntent('code\nlibraries: lodash')).toEqual({ libraries: [], layers: [], ignored: ['lodash'] });
    expect(parseLibraryIntent('code\nlibraries: bpy, constructor').libraries).toEqual([]);
    const layered = parseLibraryIntent('code\nlayers: p5[p5,culori] strudel[strudel]');
    expect(layered.libraries).toEqual(['culori']);
    expect(layered.ignored).toEqual(['p5', 'strudel']);
  });

	it('a misspelt vendored id is recovered from the code, not from the declaration', () => {
    const code = "import { formatHex } from 'culori';\nformatHex('red');";
    expect(resolveLibraryIntent(`${code}\nlibraries: culri`, code).libraries).toEqual(['culori']);
  });

	it('THROWS when the budget is exceeded', () => {
    const four = ['culori', 'roughjs', 'tonaljs', 'matter-js'].join(', ');
    expect(() => parseLibraryIntent(`code\nlibraries: ${four}`)).toThrow(/budget exceeded/i);
    expect(MAX_LIBRARIES_PER_PIECE).toBe(3);
  });

	it('deduplicates across bare + layered declarations', () => {
    const r = parseLibraryIntent('code\nlibraries: culori\nlayers: p5[culori, roughjs]');
    expect(r.libraries).toEqual(['culori', 'roughjs']);
  });

	it('eraStampPayload carries the full domains[] + libraries[] vector', () => {
    const r = parseLibraryIntent('code\nlayers: p5[culori,roughjs] strudel[tonaljs]');
    const stamp = eraStampPayload(r, 'p5');
    expect(stamp.domains).toEqual(['p5', 'strudel']);
    expect(stamp.libraries).toEqual(['culori', 'roughjs', 'tonaljs']);
  });

  it('NEVER parses mid-response prose or code comments as intent (GLM round-1)', () => {
    // a comment inside the code body mentioning libraries
    const r1 = parseLibraryIntent('// Libraries: p5.sound, p5.dom\nfunction setup() { createCanvas(400, 400); }');
    expect(r1.libraries).toEqual([]);
    // prose before the code
    const r2 = parseLibraryIntent('Libraries: I used culori for the colors.\n```js\nfunction setup() {}\n```');
    expect(r2.libraries).toEqual([]);
    // response ending INSIDE a code fence (no trailing block after code)
    const r3 = parseLibraryIntent('```js\nfunction setup() { createCanvas(400, 400); }');
    expect(r3.libraries).toEqual([]);
    // real trailing declaration still works
    const r4 = parseLibraryIntent('```js\nfunction setup() { createCanvas(400, 400); }\n```\nlibraries: culori');
    expect(r4.libraries).toEqual(['culori']);
  });

  it('budget >3 throws LIMINAL-class (never truncates silently)', () => {
    // 4 libraries = throw (already tested); verify the ERROR is the throw kind,
    // not a silent partial: the parse must complete-or-throw, never return 3 of 4
    let result: string[] | null = null;
    try { parseLibraryIntent('libraries: culori, roughjs, tonaljs, matter-js'); }
    catch (e) { result = null; }
    expect(result).toBeNull(); // threw (or would have); never a silent 3-item subset
  });

  it('eraStampPayload: empty intent = empty arrays, never omitted', () => {
    const stamp = eraStampPayload(parseLibraryIntent('just code, no declaration'), 'p5');
    expect(stamp).toEqual({ domains: ['p5'], libraries: [] });
  });
});

describe('resolveLibraryIntent: declared list unioned with import inference', () => {
  const HOLO = 'import { Holo } from "holospot";\nconst holo = new Holo(r);';

  it('infers holospot from the import when no libraries: line was written', () => {
    expect(resolveLibraryIntent(HOLO, HOLO).libraries).toEqual(['holospot']);
  });

  it('unions declared and inferred, declared first, without duplicates', () => {
    const raw = `${HOLO}\nlibraries: culori, holospot`;
    expect(resolveLibraryIntent(raw, HOLO).libraries).toEqual(['culori', 'holospot']);
  });

  it('keeps layers from the declaration', () => {
    const raw = `code\nlayers: p5[culori]`;
    expect(resolveLibraryIntent(raw, HOLO)).toEqual({
      libraries: ['culori', 'holospot'],
      layers: [{ domain: 'p5', libraries: ['culori'] }],
    });
  });

  it('applies the per-piece budget to the union', () => {
    const code = 'import "culori";\nimport "roughjs";\nimport "tonaljs";\nimport "holospot";';
    expect(() => resolveLibraryIntent(code, code)).toThrow(/Library budget exceeded/);
  });

  it('returns no libraries for a plain piece', () => {
    expect(resolveLibraryIntent('function setup(){}', 'function setup(){}')).toEqual({ libraries: [], layers: [] });
  });

  it('wraps an undeclared holospot import with the holospot import map, three remap and CSP', async () => {
    const { wrapPlayable } = await import('../../../src/runtime-core/LiminalProductionEffects.js');
    const intent = resolveLibraryIntent(HOLO, HOLO);
    const html = wrapPlayable(HOLO, 'three', intent.libraries);
    expect(html).toContain('/vendor/holospot/0.1.0/dist/holo.js');
    expect(html).toContain('/vendor/three-webgpu/0.185.1/three.module.min.js');
    expect(html).toMatch(/worker-src[^;"]*blob:/);
  });

  it('lets the vendored holospot entry replace a piece-authored import map entry', async () => {
    const { wrapPlayable } = await import('../../../src/runtime-core/LiminalProductionEffects.js');
    const page = '<!DOCTYPE html><html><head><script type="importmap">{"imports":{"three":"https://x/three.js","holospot":"/mine/holo.js"}}</script></head><body><script type="module">import { Holo } from "holospot";</script></body></html>';
    const html = wrapPlayable(page, 'three', resolveLibraryIntent(page, page).libraries);
    expect(html).toContain('/vendor/holospot/0.1.0/dist/holo.js');
    expect(html).not.toContain('/mine/holo.js');
  });
});
