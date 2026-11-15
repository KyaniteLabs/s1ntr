#!/usr/bin/env node
/**
 * Branch-pruning helper.
 *
 * Lists branches that are safe to delete (already merged into main and/or
 * older than a threshold) and never deletes protected branches.
 *
 * Usage:
 *   node scripts/housekeeping/prune-stale-branches.mjs --dry-run
 *   node scripts/housekeeping/prune-stale-branches.mjs --delete-local
 *   node scripts/housekeeping/prune-stale-branches.mjs --delete-remote=origin
 *
 * Security note: git refnames legally permit shell metacharacters, so every
 * git invocation uses argv-form execFileSync (no shell) and refs are never
 * interpolated into a command string. Deletes additionally pass refs through
 * isValidRefName() and use a `--` separator to defend against option parsing.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROTECTED = new Set(['main', 'master', 'origin/main', 'upstream-github/main']);
const STALE_DAYS = 14;
const SAFE_DELETE_AFTER_DAYS = 30;
// Merged utility branches younger than this are routed to review, not auto-deleted,
// to avoid pruning a branch that was merged moments ago.
const MIN_UTILITY_DELETE_DAYS = 7;

/**
 * Run git with an argv array (no shell). Refs are passed as discrete args, so
 * shell metacharacters in a refname can never be interpreted.
 */
function git(args, { fatal = true } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (fatal) {
      throw new Error(`Command failed: git ${args.join(' ')}\n${err.stderr ?? err.message}`);
    }
    return '';
  }
}

/**
 * Reject refnames that could be misread as shell metacharacters or as a git
 * option. Refs containing whitespace or any of ; | & $ ` < > ( ) { } [ ] ! * ? \ " ' #,
 * or that start with '-', are rejected. Used as defense-in-depth before any delete.
 */
function isValidRefName(ref) {
  if (typeof ref !== 'string' || ref.length === 0) return false;
  if (ref.startsWith('-')) return false;
  // Allow letters, digits, and the safe ref punctuation: / . _ -
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref);
}

function branchLines() {
  return git(['branch', '-a', '--format=%(refname:short)|%(committerdate:iso8601)|%(subject)'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isMerged(ref) {
  // merge-base does not support a `--` separator, so validate the ref first.
  if (!isValidRefName(ref)) return false;
  try {
    git(['merge-base', '--is-ancestor', ref, 'main']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when local `main` is an ancestor of `<remote>/main`, i.e. local
 * main has been pushed/synced. Guards remote deletes against deleting branches
 * while local main is ahead of the remote (data-loss risk). Returns false if the
 * remote main ref is unknown.
 */
function isMainSyncedToRemote(remote) {
  if (!isValidRefName(remote)) return false;
  const remoteMain = `${remote}/main`;
  if (!isValidRefName(remoteMain)) return false;
  try {
    git(['merge-base', '--is-ancestor', 'main', remoteMain]);
    return true;
  } catch {
    return false;
  }
}

function daysSince(isoDate) {
  const then = new Date(isoDate);
  const now = new Date();
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Pure classification. `merged` is supplied by the caller (computed via isMerged)
 * so this function has no side effects and is unit-testable without git.
 */
function classify(ref, date, subject, merged) {
  if (PROTECTED.has(ref)) return { action: 'keep', reason: 'protected' };

  const ageDays = daysSince(date);
  const isRemote = ref.startsWith('origin/') || ref.startsWith('upstream-github/');
  const isWorkBranch = ref.startsWith('work/') || ref.startsWith('origin/work/');
  const isWatchman = ref.includes('/watchman/auto-');
  const isRenovate = ref.includes('/renovate/');

  if (merged && ageDays > SAFE_DELETE_AFTER_DAYS) {
    return { action: 'safe-delete', reason: `merged into main, ${Math.round(ageDays)}d old` };
  }

  if (merged && (isWorkBranch || isWatchman || isRenovate)) {
    if (ageDays < MIN_UTILITY_DELETE_DAYS) {
      return { action: 'review', reason: `merged utility branch, only ${Math.round(ageDays)}d old` };
    }
    return { action: 'safe-delete', reason: `merged ${isRemote ? 'remote' : 'local'} utility branch` };
  }

  if (!merged && ageDays > STALE_DAYS) {
    return { action: 'review', reason: `unmerged, ${Math.round(ageDays)}d old: ${subject.slice(0, 60)}` };
  }

  if (merged) {
    return { action: 'review', reason: `merged but only ${Math.round(ageDays)}d old` };
  }

  return { action: 'keep', reason: `active (${Math.round(ageDays)}d old)` };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const deleteLocal = process.argv.includes('--delete-local');
  const deleteRemoteArg = process.argv.find((a) => a.startsWith('--delete-remote='));
  const deleteRemote = deleteRemoteArg ? deleteRemoteArg.split('=')[1] : null;

  if (!dryRun && !deleteLocal && !deleteRemote) {
    console.log('Usage:');
    console.log('  node scripts/housekeeping/prune-stale-branches.mjs --dry-run');
    console.log('  node scripts/housekeeping/prune-stale-branches.mjs --delete-local');
    console.log('  node scripts/housekeeping/prune-stale-branches.mjs --delete-remote=origin');
    process.exit(0);
  }

  // Guard remote deletes: only proceed if local main is synced to the remote,
  // otherwise a freshly-merged remote branch could be deleted while local main
  // is ahead of origin (data-loss risk).
  let remoteDeleteAllowed = false;
  if (deleteRemote) {
    remoteDeleteAllowed = isMainSyncedToRemote(deleteRemote);
    if (!remoteDeleteAllowed) {
      console.log(
        `\nWARNING: local 'main' is not an ancestor of '${deleteRemote}/main' ` +
          '(local main is ahead of or diverged from the remote, or the remote ref is unknown). ' +
          'Skipping all remote deletes to avoid data loss. Push/sync main and re-run.',
      );
    }
  }

  const groups = { 'safe-delete': [], review: [], keep: [] };

  for (const line of branchLines()) {
    const [ref, date, ...subjectParts] = line.split('|');
    const subject = subjectParts.join('|');
    const decision = classify(ref, date, subject, isMerged(ref));
    groups[decision.action].push({ ref, date, subject, reason: decision.reason });
  }

  console.log(`\n=== Safe to delete (${groups['safe-delete'].length}) ===`);
  for (const { ref, reason } of groups['safe-delete']) {
    console.log(`  ${ref.padEnd(60)} ${reason}`);
    const isLocal = !ref.startsWith('origin/') && !ref.startsWith('upstream-github/');
    if (deleteLocal && isLocal) {
      if (!isValidRefName(ref)) {
        console.log(`    SKIPPED unsafe local refname: ${ref}`);
      } else {
        git(['branch', '-D', '--', ref]);
        console.log(`    deleted local branch ${ref}`);
      }
    }
    if (deleteRemote && remoteDeleteAllowed && ref.startsWith(`${deleteRemote}/`)) {
      const short = ref.slice(deleteRemote.length + 1);
      if (!isValidRefName(short)) {
        console.log(`    SKIPPED unsafe remote refname: ${ref}`);
      } else {
        git(['push', deleteRemote, '--delete', '--', short]);
        console.log(`    deleted remote branch ${ref}`);
      }
    }
  }

  console.log(`\n=== Needs review (${groups.review.length}) ===`);
  for (const { ref, reason } of groups.review) {
    console.log(`  ${ref.padEnd(60)} ${reason}`);
  }

  console.log(`\n=== Kept (${groups.keep.length}) ===`);
  for (const { ref, reason } of groups.keep) {
    console.log(`  ${ref.padEnd(60)} ${reason}`);
  }

  if (dryRun) {
    console.log('\n(dry run: no branches were deleted)');
  }
}

export { classify, isValidRefName, isMainSyncedToRemote, MIN_UTILITY_DELETE_DAYS };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
