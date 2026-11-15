import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Hermetic: a private "origin" and a public target, both local bare repos.
const SCRIPT = resolve(__dirname, '../../scripts/atelier/sync-public-mirror.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function put(dir: string, rel: string, body: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mirror-test-'));
  const work = join(root, 'work');
  for (const bare of ['origin.git', 'public.git']) git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  // Public target already has one commit (the README the repo was created with).
  const pub = join(root, 'pubseed');
  git(root, 'clone', '-q', join(root, 'public.git'), pub);
  put(pub, 'README.md', 'public readme\n');
  git(pub, 'add', '.'); git(pub, 'commit', '-qm', 'readme'); git(pub, 'push', '-q', 'origin', 'HEAD:main');
  // Private source: two commits, internal docs, a kept file with internal refs.
  git(root, 'clone', '-q', join(root, 'origin.git'), work);
  put(work, 'docs/private.md', 'internal runbook\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'private history');
  put(work, 'README.md', 'sinter\n');
  put(work, 'src/a.ts', "import { b } from '../gui/b.js';\nexport const host = '<fleet-node> at <internal-host>, cdn 100.1.2.3';\n");
  put(work, 'gui/b.ts', 'export const b = 1;\n');
  put(work, 'gui/unused.ts', 'export const u = 1;\n');
  put(work, 'scripts/quality/watchman-prompt.md', 'agent ops\n');
  put(work, 'scripts/docs/check-site.mjs', 'const re = /<fleet-node>/;\n');
  mkdirSync(join(work, 'scripts/atelier'), { recursive: true });
  copyFileSync(SCRIPT, join(work, 'scripts/atelier/sync-public-mirror.sh'));
  put(work, 'scripts/atelier/public-test-deny.txt', '# tests that read private files\ntest/needs-private.test.ts  # docs/x.md\n');
  put(work, 'test/needs-private.test.ts', 'export {};\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'code'); git(work, 'push', '-q', 'origin', 'HEAD:main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function sync(...args: string[]) {
  return spawnSync('bash', ['scripts/atelier/sync-public-mirror.sh', ...args], {
    cwd: join(root, 'work'), env: { ...ENV, PUBLIC_MIRROR_REMOTE: join(root, 'public.git'), TMPDIR: root }, encoding: 'utf8',
  });
}
const pub = (...args: string[]) => git(join(root, 'public.git'), ...args);

describe('sync-public-mirror.sh', () => {
  it('publishes one curated commit on top of the public main, with no private history', () => {
    const res = sync();
    expect(res.status).toBe(0);
    expect(pub('log', '--format=%s', 'main').split('\n')).toEqual([expect.stringMatching(/^Public snapshot /), 'readme']);
    expect(pub('ls-tree', '-r', '--name-only', 'main').split('\n')).toEqual(['README.md', 'gui/b.ts', 'src/a.ts']);
    expect(pub('show', 'main:src/a.ts')).toContain("'<fleet-node> at <internal-host>, cdn 100.1.2.3'");
  });

  it('--check builds and sweeps without pushing', () => {
    const res = sync('--check');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/CHECK OK: 3 files/);
    expect(pub('rev-list', '--count', 'main')).toBe('1');
  });

  it('reports no change on a second run and leaves no temp worktree behind', () => {
    expect(sync().status).toBe(0);
    const again = sync();
    expect(again.stdout).toContain('NO CHANGE');
    expect(pub('rev-list', '--count', 'main')).toBe('2');
    expect(git(join(root, 'work'), 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('stacks on a public main that moved on instead of erasing its commits', () => {
    expect(sync().status).toBe(0);
    const other = join(root, 'other');
    git(root, 'clone', '-q', join(root, 'public.git'), other);
    put(other, 'NOTE.md', 'public-only edit\n');
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'note'); git(other, 'push', '-q', 'origin', 'HEAD:main');
    const tip = git(other, 'rev-parse', 'HEAD');
    const work = join(root, 'work');
    put(work, 'src/c.ts', 'export const c = 2;\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'c'); git(work, 'push', '-q', 'origin', 'HEAD:main');
    expect(sync().status).toBe(0);
    expect(pub('rev-parse', 'main~1')).toBe(tip);
    expect(pub('rev-list', '--count', 'main')).toBe('4');
  });

  it('never force-pushes the public branch', () => {
    const pushes = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => /^\s*git push/.test(l));
    expect(pushes).toEqual(['git push "$REMOTE" "$COMMIT:refs/heads/main"']);
  });

  it('aborts when a kept file still carries an internal reference after redaction', () => {
    const work = join(root, 'work');
    put(work, 'src/leak.ts', "export const t = 'ghp_" + 'a'.repeat(36) + "';\n");
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'leak'); git(work, 'push', '-q', 'origin', 'HEAD:main');
    const res = sync();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('SYNC-ABORT: internal references found');
    expect(pub('rev-list', '--count', 'main')).toBe('1');
  });

  it('publishes vendored third-party bytes unredacted and unswept', () => {
    const work = join(root, 'work');
    const blob = "const wasm = 'AKIA" + 'Q'.repeat(16) + "'; // <fleet-node>\n";
    put(work, 'vendor/lib/1.0.0/lib.min.js', blob);
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'vendor'); git(work, 'push', '-q', 'origin', 'HEAD:main');
    const res = sync();
    expect(res.status).toBe(0);
    expect(pub('show', 'main:vendor/lib/1.0.0/lib.min.js') + '\n').toBe(blob);
  });

  it('allowlists every path the npm package ships, so a clone can install and run', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const list = (name: string) => (script.match(new RegExp(`^${name}="([^"]*)"`, 'm'))?.[1] ?? '').split(/\s+/);
    const allowed = [...list('ALLOW_TOP'), ...list('ALLOW_DIR')];
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { files: string[] };
    // dist/ is build output and negations only narrow it.
    const shipped = pkg.files.filter((f) => !f.startsWith('!') && f !== 'dist');
    const missing = shipped.filter((f) => !allowed.includes(f) && !allowed.includes(`${f}/`));
    expect(missing).toEqual([]);
  });

  it('keeps the public test deny list to real tracked tests', () => {
    const repo = resolve(__dirname, '../..');
    const entries = readFileSync(join(repo, 'scripts/atelier/public-test-deny.txt'), 'utf8')
      .split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    expect(entries.length).toBe(new Set(entries).size);
    const tracked = new Set(git(repo, 'ls-files', '--', 'test').split('\n'));
    expect(entries.filter((e) => !tracked.has(e))).toEqual([]);
  });

  it('fails when the public target cannot be fetched', () => {
    rmSync(join(root, 'public.git'), { recursive: true, force: true });
    expect(sync('--check').status).not.toBe(0);
  });
});
