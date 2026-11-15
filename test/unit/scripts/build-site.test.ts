import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script without type declarations
import { agentFiles, htmlToMarkdown, staleFiles } from '../../../scripts/docs/build-site.mjs';
// @ts-expect-error -- plain .js Worker without type declarations
import worker, { markdownPath } from '../../../deploy/handbook/worker.js';

const dirs: string[] = [];
function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-build-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SKILL = '.well-known/agent-skills/sinter-cli/SKILL.md';

describe('htmlToMarkdown', () => {
  it('converts headings, lists, tables, code blocks and links inside <main>', () => {
    const html = '<nav>skip me</nav><main><h1>Title</h1><div><h3>Card</h3><p>Use <code>sinter list</code> or <a href="cli.html">CLI</a>.</p></div>'
      + '<ol><li>one</li><li>two</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>x|y</td><td>&lt;z&gt;</td></tr></table>'
      + '<pre><code>pnpm install\npnpm build</code></pre></main>';
    expect(htmlToMarkdown(html)).toBe([
      '# Title', '### Card', 'Use `sinter list` or [CLI](cli.md).', '1. one\n2. two',
      '| A | B |\n| --- | --- |\n| x\\|y | <z> |', '```\npnpm install\npnpm build\n```',
    ].join('\n\n') + '\n');
  });

  it('throws on a page without <main>', () => {
    expect(() => htmlToMarkdown('<body>hi</body>')).toThrow('page has no <main>');
  });
});

describe('agentFiles', () => {
  it('builds markdown twins, a sitemap without 404, and a skills index with the SKILL.md digest', () => {
    const dir = site({
      'index.html': '<main><h1>Home</h1></main>',
      'guide.html': '<main><p>Guide</p></main>',
      '404.html': '<main>gone</main>',
      [SKILL]: 'abc',
    });
    const files = agentFiles(dir);
    expect(Object.keys(files).sort()).toEqual(['.well-known/agent-skills/index.json', 'guide.md', 'index.md', 'sitemap.xml']);
    expect(files['sitemap.xml']).toContain('<url><loc>https://docs.s1ntr.com/</loc></url>\n  <url><loc>https://docs.s1ntr.com/guide</loc></url>');
    expect(JSON.parse(files['.well-known/agent-skills/index.json']).skills[0].digest)
      .toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('reports stale and missing generated files', () => {
    const dir = site({ 'index.html': '<main><h1>Home</h1></main>', [SKILL]: 'abc', 'index.md': 'old\n' });
    expect(staleFiles(dir).sort()).toEqual(['.well-known/agent-skills/index.json', 'index.md', 'sitemap.xml']);
  });

  it('keeps the committed Handbook files current', () => {
    expect(staleFiles(join(__dirname, '../../../site'))).toEqual([]);
  });
});

describe('handbook worker', () => {
  const assets = (files: Record<string, [string, string]>) => ({
    fetch: async (req: Request | URL) => {
      const path = new URL(req instanceof Request ? req.url : req).pathname;
      const hit = files[path];
      return hit ? new Response(hit[1], { headers: { 'content-type': hit[0] } }) : new Response('nf', { status: 404, headers: { 'content-type': 'text/html' } });
    },
  });
  const env = { ASSETS: assets({ '/': ['text/html', '<h1>x</h1>'], '/guide': ['text/html', 'g'], '/index.md': ['text/markdown', '# x'], '/guide.md': ['text/markdown', '# g'], '/a.css': ['text/css', 'b{}'] }) };

  it('maps page paths to markdown twins and rejects odd paths', () => {
    expect([markdownPath('/'), markdownPath('/guide'), markdownPath('/guide.html'), markdownPath('/a/b'), markdownPath('/../x')])
      .toEqual(['/index.md', '/guide.md', '/guide.md', null, null]);
  });

  it('serves markdown for Accept: text/markdown', async () => {
    const res = await worker.fetch(new Request('https://docs.s1ntr.com/guide', { headers: { accept: 'text/markdown' } }), env);
    expect([res.status, res.headers.get('content-type'), res.headers.get('vary'), await res.text()])
      .toEqual([200, 'text/markdown; charset=utf-8', 'Accept', '# g']);
  });

  it('adds discovery Link headers to HTML only', async () => {
    const html = await worker.fetch(new Request('https://docs.s1ntr.com/'), env);
    expect(html.headers.get('link')).toContain('</index.md>; rel="alternate"; type="text/markdown"');
    expect(html.headers.get('link')).toContain('rel="agent-skills"');
    const css = await worker.fetch(new Request('https://docs.s1ntr.com/a.css'), env);
    expect(css.headers.get('link')).toBe(null);
  });

  it('falls back to HTML 404 without a markdown alternate when the page is missing', async () => {
    const res = await worker.fetch(new Request('https://docs.s1ntr.com/nope', { headers: { accept: 'text/markdown' } }), env);
    expect([res.status, res.headers.get('content-type'), res.headers.get('link')?.includes('nope.md')]).toEqual([404, 'text/html', false]);
  });
});
