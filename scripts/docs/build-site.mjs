#!/usr/bin/env node
// Generates the agent-facing files of the public Handbook from its HTML pages:
// a Markdown twin of every page, sitemap.xml, and the agent-skills index with
// the SKILL.md digest. `--check` fails when the committed files are stale.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ORIGIN = 'https://docs.s1ntr.com';
const SKILL = '.well-known/agent-skills/sinter-cli/SKILL.md';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]);
const inline = (s) =>
  decode(
    s
      .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, '**$2**')
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/g, '_$2_')
      .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, text) =>
        `[${text}](${href.replace(/\.html$/, '.md')})`)
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s+/g, ' ').trim();

export function htmlToMarkdown(html) {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  if (!main) throw new Error('page has no <main>');
  const blocks = [];
  const hold = (md) => `\n\u0000${blocks.push(md) - 1}\u0000\n`;
  let body = main[1]
    .replace(/<pre[^>]*>(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?<\/pre>/g, (_, code) =>
      hold('```\n' + decode(code.replace(/<[^>]+>/g, '')).trimEnd() + '\n```'))
    .replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_, table) => {
      const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
        [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) => inline(cell).replace(/\|/g, '\\|')));
      const line = (cells) => `| ${cells.join(' | ')} |`;
      return hold([line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n'));
    })
    .replace(/<(ol|ul)[^>]*>([\s\S]*?)<\/\1>/g, (_, kind, list) =>
      hold([...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
        .map(([, item], i) => `${kind === 'ol' ? `${i + 1}.` : '-'} ${inline(item)}`).join('\n')))
    .replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g, (_, level, text) => hold(`${'#'.repeat(+level)} ${inline(text)}`))
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_, text) => hold(inline(text)));
  body = body.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (m) => hold(inline(m)));
  return body
    .replace(/<[^>]+>/g, '\n')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]) + '\n';
}

export function pages(siteDir) {
  return readdirSync(siteDir)
    .filter((f) => f.endsWith('.html') && f !== '404.html')
    .sort((a, b) => (b === 'index.html') - (a === 'index.html') || a.localeCompare(b));
}

const pageUrl = (file) => `${ORIGIN}/${file === 'index.html' ? '' : file.replace(/\.html$/, '')}`;

export function agentFiles(siteDir) {
  const out = {};
  for (const file of pages(siteDir)) {
    out[file.replace(/\.html$/, '.md')] = htmlToMarkdown(readFileSync(join(siteDir, file), 'utf8'));
  }
  out['sitemap.xml'] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages(siteDir).map((f) => `  <url><loc>${pageUrl(f)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
  const skill = readFileSync(join(siteDir, SKILL));
  out['.well-known/agent-skills/index.json'] = JSON.stringify({
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [{
      name: 'sinter-cli',
      type: 'skill-md',
      description: 'Use when making creative-code pieces with the Sinter CLI or Studio, or checking its providers.',
      url: `/${SKILL}`,
      digest: `sha256:${createHash('sha256').update(skill).digest('hex')}`,
    }],
  }, null, 2) + '\n';
  return out;
}

export function staleFiles(siteDir) {
  return Object.entries(agentFiles(siteDir))
    .filter(([rel, text]) => !existsSync(join(siteDir, rel)) || readFileSync(join(siteDir, rel), 'utf8') !== text)
    .map(([rel]) => rel);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const siteDir = join(ROOT, 'site');
  if (process.argv.includes('--check')) {
    const stale = staleFiles(siteDir);
    if (stale.length) {
      console.error(`stale generated Handbook files (run pnpm docs:build): ${stale.join(', ')}`);
      process.exit(1);
    }
    console.log('generated Handbook files are current');
  } else {
    for (const [rel, text] of Object.entries(agentFiles(siteDir))) {
      mkdirSync(dirname(join(siteDir, rel)), { recursive: true });
      writeFileSync(join(siteDir, rel), text);
    }
    console.log(`wrote ${Object.keys(agentFiles(siteDir)).length} generated files to ${siteDir}`);
  }
}
