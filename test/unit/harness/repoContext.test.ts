import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: cp.execFileSync }));

import {
  defaultJCodeRepo,
  defaultJDocRepo,
  resolveSharedRepoRoot,
} from '../../../src/harness/tools/repoContext.js';

describe('repoContext', () => {
  beforeEach(() => {
    cp.execFileSync.mockReset();
    vi.spyOn(process, 'cwd').mockReturnValue('/work/trees/feature-x');
  });

  it('resolves the shared root as the parent of the git common dir (worktree-safe)', () => {
    cp.execFileSync.mockReturnValue('/work/main-repo/.git\n');
    expect(resolveSharedRepoRoot()).toBe('/work/main-repo');
    expect(cp.execFileSync).toHaveBeenCalledWith('git', ['rev-parse', '--git-common-dir'], expect.objectContaining({ cwd: '/work/trees/feature-x' }));
  });

  it('resolves a relative common dir against cwd', () => {
    cp.execFileSync.mockReturnValue('.git\n');
    expect(resolveSharedRepoRoot()).toBe('/work/trees/feature-x');
  });

  it('falls back to cwd outside a git repository', () => {
    cp.execFileSync.mockImplementation(() => { throw new Error('not a git repository'); });
    expect(resolveSharedRepoRoot()).toBe('/work/trees/feature-x');
  });

  it('builds a doc repo id from the root basename', () => {
    cp.execFileSync.mockReturnValue('/work/main-repo/.git');
    expect(defaultJDocRepo()).toBe('local/main-repo');
  });

  it('builds a code repo id from the basename plus an 8-char sha1 of the root', () => {
    cp.execFileSync.mockReturnValue('/work/main-repo/.git');
    const digest = createHash('sha1').update('/work/main-repo').digest('hex').slice(0, 8);
    expect(defaultJCodeRepo()).toBe(`local/main-repo-${digest}`);
    expect(digest).toHaveLength(8);
  });

  it('gives different code repo ids to same-named repos in different locations', () => {
    cp.execFileSync.mockReturnValueOnce('/a/repo/.git');
    const first = defaultJCodeRepo();
    cp.execFileSync.mockReturnValueOnce('/b/repo/.git');
    const second = defaultJCodeRepo();
    expect(first).not.toBe(second);
    expect(first.startsWith('local/repo-')).toBe(true);
  });
});
