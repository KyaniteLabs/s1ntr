import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// An npm user gets only package.json "files": bin, dist, vendor and
// scripts/packaging. Commands must say so plainly instead of crashing.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pkg: string;
let cwd: string;

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'sinter-installed-'));
  pkg = path.join(root, 'pkg');
  cwd = path.join(root, 'work');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  mkdirSync(cwd);
  copyFileSync(path.join(repoRoot, 'bin/sinter'), path.join(pkg, 'bin/sinter'));
  copyFileSync(path.join(repoRoot, 'bin/wait-for-dist.mjs'), path.join(pkg, 'bin/wait-for-dist.mjs'));
  copyFileSync(path.join(repoRoot, 'package.json'), path.join(pkg, 'package.json'));
  symlinkSync(path.join(repoRoot, 'dist'), path.join(pkg, 'dist'));
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(pkg, 'node_modules'));
  writeFileSync(path.join(cwd, 'note.txt'), 'not an image\n');
});
afterAll(() => { rmSync(path.dirname(pkg), { recursive: true, force: true }); });

const sinter = (...args: string[]) => {
  const r = spawnSync(process.execPath, [path.join(pkg, 'bin/sinter'), ...args], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status, err: `${r.stdout}${r.stderr}` };
};

describe('installed package', () => {
  it.each(['mece', 'rotation'])('`sinter %s` explains it needs a source checkout', (cmd) => {
    const { status, err } = sinter(cmd);
    expect(status, err).toBe(2);
    expect(err).toContain('source checkout');
    expect(err).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  });

  it('`sinter image validate` reports the real problem with a non-image file', () => {
    const { status, err } = sinter('image', 'validate', './note.txt');
    expect(status, err).toBe(1);
    expect(err).not.toContain('requires pnpm build');
  });
});
