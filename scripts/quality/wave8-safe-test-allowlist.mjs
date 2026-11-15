import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MODES = Object.freeze({
  'campaign-continuation-e2e': [
    'test/integration/wave8-campaign-continuation-cli-safe-e2e.test.ts',
  ],
  'safe-suite': [
    'test/integration/cognitive-architecture-cli-contract.test.ts',
    'test/integration/wave8-cli-help-safe-e2e.test.ts',
  ],
  coverage: [
    'test/integration/cognitive-architecture-cli-contract.test.ts',
    'test/integration/wave8-cli-help-safe-e2e.test.ts',
  ],
});
const DENY = /runInSandbox|playwright|puppeteer|LLMClient|applyProviderEnv|requestImprovement|\bfetch\s*\(/;
const IMPORT = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
const SUBPROCESS = /\b(?:execFileAsync|execFile|spawnSync)\s*\(\s*process\.execPath\s*,\s*\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/gs;
const SAFE_SUBPROCESSES = new Set(['bin/sinter\0campaign-continue']);

function resolveImport(from, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  const sourceBase = base.replace(/\.js$/, '');
  for (const candidate of [base, `${sourceBase}.ts`, `${sourceBase}.tsx`, `${sourceBase}.js`, path.join(sourceBase, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Safe-test closure cannot resolve ${specifier} from ${from}`);
}

function inspectClosure(repoRoot, files) {
  const queue = files.map(file => path.resolve(repoRoot, file));
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    if (DENY.test(source)) throw new Error(`Unsafe browser/provider token in allowlist closure: ${path.relative(repoRoot, file)}`);
    const subprocessCalls = source.match(/\b(?:execFileAsync|execFile|spawnSync)\s*\(/g) ?? [];
    const subprocesses = [...source.matchAll(SUBPROCESS)];
    if (subprocessCalls.length !== subprocesses.length
      || subprocesses.some(match => !SAFE_SUBPROCESSES.has(`${match[1]}\0${match[2]}`))) {
      throw new Error(`Unsafe or dynamic subprocess in allowlist closure: ${path.relative(repoRoot, file)}`);
    }
    for (const match of source.matchAll(IMPORT)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen].map(file => path.relative(repoRoot, file).replaceAll(path.sep, '/')).sort();
}

const [flag, mode, inspect] = process.argv.slice(2);
if (flag !== '--mode' || !mode || !(mode in MODES) || !([4, 5].includes(process.argv.length)) || (inspect !== undefined && inspect !== '--inspect')) {
  console.error('Usage: node scripts/quality/wave8-safe-test-allowlist.mjs --mode <campaign-continuation-e2e|safe-suite|coverage>');
  process.exit(2);
}
const repoRoot = process.cwd();
const files = MODES[mode];
const closure = inspectClosure(repoRoot, files);
if (mode === 'coverage') {
  console.error('BLOCKED_UNSAFE_COVERAGE: the global ratchet requires tests outside the browser/provider-free closure');
  process.exit(78);
}
if (inspect === '--inspect') {
  process.stdout.write(`wave8-safe-test-allowlist: ${mode} inspected (${closure.length} safe files)\n`);
  process.exit(0);
}
const safeEnv = { ...process.env };
for (const key of Object.keys(safeEnv)) {
  if (/(?:KEY|TOKEN|AUTHORIZATION|SECRET|PASSWORD|CREDENTIALS)$/i.test(key)) delete safeEnv[key];
}
const run = spawnSync('pnpm', ['exec', 'vitest', 'run', mode === 'coverage' ? '--coverage' : '--coverage=false', ...files], {
  cwd: repoRoot,
  env: safeEnv,
  shell: false,
  stdio: 'inherit',
});
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
process.stdout.write(`wave8-safe-test-allowlist: ${mode} passed (${closure.length} safe files)\n`);
