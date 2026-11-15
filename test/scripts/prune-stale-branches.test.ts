import { describe, expect, it } from 'vitest';

// @ts-expect-error -- importing a plain .mjs helper module without type declarations
import { classify, isMainSyncedToRemote, isValidRefName, MIN_UTILITY_DELETE_DAYS } from '../../scripts/housekeeping/prune-stale-branches.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe('prune-stale-branches isValidRefName', () => {
  it('rejects a command-injection payload', () => {
    expect(isValidRefName('x;rm -rf ~')).toBe(false);
  });

  it('rejects a refname containing whitespace', () => {
    expect(isValidRefName('a b')).toBe(false);
  });

  it('rejects a refname that could be parsed as a git option', () => {
    expect(isValidRefName('-D')).toBe(false);
  });

  it.each([
    ['$(touch pwned)'],
    ['a`whoami`'],
    ['a|b'],
    ['a&b'],
    ['a>b'],
    ['a<b'],
    ['a*b'],
    ['..'],
  ])('rejects refname with shell metacharacter: %s', (ref) => {
    expect(isValidRefName(ref)).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(isValidRefName('')).toBe(false);
    expect(isValidRefName(undefined)).toBe(false);
    expect(isValidRefName(null)).toBe(false);
  });

  it('accepts a normal work branch', () => {
    expect(isValidRefName('work/foo')).toBe(true);
  });

  it('accepts a remote renovate branch', () => {
    expect(isValidRefName('origin/renovate/bar')).toBe(true);
  });

  it('accepts a dotted, hyphenated branch name', () => {
    expect(isValidRefName('fix/prune-script-injection-2026-06-24')).toBe(true);
  });
});

describe('prune-stale-branches classify', () => {
  it('keeps protected branches regardless of merge state', () => {
    expect(classify('main', isoDaysAgo(999), 'whatever', true)).toEqual({ action: 'keep', reason: 'protected' });
    expect(classify('origin/main', isoDaysAgo(0), 'whatever', true)).toEqual({ action: 'keep', reason: 'protected' });
  });

  it('routes a freshly merged utility branch to review, not safe-delete', () => {
    const result = classify('work/feature', isoDaysAgo(1), 'wip', true);
    expect(result.action).toBe('review');
    expect(result.reason).toContain('only 1d old');
  });

  it('marks an aged merged utility branch as safe-delete', () => {
    const result = classify('work/feature', isoDaysAgo(MIN_UTILITY_DELETE_DAYS + 1), 'wip', true);
    expect(result).toEqual({ action: 'safe-delete', reason: 'merged local utility branch' });
  });

  it('marks a remote renovate utility branch (aged) as safe-delete with remote wording', () => {
    const result = classify('origin/renovate/dep', isoDaysAgo(MIN_UTILITY_DELETE_DAYS + 5), 'bump', true);
    expect(result).toEqual({ action: 'safe-delete', reason: 'merged remote utility branch' });
  });

  it('marks an old merged non-utility branch as safe-delete by age', () => {
    const result = classify('feature/old', isoDaysAgo(45), 'done', true);
    expect(result.action).toBe('safe-delete');
    expect(result.reason).toBe('merged into main, 45d old');
  });

  it('routes a freshly merged non-utility branch to review', () => {
    const result = classify('feature/new', isoDaysAgo(2), 'done', true);
    expect(result).toEqual({ action: 'review', reason: 'merged but only 2d old' });
  });

  it('routes an unmerged stale branch to review', () => {
    const result = classify('feature/abandoned', isoDaysAgo(30), 'half-done work that is long', false);
    expect(result.action).toBe('review');
    expect(result.reason).toContain('unmerged, 30d old');
  });

  it('keeps an unmerged active branch', () => {
    const result = classify('feature/active', isoDaysAgo(3), 'in progress', false);
    expect(result).toEqual({ action: 'keep', reason: 'active (3d old)' });
  });
});

describe('prune-stale-branches isMainSyncedToRemote', () => {
  it('rejects a remote name that fails ref validation without touching git', () => {
    expect(isMainSyncedToRemote('origin;rm -rf ~')).toBe(false);
    expect(isMainSyncedToRemote('-origin')).toBe(false);
    expect(isMainSyncedToRemote('')).toBe(false);
  });
});
