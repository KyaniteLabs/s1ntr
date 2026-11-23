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
  const bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  const generations = join(root, 'generations.log');
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nFAKE_PATH_NODE=1 exec "$FAKE_NODE_EXEC" "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sinter'), String.raw`
const { appendFileSync, readFileSync, writeSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'garden') {
  writeSync(1, 'Health: 99%\n');
  process.exit(0);
}
if (args[0] !== 'generate' || process.env.FAKE_PATH_NODE !== '1') process.exit(90);
const log = process.env.FAKE_GENERATIONS;
appendFileSync(log, args.join(' ') + '\n');
const count = readFileSync(log, 'utf8').trimEnd().split('\n').length;
const mode = process.env.FAKE_MODE;
if (mode === 'missing-teaching' && args.includes('--teach') && process.env.SINTER_TEACH_STRICT === '1') {
  writeSync(2, 'TEACHING_SNAPSHOT_MISSING:' + args[args.indexOf('--teach') + 1] + '\n');
  process.exit(1);
}
if (mode === 'all-failed') {
  writeSync(2, 'EXECUTOR_AUTHORITY_UNAVAILABLE\n');
  process.exit(1);
}
if (mode === 'partial-failed' && count === 2) {
  writeSync(2, 'generation failed\n');
  process.exit(1);
}
writeSync(1, mode === 'no-score' ? 'generation completed without a score\n' : '⭐ Quality score: 0.80\n');
`);
  const ledger = join(root, 'ledger.jsonl');
  const result = spawnSync(process.execPath, [CYCLE_PATH, String(count)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: bin + ':' + process.env.PATH,
      FAKE_NODE_EXEC: process.execPath,
      SINTER_DREAM_QUEUE_PATH: join(root, 'queue.json'),
      SINTER_PROGRESS_LEDGER_PATH: ledger,
      SINTER_GEN_TIMEOUT_MS: '60000',
      SINTER_TEACH_STRICT: '0',
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
  it('fails scoped generations without an active teaching snapshot', () => {
    const { result, record } = runCycle('missing-teaching', 10);
    expect(result.status).toBe(1);
    expect(record).toMatchObject({ requested: 10, completed: 3, failRate: 0.7,
      failureClasses: { teaching_snapshot_missing: 7 } });
    expect(record.failures.map(({ domain }: { domain: string }) => domain).sort())
      .toEqual(['ascii', 'glsl', 'hydra', 'kinetic', 'p5', 'svg', 'three']);
  });

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
