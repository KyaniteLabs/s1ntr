import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { parse } from '@babel/parser';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper';
import { P5Wrapper } from '../../../src/core/wrappers/P5Wrapper';
import { ThreeWrapper } from '../../../src/core/wrappers/ThreeWrapper';
import { ThreeGenerator } from '../../../src/generators/three/ThreeGenerator';
import { HydraGenerator } from '../../../src/generators/hydra/HydraGenerator';
import { P5GeneratorV2 } from '../../../src/generators/p5/P5GeneratorV2';
import { NbeGenerator } from '../../../src/generators/nbe/NbeGenerator';
import { generateHTML } from '../../../src/utils/generateHTML';
import { scriptString } from '../../../src/utils/scriptEmbed';

/**
 * Every page S1NTR renders, scores or exports embeds model-written code in an
 * inline script. The browser must get that code exactly as written. The HTML
 * parser ends a script at `</script`, and after `<!--` plus `<script` it does
 * not end it at the wrapper's own `</script>`. Both occur in real model output.
 */
const TAG = '</script><b>bold</b>';
const COMMENT = '<!--<script>';
const code = `const tag = ${JSON.stringify(TAG)};\nconst note = ${JSON.stringify(COMMENT)};\nwindow.__ok = 1;`;

function scriptElements(html: string): HTMLScriptElement[] {
  return [...new JSDOM(html).window.document.querySelectorAll<HTMLScriptElement>('script:not([src])')];
}

/** The inline scripts the HTML parser hands over, without running them. */
function inlineScripts(html: string): string[] {
  return scriptElements(html).map((s) => s.textContent ?? '');
}

/** The one script that holds `marker`. It must still parse as the kind of script it is. */
function scriptWith(html: string, marker: string): string {
  const scripts = scriptElements(html).filter((s) => s.textContent?.includes(marker));
  expect(scripts).toHaveLength(1);
  const body = scripts[0].textContent ?? '';
  // A script that ran past its end into the page's markup no longer parses.
  if (scripts[0].type === 'module') expect(() => parse(body, { sourceType: 'module' })).not.toThrow();
  else expect(() => new vm.Script(body)).not.toThrow();
  return body;
}

const valueOf = (body: string, name: string) => {
  const line = body.split('\n').find((l) => l.includes(`const ${name} =`))!;
  return vm.runInNewContext(`${line}; ${name}`);
};

const pages: Array<[string, (code: string) => string]> = [
  ['generic hydra shell', (c) => GenericWrapper.wrap(c, { domain: 'hydra' })],
  ['generic tone shell', (c) => GenericWrapper.wrap(c, { domain: 'tone' })],
  ['p5 wrapper', (c) => P5Wrapper.wrap(c)],
  ['three wrapper', (c) => ThreeWrapper.wrap(c)],
  ['three gallery page', (c) => new ThreeGenerator().wrapForGallery(c)],
  ['hydra gallery page', (c) => new HydraGenerator().wrapForGallery(c)],
  ['p5 gallery page', (c) => new P5GeneratorV2().wrapForGallery(c)],
  ['p5 standalone page (guardrails)', (c) => generateHTML({ code: c })],
];

describe('wrappers hand the browser the code the model wrote', () => {
  it.each(pages)('%s: the strings survive and the page closes', (_, wrap) => {
    const html = wrap(code);
    const body = scriptWith(html, 'const tag');
    expect(valueOf(body, 'tag')).toBe(TAG);
    expect(valueOf(body, 'note')).toBe(COMMENT);
    // The <b> lives in a JS string, never in the page.
    expect(new JSDOM(html).window.document.querySelector('b')).toBeNull();
  });

  // `<!--` alone is legal JS that the HTML parser reads correctly, so it must
  // reach the browser untouched: a `u` regex rejects `\!`, String.raw keeps it.
  const legal = [
    'const re = /<!--/u;',
    'const raw = String.raw`<!--`;',
    'let n = 1;\n<!-- old-style comment\nn += 1;',
  ].join('\n');

  it.each(pages.filter(([name]) => !name.startsWith('three')))('%s: a lone <!-- is left as written', (_, wrap) => {
    expect(scriptWith(wrap(legal), 'const re')).toContain(legal);
  });

  // A truncated answer can end on `<script`; the wrapper's newline then completes the tag.
  it.each(pages.filter(([name]) => !name.startsWith('three')))('%s: code that ends on <!--<script keeps the page', (_, wrap) => {
    const html = wrap('window.__ok = 1; // <!--<script');
    scriptWith(html, 'window.__ok = 1;');
    expect(new JSDOM(html).window.document.querySelectorAll('script:not([src])').length).toBeGreaterThan(0);
  });

  it('shader: the fragment source reaches WebGL exactly as written', () => {
    const fragment = '#define WAVE(x) sin(x) \\\n  * 0.5\n// ${t} `q` </script> <!-- <script>\nvoid main() { gl_FragColor = vec4(WAVE(1.0)); }';
    const scripts = inlineScripts(GenericWrapper.wrap(fragment, { domain: 'shader' }));
    const line = scripts.flatMap((s) => s.split('\n')).find((l) => l.includes('const fsSource ='))!;
    const normalized = (GenericWrapper as unknown as { normalizeShaderForWebGL1(code: string): string })
      .normalizeShaderForWebGL1(fragment);
    expect(vm.runInNewContext(`${line}; fsSource`)).toBe(normalized);
  });

  it('nbe: the prompt reaches the page exactly as written', () => {
    const prompt = "it's a \\ </script> <!-- <script>\nsecond line   \ud800";
    const scripts = inlineScripts(new NbeGenerator().generate(prompt).code);
    const line = scripts.flatMap((s) => s.split('\n')).find((l) => l.includes('var PROMPT ='))!;
    expect(vm.runInNewContext(`${line}; PROMPT`)).toBe(prompt);
  });
});

describe('the tone shell tells HTML from JS by parsing', () => {
  it('an HTML fragment keeps its controls', () => {
    const html = GenericWrapper.wrap('<button id="go">Play</button>\n<script>window.__x = 1;</script>', { domain: 'tone' });
    const { document } = new JSDOM(html).window;
    expect(document.getElementById('go')?.textContent).toBe('Play');
    expect(inlineScripts(html).some((s) => s.includes('window.__x = 1;'))).toBe(true);
  });

  it('two inline scripts that only together hide the closing tag keep the page', () => {
    const fragment = '<button id="go">Play</button>\n<script>var opener = "<!--";</script>\n<script>var tag = "<script>";</script>';
    const html = GenericWrapper.wrap(fragment, { domain: 'tone' });
    const body = scriptWith(html, 'var opener =');
    expect(valueOf(body.replace(/\bvar\b/g, 'const'), 'opener')).toBe('<!--');
    expect(valueOf(body.replace(/\bvar\b/g, 'const'), 'tag')).toBe('<script>');
    expect(new JSDOM(html).window.document.getElementById('sinter-tone-start')?.tagName).toBe('BUTTON');
  });

  it('JS that names a tag in a string still runs as the artwork', () => {
    const js = 'const label = "<div>";\nfunction play() { window.__label = label; }';
    expect(scriptWith(GenericWrapper.wrap(js, { domain: 'tone' }), 'const label')).toContain(js);
  });
});

describe('scriptString', () => {
  it.each([
    ['script close', '</script>'],
    ['comment open', '<!-- <script>'],
    ['line separators', 'a b c'],
    ['lone surrogate', 'x\udfffy'],
    ['quotes and backslashes', `'"\\\``],
  ])('%s round-trips through an inline script', (_, text) => {
    const html = `<!DOCTYPE html><html><body><script>var v = ${scriptString(text)};</script><p id="after"></p></body></html>`;
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    expect((dom.window as unknown as { v: string }).v).toBe(text);
    expect(dom.window.document.body.lastElementChild?.id).toBe('after');
  });
});
