/**
 * Tests for GitCLI — handleGitCommand and all sub-handlers.
 *
 * Mocks GitService at the boundary and captures Logger/process.exit calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const { mockInit, mockIsRepo, mockStatus, mockLog, mockDiff, mockListBranches, mockBranch, mockAddAllAndCommit } = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockIsRepo: vi.fn().mockResolvedValue(true),
  mockStatus: vi.fn(),
  mockLog: vi.fn().mockResolvedValue([]),
  mockDiff: vi.fn(),
  mockListBranches: vi.fn().mockResolvedValue([]),
  mockBranch: vi.fn(),
  mockAddAllAndCommit: vi.fn(),
}));

vi.mock('../../../src/git/GitService.js', () => ({
  GitService: vi.fn().mockImplementation(function () {
    return {
      init: (...args: unknown[]) => mockInit(...args),
      isRepo: (...args: unknown[]) => mockIsRepo(...args),
      status: (...args: unknown[]) => mockStatus(...args),
      log: (...args: unknown[]) => mockLog(...args),
      diff: (...args: unknown[]) => mockDiff(...args),
      listBranches: (...args: unknown[]) => mockListBranches(...args),
      branch: (...args: unknown[]) => mockBranch(...args),
      addAllAndCommit: (...args: unknown[]) => mockAddAllAndCommit(...args),
    };
  }),
}));

const { mockInfo, mockError } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockError: vi.fn(),
}));
vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: {
    info: (...args: unknown[]) => mockInfo(...args),
    error: (...args: unknown[]) => mockError(...args),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockExit = vi.fn().mockImplementation(() => { throw new Error('process.exit'); });
const originalExit = process.exit;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

import { handleGitCommand } from '../../../src/git/GitCLI.js';

function expectStdoutContaining(text: string): void {
  const found = consoleLogSpy.mock.calls.some((call) => String(call[0]).includes(text));
  expect(found).toBe(true);
}

describe('GitCLI — handleGitCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRepo.mockResolvedValue(true);
    mockInit.mockResolvedValue(undefined);
    mockLog.mockResolvedValue([]);
    process.exit = mockExit as any;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    process.exit = originalExit;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('prints status to stdout at the default log level', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: { current: 'main', isClean: () => true, staged: [], modified: [], not_added: [], deleted: [] },
    });

    await handleGitCommand('status', []);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('On branch main'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Working tree clean'));
  });

  it('shows help when no subcommand', async () => {
    await handleGitCommand(undefined, []);
    expectStdoutContaining('Git integration');
  });

  it('shows help for --help flag', async () => {
    await handleGitCommand('--help', []);
    expectStdoutContaining('Git integration');
  });

  it('shows help for help subcommand', async () => {
    await handleGitCommand('help', []);
    expectStdoutContaining('Git integration');
  });

  it('exits when not a repo and not init', async () => {
    mockIsRepo.mockResolvedValue(false);
    await expect(handleGitCommand('status', [])).rejects.toThrow('process.exit');
    expect(mockError).toHaveBeenCalledWith('GitCLI', expect.stringContaining('Not a git repository'));
  });

  it('handles init subcommand', async () => {
    // init skips isRepo check
    await handleGitCommand('init', []);
    expect(mockInit).toHaveBeenCalledTimes(1);
    expectStdoutContaining('Initialized git repository');
  });

  it('handles status with clean tree', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: { current: 'main', isClean: () => true, staged: [], modified: [], not_added: [], deleted: [] },
    });

    await handleGitCommand('status', []);
    expectStdoutContaining('On branch main');
    expectStdoutContaining('Working tree clean');
  });

  it('handles status with staged files', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: { current: 'main', isClean: () => false, staged: ['a.ts'], modified: [], not_added: [], deleted: [] },
    });

    await handleGitCommand('status', []);
    expectStdoutContaining('Staged:');
  });

  it('handles status with modified files', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: { current: 'main', isClean: () => false, staged: [], modified: ['b.ts'], not_added: [], deleted: [] },
    });

    await handleGitCommand('status', []);
    expectStdoutContaining('Modified:');
  });

  it('handles status with untracked files', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: { current: 'main', isClean: () => false, staged: [], modified: [], not_added: ['c.ts'], deleted: [] },
    });

    await handleGitCommand('status', []);
    expectStdoutContaining('Untracked:');
  });

  it('handles status with deleted files', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: { current: 'main', isClean: () => false, staged: [], modified: [], not_added: [], deleted: ['d.ts'] },
    });

    await handleGitCommand('status', []);
    expectStdoutContaining('Deleted:');
  });

  it('handles status error from GitService', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => false,
      isErr: () => true,
      error: { message: 'repo corrupted' },
    });

    await handleGitCommand('status', []);
    expect(mockError).toHaveBeenCalledWith('GitCLI', 'Failed to get git status:', 'repo corrupted');
  });

  it('handles status returning null value', async () => {
    mockStatus.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: null,
    });

    await handleGitCommand('status', []);
    expectStdoutContaining('Unable to get status - repository may have merge conflicts');
  });

  it('handles log with default count', async () => {
    mockLog.mockResolvedValue([
      { hash: 'abc1234567890', date: '2026-04-28T12:00:00', message: 'test commit' },
    ]);

    await handleGitCommand('log', []);
    expect(mockLog).toHaveBeenCalledWith({ maxCount: 10 });
    expectStdoutContaining('abc1234');
  });

  it('handles log with custom count', async () => {
    mockLog.mockResolvedValue([]);
    await handleGitCommand('log', ['5']);
    expect(mockLog).toHaveBeenCalledWith({ maxCount: 5 });
  });

  it('handles log with no commits', async () => {
    mockLog.mockResolvedValue([]);
    await handleGitCommand('log', []);
    expectStdoutContaining('No commits yet');
  });

  it('handles diff with files changed', async () => {
    mockDiff.mockResolvedValue({
      from: 'HEAD~1',
      to: 'HEAD',
      filesChanged: 2,
      insertions: 10,
      deletions: 5,
      files: [
        { path: 'a.ts', binary: false, insertions: 8, deletions: 3 },
        { path: 'b.png', binary: true, insertions: 0, deletions: 0 },
      ],
    });

    await handleGitCommand('diff', ['HEAD~1', 'HEAD']);
    expect(mockDiff).toHaveBeenCalledWith('HEAD~1', 'HEAD');
    expectStdoutContaining('2 files');
  });

  it('handles diff with no changes', async () => {
    mockDiff.mockResolvedValue({
      from: 'HEAD',
      to: 'HEAD',
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    });

    await handleGitCommand('diff', []);
    expectStdoutContaining('No differences');
  });

  it('handles branch listing', async () => {
    mockListBranches.mockResolvedValue([
      { name: 'main', current: true },
      { name: 'feature', current: false },
    ]);

    await handleGitCommand('branch', []);
    expect(mockListBranches).toHaveBeenCalledTimes(1);
    expectStdoutContaining('* main');
    expectStdoutContaining('  feature');
  });

  it('handles branch creation', async () => {
    mockBranch.mockResolvedValue({ name: 'new-branch' });

    await handleGitCommand('branch', ['new-branch']);
    expect(mockBranch).toHaveBeenCalledWith('new-branch');
    expectStdoutContaining('new-branch');
  });

  it('handles commit with message', async () => {
    mockAddAllAndCommit.mockResolvedValue({ hash: 'deadbeef1234567890', message: 'save work' });

    await handleGitCommand('commit', ['save work']);
    expect(mockAddAllAndCommit).toHaveBeenCalledWith('save work');
    expectStdoutContaining('deadbee');
  });

  it('exits on commit without message', async () => {
    await expect(handleGitCommand('commit', [])).rejects.toThrow('process.exit');
    expect(mockError).toHaveBeenCalledWith('GitCLI', expect.stringContaining('Commit message required'));
  });

  it('handles timeline', async () => {
    mockLog.mockResolvedValue([
      { hash: 'abc1234567890', date: '2026-04-28T12:00:00', message: 'init' },
    ]);

    await handleGitCommand('timeline', []);
    expectStdoutContaining('Git Timeline:');
    expectStdoutContaining('abc1234');
  });

  it('handles timeline with no history', async () => {
    mockLog.mockResolvedValue([]);
    await handleGitCommand('timeline', []);
    expectStdoutContaining('No history yet');
  });

  it('exits on unknown subcommand', async () => {
    await expect(handleGitCommand('unknown', [])).rejects.toThrow('process.exit');
    expect(mockError).toHaveBeenCalledWith('GitCLI', 'Unknown git subcommand: unknown');
  });
});
