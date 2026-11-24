/**
 * HillClimb — the climb that runs after the cheap wins are gone.
 *
 * Three roles, each a port so any model can fill it:
 *  - proposer: a cheap generative model (LFM3-1.7B, LFM3-VL-2B) mutates the incumbent;
 *  - oracle:   a decision model (d1-2B) answers P(candidate is better);
 *  - verifier: the full gate + judge panel sinter already trusts. It is the gold label.
 *
 * The oracle may decide a step alone only where a calibration on our own gold
 * labels says its error rate is bounded. Everywhere else the step escalates to
 * the verifier, so an uncalibrated loop costs exactly what the loop costs today.
 *
 * Design and sources: docs/design/lfm3-hillclimb-20261109.md
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { sampleBeta } from '../compost/ModelRouter.js';
import { mulberry32 } from './PromptOrgan.js';

// ── Calibration ─────────────────────────────────────────────────────────────

/** One oracle answer with the verifier's verdict on the same pair. */
export interface OracleSample {
  /** Oracle's P(candidate is better than incumbent). */
  readonly p: number;
  /** Verifier's verdict: the candidate really was better. */
  readonly gold: boolean;
}

export interface CalibrationOptions {
  /** Tolerated share of auto-accepts that are not improvements. Default 0.1. */
  readonly alphaAccept?: number;
  /** Tolerated share of real improvements that get auto-rejected. Default 0.1. */
  readonly alphaMiss?: number;
  /** Chance that any chosen threshold breaks its tolerance. Default 0.1. */
  readonly delta?: number;
}

export interface AcceptanceCalibration {
  readonly schema: 'sinter.hillclimb-calibration.v1';
  readonly alphaAccept: number;
  readonly alphaMiss: number;
  readonly delta: number;
  readonly samples: number;
  /** How many samples the verifier called improvements. */
  readonly improvements: number;
  /** Auto-accept when p >= acceptAt. null = never auto-accept. */
  readonly acceptAt: number | null;
  /** Auto-reject when p <= rejectAt. null = never auto-reject. */
  readonly rejectAt: number | null;
  /**
   * Upper confidence bound (level delta) on the share of auto-rejects that were
   * improvements. Audits that run above it mean the data has moved. null without rejectAt.
   */
  readonly rejectErrorCeiling: number | null;
  /** Share of calibration samples the thresholds decide without the verifier. */
  readonly coverage: number;
  /** Expected calibration error over ten equal-width bins; null without samples. */
  readonly ece: number | null;
  /** Mean squared error of p against gold; null without samples. */
  readonly brier: number | null;
}

/** Thresholds are fixed before any data is seen; the test below depends on it. */
export const ACCEPT_GRID: readonly number[] = Array.from({ length: 9 }, (_, i) => (55 + 5 * i) / 100);
export const REJECT_GRID: readonly number[] = Array.from({ length: 9 }, (_, i) => (45 - 5 * i) / 100);

const isProbability = (p: unknown): p is number => typeof p === 'number' && p >= 0 && p <= 1;

/** P(X <= k) for X ~ Binomial(n, q), summed in log space so large n cannot underflow. */
function binomialCdf(k: number, n: number, q: number): number {
  if (k >= n) return 1;
  let logTerm = n * Math.log1p(-q);
  let sum = Math.exp(logTerm);
  const logOdds = Math.log(q) - Math.log1p(-q);
  for (let i = 0; i < k; i++) {
    logTerm += Math.log((n - i) / (i + 1)) + logOdds;
    sum += Math.exp(logTerm);
  }
  return Math.min(1, sum);
}

/** One-sided Clopper-Pearson upper bound on a rate after k events in n trials. */
function upperBound(k: number, n: number, level: number): number {
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(k, n, mid) > level) lo = mid; else hi = mid;
  }
  return hi;
}

/** Fewest calibration samples at or below a reject threshold before it may be used. */
export const MIN_REJECT_SAMPLES = 30;

/**
 * Pick the thresholds the oracle may act on alone.
 *
 * The two sides bound different mistakes. Accepting: of the steps accepted past
 * the threshold, at most alphaAccept are not improvements. Rejecting: of the
 * real improvements, at most alphaMiss fall below the threshold. (Bounding the
 * share of wrong rejects instead would be empty near a plateau, where nearly
 * every proposal is worse and rejecting everything looks accurate.)
 *
 * Each grid threshold is tested with an exact binomial tail against "the
 * mistake rate exceeds its tolerance". A Bonferroni split of delta over all 18
 * thresholds keeps the chance that any chosen threshold breaks its tolerance
 * below delta (Learn then Test). No samples, or no threshold that passes,
 * yields null: the loop then escalates every step.
 */
export function calibrateAcceptance(
  samples: readonly OracleSample[],
  options: CalibrationOptions = {},
): AcceptanceCalibration {
  const { alphaAccept = 0.1, alphaMiss = 0.1, delta = 0.1 } = options;
  for (const [name, value] of Object.entries({ alphaAccept, alphaMiss, delta })) {
    if (!(value > 0 && value < 1)) throw new RangeError(`calibrateAcceptance: ${name} must be in (0, 1), got ${value}`);
  }
  samples.forEach((s, i) => {
    if (!isProbability(s?.p) || typeof s.gold !== 'boolean') {
      throw new RangeError(`calibrateAcceptance: sample ${i} needs p in [0, 1] and a boolean gold`);
    }
  });

  const level = delta / (ACCEPT_GRID.length + REJECT_GRID.length);
  const passes = (mistakes: number, trials: number, alpha: number): boolean =>
    trials > 0 && binomialCdf(mistakes, trials, alpha) <= level;
  const improvements = samples.filter(s => s.gold);

  const acceptAt = ACCEPT_GRID.find(t => {
    const accepted = samples.filter(s => s.p >= t);
    return passes(accepted.filter(s => !s.gold).length, accepted.length, alphaAccept);
  }) ?? null;
  // A reject threshold also needs enough samples at or below it to bound the
  // share of wrong rejects; with fewer, the drift alarm on that side could never fire.
  const rejectAt = REJECT_GRID.find(t => {
    const rejected = samples.filter(s => s.p <= t);
    if (rejected.length < MIN_REJECT_SAMPLES) return false;
    if (!passes(improvements.filter(s => s.p <= t).length, improvements.length, alphaMiss)) return false;
    // Reject threshold is only usable when upperBound < 1 (parseCalibration requires < 1).
    return upperBound(rejected.filter(s => s.gold).length, rejected.length, delta) < 1;
  }) ?? null;
  let rejectErrorCeiling: number | null = null;
  if (rejectAt !== null) {
    const rejected = samples.filter(s => s.p <= rejectAt);
    rejectErrorCeiling = upperBound(rejected.filter(s => s.gold).length, rejected.length, delta);
  }

  const n = samples.length;
  const decided = samples.filter(s =>
    (acceptAt !== null && s.p >= acceptAt) || (rejectAt !== null && s.p <= rejectAt)).length;
  let ece: number | null = null;
  let brier: number | null = null;
  if (n > 0) {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, gold: 0 }));
    let squared = 0;
    for (const s of samples) {
      const bin = bins[Math.min(9, Math.floor(s.p * 10))];
      bin.n += 1; bin.p += s.p; bin.gold += s.gold ? 1 : 0;
      squared += (s.p - (s.gold ? 1 : 0)) ** 2;
    }
    ece = bins.reduce((acc, b) => acc + Math.abs(b.p - b.gold) / n, 0);
    brier = squared / n;
  }
  return {
    schema: 'sinter.hillclimb-calibration.v1',
    alphaAccept, alphaMiss, delta, samples: n, improvements: improvements.length,
    acceptAt, rejectAt, rejectErrorCeiling, coverage: n > 0 ? decided / n : 0, ece, brier,
  };
}

/**
 * Read a stored calibration; anything that is not a usable one reads as null
 * (escalate everything). Usable means the thresholds do not overlap and both
 * drift alarms can fire: tolerances strictly inside (0, 1), and a reject
 * threshold always carries its error ceiling.
 */
export function parseCalibration(raw: unknown): AcceptanceCalibration | null {
  const c = raw as Partial<AcceptanceCalibration> | null;
  const threshold = (t: unknown): boolean => t === null || isProbability(t);
  const open = (t: unknown): boolean => typeof t === 'number' && t > 0 && t < 1;
  if (c?.schema !== 'sinter.hillclimb-calibration.v1' || !threshold(c.acceptAt) || !threshold(c.rejectAt)
    || !open(c.alphaAccept) || !threshold(c.rejectErrorCeiling)) return null;
  if (c.acceptAt != null && c.rejectAt != null && c.acceptAt <= c.rejectAt) return null;
  if (c.rejectAt != null && !open(c.rejectErrorCeiling)) return null;
  return c as AcceptanceCalibration;
}

// ── Deciding one step ───────────────────────────────────────────────────────

export type StepDecision = 'accept' | 'reject' | 'escalate';

/** The oracle decides past a calibrated threshold; everything else goes to the verifier. */
export function decideStep(p: number, calibration: AcceptanceCalibration | null): StepDecision {
  if (!isProbability(p)) throw new RangeError(`decideStep: p must be a probability in [0, 1], got ${p}`);
  if (calibration?.acceptAt != null && p >= calibration.acceptAt) return 'accept';
  if (calibration?.rejectAt != null && p <= calibration.rejectAt) return 'reject';
  return 'escalate';
}

/**
 * Evidence that audited auto-decisions are failing more often than alpha allows.
 *
 * A likelihood ratio of "error rate is 2*alpha" against "error rate is alpha".
 * Under any true rate <= alpha it is a supermartingale, so by Ville's inequality
 * it crosses 1/level with probability at most level however often it is checked.
 * A tolerance of 0 or 1 cannot be tested and reads as no evidence.
 */
export function driftEvidence(errors: number, audited: number, alpha: number): number {
  if (!(alpha > 0 && alpha < 1)) return 0;
  const alt = Math.min(2 * alpha, (1 + alpha) / 2);
  return Math.exp(errors * Math.log(alt / alpha) + (audited - errors) * Math.log((1 - alt) / (1 - alpha)));
}

// ── Escaping a plateau ──────────────────────────────────────────────────────

export type PlateauRung = 'continue' | 'widen' | 'switch-target' | 'stop';

/** Each `patience` steps without an accepted change climbs one rung; the last rung stops. */
export function plateauRung(stepsSinceAccept: number, patience: number): PlateauRung {
  if (stepsSinceAccept < patience) return 'continue';
  if (stepsSinceAccept < 2 * patience) return 'widen';
  if (stepsSinceAccept < 3 * patience) return 'switch-target';
  return 'stop';
}

// ── The oracle port, filled by a decision model ─────────────────────────────

/** P(candidate is better than incumbent). The tiny-model project plugs in here too. */
export type PairOracle<T> = (incumbent: T, candidate: T) => Promise<number>;

/** The slice of DecisionModelClient this module needs (POST /v1/systemone). */
export interface DecisionOracle {
  decide(request: {
    readonly state: string;
    readonly questions: Readonly<Record<string, { readonly type: 'noul'; readonly instructions: string }>>;
  }): Promise<{ readonly answers: Readonly<Record<string, { readonly type: string; readonly probability?: number }>> }>;
}

/** Longest artifact, in characters, the pair oracle will frame. Longer input fails the call instead of being cut. */
export const PAIR_ORACLE_MAX_CHARS = 16_000;

/** A delimiter tag that appears in neither text, so an artifact cannot fake the A/B framing. */
function frameNonce(a: string, b: string): string {
  for (;;) {
    const nonce = randomBytes(6).toString('hex');
    if (!a.includes(nonce) && !b.includes(nonce)) return nonce;
  }
}

/**
 * Ask a decision model which of two texts is better. It is asked in both
 * orders, one after the other (a local seat serves one request at a time), and
 * the answers are averaged, which cancels a preference for a slot.
 */
export function pairOracle(oracle: DecisionOracle, rubric: string, maxChars = PAIR_ORACLE_MAX_CHARS): PairOracle<string> {
  const ask = async (a: string, b: string): Promise<number> => {
    if (a.length > maxChars || b.length > maxChars) {
      throw new Error(`HILLCLIMB_ORACLE_INPUT_TOO_LONG: artifacts must be at most ${maxChars} chars, got ${a.length} and ${b.length}`);
    }
    const tag = frameNonce(a, b);
    const { answers } = await oracle.decide({
      state: `Rubric: ${rubric}\n\n<A-${tag}>\n${a}\n</A-${tag}>\n\n<B-${tag}>\n${b}\n</B-${tag}>`,
      questions: { better: { type: 'noul', instructions: 'Is B better than A under the rubric?' } },
    });
    const probability = answers.better?.probability;
    if (!isProbability(probability)) throw new Error('HILLCLIMB_ORACLE_BAD_ANSWER: no probability for "better"');
    return probability;
  };
  return async (incumbent, candidate) => {
    const forward = await ask(incumbent, candidate);
    const backward = await ask(candidate, incumbent);
    return (forward + 1 - backward) / 2;
  };
}

// ── The loop ────────────────────────────────────────────────────────────────

/**
 * A scored verdict. `delta` is the verifier's score of the candidate minus the
 * incumbent's; `margin` is the noise band of that difference (e.g. the judges'
 * spread). The candidate counts as better only when delta > margin, so judge
 * noise cannot move the incumbent.
 */
export interface VerifyVerdict {
  readonly delta: number;
  readonly margin: number;
}

/** What the verifier said on a step: the scored verdict, or null for a bare boolean verifier. */
export interface VerdictRecord {
  readonly delta: number;
  readonly margin: number;
}

/** Normalize a verifier answer to the gold label plus what was measured. Throws on a malformed verdict. */
export function readVerdict(answer: boolean | VerifyVerdict): { gold: boolean; verdict: VerdictRecord | null } {
  if (typeof answer === 'boolean') return { gold: answer, verdict: null };
  const { delta, margin } = answer ?? ({} as VerifyVerdict);
  if (!Number.isFinite(delta) || !Number.isFinite(margin) || margin < 0) {
    throw new Error(`HILLCLIMB_VERDICT_INVALID: need finite delta and margin >= 0, got delta=${delta} margin=${margin}`);
  }
  return { gold: delta > margin, verdict: { delta, margin } };
}

export interface HillClimbPorts<T> {
  /** Mutate the incumbent at one target. `widen` asks for a bolder change. */
  propose(request: { readonly incumbent: T; readonly target: string; readonly widen: boolean }): Promise<T>;
  oracle: PairOracle<T>;
  /**
   * Gold: the full verifier compares the second argument with the first.
   * Return a scored verdict for real runs; a bare boolean skips the noise
   * margin and is meant for simulations and tests.
   */
  verify(incumbent: T, candidate: T): Promise<boolean | VerifyVerdict>;
}

export interface HillClimbConfig<T = unknown> {
  /** What may be mutated. The loop learns which targets pay off. */
  readonly targets: readonly string[];
  readonly maxSteps: number;
  /** null = no trusted thresholds yet: every step is verified and logged for calibration. */
  readonly calibration: AcceptanceCalibration | null;
  /**
   * Steps without an accepted change before the next plateau rung; the climb
   * stops after 3 × patience. Required: a small value stops a slow climb early
   * by chance alone (15 misses in a row happen ~46% of the time at a 5% hit rate).
   */
  readonly patience: number;
  /** Share of auto-decisions spot-checked by the verifier. Default 0.1. */
  readonly auditRate?: number;
  /** Unverified accepts allowed before the incumbent is verified against the last checkpoint. Default 5. */
  readonly checkpointEvery?: number;
  /** False-alarm bound of the drift alarm. Default 0.05. */
  readonly driftLevel?: number;
  /**
   * Seeds every random choice the loop makes (target draws, audits) and is
   * written on each step. Required: a run that cannot be replayed is not evidence.
   */
  readonly seed: number;
  /**
   * Overrides the generator built from `seed`. Only for callers that share one
   * generator between the loop and their own world, and derive it from the same seed.
   */
  readonly rng?: () => number;
  /** What is being climbed (e.g. 'p5-sketch'). Written on each step so mixed-domain logs are detectable. */
  readonly domain: string;
  /** Stable id for an artifact on the step log. Default: SHA-256 of the string, or of its JSON. */
  readonly fingerprint?: (artifact: T) => string;
  /**
   * Called with each step as soon as it is decided, before the next port call,
   * so a crash or kill mid-run still leaves every finished step on disk.
   * A sink that throws stops the run: an unlogged run cannot be replayed.
   */
  readonly onStep?: (step: HillClimbStep) => void | Promise<void>;
  /** Port failures in a row (propose or verify) before the run stops as 'infra'. Default 3. */
  readonly maxConsecutiveFailures?: number;
}

/** Which port threw. 'oracle' failures still let the step escalate to the verifier. */
export type HillClimbPort = 'propose' | 'oracle' | 'verify';

export interface HillClimbPortError {
  readonly port: HillClimbPort;
  readonly message: string;
}

export interface HillClimbStep {
  readonly step: number;
  readonly seed: number;
  readonly domain: string;
  /** SHA-256 of the calibration the step was decided under; null when none was in force. */
  readonly calibrationId: string | null;
  /** Fingerprint of the incumbent the candidate was compared with. */
  readonly incumbentId: string;
  /** Fingerprint of the candidate; null when propose failed. */
  readonly candidateId: string | null;
  readonly target: string;
  readonly rung: PlateauRung;
  /** null when the oracle failed or answered with something that is not a probability. */
  readonly p: number | null;
  readonly decision: StepDecision;
  /** Verifier verdict when it was asked (escalation or audit), else null. */
  readonly gold: boolean | null;
  /** The verifier's score difference and noise margin when it returned a scored verdict. */
  readonly verdict: VerdictRecord | null;
  readonly audited: boolean;
  readonly accepted: boolean;
  /** Set when a port threw during this step. A propose or verify failure is never accepted. */
  readonly error: HillClimbPortError | null;
}

export interface HillClimbResult<T> {
  /** Never an unverified chain: the last checkpoint, or something verified better than it. */
  readonly incumbent: T;
  readonly steps: readonly HillClimbStep[];
  /** 'infra': maxConsecutiveFailures port failures in a row. */
  readonly stopped: 'budget' | 'plateau' | 'infra';
  readonly verifierCalls: number;
  readonly rollbacks: number;
  /** The audits tripped the alarm; from then on every step was verified. */
  readonly drifted: boolean;
  /** Steps that recorded a propose or verify failure, plus failed checkpoint checks. */
  readonly portFailures: number;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** SHA-256 of a string artifact, or of the JSON of any other artifact. */
export function defaultFingerprint(artifact: unknown): string {
  return sha256(typeof artifact === 'string' ? artifact : JSON.stringify(artifact) ?? String(artifact));
}

/** Content id of a calibration: the same thresholds and fit always give the same id. */
export function calibrationId(calibration: AcceptanceCalibration | null): string | null {
  if (!calibration) return null;
  const keys = Object.keys(calibration).sort();
  return sha256(JSON.stringify(calibration, keys));
}

/** A step sink that appends one JSON line per step. The directory is created if missing. */
export function jsonlStepSink(path: string): (step: HillClimbStep) => void {
  mkdirSync(dirname(path), { recursive: true });
  return step => appendFileSync(path, `${JSON.stringify(step)}\n`);
}

/** Thompson draw over Beta(wins + 1, losses + 1); `exclude` forces a change of target. */
function pickTarget(
  arms: ReadonlyMap<string, { wins: number; losses: number }>,
  exclude: string | null,
  rng: () => number,
): string {
  let best = '';
  let bestDraw = -1;
  for (const [name, arm] of arms) {
    if (name === exclude && arms.size > 1) continue;
    const draw = sampleBeta(arm.wins + 1, arm.losses + 1, rng);
    if (draw > bestDraw) { best = name; bestDraw = draw; }
  }
  return best;
}

export async function runHillClimb<T>(
  start: T,
  ports: HillClimbPorts<T>,
  config: HillClimbConfig<T>,
): Promise<HillClimbResult<T>> {
  const {
    targets, maxSteps, calibration, seed, domain,
    patience, auditRate = 0.1, checkpointEvery = 5, driftLevel = 0.05,
    onStep, maxConsecutiveFailures = 3, fingerprint = defaultFingerprint,
  } = config;
  const positiveInt = (name: string, value: number): void => {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`runHillClimb: ${name} must be a positive integer, got ${value}`);
  };
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new RangeError(`runHillClimb: maxSteps must be a non-negative integer, got ${maxSteps}`);
  // Infinity turns the plateau ladder off (used by the synthetic simulation).
  if (patience !== Number.POSITIVE_INFINITY) positiveInt('patience', patience);
  positiveInt('checkpointEvery', checkpointEvery);
  positiveInt('maxConsecutiveFailures', maxConsecutiveFailures);
  if (!isProbability(auditRate)) throw new RangeError(`runHillClimb: auditRate must be in [0, 1], got ${auditRate}`);
  if (!(driftLevel > 0 && driftLevel < 1)) throw new RangeError(`runHillClimb: driftLevel must be in (0, 1), got ${driftLevel}`);
  if (targets.length === 0) throw new RangeError('runHillClimb: at least one mutation target is required');
  if (calibration !== null && parseCalibration(calibration) === null) {
    throw new RangeError('runHillClimb: calibration is not usable (overlapping thresholds, or a tolerance its drift alarm cannot test)');
  }
  if (!Number.isSafeInteger(seed)) throw new RangeError(`runHillClimb: seed must be a safe integer, got ${seed}`);
  if (typeof domain !== 'string' || domain.trim() === '') throw new RangeError('runHillClimb: domain is required');
  const rng = config.rng ?? mulberry32(seed);
  const provenance = { seed, domain, calibrationId: calibrationId(calibration) };

  const arms = new Map(targets.map(t => [t, { wins: 0, losses: 0 }]));
  const audits = { accept: { n: 0, wrong: 0 }, reject: { n: 0, wrong: 0 } };
  const steps: HillClimbStep[] = [];
  let incumbent = start;
  let checkpoint = start;
  let unverifiedAccepts = 0;
  let sinceAccept = 0;
  let verifierCalls = 0;
  let rollbacks = 0;
  let drifted = false;
  let lastTarget: string | null = null;
  // The target the climb was on when the plateau began; switch-target moves off it.
  let plateauTarget: string | null = null;
  // Targets of accepts not yet verified against the checkpoint; a rollback takes their wins back.
  let unverifiedTargets: string[] = [];
  let stopped: HillClimbResult<T>['stopped'] = 'budget';
  let portFailures = 0;
  let failuresInRow = 0;

  // The incumbent is only as good as its last comparison with the checkpoint.
  // The loop awaits one port at a time, so nothing else writes this state between a read and its update.
  /* eslint-disable require-atomic-updates */
  // A checkpoint check that throws counts as a failed check: the unverified chain is dropped.
  const settleCheckpoint = async (): Promise<void> => {
    if (unverifiedAccepts === 0) return;
    verifierCalls += 1;
    let better = false;
    try { better = readVerdict(await ports.verify(checkpoint, incumbent)).gold; } catch { portFailures += 1; }
    if (better) checkpoint = incumbent;
    else {
      incumbent = checkpoint;
      rollbacks += 1;
      for (const t of unverifiedTargets) arms.get(t)!.wins -= 1;
    }
    unverifiedAccepts = 0;
    unverifiedTargets = [];
  };
  const record = async (entry: HillClimbStep): Promise<void> => {
    steps.push(entry);
    if (onStep) await onStep(entry);
  };
  // A failed port says nothing about the target or the incumbent: no arm or plateau update.
  const recordFailure = async (
    base: Omit<HillClimbStep, 'gold' | 'verdict' | 'accepted' | 'error'>,
    port: HillClimbPort, error: unknown,
  ): Promise<boolean> => {
    portFailures += 1;
    failuresInRow += 1;
    await record({ ...base, gold: null, verdict: null, accepted: false, error: { port, message: errorMessage(error) } });
    if (failuresInRow < maxConsecutiveFailures) return false;
    stopped = 'infra';
    return true;
  };

  for (let step = 1; step <= maxSteps; step++) {
    const rung = plateauRung(sinceAccept, patience);
    if (rung === 'stop') { stopped = 'plateau'; break; }
    if (rung !== 'continue' && plateauTarget === null) plateauTarget = lastTarget;
    const target = pickTarget(arms, rung === 'switch-target' ? plateauTarget : null, rng);
    lastTarget = target;
    let candidate: T;
    try {
      candidate = await ports.propose({ incumbent, target, widen: rung !== 'continue' });
    } catch (error) {
      if (await recordFailure({
        step, ...provenance, incumbentId: fingerprint(incumbent), candidateId: null,
        target, rung, p: null, decision: 'escalate', audited: false,
      }, 'propose', error)) break;
      continue;
    }

    const ids = { incumbentId: fingerprint(incumbent), candidateId: fingerprint(candidate) };

    // A no-op proposal is a loss for its target and costs no oracle or verifier call.
    if (ids.candidateId === ids.incumbentId) {
      failuresInRow = 0;
      arms.get(target)!.losses += 1;
      sinceAccept += 1;
      await record({
        step, ...provenance, ...ids, target, rung, p: null, decision: 'reject', gold: null, verdict: null,
        audited: false, accepted: false, error: null,
      });
      continue;
    }

    // The oracle is asked even when it cannot decide: its answer next to the
    // verifier's verdict is the next calibration sample.
    let p: number | null = null;
    let oracleError: HillClimbPortError | null = null;
    try {
      const answer = await ports.oracle(incumbent, candidate);
      if (isProbability(answer)) p = answer;
      else oracleError = { port: 'oracle', message: `not a probability: ${String(answer)}` };
    } catch (error) {
      // An oracle that fails never decides: p stays null and the step escalates.
      oracleError = { port: 'oracle', message: errorMessage(error) };
    }
    const decision: StepDecision = p !== null && !drifted ? decideStep(p, calibration) : 'escalate';

    const audited = decision !== 'escalate' && rng() < auditRate;
    let gold: boolean | null = null;
    let verdict: VerdictRecord | null = null;
    if (decision === 'escalate' || audited) {
      verifierCalls += 1;
      try {
        ({ gold, verdict } = readVerdict(await ports.verify(incumbent, candidate)));
      } catch (error) {
        if (await recordFailure({ step, ...provenance, ...ids, target, rung, p, decision, audited }, 'verify', error)) break;
        continue;
      }
    }
    failuresInRow = 0;
    if (decision !== 'escalate' && gold !== null && calibration) {
      const side: { n: number; wrong: number } = audits[decision];
      side.n += 1;
      if (gold !== (decision === 'accept')) side.wrong += 1;
      // parseCalibration and calibrateAcceptance guarantee a ceiling whenever rejectAt is set.
      const tolerated: number = decision === 'accept' ? calibration.alphaAccept : calibration.rejectErrorCeiling!;
      drifted = driftEvidence(side.wrong, side.n, tolerated) >= 1 / driftLevel;
    }

    const accepted = gold ?? decision === 'accept';
    const arm = arms.get(target)!;
    if (accepted) arm.wins += 1; else arm.losses += 1;
    await record({ step, ...provenance, ...ids, target, rung, p, decision, gold, verdict, audited, accepted, error: oracleError });

    if (!accepted) { sinceAccept += 1; continue; }
    incumbent = candidate;
    sinceAccept = 0;
    plateauTarget = null;
    if (gold === true && unverifiedAccepts === 0) { checkpoint = incumbent; continue; }
    unverifiedAccepts += 1;
    unverifiedTargets.push(target);
    // A verified win on top of an unverified chain settles the chain now, so the
    // verified step is checkpointed rather than lost in a later rollback.
    if (gold === true || unverifiedAccepts >= checkpointEvery) await settleCheckpoint();
  }
  await settleCheckpoint();
  /* eslint-enable require-atomic-updates */

  return { incumbent, steps, stopped, verifierCalls, rollbacks, drifted, portFailures };
}
