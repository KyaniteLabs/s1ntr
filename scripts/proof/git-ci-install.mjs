#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = await mkdtemp(path.join(tmpdir(), 'sinter-git-ci-install-'));
const consumerRoot = path.join(tempRoot, 'consumer');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    const rendered = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}\n${rendered}`);
  }
  return result;
}

await mkdir(consumerRoot, { recursive: true });

// Sinter is a pnpm workspace, so `npm install git+file://...` is the wrong path:
// it runs the consumer-side `prepare`, which pulls devDependencies (including the
// dev-only `@sinter/audio-core` workspace:* link) and chokes on the workspace:
// protocol. The honest "what a downstream user installs" path is the packed
// artifact. `pnpm pack` runs prepare (build), includes only the package.json
// `files` allowlist (dist, bin, ...), and rewrites workspace: specifiers — then
// a tarball install pulls only production dependencies, never devDependencies.
run('pnpm', ['pack', '--pack-destination', tempRoot]);

const tarball = readdirSync(tempRoot).find((f) => f.endsWith('.tgz'));
if (!tarball) {
  throw new Error(`pnpm pack produced no .tgz in ${tempRoot}`);
}
const tarballPath = path.join(tempRoot, tarball);

await writeFile(
  path.join(consumerRoot, 'package.json'),
  `${JSON.stringify({ name: 's1ntr-install-consumer', type: 'module', private: true }, null, 2)}\n`,
  'utf8'
);

const cleanEnv = {
  ...process.env,
  CI: '1',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};

// Install the packed tarball exactly as a downstream consumer would install the
// published `s1ntr` package. Only production dependencies are resolved.
run('pnpm', ['add', tarballPath], { cwd: consumerRoot, env: cleanEnv });

const installedRoot = path.join(consumerRoot, 'node_modules', 's1ntr');
const distIndex = path.join(installedRoot, 'dist', 'index.js');
if (!existsSync(distIndex)) {
  throw new Error(`Installed package is missing ${path.relative(consumerRoot, distIndex)}`);
}

run('node', [
  '--input-type=module',
  '-e',
  "const mod = await import('s1ntr'); if (!mod) throw new Error('import returned empty module');",
], { cwd: consumerRoot });

// Invoke the real ESM entry directly. The pnpm-created `.bin/liminal` is a shell
// shim (not a JS file), so `node .bin/liminal` would fail to parse; running the
// package's own bin via node is package-manager-agnostic.
const version = run('node', [path.join(installedRoot, 'bin', 'sinter'), '--version'], {
  cwd: consumerRoot,
}).stdout.trim();
const versionLine = version.split(/\r?\n/).find((line) => /\bSinter v\d+\.\d+\.\d+/.test(line));
if (!versionLine) {
  throw new Error(`Unexpected sinter --version output: ${version}`);
}

console.log(`Git CI install proof passed (packed artifact): ${versionLine}`);
