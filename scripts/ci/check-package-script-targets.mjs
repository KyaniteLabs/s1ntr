#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const pkgPath = path.join(repoRoot, 'package.json');
const outDir = path.join(repoRoot, '.omx', 'proof');
const outPath = path.join(outDir, 'package-script-targets.json');

function normalizeTarget(rawTarget) {
  return rawTarget.replace(/^['"]|['"]$/g, '');
}

function isLocalTarget(target) {
  return target.startsWith('./')
    || target.startsWith('bin/')
    || target.startsWith('scripts/')
    || target.startsWith('src/')
    || target.startsWith('test/');
}

function extractLocalScriptTargets(scripts) {
  const targets = [];
  const executablePattern = /\b(?:node|tsx|bash|sh)\s+("[^"]+"|'[^']+'|[^\s&|;]+)/g;

  for (const [scriptName, command] of Object.entries(scripts)) {
    for (const match of command.matchAll(executablePattern)) {
      const target = normalizeTarget(match[1] ?? '');
      if (!target || target.startsWith('-') || !isLocalTarget(target)) continue;
      targets.push({
        scriptName,
        command,
        target,
        exists: fs.existsSync(path.join(repoRoot, target)),
      });
    }
  }

  return targets;
}

// Docs that tell a reader which commands to run. A package script named in
// their code spans or code blocks has to exist.
const commandDocs = [
  'README.md',
  'CONTRIBUTING.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/getting-started.md',
  'docs/cli-reference.md',
  'docs/THE_BIBLE.md',
];

// `pnpm <word>` runs a package script unless <word> is one of pnpm's own commands.
const pnpmCommands = new Set([
  'add', 'approve-builds', 'audit', 'bin', 'ci', 'config', 'create', 'dedupe', 'deploy', 'dlx',
  'doctor', 'env', 'exec', 'fetch', 'help', 'i', 'import', 'init', 'install', 'licenses', 'link',
  'list', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'prune', 'publish', 'rb', 'rebuild',
  'remove', 'rm', 'root', 'self-update', 'setup', 'store', 'un', 'uninstall', 'unlink', 'up',
  'update', 'upgrade', 'why',
]);

function extractDocScriptMentions(scripts) {
  const mentions = [];
  const commandPattern = /(?<![\w/.-])(pnpm|npm)\s+(run\s+)?([a-z][\w:.-]*)/g;

  for (const doc of commandDocs) {
    const docPath = path.join(repoRoot, doc);
    if (!fs.existsSync(docPath)) continue;

    let inCodeBlock = false;
    fs.readFileSync(docPath, 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inCodeBlock = !inCodeBlock;
        return;
      }
      const code = inCodeBlock ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((span) => span[1]);
      for (const text of code) {
        for (const [command, tool, run, scriptName] of text.matchAll(commandPattern)) {
          // Without `run`, npm takes only its own commands and pnpm takes its own first.
          if (!run && (tool === 'npm' || pnpmCommands.has(scriptName))) continue;
          mentions.push({ doc, line: index + 1, command, scriptName, exists: Object.hasOwn(scripts, scriptName) });
        }
      }
    });
  }

  return mentions;
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const targets = extractLocalScriptTargets(pkg.scripts ?? {});
const missingTargets = targets.filter((target) => !target.exists);
const docScriptMentions = extractDocScriptMentions(pkg.scripts ?? {});
const missingDocScripts = docScriptMentions.filter((mention) => !mention.exists);
const result = {
  generatedAt: new Date().toISOString(),
  contract: 'sinter-package-script-target-integrity-v1',
  passed: missingTargets.length === 0 && missingDocScripts.length === 0,
  checkedTargetCount: targets.length,
  targets,
  missingTargets,
  checkedDocScriptMentionCount: docScriptMentions.length,
  missingDocScripts,
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

if (!result.passed) {
  console.error(`Package script target check failed. See ${outPath}`);
  for (const target of missingTargets) {
    console.error(`- ${target.scriptName}: ${target.target}`);
  }
  for (const mention of missingDocScripts) {
    console.error(`- ${mention.doc}:${mention.line}: ${mention.command} names a package script that does not exist`);
  }
  if (missingDocScripts.length > 0) {
    console.error('Add the script, correct the doc, or write `pnpm exec <name>` when the command is a binary.');
  }
  process.exit(1);
}

console.log(`Package script target check passed: ${outPath}`);
