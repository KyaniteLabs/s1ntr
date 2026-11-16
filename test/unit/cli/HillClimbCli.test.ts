import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHillClimbCommand, simulateHillClimb } from '../../../src/cli/HillClimbCli.js';

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hillclimb-cli-'));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { err.push(line); });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Step-log rows of one domain made with no active calibration. */
const row = (fields: Record<string, unknown>): string => JSON.stringify({ domain: 'p5', calibrationId: null, ...fields });

/** 60 clear improvements, 200 clear non-improvements, plus two rows a real step log would carry. */
function writeSamples(extra: string[] = []): string {
  const rows = [
    ...Array.from({ length: 60 }, () => row({ p: 0.9, gold: true })),
    ...Array.from({ length: 200 }, () => row({ step: 3, p: 0.1, gold: false })),
    row({ p: null, gold: true }),
    row({ p: 0.4, gold: null }),
    ...extra,
  ];
  const path = join(dir, 'samples.jsonl');
  writeFileSync(path, `${rows.join('\n')}\n\n`);
  return path;
}

describe('sinter hillclimb calibrate', () => {
  it('turns logged (p, gold) pairs into thresholds and stores them', async () => {
    const calPath = join(dir, 'cal.json');
    await runHillClimbCommand(['calibrate', writeSamples(), 'domain=p5', `out=${calPath}`]);

    const printed = JSON.parse(out[0]);
    expect(printed).toMatchObject({
      schema: 'sinter.hillclimb-calibration.v1', samples: 260, improvements: 60,
      acceptAt: 0.55, rejectAt: 0.45, alphaAccept: 0.1, alphaMiss: 0.1, delta: 0.1, coverage: 1,
    });
    expect(JSON.parse(readFileSync(calPath, 'utf8'))).toEqual(printed);
    expect(err).toEqual(['[hillclimb] skipped 2 rows without both p and gold']);
    expect(process.exitCode).toBeUndefined();
  });

  it('applies the tolerances it is given', async () => {
    // 60 clean samples pass a 10% tolerance (0.9^60) but not a 5% one (0.95^60 = 0.046).
    await runHillClimbCommand(['calibrate', writeSamples(), 'domain=p5', 'alpha-accept=0.05']);
    expect(JSON.parse(out[0])).toMatchObject({ alphaAccept: 0.05, acceptAt: null, rejectAt: 0.45 });
  });

  it('names the line that is not JSON and writes nothing', async () => {
    const calPath = join(dir, 'cal.json');
    await runHillClimbCommand(['calibrate', writeSamples(['{oops']), 'domain=p5', `out=${calPath}`]);
    expect(err).toEqual([`[hillclimb] ${join(dir, 'samples.jsonl')}:263 is not JSON`]);
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(2);
    expect(() => readFileSync(calPath, 'utf8')).toThrow('ENOENT');
  });

  it('fails on a missing file, a non-numeric option and an out-of-range tolerance', async () => {
    await runHillClimbCommand(['calibrate', join(dir, 'absent.jsonl'), 'domain=p5']);
    expect(err[0]).toContain('ENOENT');
    expect(process.exitCode).toBe(2);

    await runHillClimbCommand(['calibrate', writeSamples(), 'domain=p5', 'delta=abc']);
    expect(err[1]).toBe('[hillclimb] delta must be a number, got abc');

    await runHillClimbCommand(['calibrate', writeSamples(), 'domain=p5', 'alpha-miss=1.5']);
    expect(err[2]).toBe('[hillclimb] calibrateAcceptance: alphaMiss must be in (0, 1), got 1.5');
    expect(out).toEqual([]);
  });

  it('needs a domain and keeps only rows of that domain made with no active calibration (bug 25)', async () => {
    await runHillClimbCommand(['calibrate', writeSamples()]);
    expect(err[0]).toBe('[hillclimb] calibrate needs domain=<name>: samples from different domains do not mix');
    expect(process.exitCode).toBe(2);
    err.length = 0;
    process.exitCode = undefined;

    const mixed = writeSamples([
      ...Array.from({ length: 5 }, () => row({ domain: 'svg', p: 0.9, gold: false })),
      ...Array.from({ length: 4 }, () => row({ calibrationId: 'abc', p: 0.9, gold: false })),
      JSON.stringify({ p: 0.9, gold: false }),
    ]);
    await runHillClimbCommand(['calibrate', mixed, 'domain=p5']);
    expect(JSON.parse(out[0])).toMatchObject({ samples: 260, improvements: 60, acceptAt: 0.55 });
    expect(err).toEqual([
      '[hillclimb] skipped 2 rows without both p and gold',
      '[hillclimb] skipped 6 rows from other domains (or none)',
      '[hillclimb] skipped 4 rows made under an active calibration (or without calibrationId)',
    ]);
  });
});

describe('sinter hillclimb decide', () => {
  it('answers accept, reject or escalate from a stored calibration', async () => {
    const calPath = join(dir, 'cal.json');
    await runHillClimbCommand(['calibrate', writeSamples(), 'domain=p5', `out=${calPath}`]);
    out.length = 0;
    err.length = 0;

    await runHillClimbCommand(['decide', '0.9', calPath]);
    await runHillClimbCommand(['decide', '0.5', calPath]);
    await runHillClimbCommand(['decide', '0.2', calPath]);
    expect(out).toEqual(['accept', 'escalate', 'reject']);
    expect(err).toEqual([]);
  });

  it('exits 2 when the calibration is missing, unreadable or unusable (bug 24)', async () => {
    await runHillClimbCommand(['decide', '0.99']);
    expect(err[0]).toContain('decide takes 2 argument(s), got 1');
    await runHillClimbCommand(['decide', '0.99', join(dir, 'absent.json')]);
    expect(err[1]).toContain(`cannot read calibration ${join(dir, 'absent.json')}`);
    const wrongSchema = join(dir, 'wrong.json');
    writeFileSync(wrongSchema, JSON.stringify({ schema: 'other.v1', acceptAt: 0.6, rejectAt: 0.4 }));
    await runHillClimbCommand(['decide', '0.99', wrongSchema]);
    expect(err[2]).toBe(`[hillclimb] ${wrongSchema} is not a usable calibration`);
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(2);
  });

  it('rejects a value that is not a probability', async () => {
    const calPath = join(dir, 'cal.json');
    await runHillClimbCommand(['calibrate', writeSamples(), 'domain=p5', `out=${calPath}`]);
    out.length = 0;
    err.length = 0;
    await runHillClimbCommand(['decide', 'high', calPath]);
    expect(out).toEqual([]);
    expect(err[0]).toBe('[hillclimb] decideStep: p must be a probability in [0, 1], got NaN');
    expect(process.exitCode).toBe(2);
  });
});

describe('sinter hillclimb usage', () => {
  it('prints usage and exits 2 for an unknown or incomplete subcommand', async () => {
    await runHillClimbCommand([]);
    await runHillClimbCommand(['calibrate']);
    await runHillClimbCommand(['climb']);
    expect(out).toEqual([]);
    expect(err).toHaveLength(3);
    for (const line of err) {
      expect(line).toContain('usage: sinter hillclimb calibrate <steps.jsonl> domain=<name>');
      expect(line).toContain('sinter hillclimb decide <p> <calibration.json>');
    }
    expect(err[0]).toContain('unknown subcommand: (none)');
    expect(err[2]).toContain('unknown subcommand: climb');
    expect(process.exitCode).toBe(2);
  });

  it('refuses unknown, repeated or out-of-range options instead of ignoring them (bugs 23, 26)', async () => {
    await runHillClimbCommand(['simulate', 'stpes=10']);
    await runHillClimbCommand(['simulate', 'seeds=1', 'seeds=2']);
    await runHillClimbCommand(['simulate', 'seeds=1.5']);
    await runHillClimbCommand(['simulate', 'steps=0']);
    await runHillClimbCommand(['simulate', 'oracle-noise=-1']);
    await runHillClimbCommand(['simulate', 'extra']);
    expect(out).toEqual([]);
    expect(err[0]).toContain('unknown option for simulate: stpes');
    expect(err[1]).toContain('option given twice: seeds');
    expect(err[2]).toBe('[hillclimb] seeds must be an integer in [1, 1000], got 1.5');
    expect(err[3]).toBe('[hillclimb] steps must be an integer in [1, 100000], got 0');
    expect(err[4]).toBe('[hillclimb] oracle-noise must be >= 0, got -1');
    expect(err[5]).toContain('simulate takes 0 argument(s), got 1');
    expect(process.exitCode).toBe(2);
  });
});

describe('simulateHillClimb', () => {
  const options = { seeds: 2, calibrationRuns: 5, steps: 200, patience: 40, oracleNoise: 0.5, seed: 1 };

  it('saves verifier calls without auto-accepting, and repeats exactly for a seed', async () => {
    const first = await simulateHillClimb(options);
    expect(first.simulation).toBe(true);
    expect(first.verifierCallsBaseline).toBe(400);
    expect(first.seedsWithRejectThreshold).toBe(2);
    // Improvements are rare near a plateau, so no accept threshold earns trust and none is used.
    expect(first.seedsWithAcceptThreshold).toBe(0);
    expect(first.autoAccepts).toBe(0);
    expect(first.wrongAutoAcceptShare).toBeNull();
    // Every auto-reject saves one verifier call; each audit and the closing checkpoint spend one.
    expect(first.verifierCallsCascade).toBeLessThan(first.verifierCallsBaseline - first.autoRejects * 0.8);
    expect(first.verifierCallsCascade).toBeGreaterThanOrEqual(first.verifierCallsBaseline - first.autoRejects);
    expect(first.missedImprovementShare).toBeLessThanOrEqual(0.1);
    expect(await simulateHillClimb(options)).toEqual(first);
  });

  it('runs through the command and prints the report as JSON', async () => {
    await runHillClimbCommand(['simulate', 'seeds=1', 'calibration-runs=1', 'steps=20', 'oracle-noise=0.5', 'seed=3']);
    expect(JSON.parse(out[0])).toMatchObject({
      simulation: true, seeds: 1, calibrationRuns: 1, steps: 20, oracleNoise: 0.5, seed: 3,
      // 20 verified steps cannot calibrate anything, so the cascade verifies every step like the baseline.
      seedsWithAcceptThreshold: 0, seedsWithRejectThreshold: 0,
      verifierCallsBaseline: 20, verifierCallsCascade: 20, verifierCallsSaved: 0, autoAccepts: 0, autoRejects: 0,
    });
  });
});

describe('bin/sinter hillclimb', () => {
  it('prints only the decision: no provider is resolved for arithmetic', () => {
    const calPath = join(dir, 'cal.json');
    writeFileSync(calPath, JSON.stringify({
      schema: 'sinter.hillclimb-calibration.v1', alphaAccept: 0.1, alphaMiss: 0.1, delta: 0.1,
      samples: 260, improvements: 60, acceptAt: 0.8, rejectAt: 0.2, rejectErrorCeiling: 0.02,
      coverage: 1, ece: 0.1, brier: 0.01,
    }));
    const stdout = execFileSync(process.execPath, ['bin/sinter', 'hillclimb', 'decide', '0.9', calPath], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(stdout).toBe('accept\n');
  });
});
