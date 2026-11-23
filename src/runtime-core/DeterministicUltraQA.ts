import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { computeProofSourceFingerprint, readCurrentGitCommit } from './ProofReceiptValidator.js';
import {
  createWave8EvidenceReceipt,
  createWave8ReleaseRoot,
  parseWave8EvidenceReceipt,
  parseWave8ReleaseRoot,
  requireCurrentWave8ReceiptSource,
  validateWave8ReleaseRoot,
  type Wave8EvidenceReceipt,
  type Wave8ReceiptKind,
  type Wave8ReleaseRoot,
} from './Wave8ReleaseRoot.js';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMAND_CONTRACT = 'sinter.deterministic-ultraqa-command/v2';
const QUALITY_KINDS = [
  'packed-install', 'startup', 'focused-checks', 'build', 'typecheck', 'lint',
  'coverage', 'deterministic-no-spend', 'restart', 'wave7-reproof', 'frozen-install',
  'orphan-scan', 'script-targets', 'compound-health', 'audio-build', 'test-quality',
  'pack', 'installed-startup', 'deterministic-e2e', 'safe-suite', 'leak-audit', 'semantic-audit',
] as const satisfies readonly Wave8ReceiptKind[];
const EVIDENCE_ROOT = '.quality/wave-8/release';

export type UltraQACommandKind = typeof QUALITY_KINDS[number];
export interface FixedUltraQACommand {
  readonly kind: UltraQACommandKind;
  readonly argv: readonly string[];
  readonly artifactRoots: readonly string[];
  /** A literal success witness, or empty string when the tool must stay silent. */
  readonly expectedOutput: string;
}

/** This table is the complete command authority. No caller-supplied shell strings are accepted. */
export const FIXED_ULTRAQA_COMMANDS: readonly FixedUltraQACommand[] = Object.freeze([
  { kind: 'frozen-install', argv: ['pnpm', 'install', '--frozen-lockfile', '--offline'], artifactRoots: ['pnpm-lock.yaml', 'node_modules/.modules.yaml'], expectedOutput: 'Done in' },
  { kind: 'orphan-scan', argv: ['bash', 'scripts/check-orphans.sh'], artifactRoots: ['scripts/check-orphans.sh'], expectedOutput: 'No orphaned files found.' },
  { kind: 'script-targets', argv: ['node', 'scripts/ci/check-package-script-targets.mjs'], artifactRoots: ['.omx/proof/package-script-targets.json'], expectedOutput: 'Package script target check passed:' },
  { kind: 'build', argv: ['pnpm', 'exec', 'tsc', '--incremental', 'false'], artifactRoots: ['dist'], expectedOutput: '' },
  { kind: 'audio-build', argv: ['pnpm', '--filter', '@sinter/audio-core', 'build'], artifactRoots: ['packages/audio-core/dist'], expectedOutput: '@sinter/audio-core@' },
  { kind: 'typecheck', argv: ['pnpm', 'exec', 'tsc', '--noEmit'], artifactRoots: ['dist'], expectedOutput: '' },
  // ESLint may print warnings to stdout with exit 0; require zero errors, not empty stdout.
  { kind: 'lint', argv: ['pnpm', 'exec', 'eslint', 'src/', '--cache', '--cache-location', '.eslintcache'], artifactRoots: ['dist'], expectedOutput: '0 errors' },
  { kind: 'focused-checks', argv: ['pnpm', 'exec', 'vitest', 'run', '--coverage=false', 'test/unit/runtime-core/Wave8ReleaseRoot.test.ts', 'test/unit/creative-run/CampaignContinuation.test.ts'], artifactRoots: ['dist'], expectedOutput: 'Test Files' },
  { kind: 'deterministic-e2e', argv: ['node', 'scripts/quality/wave8-safe-test-allowlist.mjs', '--mode', 'campaign-continuation-e2e'], artifactRoots: ['dist'], expectedOutput: 'wave8-safe-test-allowlist: campaign-continuation-e2e passed' },
  { kind: 'restart', argv: ['pnpm', 'exec', 'vitest', 'run', '--coverage=false', 'test/unit/creative-run/CampaignContinuation.test.ts'], artifactRoots: ['dist'], expectedOutput: 'Test Files' },
  // This is intentionally not named full-suite: it is an explicit browser/provider-safe allowlist.
  { kind: 'safe-suite', argv: ['node', 'scripts/quality/wave8-safe-test-allowlist.mjs', '--mode', 'safe-suite'], artifactRoots: ['dist'], expectedOutput: 'wave8-safe-test-allowlist: safe-suite passed' },
  { kind: 'coverage', argv: ['node', 'scripts/quality/wave8-safe-test-allowlist.mjs', '--mode', 'coverage'], artifactRoots: ['coverage'], expectedOutput: 'Coverage' },
  { kind: 'test-quality', argv: ['node', 'scripts/testing/test-quality-check.mjs', '--strict', '--baseline', 'scripts/testing/test-quality-baseline.txt'], artifactRoots: ['scripts/testing/test-quality-baseline.txt'], expectedOutput: 'All test quality checks passed!' },
  { kind: 'compound-health', argv: ['node', 'scripts/rotation/wave3-compound-health.mjs', '--json'], artifactRoots: ['scripts/rotation/wave3-compound-health.mjs'], expectedOutput: 'sinter-wave3-compound-health-v1' },
  { kind: 'pack', argv: ['pnpm', 'pack', '--pack-destination', '.quality/wave-8/ultraqa-pack'], artifactRoots: ['.quality/wave-8/ultraqa-pack'], expectedOutput: '.tgz' },
  { kind: 'packed-install', argv: ['node', 'scripts/proof/git-ci-install.mjs'], artifactRoots: ['dist'], expectedOutput: 'Git CI install proof passed' },
  { kind: 'installed-startup', argv: ['node', 'scripts/ci/wave7-packed-install-smoke.mjs'], artifactRoots: ['dist'], expectedOutput: 'packed-install-smoke' },
  { kind: 'startup', argv: ['node', 'bin/sinter', '--help'], artifactRoots: ['dist', 'bin/sinter'], expectedOutput: '🎨 S1NTR: a tool for coding art.' },
  { kind: 'deterministic-no-spend', argv: ['pnpm', 'exec', 'tsx', 'scripts/proof/wave7-no-spend-circulation.ts', '--output', `${EVIDENCE_ROOT}/deterministic-no-spend.json`], artifactRoots: [`${EVIDENCE_ROOT}/deterministic-no-spend.json`], expectedOutput: `${EVIDENCE_ROOT}/deterministic-no-spend.json` },
  { kind: 'leak-audit', argv: ['pnpm', 'exec', 'tsx', 'scripts/ci/wave7-leak-audit.ts', 'dist', '--output', `${EVIDENCE_ROOT}/leak-audit.json`], artifactRoots: [`${EVIDENCE_ROOT}/leak-audit.json`], expectedOutput: 'wave7-leak-audit' },
  // These three reports and the provisional current root are emitted just before this command.
  { kind: 'semantic-audit', argv: ['pnpm', 'exec', 'tsx', 'scripts/ci/wave8-semantic-audit.ts', `${EVIDENCE_ROOT}/market.json`, `${EVIDENCE_ROOT}/release.json`, `${EVIDENCE_ROOT}/terminal.json`], artifactRoots: [`${EVIDENCE_ROOT}/semantic-input-root.json`], expectedOutput: '"gate": "wave8-semantic-audit"' },
  { kind: 'wave7-reproof', argv: ['pnpm', 'exec', 'tsx', 'scripts/proof/wave7-no-spend-circulation.ts', '--output', `${EVIDENCE_ROOT}/wave7-reproof.json`], artifactRoots: [`${EVIDENCE_ROOT}/wave7-reproof.json`], expectedOutput: `${EVIDENCE_ROOT}/wave7-reproof.json` },
]);

export interface UltraQASourceSnapshot { readonly releaseHead: string; readonly sourceFingerprint: string; }
export interface UltraQACommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly startedAt: string; readonly finishedAt: string; readonly toolVersion: string; }
export interface UltraQAExecutionResult { readonly receipts: readonly Wave8EvidenceReceipt[]; readonly root: Wave8ReleaseRoot; readonly releaseReady: boolean; readonly blockers: readonly string[]; }
export type UltraQAExecutor = (command: FixedUltraQACommand, repoRoot: string) => Promise<UltraQACommandResult>;

interface PersistedLogs { readonly stdout: string; readonly stderr: string; readonly toolVersion: string; readonly paths: Record<string, string>; }
interface RunState { readonly target: string; readonly frozen: UltraQASourceSnapshot | null; readonly receipts: readonly Wave8EvidenceReceipt[]; readonly failedKind?: string; readonly error?: string; }
interface ActiveDigests { readonly schema: string; readonly implementation: string; }
interface BootstrapState { readonly receipts: readonly Wave8EvidenceReceipt[]; readonly activeDigests: ActiveDigests; }

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function isDigest(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value); }
function isIso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function git(repoRoot: string, args: readonly string[]): string { return execFileSync('git', [...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

/** Includes staged, unstaged, and untracked source state; ignored QA output is intentionally excluded. */
export function assertCleanRepository(repoRoot: string): void {
  if (git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']).trim()) throw new Error('Ultra QA refuses a dirty, staged, or untracked repository');
}

export function freezeUltraQASource(repoRoot: string): UltraQASourceSnapshot {
  assertCleanRepository(repoRoot);
  const releaseHead = readCurrentGitCommit(repoRoot);
  const sourceFingerprint = computeProofSourceFingerprint(repoRoot)?.replace(/^sha256:/, '');
  if (!releaseHead || !sourceFingerprint) throw new Error('Ultra QA cannot freeze the current HEAD/source fingerprint');
  return { releaseHead, sourceFingerprint };
}

function assertStillFrozen(repoRoot: string, frozen: UltraQASourceSnapshot): void {
  assertCleanRepository(repoRoot);
  const current = freezeUltraQASource(repoRoot);
  if (current.releaseHead !== frozen.releaseHead || current.sourceFingerprint !== frozen.sourceFingerprint) throw new Error('Ultra QA source changed after the frozen snapshot');
}

function repoPath(repoRoot: string, relative: string): string {
  const root = path.resolve(repoRoot); const full = path.resolve(root, relative);
  if (!full.startsWith(`${root}${path.sep}`) && full !== root) throw new Error('artifact path escapes repository');
  return full;
}
function treeDigest(repoRoot: string, relative: string): string {
  const full = repoPath(repoRoot, relative);
  if (!fs.existsSync(full)) return digest(`missing:${relative}`);
  const hash = createHash('sha256');
  const visit = (file: string, label: string): void => {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) { for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child), `${label}/${child}`); return; }
    hash.update(label); hash.update('\0'); hash.update(fs.readFileSync(file)); hash.update('\0');
  };
  visit(full, relative); return hash.digest('hex');
}

function sanitized(value: string, repoRoot: string): string {
  return value.replaceAll(path.resolve(repoRoot), '<repo>')
    .replace(/\/(Users|home|tmp)\/[A-Za-z0-9_./-]+/g, '<path>')
    .replace(/(?:sk|key|token|secret)[_-]?[A-Za-z0-9]{12,}/gi, '<redacted>');
}
function safeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['CODEX_PROXY_API_KEY', 'KILO_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GROK_API_KEY', 'GLM_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'LMSTUDIO_API_KEY', 'OLLAMA_API_KEY', 'LIMINAL_LLM_API_KEY', 'LIMINAL_HARNESS_API_KEY', 'LIMINAL_EVALUATOR_API_KEY', 'SINTER_LLM_API_KEY', 'SINTER_HARNESS_API_KEY', 'SINTER_EVALUATOR_API_KEY', 'LLM_API_KEY', 'HARNESS_API_KEY', 'EVALUATOR_API_KEY', 'RUN_CLOUD_MODEL_TESTS']) delete env[key];
  return env;
}
function commandPreflight(command: FixedUltraQACommand, repoRoot: string): string | undefined {
  if (command.argv[1] !== 'scripts/quality/wave8-safe-test-allowlist.mjs') return undefined;
  const mode = command.argv[3];
  const checked = spawnSync('node', ['scripts/quality/wave8-safe-test-allowlist.mjs', '--mode', mode, '--inspect'], {
    cwd: repoRoot, env: safeEnv(), shell: false, encoding: 'utf8',
  });
  return checked.status === 0 ? undefined : (checked.stderr || checked.stdout || checked.error?.message || 'safe-test preflight rejected');
}

/** Executes a fixed argv with no shell and without cloud-provider credentials. */
export async function executeFixedUltraQACommand(command: FixedUltraQACommand, repoRoot: string): Promise<UltraQACommandResult> {
  const startedAt = new Date().toISOString(); const [file, ...args] = command.argv;
  const completed = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { cwd: repoRoot, env: safeEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
    const timeoutHandle = setTimeout(() => { stderr += '\nCOMMAND_TIMEOUT_AFTER_600S'; child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 5_000); }, 600_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timeoutHandle); resolve({ exitCode: code ?? 1, stdout, stderr }); });
  });
  const toolVersion = await new Promise<string>(resolve => {
    const child = spawn(file, ['--version'], { cwd: repoRoot, env: safeEnv(), shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { output += data; }); child.on('error', () => resolve('unavailable')); child.on('close', () => resolve(output.trim() || 'unavailable'));
  });
  return { ...completed, startedAt, finishedAt: new Date().toISOString(), toolVersion };
}

function logPaths(command: FixedUltraQACommand): Record<string, string> {
  return { stdout: `logs/${command.kind}.stdout.log`, stderr: `logs/${command.kind}.stderr.log`, toolVersion: `logs/${command.kind}.tool-version.log` };
}
function writeEvidence(target: string, relative: string, value: string): void {
  const full = repoPath(target, relative); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, value, { flag: 'w' });
}
function persistLogs(target: string, command: FixedUltraQACommand, result: UltraQACommandResult, repoRoot: string): PersistedLogs {
  const paths = logPaths(command); const logs = { stdout: sanitized(result.stdout, repoRoot), stderr: sanitized(result.stderr, repoRoot), toolVersion: sanitized(result.toolVersion, repoRoot) };
  writeEvidence(target, paths.stdout, logs.stdout); writeEvidence(target, paths.stderr, logs.stderr); writeEvidence(target, paths.toolVersion, logs.toolVersion);
  return { ...logs, paths };
}
function normalizedResult(result: UltraQACommandResult, logs: PersistedLogs): UltraQACommandResult { return { ...result, stdout: logs.stdout, stderr: logs.stderr, toolVersion: logs.toolVersion }; }
function outputMatches(command: FixedUltraQACommand, result: UltraQACommandResult): boolean { return command.expectedOutput === '' ? `${result.stdout}${result.stderr}`.trim() === '' : `${result.stdout}${result.stderr}`.includes(command.expectedOutput); }
function noSpendArtifactValid(command: FixedUltraQACommand, repoRoot: string): boolean {
  if (command.kind !== 'deterministic-no-spend' && command.kind !== 'wave7-reproof') return true;
  try {
    const receipt = JSON.parse(fs.readFileSync(repoPath(repoRoot, command.artifactRoots[0]), 'utf8')) as Record<string, unknown>;
    return receipt.passed === true && receipt.noSpendCirculationProof === true && receipt.evidenceClass === 'deterministic-proof'
      && receipt.livePass === false && Array.isArray(receipt.providerCalls);
  } catch { return false; }
}
function commandArtifactState(command: FixedUltraQACommand, repoRoot: string): boolean {
  return command.artifactRoots.every(root => fs.existsSync(repoPath(repoRoot, root))) && noSpendArtifactValid(command, repoRoot);
}

function contractPayload(command: FixedUltraQACommand, result: UltraQACommandResult, frozen: UltraQASourceSnapshot, artifacts: string[], outputMatched: boolean, artifactsPresent: boolean, logs: PersistedLogs): Record<string, unknown> {
  return { contract: COMMAND_CONTRACT, command: command.kind, argv: [...command.argv], exitCode: result.exitCode, startedAt: result.startedAt, finishedAt: result.finishedAt,
    stdoutDigest: digest(result.stdout), stderrDigest: digest(result.stderr), toolVersionDigest: digest(result.toolVersion), logs: logs.paths, artifactDigests: artifacts,
    releaseHead: frozen.releaseHead, sourceFingerprint: frozen.sourceFingerprint, noSpend: true, providerCalls: 0, expectedOutput: command.expectedOutput,
    requiredArtifacts: [...command.artifactRoots], outputMatched, outputWitness: outputMatched ? command.expectedOutput : null, artifactsPresent,
    ...(command.kind === 'wave7-reproof' ? { reproved: outputMatched && artifactsPresent } : {}),
  };
}

export function createUltraQACommandReceipt(command: FixedUltraQACommand, result: UltraQACommandResult, frozen: UltraQASourceSnapshot, schemaDigest: string, implementationDigest: string, repoRoot: string, logs: PersistedLogs): Wave8EvidenceReceipt {
  const artifactsPresent = commandArtifactState(command, repoRoot);
  const outputMatched = outputMatches(command, result);
  const artifacts = [digest(result.stdout), digest(result.stderr), digest(result.toolVersion), ...command.artifactRoots.map(root => treeDigest(repoRoot, root))];
  return createWave8EvidenceReceipt({ receiptId: `wave8-ultraqa:${command.kind}:${frozen.releaseHead}`, kind: command.kind, generatedAt: result.finishedAt,
    sourceFingerprint: frozen.sourceFingerprint, purpose: 'diagnostic', evidenceClass: 'deterministic-proof', passed: result.exitCode === 0 && outputMatched && artifactsPresent,
    deterministic: true, spendUsd: 0, providerCalls: 0, artifactDigests: artifacts, schemaDigest, implementationDigest,
    payload: contractPayload(command, result, frozen, artifacts, outputMatched, artifactsPresent, logs) });
}

function sameArray(actual: unknown, expected: readonly string[]): boolean { return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]); }
function validRelativeEvidencePath(value: unknown): value is string { return typeof value === 'string' && !path.isAbsolute(value) && !value.includes('..') && value.startsWith('logs/'); }

export function validateUltraQACommandReceipt(receipt: Wave8EvidenceReceipt, command: FixedUltraQACommand, frozen: UltraQASourceSnapshot, evidenceDir: string, observed?: UltraQACommandResult, repoRoot?: string): string[] {
  const failures: string[] = []; try { parseWave8EvidenceReceipt(receipt); } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  const payload = receipt.payload; const rawReceipt = receipt as unknown as Record<string, unknown>; const expect = (id: string, ok: boolean): void => { if (!ok) failures.push(id); };
  expect('unsigned-receipt-required', rawReceipt.keyId === undefined && rawReceipt.signatureBase64 === undefined);
  expect('kind-mismatch', receipt.kind === command.kind && receipt.receiptId === `wave8-ultraqa:${command.kind}:${frozen.releaseHead}`);
  expect('source-mismatch', receipt.sourceFingerprint === frozen.sourceFingerprint && payload.sourceFingerprint === frozen.sourceFingerprint && payload.releaseHead === frozen.releaseHead);
  expect('proof-metadata-invalid', receipt.evidenceClass === 'deterministic-proof' && receipt.deterministic && receipt.spendUsd === 0 && receipt.providerCalls === 0);
  expect('command-contract-invalid', payload.contract === COMMAND_CONTRACT && payload.command === command.kind && sameArray(payload.argv, command.argv));
  expect('exit-code-invalid', Number.isInteger(payload.exitCode)); expect('execution-window-invalid', isIso(payload.startedAt) && isIso(payload.finishedAt) && Date.parse(payload.finishedAt as string) >= Date.parse(payload.startedAt as string));
  expect('log-digest-invalid', isDigest(payload.stdoutDigest) && isDigest(payload.stderrDigest) && isDigest(payload.toolVersionDigest));
  expect('artifact-contract-invalid', sameArray(payload.artifactDigests, receipt.artifactDigests) && receipt.artifactDigests.length >= 4 && receipt.artifactDigests.every(isDigest));
  expect('expected-output-invalid', payload.expectedOutput === command.expectedOutput && typeof payload.outputMatched === 'boolean' && payload.outputWitness === (payload.outputMatched === true ? command.expectedOutput : null));
  expect('required-artifact-invalid', sameArray(payload.requiredArtifacts, command.artifactRoots) && typeof payload.artifactsPresent === 'boolean');
  expect('result-not-proved', receipt.passed === (payload.exitCode === 0 && payload.outputMatched === true && payload.artifactsPresent === true));
  expect('no-spend-contract-invalid', payload.noSpend === true && payload.providerCalls === 0);
  expect('wave7-reproof-invalid', command.kind !== 'wave7-reproof' ? payload.reproved === undefined : payload.reproved === true);
  const artifactRepoRoot = repoRoot ?? path.resolve(evidenceDir, '../../..');
  const currentArtifactDigests = command.artifactRoots.map(root => treeDigest(artifactRepoRoot, root));
  const artifactsPresentNow = commandArtifactState(command, artifactRepoRoot);
  expect('artifact-tree-missing-or-tampered', payload.artifactsPresent === artifactsPresentNow
    && (!artifactsPresentNow || sameArray(receipt.artifactDigests.slice(3), currentArtifactDigests)));
  const logRecord = payload.logs as Record<string, unknown> | undefined; const expectedPaths = logPaths(command);
  expect('log-path-invalid', !!logRecord && sameArray(Object.keys(logRecord).sort(), Object.keys(expectedPaths).sort()) && Object.values(logRecord).every(validRelativeEvidencePath)
    && logRecord?.stdout === expectedPaths.stdout && logRecord?.stderr === expectedPaths.stderr && logRecord?.toolVersion === expectedPaths.toolVersion);
  if (logRecord && Object.values(logRecord).every(validRelativeEvidencePath)) {
    const load = (key: 'stdout' | 'stderr' | 'toolVersion'): string | null => { const full = repoPath(evidenceDir, logRecord[key] as string); return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null; };
    const stdout = load('stdout'); const stderr = load('stderr'); const toolVersion = load('toolVersion');
    expect('persisted-log-missing-or-tampered', stdout !== null && stderr !== null && toolVersion !== null && payload.stdoutDigest === digest(stdout) && payload.stderrDigest === digest(stderr) && payload.toolVersionDigest === digest(toolVersion)
      && !`${stdout}${stderr}${toolVersion}`.includes(path.resolve(repoRoot ?? evidenceDir)));
    if (observed && repoRoot) {
      const normalized = normalizedResult(observed, { stdout: sanitized(observed.stdout, repoRoot), stderr: sanitized(observed.stderr, repoRoot), toolVersion: sanitized(observed.toolVersion, repoRoot), paths: expectedPaths });
      const artifactDigests = [digest(normalized.stdout), digest(normalized.stderr), digest(normalized.toolVersion), ...command.artifactRoots.map(root => treeDigest(repoRoot, root))];
      expect('observed-result-mismatch', payload.exitCode === normalized.exitCode && payload.stdoutDigest === digest(normalized.stdout) && payload.stderrDigest === digest(normalized.stderr)
        && payload.toolVersionDigest === digest(normalized.toolVersion) && payload.outputMatched === outputMatches(command, normalized) && sameArray(receipt.artifactDigests, artifactDigests));
    }
  }
  expect('absolute-path-leak', !JSON.stringify(receipt).includes(path.resolve(repoRoot ?? evidenceDir)));
  return failures;
}

function canonicalSourceDigest(repoRoot: string, relative: string): string {
  const source = repoPath(repoRoot, relative);
  if (!fs.existsSync(source)) throw new Error(`Ultra QA canonical source is missing: ${relative}`);
  return digest(fs.readFileSync(source));
}

/** Canonical current-code digests bind every bootstrap and emitted QA receipt. */
export function deriveUltraQAActiveDigests(repoRoot: string): ActiveDigests {
  return {
    schema: canonicalSourceDigest(repoRoot, 'src/runtime-core/Wave8ReleaseRoot.ts'),
    implementation: canonicalSourceDigest(repoRoot, 'src/runtime-core/DeterministicUltraQA.ts'),
  };
}

function bootstrapState(root: Wave8ReleaseRoot | undefined, frozen: UltraQASourceSnapshot, repoRoot: string): BootstrapState {
  const activeDigests = deriveUltraQAActiveDigests(repoRoot);
  if (!root) return { receipts: [], activeDigests };
  parseWave8ReleaseRoot(root);
  if (root.releaseHead !== frozen.releaseHead || root.sourceFingerprint !== frozen.sourceFingerprint) throw new Error('Bootstrap root is not bound to frozen source');
  requireCurrentWave8ReceiptSource(root.receipts, frozen.sourceFingerprint);
  if (root.receipts.some(receipt => QUALITY_KINDS.includes(receipt.kind as UltraQACommandKind))) throw new Error('Bootstrap root cannot pre-mint Ultra QA command receipts');
  if (root.activeDigests.schema !== activeDigests.schema || root.activeDigests.implementation !== activeDigests.implementation) {
    throw new Error('Bootstrap active digests do not match canonical source');
  }
  if (root.receipts.some(receipt => receipt.schemaDigest !== activeDigests.schema || receipt.implementationDigest !== activeDigests.implementation)) {
    throw new Error('Bootstrap receipt digests do not match canonical source');
  }
  return { receipts: root.receipts, activeDigests };
}

function writeReceipt(target: string, receipt: Wave8EvidenceReceipt): void { writeEvidence(target, `receipts/${receipt.kind}.json`, `${JSON.stringify(receipt, null, 2)}\n`); }
function writeSummary(state: RunState): void {
  writeEvidence(state.target, 'summary.json', `${JSON.stringify({ status: state.error ? 'failed' : 'completed', failedKind: state.failedKind ?? null, error: state.error ?? null,
    releaseHead: state.frozen?.releaseHead ?? null, sourceFingerprint: state.frozen?.sourceFingerprint ?? null, receiptCount: state.receipts.length }, null, 2)}\n`);
}
function currentRoot(seeds: readonly Wave8EvidenceReceipt[], receipts: readonly Wave8EvidenceReceipt[], frozen: UltraQASourceSnapshot, activeDigests: ActiveDigests): Wave8ReleaseRoot {
  return createWave8ReleaseRoot({ generatedAt: new Date().toISOString(), releaseHead: frozen.releaseHead, sourceFingerprint: frozen.sourceFingerprint,
    activeDigests, receipts: [...seeds, ...receipts] });
}
function writeSemanticInputs(target: string, root: Wave8ReleaseRoot, frozen: UltraQASourceSnapshot, preserveSemanticSnapshot = false): void {
  if (preserveSemanticSnapshot) writeEvidence(target, 'semantic-input-root.json', `${JSON.stringify(root, null, 2)}\n`);
  writeEvidence(target, 'release-root.json', `${JSON.stringify(root, null, 2)}\n`);
  const report = validateWave8ReleaseRoot(root, { currentSourceFingerprint: frozen.sourceFingerprint, requireCampaignOrigin: true });
  for (const name of ['market.json', 'release.json', 'terminal.json']) writeEvidence(target, name, `${JSON.stringify(report, null, 2)}\n`);
}

/** Validates the final root and every fixed command receipt against the persisted, sanitized evidence files. */
export function validateDeterministicUltraQAEnvelope(root: Wave8ReleaseRoot, frozen: UltraQASourceSnapshot, evidenceDir: string): string[] {
  const failures: string[] = []; try { parseWave8ReleaseRoot(root); } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  if (root.releaseHead !== frozen.releaseHead || root.sourceFingerprint !== frozen.sourceFingerprint) failures.push('root-source-mismatch');
  for (const command of FIXED_ULTRAQA_COMMANDS) {
    const matches = root.receipts.filter(receipt => receipt.kind === command.kind);
    if (matches.length !== 1) { failures.push(`command-receipt-count:${command.kind}`); continue; }
    failures.push(...validateUltraQACommandReceipt(matches[0], command, frozen, evidenceDir).map(failure => `${command.kind}:${failure}`));
  }
  return failures;
}

export async function runDeterministicUltraQA(repoRoot: string, bootstrap: Wave8ReleaseRoot | undefined, executor: UltraQAExecutor = executeFixedUltraQACommand, evidenceDir = path.join(repoRoot, EVIDENCE_ROOT)): Promise<UltraQAExecutionResult> {
  const target = path.resolve(evidenceDir); if (target !== path.join(path.resolve(repoRoot), EVIDENCE_ROOT)) throw new Error(`Ultra QA evidence directory must be ${EVIDENCE_ROOT}`);
  if (fs.existsSync(target)) throw new Error('Ultra QA refuses to overwrite prior evidence; use a new clean worktree after preserving the old receipt');
  fs.mkdirSync(target, { recursive: true });
  let frozen: UltraQASourceSnapshot | null = null; const receipts: Wave8EvidenceReceipt[] = [];
  try {
    if (new Set(FIXED_ULTRAQA_COMMANDS.map(command => command.kind)).size !== FIXED_ULTRAQA_COMMANDS.length) throw new Error('Ultra QA fixed command table has duplicate receipt kinds');
    frozen = freezeUltraQASource(repoRoot); const bootstrapStateResult = bootstrapState(bootstrap, frozen, repoRoot);
    const seeds = bootstrapStateResult.receipts; const activeDigests = bootstrapStateResult.activeDigests;
    for (const command of FIXED_ULTRAQA_COMMANDS) {
      if (command.kind === 'semantic-audit') writeSemanticInputs(target, currentRoot(seeds, receipts, frozen, activeDigests), frozen, true);
      const startedAt = new Date().toISOString(); const blocked = commandPreflight(command, repoRoot);
      let raw: UltraQACommandResult;
      if (blocked) raw = { exitCode: 78, stdout: '', stderr: `BLOCKED_UNSAFE_CLOSURE:${blocked}`, startedAt, finishedAt: new Date().toISOString(), toolVersion: 'not-run' };
      else {
        try { raw = await executor(command, repoRoot); }
        catch (error) { raw = { exitCode: 1, stdout: '', stderr: `COMMAND_EXECUTION_ERROR:${error instanceof Error ? error.message : String(error)}`, startedAt, finishedAt: new Date().toISOString(), toolVersion: 'unavailable' }; }
      }
      const logs = persistLogs(target, command, raw, repoRoot); const result = normalizedResult(raw, logs);
      const receipt = createUltraQACommandReceipt(command, result, frozen, activeDigests.schema, activeDigests.implementation, repoRoot, logs); writeReceipt(target, receipt);
      const failures = validateUltraQACommandReceipt(receipt, command, frozen, target, raw, repoRoot);
      if (failures.length > 0) throw new Error(`Ultra QA evidence receipt ${command.kind} is invalid: ${failures.join(', ')}`);
      assertStillFrozen(repoRoot, frozen); receipts.push(receipt);
    }
    const root = currentRoot(seeds, receipts, frozen, activeDigests); writeSemanticInputs(target, root, frozen); assertStillFrozen(repoRoot, frozen); requireCurrentWave8ReceiptSource(root.receipts, frozen.sourceFingerprint);
    const envelopeFailures = validateDeterministicUltraQAEnvelope(root, frozen, target); if (envelopeFailures.length > 0) throw new Error(`Ultra QA evidence envelope failed: ${envelopeFailures.join(', ')}`);
    const report = validateWave8ReleaseRoot(root, { currentSourceFingerprint: frozen.sourceFingerprint, requireCampaignOrigin: true });
    writeSummary({ target, frozen, receipts }); return { receipts, root, releaseReady: report.ownerReleaseReady, blockers: report.blockers };
  } catch (error) {
    writeSummary({ target, frozen, receipts, failedKind: receipts.length < FIXED_ULTRAQA_COMMANDS.length ? FIXED_ULTRAQA_COMMANDS[receipts.length]?.kind : undefined, error: sanitized(error instanceof Error ? error.message : String(error), repoRoot) });
    throw error;
  }
}

export function parseUltraQABootstrap(value: unknown): Wave8ReleaseRoot { return parseWave8ReleaseRoot(value); }
