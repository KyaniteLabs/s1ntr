import { describe, expect, it, vi } from 'vitest';

import { GitLogTool, GitDiffTool } from '../../../src/harness/tools/GitReadOnlyTools.js';

type Runner = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>;

function runnerReturning(stdout: string) {
  return vi.fn<Runner>(async () => ({ stdout, stderr: '' }));
}

describe('GitLogTool', () => {
  it('returns parsed commit history for HEAD by default', async () => {
    const runner = runnerReturning('abc1234 2026-07-20 Alice fix thing\ndef5678 2026-07-19 Bob add other\n');
    const tool = new GitLogTool(runner);

    const result = await tool.execute({});

    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(2);
    expect(result.data?.commits).toContain('fix thing');
    const args = runner.mock.calls[0][1];
    expect(args[0]).toBe('log');
    expect(args).toContain('--max-count=10');
    expect(args).toContain('HEAD');
  });

  it('caps maxCount and passes a file pathspec after --', async () => {
    const runner = runnerReturning('abc1234 2026-07-20 Alice fix thing\n');
    const tool = new GitLogTool(runner);

    const result = await tool.execute({ maxCount: 500, file: 'src/foo.ts' });

    expect(result.success).toBe(true);
    const args = runner.mock.calls[0][1];
    expect(args).toContain('--max-count=50');
    const dashDash = args.indexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    expect(args[dashDash + 1]).toBe('src/foo.ts');
  });

  it('rejects refs that could be interpreted as git options', async () => {
    const runner = runnerReturning('');
    const tool = new GitLogTool(runner);

    const result = await tool.execute({ ref: '--output=/tmp/evil' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ref not allowed');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects file pathspecs outside the project', async () => {
    const runner = runnerReturning('');
    const tool = new GitLogTool(runner);

    const result = await tool.execute({ file: '../../etc/passwd' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('File path not allowed');
    expect(runner).not.toHaveBeenCalled();
  });

  it('surfaces git failures', async () => {
    const runner = vi.fn(async () => { throw new Error('fatal: bad revision'); });
    const tool = new GitLogTool(runner);

    const result = await tool.execute({ ref: 'nope' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('bad revision');
  });
});

describe('GitDiffTool', () => {
  it('diffs the working tree when no refs are given', async () => {
    const runner = runnerReturning('diff --git a/src/a.ts b/src/a.ts\n+changed\n');
    const tool = new GitDiffTool(runner);

    const result = await tool.execute({});

    expect(result.success).toBe(true);
    expect(result.data?.range).toBe('(working tree)');
    expect(result.data?.diff).toContain('+changed');
    const args = runner.mock.calls[0][1];
    expect(args).toEqual(['diff']);
  });

  it('builds a validated base..head range', async () => {
    const runner = runnerReturning('diff output\n');
    const tool = new GitDiffTool(runner);

    const result = await tool.execute({ base: 'HEAD~1', head: 'HEAD', stat: true });

    expect(result.success).toBe(true);
    expect(result.data?.range).toBe('HEAD~1..HEAD');
    const args = runner.mock.calls[0][1];
    expect(args).toEqual(['diff', '--stat', 'HEAD~1..HEAD']);
  });

  it('accepts a single range ref expression', async () => {
    const runner = runnerReturning('diff output\n');
    const tool = new GitDiffTool(runner);

    const result = await tool.execute({ ref: 'main..feature' });

    expect(result.success).toBe(true);
    expect(runner.mock.calls[0][1]).toContain('main..feature');
  });

  it('requires both base and head for a range diff', async () => {
    const runner = runnerReturning('');
    const tool = new GitDiffTool(runner);

    const result = await tool.execute({ base: 'HEAD~1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('base and params.head');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects option-injection refs on both sides of a range', async () => {
    const runner = runnerReturning('');
    const tool = new GitDiffTool(runner);

    expect((await tool.execute({ base: '-x', head: 'HEAD' })).success).toBe(false);
    expect((await tool.execute({ ref: '--exec=rm' })).success).toBe(false);
    expect((await tool.execute({ ref: '..--flag' })).success).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('truncates oversized diffs with a marker', async () => {
    const runner = runnerReturning('x'.repeat(30_000));
    const tool = new GitDiffTool(runner);

    const result = await tool.execute({ maxChars: 1000 });

    expect(result.success).toBe(true);
    expect(result.data?.truncated).toBe(true);
    expect(result.data?.diff.length).toBeLessThan(1200);
    expect(result.data?.diff).toContain('[truncated');
  });
});
