/**
 * Live ports for the hill-climb (#1423 PR 7): a generator proposes, a decision
 * model screens, rendered-evidence judges verify. Every dependency is injected
 * so the loop logic is testable without a provider; bin/sinter wires the real
 * clients through the governed research-provider path.
 */

import { defaultFingerprint, pairOracle, type DecisionOracle, type HillClimbPorts, type VerifyVerdict } from './HillClimb.js';

/** The slice of LLMClient the proposer needs. */
export interface ProposeClient {
  generate(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    bypassCache?: boolean,
  ): Promise<{ readonly success: boolean; readonly code: string; readonly error?: string; readonly fromCache?: boolean }>;
}

/** Domain gate for a proposed artifact (CodeValidator.validate in production). */
export type ArtifactValidator = (code: string) => { readonly valid: boolean; readonly cleanedCode: string; readonly errors: readonly string[] };

/**
 * One independent judge score in [0, 1] for an artifact. Throws when the judge
 * gave no verdict (timeout, unscored, infra): a missing score is a port failure,
 * never a zero. A render failure of the artifact itself is a real 0.
 */
export type ArtifactScorer = (code: string) => Promise<number>;

/** What each target asks the generator to change. Unknown targets fall back to their name. */
export const P5_TARGETS: Readonly<Record<string, string>> = {
  palette: 'Change the colour palette and how colour is used: hue relationships, value contrast, saturation.',
  motion: 'Change the motion: timing, easing, rhythm, what moves and why.',
  composition: 'Change the composition: placement, scale, negative space, focal hierarchy.',
  texture: 'Change surface and material: grain, layering, line quality, finish.',
  structure: 'Change the generative structure: the rule or system that produces the forms.',
};

export const MUTATE_SYSTEM_PROMPT = `You improve one generative p5.js sketch by changing ONE aspect of it.
Return ONLY the complete sketch as JavaScript (setup() and draw()), no prose, no markdown fences.
Keep everything you were not asked to change. The result must run as-is in p5.js.`;

export function mutationPrompt(input: { incumbent: string; target: string; widen: boolean; brief: string; instruction: string }): string {
  return [
    `Brief: ${input.brief}`,
    `Aspect to change (${input.target}): ${input.instruction}`,
    input.widen
      ? 'The last several small edits did not help. Make a BOLD change to this aspect, not a tweak.'
      : 'Make one focused change to this aspect that a viewer would notice.',
    '',
    'Current sketch:',
    input.incumbent,
  ].join('\n');
}

export interface LivePortsOptions {
  readonly generator: ProposeClient;
  readonly validate: ArtifactValidator;
  readonly decisionModel: DecisionOracle;
  readonly score: ArtifactScorer;
  /** What the art is for; given to the generator and the oracle rubric. */
  readonly brief: string;
  /** Pairwise rubric for the decision model. */
  readonly rubric: string;
  /** Judge calls per artifact (>= 2, so a spread exists). Default 3. */
  readonly judges?: number;
  /** Width of the noise band in standard errors of the difference. Default 2. */
  readonly marginZ?: number;
  /** Smallest noise band, so identical judges cannot accept a hair's-breadth delta. Default 0.02. */
  readonly minMargin?: number;
  readonly targets?: Readonly<Record<string, string>>;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: readonly number[]): number => {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};

/** delta = mean(candidate) − mean(incumbent); margin = z·SE of that difference, floored. */
export function verdictFromScores(
  incumbent: readonly number[],
  candidate: readonly number[],
  marginZ = 2,
  minMargin = 0.02,
): VerifyVerdict {
  if (incumbent.length < 2 || candidate.length < 2) throw new Error('HILLCLIMB_VERIFY_TOO_FEW_JUDGES: need >= 2 scores per side');
  const se = Math.sqrt(variance(incumbent) / incumbent.length + variance(candidate) / candidate.length);
  return { delta: mean(candidate) - mean(incumbent), margin: Math.max(minMargin, marginZ * se) };
}

export function buildLivePorts(options: LivePortsOptions): HillClimbPorts<string> {
  const judges = options.judges ?? 3;
  if (!Number.isInteger(judges) || judges < 2) throw new RangeError(`judges must be an integer >= 2, got ${judges}`);
  const targets = options.targets ?? P5_TARGETS;
  // Judge scores per artifact: an incumbent is compared many times and scored once.
  const scores = new Map<string, Promise<number[]>>();
  const scoreAll = (code: string): Promise<number[]> => {
    const key = defaultFingerprint(code);
    let pending = scores.get(key);
    if (!pending) {
      // One after another: a local judge serves one request at a time.
      pending = (async () => {
        const out: number[] = [];
        for (let i = 0; i < judges; i++) {
          const s = await options.score(code);
          if (!Number.isFinite(s) || s < 0 || s > 1) throw new Error(`HILLCLIMB_SCORE_INVALID: judge returned ${s}`);
          out.push(s);
        }
        return out;
      })();
      // A failed scoring is retried on the next ask, never cached.
      pending.catch(() => scores.delete(key));
      scores.set(key, pending);
    }
    return pending;
  };

  return {
    async propose({ incumbent, target, widen }) {
      const user = mutationPrompt({ incumbent, target, widen, brief: options.brief, instruction: targets[target] ?? target });
      // bypassCache: the same incumbent and target must yield a new sample each step (bug 8).
      const response = await options.generator.generate(MUTATE_SYSTEM_PROMPT, user, undefined, true);
      if (!response.success) throw new Error(`HILLCLIMB_PROPOSE_FAILED: ${response.error ?? 'generator returned no success'}`);
      if (response.fromCache) throw new Error('HILLCLIMB_PROPOSE_CACHED: a proposal came from cache');
      const checked = options.validate(response.code);
      if (!checked.valid) throw new Error(`HILLCLIMB_PROPOSE_INVALID: ${checked.errors.join('; ') || 'validator rejected the sketch'}`);
      if (defaultFingerprint(checked.cleanedCode) === defaultFingerprint(incumbent)) {
        throw new Error('HILLCLIMB_PROPOSE_UNCHANGED: the proposal is identical to the incumbent');
      }
      return checked.cleanedCode;
    },
    oracle: pairOracle(options.decisionModel, `${options.rubric}\nBrief: ${options.brief}`),
    async verify(incumbent, candidate) {
      const a = await scoreAll(incumbent);
      const b = await scoreAll(candidate);
      return verdictFromScores(a, b, options.marginZ, options.minMargin);
    },
  };
}
