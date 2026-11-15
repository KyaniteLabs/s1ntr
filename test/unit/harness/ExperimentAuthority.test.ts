import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeCandidateDiff,
  authorizeExperimentRequest,
  createExperimentAuthorityPolicy,
  parseExperimentAuthorityReceipt,
  requestFromToolCall,
  type ExperimentAuthorityPolicy,
} from '../../../src/harness/authority/ExperimentAuthority.js';
import {
  DEFAULT_SHADOW_BUDGETS,
  RECURSIVE_CONTRACT_VERSION,
} from '../../../src/runtime-core/RecursiveImprovementContract.js';

describe('ExperimentAuthority', () => {
  let root: string;
  let policy: ExperimentAuthorityPolicy;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'liminal-w5-authority-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'config'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', 'agents', 'waves', 'receipts'), { recursive: true });
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.mkdir(path.join(root, '.githooks'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'candidate.ts'), 'export const value = 1;\n');
    await fs.writeFile(path.join(root, 'src', 'read-only.ts'), 'export const read = true;\n');
    await fs.writeFile(path.join(root, 'src', 'config', 'runtime.ts'), 'export const secret = true;\n');
    await fs.writeFile(path.join(root, 'vitest.config.ts'), 'export default {};\n');
    await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"escape":"node escape.js"}}\n');
    await fs.writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    await fs.writeFile(path.join(root, '.githooks', 'pre-commit'), '#!/bin/sh\n');
    policy = createExperimentAuthorityPolicy({
      projectRoot: root,
      contract: {
        version: RECURSIVE_CONTRACT_VERSION,
        loop: 'autoresearch',
        experimentId: 'exp-w5-04',
        lineageId: 'lineage-w5-04',
        state: 'mutate',
        stage: 'shadow',
        sourceMutationRequested: true,
        budgets: DEFAULT_SHADOW_BUDGETS,
      },
      candidateFiles: [
        'src/candidate.ts',
        'src/config/runtime.ts',
        'vitest.config.ts',
        '.gitignore',
        '.githooks/pre-commit',
      ],
      sealedEvaluatorFiles: ['src/sealed-evaluator.ts'],
      allowedSkills: ['comorbidity-check'],
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('allows a read-only capability with a complete immutable receipt', async () => {
    const receipt = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'readFile',
      path: 'src/read-only.ts',
    });

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      experimentId: 'exp-w5-04',
      lineageId: 'lineage-w5-04',
      decision: 'allow',
      reason: 'READ_PATH_ALLOWLISTED',
      requested: { kind: 'tool', name: 'readFile', path: 'src/read-only.ts' },
      resolved: {
        kind: 'tool',
        name: 'readFile',
        path: 'src/read-only.ts',
        canonicalPath: 'src/read-only.ts',
      },
    });
    expect(receipt.receiptId).toMatch(/\S/);
    expect(receipt.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(parseExperimentAuthorityReceipt(receipt)).toEqual(receipt);
    expect(() => parseExperimentAuthorityReceipt({
      ...receipt,
      decision: 'deny',
    })).toThrow('EXPERIMENT_AUTHORITY_RECEIPT_DIGEST_MISMATCH');
  });

  it('allows only exact candidate-source mutations', async () => {
    const allowed = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'applyEdit',
      path: 'src/candidate.ts',
      content: 'export const value = 2;',
    });
    const undeclared = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/read-only.ts',
      content: 'changed',
    });

    expect(allowed).toMatchObject({
      decision: 'allow',
      reason: 'MUTATION_AUTHORIZED',
      resolved: { pathClass: 'candidate-source' },
    });
    expect(undeclared.decision).toBe('deny');
  });

  it.each([
    { kind: 'filesystem' as const, name: 'node:fs', reason: 'DIRECT_FILESYSTEM_DENIED' },
    { kind: 'subprocess' as const, name: 'spawn', reason: 'SUBPROCESS_DENIED' },
    { kind: 'package-script' as const, name: 'escape', reason: 'PACKAGE_SCRIPT_DENIED' },
    { kind: 'plugin' as const, name: 'untrusted-plugin', reason: 'PLUGIN_NOT_ALLOWLISTED' },
  ])('denies $kind escape requests', async ({ kind, name, reason }) => {
    const receipt = await authorizeExperimentRequest(policy, { kind, name });
    expect(receipt).toMatchObject({ decision: 'deny', reason });
  });

  it('allows only explicitly named skills', async () => {
    const allowed = await authorizeExperimentRequest(policy, {
      kind: 'skill',
      name: 'comorbidity-check',
    });
    const denied = await authorizeExperimentRequest(policy, {
      kind: 'skill',
      name: 'arbitrary-skill',
    });
    expect(allowed.decision).toBe('allow');
    expect(denied).toMatchObject({ decision: 'deny', reason: 'SKILL_NOT_ALLOWLISTED' });
  });

  it.each([
    '../outside.ts',
    '/tmp/outside.ts',
    '~/.sinter/config.json',
    '.git/config',
    'package.json',
    'docs/agents/waves/receipts/proof.json',
  ])('denies protected or escaping mutation path %s', async (requestedPath) => {
    const receipt = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: requestedPath,
      content: 'changed',
    });
    expect(receipt.decision).toBe('deny');
  });

  it('denies symlink and hardlink aliases', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'liminal-w5-outside-'));
    const outsideFile = path.join(outside, 'secret.ts');
    await fs.writeFile(outsideFile, 'secret\n');
    await fs.symlink(outsideFile, path.join(root, 'src', 'symlink.ts'));
    await fs.symlink(
      path.join(root, 'src', 'candidate.ts'),
      path.join(root, 'src', 'internal-symlink.ts'),
    );
    await fs.link(path.join(root, 'src', 'candidate.ts'), path.join(root, 'src', 'hardlink.ts'));
    policy.candidateFiles.push('src/symlink.ts', 'src/internal-symlink.ts', 'src/hardlink.ts');

    const symlink = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/symlink.ts',
      content: 'changed',
    });
    const hardlink = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/hardlink.ts',
      content: 'changed',
    });
    const internalSymlink = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/internal-symlink.ts',
      content: 'changed',
    });
    await fs.rm(outside, { recursive: true, force: true });

    expect(symlink.decision).toBe('deny');
    expect(internalSymlink).toMatchObject({ decision: 'deny', reason: 'SYMLINK_ALIAS_DENIED' });
    expect(hardlink).toMatchObject({ decision: 'deny', reason: 'HARDLINK_ALIAS_DENIED' });
  });

  it('denies embedded filesystem and subprocess authority', async () => {
    const fsEscape = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/candidate.ts',
      content: "import { writeFile } from 'node:fs/promises';",
    });
    const processEscape = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'applyEdit',
      path: 'src/candidate.ts',
      content: "import { spawn } from 'node:child_process';",
    });
    const dynamicEscape = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/candidate.ts',
      content: "const fs = await import('node:fs/promises');",
    });
    const bindingEscape = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/candidate.ts',
      content: "process.binding('spawn_sync');",
    });
    expect(fsEscape).toMatchObject({
      decision: 'deny',
      reason: 'EMBEDDED_AUTHORITY_ESCAPE_DENIED',
    });
    expect(processEscape.decision).toBe('deny');
    expect(dynamicEscape.decision).toBe('deny');
    expect(bindingEscape.decision).toBe('deny');
  });

  it('returns a static reason when path resolution fails', async () => {
    const receipt = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: 'src/missing/child.ts',
      content: 'changed',
    });
    expect(receipt).toMatchObject({
      decision: 'deny',
      reason: 'PATH_RESOLUTION_DENIED',
    });
    expect(receipt.reason).not.toContain(root);
  });

  it('maps gitStatus on the project root to a pathless repo-metadata request', () => {
    expect(requestFromToolCall('gitStatus', { path: '.' })).toEqual({ kind: 'tool', name: 'gitStatus' });
    expect(requestFromToolCall('gitStatus', {})).toEqual({ kind: 'tool', name: 'gitStatus' });
    expect(requestFromToolCall('gitStatus', { path: '../other' })).toEqual({ kind: 'tool', name: 'gitStatus', path: '../other' });
    expect(requestFromToolCall('listDir', { path: '.' })).toEqual({ kind: 'tool', name: 'listDir', path: '.' });
  });

  it('denies pathless repository search before the real tool can default to root', async () => {
    const request = requestFromToolCall('search', { pattern: 'secret' });
    expect(request).toMatchObject({ kind: 'tool', name: 'search', path: '.' });
    await expect(authorizeExperimentRequest(policy, request)).resolves.toMatchObject({
      decision: 'deny',
      reason: 'PATH_OUTSIDE_PROJECT',
    });
  });

  it.each(['.gitignore', '.githooks/pre-commit'])(
    'denies declared Git metadata candidate %s',
    async (requestedPath) => {
      await expect(authorizeExperimentRequest(policy, {
        kind: 'tool',
        name: 'writeFile',
        path: requestedPath,
        content: 'changed',
      })).resolves.toMatchObject({
        decision: 'deny',
        resolved: { pathClass: 'secret-config-git' },
      });
    },
  );

  it('redacts private absolute paths in deny receipts', async () => {
    const receipt = await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'writeFile',
      path: path.join(root, 'secret.ts'),
      content: 'changed',
    });
    expect(receipt.requested.path).toBe('[private-path-redacted]');
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it('rejects candidate diffs containing evidence, config, git, cache, or evaluator paths', async () => {
    const result = await authorizeCandidateDiff(policy, [
      'src/candidate.ts',
      'docs/agents/waves/receipts/proof.json',
      'package.json',
      'src/config/runtime.ts',
      'vitest.config.ts',
      '.git/config',
      'node_modules/cache.js',
      'src/sealed-evaluator.ts',
    ]);

    expect(result.allowed).toBe(false);
    expect(result.receipts[0]).toMatchObject({ decision: 'allow' });
    expect(result.receipts.slice(1).every((receipt) => receipt.decision === 'deny')).toBe(true);
  });

  it('fails closed on an unknown authority schema', async () => {
    await expect(authorizeExperimentRequest(
      { ...policy, schemaVersion: 2 as 1 },
      { kind: 'tool', name: 'readFile', path: 'src/read-only.ts' },
    )).rejects.toThrow('UNKNOWN_EXPERIMENT_AUTHORITY_SCHEMA');
  });

  it('maps real harness tool calls to the correct authority capability', () => {
    expect(requestFromToolCall('executeSkill', { name: 'comorbidity-check' })).toEqual({
      kind: 'skill',
      name: 'comorbidity-check',
    });
    expect(requestFromToolCall('npm', { command: 'test' })).toEqual({
      kind: 'package-script',
      name: 'test',
    });
    expect(requestFromToolCall('writeFile', {
      path: 'src/candidate.ts',
      content: 'next',
    })).toEqual({
      kind: 'tool',
      name: 'writeFile',
      path: 'src/candidate.ts',
      content: 'next',
    });
    expect(requestFromToolCall('applyEdit', {
      path: 'src/candidate.ts',
      newText: "import('node:fs')",
    })).toEqual({
      kind: 'tool',
      name: 'applyEdit',
      path: 'src/candidate.ts',
      content: "import('node:fs')",
    });
  });
});
