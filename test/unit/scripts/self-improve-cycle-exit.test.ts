import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CYCLE_PATH = join(here, '..', '..', '..', 'scripts', 'quality', 'self-improve-cycle.mjs');
const fixtures: string[] = [];

function runCycle(mode: string, count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'self-improve-cycle-exit-'));
  fixtures.push(root);
  const home = join(root, 'home');
  const shimDir = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(shimDir);
  const generations = join(root, 'generations.log');
  writeFileSync(join(shimDir, 'node'), `#!/bin/sh
if [ "$1" = "bin/sinter" ] && [ "$2" = "garden" ]; then echo 'Health: 99%'; exit 0; fi
if [ "$1" = "bin/sinter" ]; then
  printf '%s\\n' "$*" >> "$FAKE_GENERATIONS"
  count=$(wc -l < "$FAKE_GENERATIONS" | tr -d ' ')
  case "$FAKE_MODE" in
    all-failed) echo 'EXECUTOR_AUTHORITY_UNAVAILABLE' >&2; exit 1 ;;
    partial-failed) if [ "$count" = 2 ]; then echo 'generation failed' >&2; exit 1; fi ;;
    no-score) echo 'generation completed without a score'; exit 0 ;;
  esac
  printf '⭐ Quality score: 8.0\\n'
  exit 0
fi
exit 90
`, { mode: 0o755 });
  const ledger = join(root, 'ledger.jsonl');
  const result = spawnSync(process.execPath, [CYCLE_PATH, String(count)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      SINTER_PROGRESS_LEDGER_PATH: ledger,
      SINTER_GEN_TIMEOUT_MS: '60000',
      FAKE_MODE: mode,
      FAKE_GENERATIONS: generations,
    },
  });
  const record = JSON.parse(readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!);
  return { result, record, generations: readFileSync(generations, 'utf8').trim().split('\n') };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('self-improve-cycle CLI exit status', () => {
  it('returns failure after logging an all-failed cycle', () => {
    const { result, record, generations } = runCycle('all-failed');
    expect(result.status).toBe(1);
    expect(record).toMatchObject({ requested: 2, completed: 0, failRate: 1 });
    expect(record.failures).toHaveLength(2);
    expect(generations).toHaveLength(2);
  });

  it('returns failure after logging a partially failed cycle', () => {
    const { result, record, generations } = runCycle('partial-failed');
    expect(result.status).toBe(1);
    expect(record).toMatchObject({ requested: 2, completed: 1, failRate: 0.5 });
    expect(record.failures).toHaveLength(1);
    expect(generations).toHaveLength(2);
  });

  it('returns success when every generation completes with a score', () => {
    const { result, record, generations } = runCycle('success');
    expect(result.status).toBe(0);
    expect(record).toMatchObject({ requested: 2, completed: 2, failRate: 0 });
    expect(record.failures).toHaveLength(0);
    expect(generations).toHaveLength(2);
  });

  it('returns failure when commands succeed but produce no scored completions', () => {
    const { result, record, generations } = runCycle('no-score');
    expect(result.status).toBe(1);
    expect(record).toMatchObject({ requested: 2, completed: 0, failRate: 0 });
    expect(generations).toHaveLength(2);
  });
});
