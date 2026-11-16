/**
 * `sinter hillclimb run` (#1423 PR 7): one live climb of a p5 sketch.
 *
 * Generator proposes (role 'generator'), a decision model screens (oracle-url),
 * the evaluator role judges rendered evidence (verify). Provider calls run
 * inside the governed research-provider effect (bug 28), never as bare transports.
 * Spends provider calls: bin/sinter dispatches it only after role loading.
 */

import { readFileSync } from 'node:fs';

import {
  jsonlStepSink, parseCalibration, runHillClimb,
  type AcceptanceCalibration, type HillClimbPorts, type HillClimbResult,
} from '../atelier/HillClimb.js';
import { buildLivePorts, P5_TARGETS } from '../atelier/HillClimbLivePorts.js';

export interface LiveRunOptions {
  readonly start: string;
  readonly brief: string;
  readonly rubric: string;
  readonly steps: number;
  readonly patience: number;
  readonly seed: number;
  readonly judges: number;
  readonly out: string;
  readonly calibration: string | null;
  readonly oracleUrl: string;
  readonly oracleModel: string;
  readonly temperature: number | null;
}

export const DEFAULT_RUBRIC = 'Which sketch is the stronger generative artwork: composition, palette, motion with purpose, finish. Ignore code style.';

export function readCalibrationFile(path: string | null): AcceptanceCalibration | null {
  if (!path) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    throw new Error(`cannot read calibration ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const calibration = parseCalibration(raw);
  if (!calibration) throw new Error(`${path} is not a usable calibration`);
  return calibration;
}

/** Run the loop with given ports; the summary is what the CLI prints. */
export async function runLiveClimb(options: LiveRunOptions, ports: HillClimbPorts<string>) {
  const start = readFileSync(options.start, 'utf8');
  const result: HillClimbResult<string> = await runHillClimb(start, ports, {
    targets: Object.keys(P5_TARGETS), maxSteps: options.steps, patience: options.patience,
    calibration: readCalibrationFile(options.calibration), seed: options.seed, domain: 'p5',
    onStep: jsonlStepSink(options.out),
  });
  return {
    result,
    summary: {
      steps: result.steps.length, accepted: result.steps.filter(s => s.accepted).length,
      stopped: result.stopped, verifierCalls: result.verifierCalls, rollbacks: result.rollbacks,
      drifted: result.drifted, portFailures: result.portFailures, log: options.out,
    },
  };
}

type Role = 'generator' | 'evaluator';

/** Build the production ports. Returns them with a close() for the renderer and runtime. */
export async function buildProductionPorts(options: LiveRunOptions) {
  const { LLMClient } = await import('../llm/LLMClient.js');
  const { DecisionModelClient } = await import('../llm/DecisionModelClient.js');
  const { CapabilityRegistry } = await import('../llm/CapabilityRegistry.js');
  const { CodeValidator } = await import('../core/CodeValidator.js');
  const { HeadlessRenderer } = await import('../render/HeadlessRenderer.js');
  const { scoreRenderedEvidence } = await import('../core/ScoringEngine.js');
  const { bootstrapProductionLiminalRuntime } = await import('../runtime-core/ProductionLiminalRuntime.js');

  const generator = new LLMClient({ role: 'generator', ...(options.temperature !== null ? { temperature: options.temperature } : {}) });
  const evaluator = new LLMClient({ role: 'evaluator' });
  const temperature = generator.getConfig().temperature ?? 0;
  if (!(temperature > 0)) throw new Error(`generator temperature must be > 0 for distinct proposals, got ${temperature}`);
  if (CapabilityRegistry.isDecisionModel(String(evaluator.getConfig().model))) {
    throw new Error('the evaluator role is a decision model; verify needs an independent LLM judge');
  }
  const decisionModel = new DecisionModelClient({
    baseUrl: options.oracleUrl, model: options.oracleModel,
    allowRemoteHttp: (process.env.SINTER_DECISION_ALLOW_REMOTE_HTTP ?? process.env.LIMINAL_DECISION_ALLOW_REMOTE_HTTP) === '1',
  });

  const runtime = await bootstrapProductionLiminalRuntime();
  let calls = 0;
  const governed = <T>(role: Role, client: { getConfig(): { provider?: string; model?: string } }, purpose: string,
    effect: () => Promise<T>): Promise<T> => {
    const identity = `${client.getConfig().provider ?? 'configured'}/${client.getConfig().model}`;
    return runtime.port.runResearchProviderEffect({
      idempotencyKey: `hillclimb-${role}-${options.seed}-${(calls += 1)}-${Date.now()}`,
      binding: { surface: 'hillclimb', purpose, identity }, identity, role, maxTransportAttempts: 1, effect,
    });
  };

  const renderer = HeadlessRenderer.getInstance();
  const evidence = new Map<string, ReturnType<typeof renderer.renderWithEvidence>>();
  const render = (code: string) => {
    let pending = evidence.get(code);
    if (!pending) { pending = renderer.renderWithEvidence(code, { domain: 'p5' }); evidence.set(code, pending); }
    return pending;
  };

  const ports = buildLivePorts({
    brief: options.brief, rubric: options.rubric, judges: options.judges, decisionModel,
    validate: code => CodeValidator.validate(code, 'p5'),
    generator: {
      generate: (system, user, signal, bypassCache) =>
        governed('generator', generator, 'propose', () => generator.generate(system, user, signal, bypassCache)),
    },
    score: async code => {
      const ev = await render(code);
      const verdict = await governed('evaluator', evaluator, 'verify',
        () => scoreRenderedEvidence(ev, code, options.brief, evaluator, 'p5'));
      if (verdict.scoreState === 'unscored' || verdict.failureClass === 'infra' || verdict.failureClass === 'scorer'
        || verdict.failureClass === 'parse') {
        throw new Error(`HILLCLIMB_JUDGE_NO_VERDICT (${verdict.failureClass}): ${verdict.unscoredReason ?? 'judge gave no score'}`);
      }
      return verdict.score;
    },
  });

  return { ports, close: async () => { await renderer.close(); await runtime.close(); } };
}
