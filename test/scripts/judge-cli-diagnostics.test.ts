import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('bin/sinter');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'judge-cli-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: dir, SINTER_CONFIG_PATH: join(dir, 'missing.json'), PATH: dir + ':' + process.env.PATH } });
}

it('explains how to configure a missing second-judge seat file', () => {
  const result = run('second-judge');
  expect(result.stderr).toContain('second-judge needs the judge seats');
  expect(result.stderr).toContain('sinter provider help');
  expect(result.status).toBe(1);
});

it('reports the scorer failure once when all generated candidates fail the same check', () => {
  writeFileSync(join(dir, 'node'), [
    '#!/bin/sh',
    'if [ "$2" = "sss-score" ]; then',
    '  echo "SSS_SCORE_INSUFFICIENT_JUDGES: found 1 of 2" >&2',
    '  exit 4',
    'fi',
    'echo "Saved: fixture/source.txt"',
  ].join('\n'), { mode: 0o755 });
  const result = run('best-of', '2', 'fixture');
  expect(result.status).toBe(4);
  const summary = result.stderr.split('\n').find(line => line.startsWith('BEST_OF_NO_CANDIDATES'));
  expect(summary).toContain('SSS_SCORE_INSUFFICIENT_JUDGES: found 1 of 2');
  expect(summary?.match(/SSS_SCORE_INSUFFICIENT_JUDGES/g)).toHaveLength(1);
});
