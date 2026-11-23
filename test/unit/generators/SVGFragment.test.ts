import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildFragmentBrief,
  buildHostProofPage,
  extractFragmentSpec,
  FRAGMENT_DOMAIN_ERROR,
  parseSvgOutputFlags,
  routeFragmentDomain,
  validateSVGFragment,
  type SVGFragmentSpec,
} from '../../../src/generators/svg/SVGFragment.js';
import { validateSVG } from '../../../src/generators/svg/SVGValidator.js';

const spec: SVGFragmentSpec = { tokens: ['art-red', 'art-ink'], container: { width: 320, height: 80 }, motion: 'none' };

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80" aria-hidden="true" fill="none">'
  + '<path d="M0 40 C80 0 160 80 320 40" stroke="var(--art-red)" stroke-width="4"/>'
  + '<circle cx="40" cy="40" r="6" fill="var(--art-ink, #111)"/></svg>';

describe('parseSvgOutputFlags (CLI flag parsing)', () => {
  it('returns null for standalone, the default', () => {
    expect(parseSvgOutputFlags({})).toBeNull();
    expect(parseSvgOutputFlags({ outputMode: 'standalone' })).toBeNull();
  });

  it('parses fragment flags into a spec', () => {
    expect(parseSvgOutputFlags({ outputMode: 'fragment', tokens: 'art-red, --art-ink,art-red', container: '320x80', motion: 'hover' }))
      .toEqual({ tokens: ['art-red', 'art-ink'], container: { width: 320, height: 80 }, motion: 'hover' });
  });

  it('defaults fragment motion to none and tokens to empty', () => {
    expect(parseSvgOutputFlags({ outputMode: 'fragment' })).toEqual({ tokens: [], container: undefined, motion: 'none' });
  });

  it.each([
    [{ outputMode: 'inline' }, /must be "standalone" or "fragment"/],
    [{ outputMode: 'fragment', tokens: 'bad name' }, /not a CSS custom property name/],
    [{ outputMode: 'fragment', container: '320' }, /320x80/],
    [{ outputMode: 'fragment', container: '0x80' }, /320x80/],
    [{ outputMode: 'fragment', motion: 'spin' }, /none, hover or loop/],
    [{ tokens: 'art-red' }, /only apply with --output-mode fragment/],
  ])('rejects %j', (flags, message) => {
    expect(() => parseSvgOutputFlags(flags)).toThrow(message);
  });
});

describe('buildFragmentBrief', () => {
  const brief = buildFragmentBrief('a vector ribbon', spec);

  it('keeps the user request and carries every host constraint', () => {
    expect(brief.startsWith('a vector ribbon\n')).toBe(true);
    expect(brief).toContain('var(--art-red), var(--art-ink)');
    expect(brief).toContain('320x80 CSS px');
    expect(brief).toContain('Motion: none. Static artwork.');
    expect(brief).toContain('aria-hidden="true"');
    expect(brief).toContain('No <html>, <head>, <body>, doctype or <script>');
  });

  it('states reduced-motion handling when motion is requested', () => {
    const loop = buildFragmentBrief('ribbon', { ...spec, motion: 'loop' });
    expect(loop).toContain('Motion: loop. Do not animate inside the SVG.');
    expect(loop).toContain('prefers-reduced-motion');
  });

  it('round-trips the spec through the marker line', () => {
    expect(extractFragmentSpec(brief)).toEqual(spec);
    expect(extractFragmentSpec(buildFragmentBrief('x', { tokens: [], motion: 'hover' })))
      .toEqual({ tokens: [], container: undefined, motion: 'hover' });
  });

  it('leaves standalone prompts alone', () => {
    expect(extractFragmentSpec('a generative ribbon with var(--x) hints')).toBeNull();
  });
});

describe('validateSVGFragment', () => {
  it('accepts a good fragment', () => {
    expect(validateSVGFragment(GOOD, spec).valid).toBe(true);
  });

  it('rejects a script', () => {
    const r = validateSVGFragment(GOOD.replace('</svg>', '<script>alert(1)</script></svg>'), spec);
    expect(r).toMatchObject({ valid: false, error: 'fragment must not contain <script>' });
  });

  it('rejects an html wrapper', () => {
    const r = validateSVGFragment(`<!DOCTYPE html><html><body>${GOOD}</body></html>`, spec);
    expect(r).toMatchObject({ valid: false, error: 'fragment must not have an <html>/<body> wrapper' });
  });

  it.each([
    ['file: use href', '<use href="file:///etc/hostname#x"/>'],
    ['relative use href', '<use href="canary.svg#x"/>'],
    ['relative xlink:href', '<use xlink:href="/canary-rel#x"/>'],
    ['file: feImage href', '<filter id="f"><feImage href="file:///etc/hostname"/></filter>'],
  ])('rejects an external reference (%s) in standalone and fragment mode', (_name, extra) => {
    const svg = GOOD.replace('</svg>', `${extra}</svg>`);
    expect(validateSVG(svg).valid).toBe(false);
    expect(validateSVGFragment(svg, spec).valid).toBe(false);
  });

  it('still accepts a same-document <use href="#id"> reference', () => {
    const svg = GOOD.replace('</svg>', '<defs><circle id="dot" r="3"/></defs><use href="#dot" x="10" y="10"/></svg>');
    expect(validateSVGFragment(svg, spec).valid).toBe(true);
  });

  it('rejects a missing viewBox', () => {
    const r = validateSVGFragment(GOOD.replace(' viewBox="0 0 320 80"', ''), spec);
    expect(r).toMatchObject({ valid: false, error: 'SVG must include a valid viewBox' });
  });

  it('rejects off-token colours: bare hex, unlisted var, currentColor', () => {
    const bare = validateSVGFragment(GOOD.replace('var(--art-red)', '#ff0000'), spec);
    expect(bare.valid).toBe(false);
    expect(bare.error).toContain('"#ff0000" is not one of the host tokens');
    const other = validateSVGFragment(GOOD.replace('var(--art-red)', 'var(--brand-blue)'), spec);
    expect(other.error).toContain('"var(--brand-blue)" is not one of the host tokens');
    const current = validateSVGFragment(GOOD.replace('var(--art-red)', 'currentColor'), spec);
    expect(current.valid).toBe(false);
  });

  it('accepts any host token when none are listed', () => {
    expect(validateSVGFragment(GOOD.replace('--art-red', '--whatever'), { tokens: [], motion: 'none' }).valid).toBe(true);
  });

  it('rejects a fragment without aria-hidden or role=img', () => {
    const r = validateSVGFragment(GOOD.replace(' aria-hidden="true"', ''), spec);
    expect(r.error).toBe('embed SVG root must be aria-hidden="true" or role="img"');
  });

  it('rejects empty input', () => {
    expect(validateSVGFragment('', spec).valid).toBe(false);
  });
});

describe('standalone output is unchanged', () => {
  const standalone = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ff0000"/></svg>';

  it('still validates bare colours and does not need aria-hidden', () => {
    expect(validateSVG(standalone, { mode: 'generative-art' }).valid).toBe(true);
    expect(validateSVG(standalone).valid).toBe(true);
  });

  it('embed mode without host tokens keeps its old rule (any var or currentColor)', () => {
    expect(validateSVG(GOOD.replace('var(--art-red)', 'var(--anything)'), { mode: 'embed' }).valid).toBe(true);
    expect(validateSVG(GOOD.replace('var(--art-red)', '#fff'), { mode: 'embed' }).error)
      .toBe('embed SVG color "#fff" must use a host token var(--name) or currentColor');
  });
});

describe('routeFragmentDomain (meta/custom routing, #1162)', () => {
  it('keeps an explicit svg domain as-is', () => {
    expect(routeFragmentDomain('svg')).toEqual({ ok: true, route: { domain: 'svg', notice: '' } });
  });

  it('routes custom (formerly meta) to svg with a notice', () => {
    const r = routeFragmentDomain('custom');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route.domain).toBe('svg');
      expect(r.route.reroutedFrom).toBe('custom');
      expect(r.route.notice).toContain('svg');
    }
  });

  it('defaults an undetected domain to svg with a notice', () => {
    const r = routeFragmentDomain(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route.domain).toBe('svg');
      expect(r.route.reroutedFrom).toBe('undetected');
    }
  });

  it.each(['p5', 'three', 'glsl', 'strudel'])('refuses %s: p5 instance-mode and Three.js fragments are separate issues', (domain) => {
    const r = routeFragmentDomain(domain);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(FRAGMENT_DOMAIN_ERROR);
  });
});

describe('buildHostProofPage (host-page proof, #1162)', () => {
  it('embeds the fragment verbatim and declares every token on :root', () => {
    const page = buildHostProofPage(GOOD, spec);
    expect(page).toContain(GOOD);
    expect(page).toContain('--art-red: #e5484d;');
    expect(page).toContain('--art-ink: #3b5bdb;');
    expect(page).toContain('width: 320px; height: 80px;');
  });

  it('renders a visible, editable swatch per token', () => {
    const page = buildHostProofPage(GOOD, spec);
    expect(page.match(/class="swatch"/g)?.length).toBe(2);
    expect(page).toContain('<code>--art-red</code>');
  });

  it('notes the empty-token case instead of inventing tokens', () => {
    const page = buildHostProofPage(GOOD, { tokens: [], motion: 'none' });
    expect(page).toContain('declare them here');
    expect(page).not.toContain('--art-red:');
  });

  it.each([
    ['none', ['Motion: none'], false],
    ['hover', ['prefers-reduced-motion: no-preference', '.fragment-host:hover svg'], false],
    ['loop', ['prefers-reduced-motion: no-preference', '@keyframes sinter-fragment-drift'], true],
  ] as const)('motion %s CSS', (motion, mustContain, wantsKeyframes) => {
    const page = buildHostProofPage(GOOD, { ...spec, motion });
    for (const fragment_ of mustContain) expect(page).toContain(fragment_);
    expect(page.includes('@keyframes')).toBe(wantsKeyframes);
    expect(page.includes('prefers-reduced-motion')).toBe(motion !== 'none');
  });
});

describe('host-page render proof in jsdom (#1162 acceptance)', () => {
  const page = buildHostProofPage(GOOD, spec);
  const dom = new JSDOM(page);
  const doc = dom.window.document;

  it('embeds the fragment as a namespaced SVG inside the host container', () => {
    const svg = doc.querySelector('.fragment-host svg');
    expect(svg).toBeInstanceOf(dom.window.SVGElement);
    expect(svg?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 320 80');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('declares every token the fragment references on :root', () => {
    const used = new Set([...GOOD.matchAll(/var\(--([a-z0-9_-]+)/gi)].map((m) => m[1]));
    expect([...used].sort()).toEqual(['art-ink', 'art-red']);
    const style = doc.querySelector('style')?.textContent ?? '';
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(style)?.[1] ?? '';
    for (const token of used) expect(rootBlock).toContain(`--${token}:`);
  });

  it('re-themes from the host stylesheet without touching the fragment markup', () => {
    const before = doc.querySelector('.fragment-host')?.innerHTML;
    expect(before).toContain('var(--art-red)');
    const themed = page.replace(/--art-red: [^;]+;/, '--art-red: #00008b;');
    const dom2 = new JSDOM(themed);
    expect(dom2.window.document.querySelector('.fragment-host')?.innerHTML).toBe(before);
    expect(dom2.window.document.querySelector('style')?.textContent).toContain('--art-red: #00008b;');
  });

  it('keeps styling and scripting in the host, never inside the fragment', () => {
    expect(doc.querySelectorAll('.fragment-host svg script, .fragment-host svg style').length).toBe(0);
    expect(doc.querySelectorAll('script').length).toBe(0);
  });
});

describe('sinter CLI flag wiring', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const run = (args: string[]) => promisify(execFile)(process.execPath, [path.join(repoRoot, 'bin', 'sinter'), ...args],
    // Provider resolution runs before the fragment gate: a keyless environment (CI) dies
    // earlier with "Missing API key" instead of reaching the refusal under test. A dummy
    // key lets boot proceed; the refusal still exits before any real provider call.
    { cwd: repoRoot, env: { ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_QUIET: 'true',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'dummy-key-for-refusal-tests' } })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: String(e.stdout), stderr: String(e.stderr) }));

  it('lists the fragment flags in --help', async () => {
    const { stdout } = await run(['--help']);
    expect(stdout).toContain('--output-mode <mode>');
    expect(stdout).toContain('--container <WxH>');
    expect(stdout).toContain('--motion <m>');
  });

  // Refused before any provider call, so this never spends.
  it('refuses a bad --output-mode before generating', async () => {
    const r = await run(['generate', 'a ribbon', '--domain', 'svg', '--output-mode', 'inline']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--output-mode must be "standalone" or "fragment", got "inline"');
  });

  it('refuses --tokens without fragment mode', async () => {
    const r = await run(['generate', 'a ribbon', '--domain', 'svg', '--tokens', 'art-red']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--tokens only apply with --output-mode fragment');
  });

  // Refused before any provider call, so this never spends.
  it('still refuses fragment mode for a non-svg, non-custom domain', async () => {
    const r = await run(['generate', 'a ribbon', '--domain', 'p5', '--output-mode', 'fragment']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--output-mode fragment needs the svg domain. Add --domain svg.');
  });
});
