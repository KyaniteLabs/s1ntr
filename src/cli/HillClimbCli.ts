import { readFileSync, writeFileSync } from 'node:fs';

import {
  calibrateAcceptance, decideStep, pairOracle, parseCalibration, runHillClimb,
  type DecisionOracle, type HillClimbPorts, type OracleSample,
} from '../atelier/HillClimb.js';
import { mulberry32 } from '../atelier/PromptOrgan.js';
import { buildProductionPorts, DEFAULT_RUBRIC, runLiveClimb, type LiveRunOptions } from './HillClimbLive.js';

// Options are name=value words: bin/sinter's global parser rejects --flags it does not own.
const USAGE = [
  'usage: sinter hillclimb calibrate <steps.jsonl> domain=<name> [alpha-accept=0.1] [alpha-miss=0.1] [delta=0.1] [out=<file>]',
  '       sinter hillclimb decide <p> <calibration.json>',
  '       sinter hillclimb simulate [seeds=20] [calibration-runs=5] [steps=400] [patience=40] [oracle-noise=1] [seed=1]',
  '       sinter hillclimb run <start.js> brief=<text> oracle-url=<d1 url> out=<steps.jsonl> [oracle-model=LiquidAI/d1-2B]',
  '                            [steps=50] [patience=10] [seed=1] [judges=3] [calibration=<file>] [rubric=<text>] [temperature=<t>]',
].join('\n');

/** Positional arguments and name=value options each subcommand takes; anything else is a usage error. */
const ARGS: Readonly<Record<string, { positional: number; names: readonly string[] }>> = {
  calibrate: { positional: 1, names: ['domain', 'alpha-accept', 'alpha-miss', 'delta', 'out'] },
  decide: { positional: 2, names: [] },
  simulate: { positional: 0, names: ['seeds', 'calibration-runs', 'steps', 'patience', 'oracle-noise', 'seed'] },
  run: { positional: 1, names: ['brief', 'oracle-url', 'oracle-model', 'out', 'steps', 'patience', 'seed', 'judges',
    'calibration', 'rubric', 'temperature'] },
};

/** Check the words after the subcommand; returns the problem, or null when they fit. */
export function checkHillClimbArgs(cmdArgs: readonly string[]): string | null {
  const spec = ARGS[cmdArgs[0] ?? ''];
  if (!spec) return `unknown subcommand: ${cmdArgs[0] ?? '(none)'}`;
  const rest = cmdArgs.slice(1);
  const positional = rest.filter(arg => !/^[a-z-]+=/.test(arg));
  if (positional.length !== spec.positional) return `${cmdArgs[0]} takes ${spec.positional} argument(s), got ${positional.length}`;
  const seen = new Set<string>();
  for (const arg of rest.filter(a => /^[a-z-]+=/.test(a))) {
    const name = arg.slice(0, arg.indexOf('='));
    if (!spec.names.includes(name)) return `unknown option for ${cmdArgs[0]}: ${name}`;
    if (seen.has(name)) return `option given twice: ${name}`;
    seen.add(name);
  }
  return null;
}

export interface SimulationOptions {
  readonly seeds: number;
  /** Fully verified climbs of `steps` steps that feed the calibration. */
  readonly calibrationRuns: number;
  readonly steps: number;
  /** Plateau patience of every simulated climb (a finite value, as a real run must use). */
  readonly patience: number;
  /** Standard deviation of the synthetic oracle's error, in units of one proposal step. */
  readonly oracleNoise: number;
  readonly seed: number;
}

/**
 * Run the loop against a synthetic world where true quality is a number.
 * It checks the mechanism (thresholds, audits, checkpoints); it measures nothing
 * about LFM3 or d1.
 */
export async function simulateHillClimb(options: SimulationOptions) {
  const meanChange: Record<string, number> = { palette: -0.2, motion: -0.6, composition: -1.2 };
  const quality = (artifact: string): number => Number(artifact.slice(2));
  const totals = {
    acceptCalibrated: 0, rejectCalibrated: 0, verifierCallsBaseline: 0, verifierCallsCascade: 0,
    autoAccepts: 0, wrongAutoAccepts: 0, autoRejects: 0, missedImprovements: 0, improvements: 0,
    finalQualityBaseline: 0, finalQualityCascade: 0, finalQualityMatched: 0, rollbacks: 0, driftAlarms: 0,
  };

  for (let s = 0; s < options.seeds; s++) {
    const world = (seed: number) => {
      const rng = mulberry32(seed);
      const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      const truth: boolean[] = [];
      const decisionModel: DecisionOracle = {
        decide: async ({ state }) => {
          const [, a, b] = /<A-(\w+)>\n(.*)\n<\/A-\1>\n\n<B-\1>\n(.*)\n<\/B-\1>$/s.exec(state)!.slice(1);
          const margin = quality(b) - quality(a) + options.oracleNoise * gauss();
          return { answers: { better: { type: 'noul', probability: 1 / (1 + Math.exp(-2 * margin)) } } };
        },
      };
      return {
        rng, truth,
        ports: {
          // Gains shrink as quality rises, so improving proposals get rarer: a plateau.
          propose: async ({ incumbent, target, widen }: { incumbent: string; target: string; widen: boolean }) => {
            const q = quality(incumbent);
            const next = q + meanChange[target] - 0.15 * q + gauss() * (widen ? 2 : 1);
            truth.push(next > q);
            return `q=${next}`;
          },
          oracle: pairOracle(decisionModel, 'higher q is better'),
          verify: async (a: string, b: string) => quality(b) > quality(a),
        },
      };
    };
    const base = { targets: Object.keys(meanChange), patience: options.patience, domain: 'simulation' };

    const samples: OracleSample[] = [];
    for (let r = 0; r < options.calibrationRuns; r++) {
      const bootSeed = options.seed + s + 1000 * (r + 1);
      const boot = world(bootSeed);
      const run = await runHillClimb('q=0', boot.ports, {
        ...base, maxSteps: options.steps, calibration: null, seed: bootSeed, rng: boot.rng,
      });
      for (const st of run.steps) if (st.p !== null && st.gold !== null) samples.push({ p: st.p, gold: st.gold });
    }
    const calibration = calibrateAcceptance(samples);
    if (calibration.acceptAt !== null) totals.acceptCalibrated += 1;
    if (calibration.rejectAt !== null) totals.rejectCalibrated += 1;

    const runSeed = options.seed + s + 100_000;
    const plain = world(runSeed);
    const baseline = await runHillClimb('q=0', plain.ports, {
      ...base, maxSteps: options.steps, calibration: null, seed: runSeed, rng: plain.rng,
    });
    const screened = world(runSeed);
    const cascade = await runHillClimb('q=0', screened.ports, {
      ...base, maxSteps: options.steps, calibration, seed: runSeed, rng: screened.rng,
    });

    // What the plain loop reaches when it may spend only as many verifier calls as the cascade did.
    const budgeted = world(runSeed);
    const matched = await runHillClimb('q=0', budgeted.ports, {
      ...base, maxSteps: cascade.verifierCalls, calibration: null, seed: runSeed, rng: budgeted.rng,
    });
    totals.finalQualityMatched += quality(matched.incumbent);
    totals.verifierCallsBaseline += baseline.verifierCalls;
    totals.verifierCallsCascade += cascade.verifierCalls;
    totals.finalQualityBaseline += quality(baseline.incumbent);
    totals.finalQualityCascade += quality(cascade.incumbent);
    totals.rollbacks += cascade.rollbacks;
    totals.driftAlarms += cascade.drifted ? 1 : 0;
    cascade.steps.forEach((st, i) => {
      if (st.decision === 'accept') { totals.autoAccepts += 1; if (!screened.truth[i]) totals.wrongAutoAccepts += 1; }
      if (screened.truth[i]) totals.improvements += 1;
      if (st.decision === 'reject') { totals.autoRejects += 1; if (screened.truth[i]) totals.missedImprovements += 1; }
    });
  }

  const share = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);
  return {
    simulation: true,
    note: 'Synthetic proposer, oracle and verifier. Checks the mechanism; measures nothing about LFM3 or d1.',
    ...options,
    seedsWithAcceptThreshold: totals.acceptCalibrated,
    seedsWithRejectThreshold: totals.rejectCalibrated,
    verifierCallsBaseline: totals.verifierCallsBaseline,
    verifierCallsCascade: totals.verifierCallsCascade,
    verifierCallsSaved: share(totals.verifierCallsBaseline - totals.verifierCallsCascade, totals.verifierCallsBaseline),
    autoAccepts: totals.autoAccepts,
    wrongAutoAcceptShare: share(totals.wrongAutoAccepts, totals.autoAccepts),
    autoRejects: totals.autoRejects,
    missedImprovementShare: share(totals.missedImprovements, totals.improvements),
    meanFinalQualityBaseline: share(totals.finalQualityBaseline, options.seeds),
    meanFinalQualityCascade: share(totals.finalQualityCascade, options.seeds),
    meanFinalQualityBaselineAtCascadeVerifierCalls: share(totals.finalQualityMatched, options.seeds),
    rollbacks: totals.rollbacks,
    driftAlarms: totals.driftAlarms,
  };
}

/** Live ports for `run`; injectable so the argument handling is testable without providers. */
export type LivePortsFactory = (options: LiveRunOptions) => Promise<{ ports: HillClimbPorts<string>; close(): Promise<void> }>;

export async function runHillClimbCommand(cmdArgs: string[], livePorts: LivePortsFactory = buildProductionPorts): Promise<void> {
  const flag = (name: string): string | undefined =>
    cmdArgs.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const num = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) throw new RangeError(`${name} must be a number, got ${raw}`);
    return value;
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const value = num(name, fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
    }
    return value;
  };

  const nonNegative = (name: string, fallback: number): number => {
    const value = num(name, fallback);
    if (value < 0) throw new RangeError(`${name} must be >= 0, got ${value}`);
    return value;
  };

  const problem = checkHillClimbArgs(cmdArgs);
  if (problem) {
    console.error(`[hillclimb] ${problem}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  try {
    if (cmdArgs[0] === 'calibrate') {
      const path = cmdArgs.find((arg, i) => i > 0 && !/^[a-z-]+=/.test(arg))!;
      const domain = flag('domain');
      if (!domain) throw new RangeError('calibrate needs domain=<name>: samples from different domains do not mix');
      const samples: OracleSample[] = [];
      const skipped = { unverified: 0, otherDomain: 0, underCalibration: 0 };
      for (const [i, line] of readFileSync(path, 'utf8').split('\n').entries()) {
        if (!line.trim()) continue;
        let row: { p?: unknown; gold?: unknown; domain?: unknown; calibrationId?: unknown };
        try { row = JSON.parse(line); } catch { throw new SyntaxError(`${path}:${i + 1} is not JSON`); }
        // Loop step records carry p: null (oracle failed) or gold: null (never verified).
        if (typeof row.p !== 'number' || typeof row.gold !== 'boolean') skipped.unverified += 1;
        else if (row.domain !== domain) skipped.otherDomain += 1;
        // Under an active calibration only escalated and audited steps get a verdict: a biased sample.
        else if (row.calibrationId !== null) skipped.underCalibration += 1;
        else samples.push({ p: row.p, gold: row.gold });
      }
      const calibration = calibrateAcceptance(samples, {
        alphaAccept: num('alpha-accept', 0.1), alphaMiss: num('alpha-miss', 0.1), delta: num('delta', 0.1),
      });
      const out = flag('out');
      if (out) writeFileSync(out, `${JSON.stringify(calibration, null, 2)}\n`);
      if (skipped.unverified > 0) console.error(`[hillclimb] skipped ${skipped.unverified} rows without both p and gold`);
      if (skipped.otherDomain > 0) console.error(`[hillclimb] skipped ${skipped.otherDomain} rows from other domains (or none)`);
      if (skipped.underCalibration > 0) {
        console.error(`[hillclimb] skipped ${skipped.underCalibration} rows made under an active calibration (or without calibrationId)`);
      }
      console.log(JSON.stringify(calibration, null, 2));
      return;
    }

    if (cmdArgs[0] === 'decide') {
      // A path was given, so an unreadable or unusable file is an error, not a silent "escalate".
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(cmdArgs[2], 'utf8')); } catch (error) {
        throw new Error(`cannot read calibration ${cmdArgs[2]}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const calibration = parseCalibration(raw);
      if (!calibration) throw new Error(`${cmdArgs[2]} is not a usable calibration`);
      console.log(decideStep(Number(cmdArgs[1]), calibration));
      return;
    }

    if (cmdArgs[0] === 'run') {
      const required = (name: string): string => {
        const value = flag(name);
        if (!value) throw new RangeError(`run needs ${name}=<value>`);
        return value;
      };
      const temperature = flag('temperature') === undefined ? null : nonNegative('temperature', 0);
      const options: LiveRunOptions = {
        start: cmdArgs.find((arg, i) => i > 0 && !/^[a-z-]+=/.test(arg))!,
        brief: required('brief'), oracleUrl: required('oracle-url'), out: required('out'),
        oracleModel: flag('oracle-model') ?? 'LiquidAI/d1-2B', rubric: flag('rubric') ?? DEFAULT_RUBRIC,
        steps: int('steps', 50, 1, 10_000), patience: int('patience', 10, 1, 10_000), seed: int('seed', 1, 0, 2 ** 31 - 1),
        judges: int('judges', 3, 2, 20), calibration: flag('calibration') ?? null, temperature,
      };
      const live = await livePorts(options);
      try {
        const { summary } = await runLiveClimb(options, live.ports);
        console.log(JSON.stringify(summary, null, 2));
      } finally {
        await live.close();
      }
      return;
    }

    if (cmdArgs[0] === 'simulate') {
      console.log(JSON.stringify(await simulateHillClimb({
        seeds: int('seeds', 20, 1, 1000), calibrationRuns: int('calibration-runs', 5, 0, 100),
        steps: int('steps', 400, 1, 100_000), patience: int('patience', 40, 1, 100_000),
        oracleNoise: nonNegative('oracle-noise', 1), seed: int('seed', 1, 0, 2 ** 31 - 1),
      }), null, 2));
      return;
    }
  } catch (error) {
    console.error(`[hillclimb] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  console.error(USAGE);
  process.exitCode = 2;
}
