import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hook = resolve('.githooks/post-checkout');
const fakeGit = `#!/usr/bin/env node
const fs = require('node:fs');
const f = JSON.parse(fs.readFileSync(process.env.CHECKOUT_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'symbolic-ref') {
  if (f.branch === null) process.exitCode = 1;
  else process.stdout.write(f.branch + '\\n');
} else if (args[0] === 'worktree') {
  const separator = args.includes('-z') ? '\\0' : '\\n';
  const fields = f.worktrees.flatMap(w => [
    'worktree ' + w.path, 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/' + w.branch, '',
  ]);
  process.stdout.write(fields.join(separator) + separator);
} else if (args[0] === 'rev-parse') {
  if (args.includes('--show-toplevel')) process.stdout.write(f.current + '\\n');
  else process.exitCode = f.mainExists ? 0 : 1;
} else if (args[0] === 'branch') {
  const formatted = args.some(a => a.startsWith('--format='));
  process.stdout.write(f.merged.map(b => (formatted ? '' : '  ') + b).join('\\n'));
} else process.exitCode = 2;
`;

interface Fixture {
  branch: string | null;
  current: string;
  worktrees: Array<{ path: string; branch: string }>;
  merged: string[];
  mainExists: boolean;
}

describe('post-checkout warnings', () => {
  let directory: string;
  let current: string;
  let bin: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'checkout-hook-'));
    current = join(directory, 'current checkout');
    bin = join(directory, 'bin');
    mkdirSync(current); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), fakeGit, { mode: 0o755 });
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function invoke(overrides: Partial<Fixture> = {}, type = '1', cwd = current): string {
    const fixture: Fixture = { branch: 'feature/qa.fix', current,
      worktrees: [{ path: current, branch: 'feature/qa.fix' }],
      merged: [], mainExists: true, ...overrides };
    const fixturePath = join(directory, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify(fixture));
    return execFileSync('bash', [hook, 'previous', 'next', type], {
      cwd, encoding: 'utf8', env: { ...process.env,
        PATH: bin + ':' + process.env.PATH, CHECKOUT_FIXTURE: fixturePath },
    });
  }

  it('does not warn about its own checkout', () => {
    expect(invoke()).toBe('');
  });

  it('reports the other worktree path instead of a HEAD hash', () => {
    const other = join(directory, 'other checkout');
    const output = invoke({ worktrees: [
      { path: current, branch: 'feature/qa.fix' },
      { path: other, branch: 'feature/qa.fix' },
    ] });
    expect(output).toContain('already checked out in:');
    expect(output).toContain('other\\ checkout');
    expect(output).toContain('cd -- ');
    expect(output).not.toContain('a'.repeat(40));
  });

  it('does not treat a branch prefix as the same branch', () => {
    expect(invoke({ worktrees: [
      { path: join(directory, 'other'), branch: 'feature/qa.fix-extra' },
      { path: current, branch: 'feature/qa.fix' },
    ] })).toBe('');
  });

  it('uses the repository root when called from a subdirectory', () => {
    const nested = join(current, 'nested'); mkdirSync(nested);
    expect(invoke({}, '1', nested)).toBe('');
  });

  it('preserves a trailing newline in the current worktree path', () => {
    const odd = join(directory, 'current\n'); mkdirSync(odd);
    expect(invoke({ current: odd,
      worktrees: [{ path: odd, branch: 'feature/qa.fix' }],
    }, '1', odd)).toBe('');
  });

  it('does not interpret branch punctuation as a merge regex', () => {
    expect(invoke({ merged: ['feature/qaxfix'] })).not.toContain('MERGED into');
  });

  it('warns when the exact branch is ancestry-merged', () => {
    const output = invoke({ merged: ['feature/qa.fix'] });
    expect(output).toContain('MERGED into main');
    expect(output).not.toContain('git pull');
  });

  it('uses master when main is absent', () => {
    expect(invoke({ mainExists: false, merged: ['feature/qa.fix'] }))
      .toContain('MERGED into master');
  });

  it('skips file checkouts and detached HEAD', () => {
    expect(invoke({}, '0')).toBe('');
    expect(invoke({ branch: null })).toBe('');
  });

  it('prints newline-containing worktree paths as safe shell literals', () => {
    const output = invoke({ worktrees: [
      { path: current, branch: 'feature/qa.fix' },
      { path: join(directory, 'other\ncheckout'), branch: 'feature/qa.fix' },
    ] });
    expect(output).toContain('other\\ncheckout');
    expect(output).not.toContain('other\ncheckout');
  });
});
