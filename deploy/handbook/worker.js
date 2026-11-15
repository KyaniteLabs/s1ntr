// Serves the public Handbook (site/) as static assets, adds agent discovery
// Link headers, and answers `Accept: text/markdown` with each page's .md twin.
const LINKS = [
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
];

export function markdownPath(pathname) {
  const page = pathname.replace(/^\/+|\/+$/g, '').replace(/\.html$/, '') || 'index';
  return /^[a-z0-9-]+$/.test(page) ? `/${page}.md` : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wantsMarkdown = /\btext\/markdown\b/i.test(request.headers.get('accept') ?? '');
    const mdPath = wantsMarkdown ? markdownPath(url.pathname) : null;
    if (mdPath) {
      const md = await env.ASSETS.fetch(new URL(mdPath, url));
      if (md.ok) {
        const headers = new Headers(md.headers);
        headers.set('content-type', 'text/markdown; charset=utf-8');
        headers.set('vary', 'Accept');
        return new Response(md.body, { status: 200, headers });
      }
    }
    const res = await env.ASSETS.fetch(request);
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('text/html')) return res;
    const headers = new Headers(res.headers);
    const alt = markdownPath(url.pathname);
    for (const link of alt && res.ok ? [...LINKS, `<${alt}>; rel="alternate"; type="text/markdown"`] : LINKS) {
      headers.append('link', link);
    }
    headers.set('vary', 'Accept');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
