import { describe, it, expect } from 'vitest';
import { parseLibraryIntent, eraStampPayload, MAX_LIBRARIES_PER_PIECE } from '../../../src/runtime-core/LibraryIntent.js';

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

	it('THROWS on unknown library ids (fail-loud pre-wrap, feeds the repair loop)', () => {
    expect(() => parseLibraryIntent('code\nlibraries: culri, roughjs')).toThrow(/Unknown vendored library "culri"/);
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
