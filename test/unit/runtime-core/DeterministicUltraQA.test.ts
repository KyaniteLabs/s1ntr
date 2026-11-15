import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWave8EvidenceReceipt, createWave8ReleaseRoot, type Wave8EvidenceReceipt, type Wave8ReleaseRoot } from '../../../src/runtime-core/Wave8ReleaseRoot.js';
import {
  FIXED_ULTRAQA_COMMANDS,
  assertCleanRepository,
  createUltraQACommandReceipt,
  deriveUltraQAActiveDigests,
  executeFixedUltraQACommand,
  freezeUltraQASource,
  runDeterministicUltraQA,
  validateDeterministicUltraQAEnvelope,
  validateUltraQACommandReceipt,
} from '../../../src/runtime-core/DeterministicUltraQA.js';

const temporary: string[] = [];
const workspaceRoot = fs.realpathSync(process.cwd());
afterEach(() => temporary.splice(0).forEach(folder => fs.rmSync(folder, { recursive: true, force: true })));
const DIGEST = 'a'.repeat(64);

function fixtureGit(root: string, args: string[]): void {
  const realRoot = fs.realpathSync(root);
  const relative = path.relative(workspaceRoot, realRoot);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    throw new Error(`Fixture git mutation refused inside workspace: ${relative || '.'}`);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  execFileSync('git', args, { cwd: realRoot, env });
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wave8-ultraqa-')); temporary.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.quality/\nnode_modules/\n');
  for (const relative of ['src/runtime-core/Wave8ReleaseRoot.ts', 'src/runtime-core/DeterministicUltraQA.ts']) {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(workspaceRoot, relative), target);
  }
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['config', 'core.hooksPath', '']);
  fixtureGit(root, ['config', 'user.email', 'test@example.com']);
  fixtureGit(root, ['config', 'user.name', 'Test']);
  for (const command of FIXED_ULTRAQA_COMMANDS.filter(command => !command.artifactRoots.some(item => item.startsWith('.quality/')))) materializeArtifacts(root, command);
  fixtureGit(root, ['add', '.']); fixtureGit(root, ['commit', '-qm', 'fixture']);
  return root;
}

function seed(root: string, mutate?: (receipt: Wave8EvidenceReceipt) => void): Wave8ReleaseRoot {
  const current = freezeUltraQASource(root); const activeDigests = deriveUltraQAActiveDigests(root);
  const receipt = (kind: Wave8EvidenceReceipt['kind'], payload: Record<string, unknown> = {}): Wave8EvidenceReceipt => createWave8EvidenceReceipt({
    receiptId: `seed-${kind}`, kind, generatedAt: '2026-08-02T00:00:00.000Z', sourceFingerprint: current.sourceFingerprint,
    purpose: 'governed-product', evidenceClass: 'execution', passed: true, deterministic: false, spendUsd: 0, providerCalls: 0,
    artifactDigests: [DIGEST], schemaDigest: activeDigests.schema, implementationDigest: activeDigests.implementation, payload,
  });
  const product = receipt('product', { productDelta: {}, inheritedFrom: 'prior', priorReceiptId: 'prior', userVisible: true });
  mutate?.(product);
  return createWave8ReleaseRoot({ generatedAt: '2026-08-02T00:00:00.000Z', releaseHead: current.releaseHead, sourceFingerprint: current.sourceFingerprint,
    activeDigests, receipts: [
      receipt('corpus', { complete: true, entries: ['one'], sourceDigests: [DIGEST] }), product,
      receipt('authority', { ownerVerified: true, transferBound: true, revocationChecked: true }), receipt('exact-evidence'),
      receipt('graph-migration', { cycleDetected: false, migrationRoundTrip: true, graphDigest: DIGEST }), receipt('idempotency', { duplicateEffectsAbsent: true }),
      receipt('schema-invalidation'),
    ] });
}

function passing(command: typeof FIXED_ULTRAQA_COMMANDS[number]) {
  return { exitCode: 0, stdout: command.expectedOutput, stderr: '', startedAt: '2026-08-02T00:00:00.000Z', finishedAt: '2026-08-02T00:00:01.000Z', toolVersion: '1.0.0' };
}

function evidence(root: string, command: typeof FIXED_ULTRAQA_COMMANDS[number], result = passing(command)) {
  const target = path.join(root, '.quality/wave-8/release');
  for (const [name, content] of Object.entries({ stdout: result.stdout, stderr: result.stderr, toolVersion: result.toolVersion })) {
    const file = path.join(target, 'logs', `${command.kind}.${name === 'toolVersion' ? 'tool-version' : name}.log`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  return { target, logs: { stdout: `logs/${command.kind}.stdout.log`, stderr: `logs/${command.kind}.stderr.log`, toolVersion: `logs/${command.kind}.tool-version.log` } };
}

function issued(root: string, command: typeof FIXED_ULTRAQA_COMMANDS[number], result = passing(command)) {
  const frozen = freezeUltraQASource(root); materializeArtifacts(root, command); const persisted = evidence(root, command, result);
  const logs = { stdout: result.stdout, stderr: result.stderr, toolVersion: result.toolVersion, paths: persisted.logs };
  return { frozen, result, target: persisted.target, receipt: createUltraQACommandReceipt(command, result, frozen, 'b'.repeat(64), 'c'.repeat(64), root, logs) };
}

describe('DeterministicUltraQA', () => {
  it('uses one fixed non-shell command table for every required quality receipt', () => {
    expect(FIXED_ULTRAQA_COMMANDS.map(command => command.kind)).toEqual([
      'frozen-install', 'orphan-scan', 'script-targets', 'build', 'audio-build', 'typecheck', 'lint', 'focused-checks', 'deterministic-e2e', 'restart', 'safe-suite', 'coverage', 'test-quality', 'compound-health', 'pack', 'packed-install', 'installed-startup', 'startup', 'deterministic-no-spend', 'leak-audit', 'semantic-audit', 'wave7-reproof',
    ]);
    expect(new Set(FIXED_ULTRAQA_COMMANDS.map(command => command.kind)).size).toBe(FIXED_ULTRAQA_COMMANDS.length);
    expect(FIXED_ULTRAQA_COMMANDS.every(command => command.argv.length > 1 && !command.argv.join(' ').match(/[;&|`$]/))).toBe(true);
    const allowlist = fs.readFileSync(path.join(process.cwd(), 'scripts/quality/wave8-safe-test-allowlist.mjs'), 'utf8');
    expect(allowlist).toContain('runInSandbox|playwright|puppeteer|LLMClient|applyProviderEnv|requestImprovement');
    expect(allowlist).toContain("SAFE_SUBPROCESSES = new Set(['bin/sinter\\0campaign-continue'])");
    expect(allowlist).toContain('Unsafe or dynamic subprocess in allowlist closure');
    expect(allowlist).toContain('KEY|TOKEN|AUTHORIZATION|SECRET|PASSWORD|CREDENTIALS');
    expect(FIXED_ULTRAQA_COMMANDS.filter(command => ['deterministic-e2e', 'safe-suite', 'coverage'].includes(command.kind))
      .every(command => command.argv[1] === 'scripts/quality/wave8-safe-test-allowlist.mjs')).toBe(true);
  });

  it('admits the bounded CLI e2e but blocks global coverage before launch', () => {
    const script = path.join(process.cwd(), 'scripts/quality/wave8-safe-test-allowlist.mjs');
    const e2e = spawnSync(process.execPath,
      [script, '--mode', 'campaign-continuation-e2e', '--inspect'], { encoding: 'utf8' });
    expect(e2e.status).toBe(0);
    expect(e2e.stdout).toContain('campaign-continuation-e2e inspected');
    const coverage = spawnSync(process.execPath,
      [script, '--mode', 'coverage', '--inspect'], { encoding: 'utf8' });
    expect(coverage.status).toBe(78);
    expect(coverage.stderr).toContain('BLOCKED_UNSAFE_COVERAGE');
  });

  it.each(['unstaged', 'staged', 'untracked'] as const)('refuses %s source state', state => {
    const root = repository(); fs.writeFileSync(path.join(root, 'untracked.ts'), 'x');
    if (state === 'unstaged') { fixtureGit(root, ['add', 'untracked.ts']); fixtureGit(root, ['commit', '-qm', 'tracked']); fs.writeFileSync(path.join(root, 'untracked.ts'), 'changed'); }
    if (state === 'staged') fixtureGit(root, ['add', 'untracked.ts']);
    expect(() => assertCleanRepository(root)).toThrow('dirty, staged, or untracked');
  });

  it('binds command receipt status, logs, artifact digests, tool version, and frozen source', () => {
    const root = repository(); const command = FIXED_ULTRAQA_COMMANDS[0]; const { frozen, result, receipt, target } = issued(root, command);
    expect(receipt.payload.logs).toEqual({ stdout: 'logs/frozen-install.stdout.log', stderr: 'logs/frozen-install.stderr.log', toolVersion: 'logs/frozen-install.tool-version.log' });
    expect(validateUltraQACommandReceipt(receipt, command, frozen, target, result, root)).toEqual([]);
    const forged = rehash(receipt, { payload: { ...receipt.payload, exitCode: 1 } });
    expect(validateUltraQACommandReceipt(forged, command, frozen, target, result, root)).toContain('result-not-proved');
  });

  it.each(FIXED_ULTRAQA_COMMANDS)('rejects malformed required artifact proof for $kind', command => {
    const root = repository(); const { frozen, result, receipt, target } = issued(root, command);
    const malformed = rehash(receipt, { payload: { ...receipt.payload, requiredArtifacts: [] } });
    expect(validateUltraQACommandReceipt(malformed, command, frozen, target, result, root)).toContain('required-artifact-invalid');
    const wrongWitness = rehash(receipt, { payload: { ...receipt.payload, expectedOutput: 'forged' } });
    expect(validateUltraQACommandReceipt(wrongWitness, command, frozen, target, result, root)).toContain('expected-output-invalid');
    const missingWitness = rehash(receipt, { payload: { ...receipt.payload, outputWitness: null } });
    expect(validateUltraQACommandReceipt(missingWitness, command, frozen, target, result, root)).toContain('expected-output-invalid');
  });

  it('rejects a forged signature field instead of trusting self-generated keys', () => {
    const root = repository(); const command = FIXED_ULTRAQA_COMMANDS[0]; const { frozen, receipt, target } = issued(root, command);
    const forged = { ...rehash(receipt), keyId: 'ephemeral', signatureBase64: 'forged' } as Wave8EvidenceReceipt;
    expect(validateUltraQACommandReceipt(forged, command, frozen, target)).not.toEqual([]);
  });

  it('runs every command, rebuilds the root, and keeps no-owner campaign gates honest', async () => {
    const root = repository(); const calls: string[] = [];
    const result = await runDeterministicUltraQA(root, seed(root), async command => { calls.push(command.kind); materializeArtifacts(root, command); return passing(command); });
    expect(calls).not.toContain('deterministic-e2e');
    expect(calls).toContain('startup');
    expect(result.receipts).toHaveLength(FIXED_ULTRAQA_COMMANDS.length);
    expect(result.root.receipts).toHaveLength(29);
    expect(result.receipts.every(receipt => !('signatureBase64' in receipt))).toBe(true);
    expect(result.receipts.find(receipt => receipt.kind === 'deterministic-e2e')?.passed).toBe(false);
    expect(result.releaseReady).toBe(false);
    expect(result.blockers).toContain('product-complete: product-campaign-origin-invalid');
  });

  it('runs all fixed lanes without a bootstrap and preserves missing prerequisite blockers', async () => {
    const root = repository(); const calls: string[] = [];
    const result = await runDeterministicUltraQA(root, undefined, async command => {
      calls.push(command.kind); materializeArtifacts(root, command); return passing(command);
    });
    expect(calls).not.toContain('deterministic-e2e');
    expect(result.receipts).toHaveLength(FIXED_ULTRAQA_COMMANDS.length);
    expect(result.root.receipts).toHaveLength(FIXED_ULTRAQA_COMMANDS.length);
    expect(result.root.receipts.some(receipt => receipt.kind === 'corpus')).toBe(false);
    expect(result.root.activeDigests).toEqual(deriveUltraQAActiveDigests(root));
    expect(result.releaseReady).toBe(false);
    expect(result.blockers).toContain('corpus-complete: missing-corpus-receipt');
    expect(result.blockers).toContain('product-complete: missing-product-receipt');
  });

  it('persists a red command receipt and continues to later safe commands', async () => {
    const root = repository();
    const calls: string[] = [];
    const result = await runDeterministicUltraQA(root, seed(root), async command => {
      calls.push(command.kind);
      materializeArtifacts(root, command);
      return command.kind === 'lint' ? { ...passing(command), exitCode: 1, stderr: 'bad' } : passing(command);
    });
    expect(result.receipts).toHaveLength(FIXED_ULTRAQA_COMMANDS.length);
    expect(result.receipts.find(receipt => receipt.kind === 'lint')?.passed).toBe(false);
    expect(calls).toContain('startup');
  });

  it('continues from an authentic red bootstrap without converting it to green', async () => {
    const root = repository();
    const bootstrap = seed(root, receipt => { Object.assign(receipt, rehash(receipt, { passed: false })); });
    const result = await runDeterministicUltraQA(root, bootstrap, async command => { materializeArtifacts(root, command); return passing(command); });
    expect(result.root.receipts.find(receipt => receipt.receiptId === 'seed-product')?.passed).toBe(false);
    expect(result.releaseReady).toBe(false);
    expect(result.blockers).toContain('product-complete: product-not-passed');
  });

  it('continues from a partial authentic bootstrap and reports its missing prerequisites', async () => {
    const root = repository(); const complete = seed(root);
    const partial = createWave8ReleaseRoot({
      generatedAt: complete.generatedAt, releaseHead: complete.releaseHead, sourceFingerprint: complete.sourceFingerprint,
      activeDigests: complete.activeDigests, receipts: [complete.receipts[0]],
    });
    const result = await runDeterministicUltraQA(root, partial, async command => { materializeArtifacts(root, command); return passing(command); });
    expect(result.root.receipts).toHaveLength(FIXED_ULTRAQA_COMMANDS.length + 1);
    expect(result.releaseReady).toBe(false);
    expect(result.blockers).toContain('product-complete: missing-product-receipt');
  });

  it('rejects a bootstrap from a different frozen source', async () => {
    const bootstrapSource = repository(); const target = repository();
    fs.writeFileSync(path.join(target, 'different.ts'), 'different'); fixtureGit(target, ['add', 'different.ts']); fixtureGit(target, ['commit', '-qm', 'different source']);
    await expect(runDeterministicUltraQA(target, seed(bootstrapSource), async command => passing(command))).rejects.toThrow('Bootstrap root is not bound to frozen source');
  });

  it('rejects mutually consistent bootstrap digests that do not describe canonical source', async () => {
    const root = repository(); const canonical = seed(root); const forgedDigests = { schema: 'd'.repeat(64), implementation: 'e'.repeat(64) };
    const forged = createWave8ReleaseRoot({
      generatedAt: canonical.generatedAt, releaseHead: canonical.releaseHead, sourceFingerprint: canonical.sourceFingerprint,
      activeDigests: forgedDigests,
      receipts: canonical.receipts.map(receipt => rehash(receipt, { schemaDigest: forgedDigests.schema, implementationDigest: forgedDigests.implementation })),
    });
    await expect(runDeterministicUltraQA(root, forged, async command => passing(command))).rejects.toThrow('Bootstrap active digests do not match canonical source');
  });

  it('fails if source state changes during execution', async () => {
    const root = repository(); let changed = false;
    await expect(runDeterministicUltraQA(root, seed(root), async command => { materializeArtifacts(root, command); if (!changed) { fs.writeFileSync(path.join(root, 'drift.ts'), 'x'); changed = true; } return passing(command); })).rejects.toThrow('dirty, staged, or untracked');
  });

  it('fails if HEAD advances during execution even when the repository is clean', async () => {
    const root = repository(); let committed = false;
    await expect(runDeterministicUltraQA(root, seed(root), async command => {
      materializeArtifacts(root, command);
      if (!committed) { fs.writeFileSync(path.join(root, 'next.ts'), 'x'); fixtureGit(root, ['add', 'next.ts']); fixtureGit(root, ['commit', '-qm', 'drift']); committed = true; }
      return passing(command);
    })).rejects.toThrow('source changed after the frozen snapshot');
  });

  it('detects a persisted log mutation during final-envelope validation', async () => {
    const root = repository(); const result = await runDeterministicUltraQA(root, seed(root), async command => { materializeArtifacts(root, command); return passing(command); });
    const frozen = freezeUltraQASource(root); const target = path.join(root, '.quality/wave-8/release');
    fs.writeFileSync(path.join(target, 'logs', 'lint.stdout.log'), 'tampered');
    expect(validateDeterministicUltraQAEnvelope(result.root, frozen, target)).toContain('lint:persisted-log-missing-or-tampered');
  });

  it('detects an artifact-tree mutation during final-envelope validation', async () => {
    const root = repository(); const result = await runDeterministicUltraQA(root, seed(root), async command => { materializeArtifacts(root, command); return passing(command); });
    const frozen = freezeUltraQASource(root); const target = path.join(root, '.quality/wave-8/release');
    fs.writeFileSync(path.join(root, 'dist', 'artifact'), 'tampered');
    expect(validateDeterministicUltraQAEnvelope(result.root, frozen, target).some(item => item.endsWith(':artifact-tree-missing-or-tampered'))).toBe(true);
  });

  it('uses the real non-shell executor for the safe startup command and persists recomputable evidence', async () => {
    const repoRoot = process.cwd(); const command = FIXED_ULTRAQA_COMMANDS.find(item => item.kind === 'startup')!;
    const result = await executeFixedUltraQACommand(command, repoRoot);
    expect(result.exitCode).toBe(0); expect(`${result.stdout}${result.stderr}`).toContain('🎨 Sinter: Creative Coding Agent');
    const root = repository(); const frozen = freezeUltraQASource(root); materializeArtifacts(root, command); const persisted = evidence(root, command, result);
    const receipt = createUltraQACommandReceipt(command, result, frozen, 'b'.repeat(64), 'c'.repeat(64), root, { stdout: result.stdout, stderr: result.stderr, toolVersion: result.toolVersion, paths: persisted.logs });
    expect(validateUltraQACommandReceipt(receipt, command, frozen, persisted.target, result, root)).toEqual([]);
  });
});

function materializeArtifacts(root: string, command: typeof FIXED_ULTRAQA_COMMANDS[number]): void {
  for (const relative of command.artifactRoots) {
    const target = path.join(root, relative);
    if (command.kind === 'semantic-audit' && fs.existsSync(target)) continue;
    if (path.extname(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const noSpend = command.kind === 'deterministic-no-spend' || command.kind === 'wave7-reproof';
      fs.writeFileSync(target, noSpend ? JSON.stringify({ passed: true, noSpendCirculationProof: true, evidenceClass: 'deterministic-proof', livePass: false, providerCalls: [] }) : 'artifact');
    }
    else { fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'artifact'), 'artifact'); }
  }
}

function rehash(receipt: Wave8EvidenceReceipt, change: Partial<Wave8EvidenceReceipt> = {}): Wave8EvidenceReceipt {
  const { schema: _schema, schemaVersion: _version, resultDigest: _digest, ...input } = receipt;
  return createWave8EvidenceReceipt({ ...input, ...change });
}
