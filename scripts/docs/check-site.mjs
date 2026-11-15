#!/usr/bin/env node
// Public Handbook gate: fails when site/ leaks old names, private hosts or
// paths, documents a `sinter <word>` that the CLI would treat as a paid
// prompt, or links to a local file that does not exist.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const RULES = [
  ['old-name', /liminal/i],
  ['home-path', /\/(?:home|Users)\/[a-z][\w-]*/],
  ['tailnet-ip', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['private-host', /\b(?:nucbox|omarchymbp|g2-worker|jetson|tailnet|\.ts\.net)\b/i],
  ['repo-link', /git\.kyanitelabs\.tech|github\.com\/KyaniteLabs/i],
  ['token', /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/],
];
const LINK = /(?:href|src)\s*=\s*["'](?!https?:|data:|mailto:|#)([^"'?#]+)/g;
const COMMAND = /(?<![\w-])sinter ([a-z][\w-]*)/g;

export function knownCommands(root = ROOT) {
  const src = readFileSync(join(root, 'src/cli/PromptArgs.ts'), 'utf8');
  const block = src.match(/const KNOWN_COMMANDS = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('KNOWN_COMMANDS not found in src/cli/PromptArgs.ts');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function checkSite(siteDir, commands) {
  const problems = [];
  for (const file of walk(siteDir)) {
    if (!['.html', '.css', '.js', '.txt', '.xml', '.json', '.md'].includes(extname(file))) continue;
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(siteDir.length + 1);
    for (const [rule, rx] of RULES) {
      const m = text.match(rx);
      if (m) problems.push(`${rel}: ${rule} "${m[0]}"`);
    }
    for (const [, word] of text.matchAll(COMMAND)) {
      if (!commands.has(word)) problems.push(`${rel}: unknown command "sinter ${word}" would run as a paid prompt`);
    }
    if (extname(file) === '.html') {
      for (const [, target] of text.matchAll(LINK)) {
        if (target.startsWith('/') || !existsSync(join(dirname(file), target))) {
          problems.push(`${rel}: broken local link "${target}"`);
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const siteDir = resolve(process.argv[2] ?? join(ROOT, 'site'));
  const problems = checkSite(siteDir, knownCommands());
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s) in ${siteDir}`);
    process.exit(1);
  }
  console.log(`site check passed: ${siteDir}`);
}
