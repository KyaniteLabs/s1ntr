/**
 * TaskVerifier command guard tests — validates assertAllowedCommand()
 * blocks shell metacharacters and disallowed command prefixes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SinterFS } from '../../../src/fs/SinterFS.js';
import { TaskLedger } from '../../../src/ledger/TaskLedger.js';
import type { TaskManifest, TaskAttempt } from '../../../src/ledger/types.js';

const { mockScore, mockExecFileSync } = vi.hoisted(() => ({
  mockScore: vi.fn().mockResolvedValue({ score: 0.85, issues: [], dimensions: {} }),
  mockExecFileSync: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../src/core/ScoringEngine.js', () => ({
  ScoringEngine: class {
    score = mockScore;
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

import { TaskVerifier, parseVerifyCommand } from '../../../src/ledger/TaskVerifier.js';

describe('TaskVerifier command guard', () => {
  let tempDir: string;
  let liminalFs: SinterFS;
  let ledger: TaskLedger;
  let verifier: TaskVerifier;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sinter-guard-test-'));
    liminalFs = SinterFS.open(tempDir);
    ledger = new TaskLedger(liminalFs);
    verifier = new TaskVerifier(ledger);
    mockScore.mockResolvedValue({ score: 0.85, issues: [], dimensions: {} });
    mockExecFileSync.mockReturnValue('');
    mockExecFileSync.mockClear();
    mockScore.mockClear();
  });

  afterEach(() => {
    liminalFs.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTask(verifyCommand: string): TaskManifest {
    return {
      id: 'G001',
      title: 'Guard test',
      description: 'Test command validation',
      taskClass: 'leaf',
      status: 'pending',
      files: { allowlist: ['src/**'], denylist: [] },
      verifyCommand,
      scoringCriteria: ['technical'],
      lane: 1,
      attemptCount: 0,
      maxAttempts: 1,
      createdAt: '2026-04-15T00:00:00Z',
      updatedAt: '2026-04-15T00:00:00Z',
    };
  }

  function makeAttempt(): TaskAttempt {
    return {
      id: 'att-guard-001',
      taskId: 'G001',
      prompt: 'test',
      runId: '2026-04-15T00:00:00Z',
      startedAt: '2026-04-15T00:00:00Z',
      completedAt: '2026-04-15T00:00:00Z',
      duration: 100,
      iterations: 1,
      completed: true,
      reason: 'done',
      finalScore: 0.85,
      artifactRef: null,
    };
  }

  describe('allowed commands pass', () => {
    it.each([
      'pnpm test',
      'pnpm build',
      'pnpm vitest run foo.test.ts',
      'npx vitest',
      'pnpm vitest run test/unit/ledger/ --no-coverage',
      'pnpm vitest run test/unit/fs/TraceFSAdapter.test.ts --coverage=false',
    ])('allows "%s"', async (cmd) => {
      const candidate = await verifier.verify(makeTask(cmd), makeAttempt(), 'code');
      expect(candidate.testPassed).toBe(true);
    });
  });

  describe('shell metacharacters are blocked', () => {
    it.each([
      ['pnpm test; rm -rf /', ';'],
      ['pnpm test && echo pwned', '&'],
      ['pnpm test `code`', '`'],
      ['pnpm test | tee log', '|'],
      ['pnpm test > output.txt', '>'],
      ['pnpm test$HOME', '$'],
    ])('blocks "%s" (metachar: %s)', async (cmd, _metachar) => {
      await expect(
        verifier.verify(makeTask(cmd), makeAttempt(), 'code'),
      ).rejects.toThrow('contains shell metacharacters');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('disallowed command prefixes are blocked', () => {
    it.each([
      'npm test',
      'bash script.sh',
      'sh -c pnpm test',
      'python3 exploit.py',
    ])('blocks "%s"', async (cmd) => {
      await expect(
        verifier.verify(makeTask(cmd), makeAttempt(), 'code'),
      ).rejects.toThrow('does not match allowed prefixes');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  it('metachar check fires before prefix check', async () => {
    await expect(
      verifier.verify(makeTask('npm test; rm -rf /'), makeAttempt(), 'code'),
    ).rejects.toThrow('contains shell metacharacters');
  });

  it('blocks empty command', async () => {
    await expect(
      verifier.verify(makeTask(''), makeAttempt(), 'code'),
    ).rejects.toThrow('does not match allowed prefixes');
  });

  it('blocks newline injection', async () => {
    const cmd = 'pnpm test\nrm -rf /';
    await expect(
      verifier.verify(makeTask(cmd), makeAttempt(), 'code'),
    ).rejects.toThrow('contains shell metacharacters');
  });

  describe('token-exact parsing closes prefix and argument bypasses (#1328)', () => {
    it.each([
      ['npx vitest-evil', 'does not match allowed prefixes'],
      ['pnpm testx', 'does not match allowed prefixes'],
      ['pnpm buildscript', 'does not match allowed prefixes'],
      ['npx vitest --config ./evil.config.ts', 'disallowed flag "--config"'],
      ['pnpm vitest run --globalSetup=./pwn.ts', 'disallowed flag "--globalSetup=./pwn.ts"'],
      ['pnpm vitest run --reporter=./steal.js', 'disallowed flag "--reporter=./steal.js"'],
      ['pnpm test -- --anything', 'disallowed flag "--"'],
      ['pnpm vitest run /etc/passwd', 'unsafe argument "/etc/passwd"'],
      ['pnpm vitest run ../outside/x.test.ts', 'unsafe argument "../outside/x.test.ts"'],
      ['pnpm vitest run "a b"', 'contains quotes'],
    ])('blocks "%s"', async (cmd, why) => {
      await expect(verifier.verify(makeTask(cmd), makeAttempt(), 'code')).rejects.toThrow(why);
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockScore).not.toHaveBeenCalled();
    });

    it('collapses repeated spaces and tabs instead of passing empty or merged args', () => {
      expect(parseVerifyCommand('  pnpm   vitest\trun  test/unit/a.test.ts ')).toEqual([
        'pnpm', 'vitest', 'run', 'test/unit/a.test.ts',
      ]);
    });

    it('executes exactly the parsed argv', async () => {
      await verifier.verify(makeTask('pnpm vitest run test/unit/a.test.ts --no-coverage'), makeAttempt(), 'code');
      expect(mockExecFileSync.mock.calls[0][0]).toBe('pnpm');
      expect(mockExecFileSync.mock.calls[0][1]).toEqual(['vitest', 'run', 'test/unit/a.test.ts', '--no-coverage']);
    });
  });
});
