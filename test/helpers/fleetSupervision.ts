import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SUITES = ['standing_loop_regressions.py', 'fleet_health_regressions.py', 'wave_validator_regressions.py', 'supervision_lifecycle_regressions.py', 'watchdog_regressions.py', 'system_loop_regressions.py', 'art_wave_envelope_regressions.py'];

interface Case { readonly filename: string; readonly path: string; readonly testCase: string }

function fixturePath(filename: string): string {
  return fileURLToPath(new URL(`../fixtures/${filename}`, import.meta.url));
}

/** Every regression case, in a stable order. system_loop runs one case per child. */
function allCases(): Case[] {
  return SUITES.flatMap((filename) => {
    const path = fixturePath(filename);
    if (filename !== 'system_loop_regressions.py') return [{ filename, path, testCase: '' }];
    const listing = spawnSync('python3', [path, '--list-tests'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (listing.status !== 0) throw new Error(listing.error?.message || listing.stderr);
    const cases: unknown = JSON.parse(listing.stdout);
    if (!Array.isArray(cases) || !cases.length
      || cases.some(name => typeof name !== 'string' || !/^[\w.]+\.test_\w+$/.test(name))) {
      throw new Error('System-loop discovery returned no valid regression cases');
    }
    return (cases as string[]).map(testCase => ({ filename, path, testCase }));
  });
}

// These suites run many real child processes: measured at 40+ seconds
// locally, with a 60-second bound on the standing loop's 50-wave case.
// The 24-case system-loop suite measured 113s locally (slowest case: 26s).
// Per-file spawn budgets. system_loop_regressions.py gets 150s: at 60s its wave-restart case hit
// spawnSync ETIMEDOUT on a loaded 2-slot runner (run 3965, 2026-11-23) while passing in seconds when idle.
function timeoutFor(filename: string): number {
  return filename === 'system_loop_regressions.py' ? 150_000
    : filename === 'standing_loop_regressions.py' ? 90_000
      : filename === 'art_wave_envelope_regressions.py' ? 15_000 : 45_000;
}

/**
 * Register shard `shard` of `shards`. The cases take ~186s serially, so one
 * file was the fast suite's critical path; vitest parallelizes across files,
 * so each shard lives in its own test file.
 */
export function registerFleetSupervisionShard(shard: number, shards: number): void {
  describe(`fleet supervision and verification regressions (shard ${shard + 1}/${shards})`, () => {
    allCases().forEach(({ filename, path, testCase }, index) => {
      if (index % shards !== shard) return;
      const timeout = timeoutFor(filename);
      it(testCase ? `${filename}: ${testCase}` : filename, () => {
        const result = spawnSync('python3', [path, ...(testCase ? [testCase] : []), '-q'], {
          encoding: 'utf8', timeout,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        });
        expect(result.status, [result.error?.message, result.stderr].filter(Boolean).join('\n')).toBe(0);
        expect(result.stderr).toMatch(testCase ? /Ran 1 test\b/ : /Ran [1-9]\d* tests/);
        expect(result.stderr).toMatch(/\nOK\s*$/);
      }, timeout + 5_000);
    });
  });
}
