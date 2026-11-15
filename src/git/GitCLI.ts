/**
 * GitCLI — CLI handler for `sinter git <subcommand>`
 *
 * Routes subcommands to GitService:
 *   sinter git status              — Working tree status
 *   sinter git log [N]             — Last N commits
 *   sinter git diff [from] [to]    — Diff between refs
 *   sinter git branch [name]       — List or create branches
 *   sinter git commit <message>    — Manual commit
 *   sinter git init                — Initialize repo
 *   sinter git timeline [project]  — Unified git+compost timeline
 */

import { GitService } from './GitService.js';
import { Logger } from '../utils/Logger.js';

const HELP_TEXT = `
Git integration for Sinter

USAGE:
  sinter git <subcommand> [options]

SUBCOMMANDS:
  status                  Show working tree status
  log [N]                 Show last N commits (default: 10)
  diff [from] [to]        Diff between refs (defaults to HEAD vs working)
  branch [name]           List branches, or create a new one
  commit <message>        Stage all and commit
  init                    Initialize a git repo in the gallery directory
  timeline [project]      Unified git + compost timeline

EXAMPLES:
  sinter git status
  sinter git log 5
  sinter git diff HEAD~3 HEAD
  sinter git branch liminal/experiment-1
  sinter git commit "save iteration 3"
  sinter git init
`.trim();

function print(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

export async function handleGitCommand(subcmd: string | undefined, args: string[]): Promise<void> {
  const git = new GitService();

  if (!subcmd || subcmd === 'help' || subcmd === '--help') {
    print(HELP_TEXT);
    return;
  }

  // Ensure we're in a git repo for most commands
  if (subcmd !== 'init') {
    const isRepo = await git.isRepo();
    if (!isRepo) {
      Logger.error('GitCLI', 'Not a git repository. Run `sinter git init` first.');
      process.exit(1);
    }
  }

  switch (subcmd) {
    case 'init':
      await handleInit(git);
      break;
    case 'status':
      await handleStatus(git);
      break;
    case 'log':
      await handleLog(git, args);
      break;
    case 'diff':
      await handleDiff(git, args);
      break;
    case 'branch':
      await handleBranch(git, args);
      break;
    case 'commit':
      await handleCommit(git, args);
      break;
    case 'timeline':
      await handleTimeline(git, args);
      break;
    default:
      Logger.error('GitCLI', `Unknown git subcommand: ${subcmd}`);
      print(HELP_TEXT);
      process.exit(1);
  }
}

async function handleInit(git: GitService): Promise<void> {
  await git.init();
  print('Initialized git repository');
}

async function handleStatus(git: GitService): Promise<void> {
  const result = await git.status();
  if (result.isErr()) {
    Logger.error('GitCLI', 'Failed to get git status:', result.error.message);
    return;
  }
  const status = result.value;

  if (!status) {
    print('Unable to get status - repository may have merge conflicts');
    return;
  }

  const branch = status.current;
  print(`On branch ${branch}`);

  if (status.isClean()) {
    print('Working tree clean');
    return;
  }

  if (status.staged.length > 0) {
    print('\nStaged:');
    for (const f of status.staged) {
      print(`  + ${f}`);
    }
  }
  if (status.modified.length > 0) {
    print('\nModified:');
    for (const f of status.modified) {
      print(`  M ${f}`);
    }
  }
  if (status.not_added.length > 0) {
    print('\nUntracked:');
    for (const f of status.not_added) {
      print(`  ? ${f}`);
    }
  }
  if (status.deleted.length > 0) {
    print('\nDeleted:');
    for (const f of status.deleted) {
      print(`  D ${f}`);
    }
  }
}

async function handleLog(git: GitService, args: string[]): Promise<void> {
  const count = parseInt(args[0] ?? '10', 10);
  const commits = await git.log({ maxCount: count });

  if (commits.length === 0) {
    print('No commits yet');
    return;
  }

  for (const c of commits) {
    const short = c.hash.slice(0, 7);
    print(`${short} ${c.date.slice(0, 10)} ${c.message}`);
  }
}

async function handleDiff(git: GitService, args: string[]): Promise<void> {
  const from = args[0] ?? undefined;
  const to = args[1] ?? undefined;
  const diff = await git.diff(from, to);

  if (diff.filesChanged === 0) {
    print('No differences');
    return;
  }

  print(`${diff.from}..${diff.to}: ${diff.filesChanged} files, +${diff.insertions}/-${diff.deletions}`);
  print('');
  for (const f of diff.files) {
    const indicator = f.binary ? '(binary)' : `+${f.insertions}/-${f.deletions}`;
    print(`  ${f.path} ${indicator}`);
  }
}

async function handleBranch(git: GitService, args: string[]): Promise<void> {
  if (args.length === 0) {
    // List branches
    const branches = await git.listBranches();
    for (const b of branches) {
      const marker = b.current ? '* ' : '  ';
      print(`${marker}${b.name}`);
    }
  } else {
    // Create branch
    const name = args[0];
    const info = await git.branch(name);
    print(`Created and switched to branch: ${info.name}`);
  }
}

async function handleCommit(git: GitService, args: string[]): Promise<void> {
  const message = args[0];
  if (!message) {
    Logger.error('GitCLI', 'Commit message required: sinter git commit "your message"');
    process.exit(1);
  }

  const commit = await git.addAllAndCommit(message);
  print(`Committed: ${commit.hash.slice(0, 7)} ${commit.message}`);
}

async function handleTimeline(git: GitService, _args: string[]): Promise<void> {
  // Full compost+git timeline is a future feature — for now, show git log
  const commits = await git.log({ maxCount: 20 });

  if (commits.length === 0) {
    print('No history yet');
    return;
  }

  print('Git Timeline:');
  print('');
  for (const c of commits) {
    const short = c.hash.slice(0, 7);
    const date = c.date.slice(0, 19);
    print(`  ${date}  ${short}  ${c.message}`);
  }
  print('');
  print('(Full compost+git timeline integration is a future feature)');
}
