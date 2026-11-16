import { describe, expect, it } from 'vitest';

import { calibrateAcceptance, pairOracle, type OracleSample } from '../../../src/atelier/HillClimb.js';
import { DecisionModelClient } from '../../../src/llm/DecisionModelClient.js';

/**
 * d1 as the hill-climb's acceptance oracle: live proof.
 *
 * Gated because it needs a server answering POST /v1/systemone with LiquidAI/d1-2B
 * loaded (llama.cpp, or the shard worker's transformers route), reachable at
 * LFM_D1_BASE_URL. When the gate is enabled, a missing endpoint is a real failure,
 * not a silent skip. The run prints one JSON line per pair: those lines fill the
 * "pending live run" table in docs/design/lfm3-hillclimb-20261109.md.
 *
 * Latency is timed per oracle() call, run one at a time, so it is the cost the
 * loop pays for one decision (both orders), not one HTTP request under load.
 */

const RUN_LFM = process.env.RUN_LFM_MODEL_TESTS === '1' || process.env.RUN_LFM_MODEL_TESTS === 'true';
const REQUEST_TIMEOUT_MS = 30000;

const RUBRIC = 'A p5.js sketch is better when it runs without errors and shows smooth, visible motion.';
const MOVING = 'function setup(){createCanvas(200,200);}\n'
  + 'function draw(){background(20);fill(255,120,0);circle(100+80*sin(frameCount*0.05),100,30);}';
/** Each pair is [worse, better] by construction, so the gold label needs no judge. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['function setup(){createCanvas(200,200);}\nfunction draw(){}', MOVING],
  ['function setup(){createCanvas(200,200)\nfunction draw(){background(20);circle(100,100', MOVING],
  ['function setup(){createCanvas(200,200);}\nfunction draw(){background(20);circle(100,100,30);}', MOVING],
  ['function setup(){noCanvas();}\nfunction draw(){undefinedFunction();}', MOVING],
];

describe.skipIf(process.env.CI || !RUN_LFM)('d1-2B as hill-climb acceptance oracle', () => {
  it('prefers the better sketch in every unambiguous pair, in both directions', async () => {
    const baseUrl = process.env.LFM_D1_BASE_URL;
    if (!baseUrl) throw new Error('RUN_LFM_MODEL_TESTS is set but LFM_D1_BASE_URL is not');
    const latenciesMs: number[] = [];
    const client = new DecisionModelClient({ baseUrl, model: 'LiquidAI/d1-2B', timeoutMs: REQUEST_TIMEOUT_MS });
    const pair = pairOracle(client, RUBRIC);
    const oracle = async (a: string, b: string): Promise<number> => {
      const started = performance.now();
      const p = await pair(a, b);
      latenciesMs.push(performance.now() - started);
      return p;
    };

    const samples: OracleSample[] = [];
    for (const [index, [worse, better]] of PAIRS.entries()) {
      const up = await oracle(worse, better);
      const down = await oracle(better, worse);
      console.info(JSON.stringify({ pair: index, pImprovement: up, pRegression: down }));
      samples.push({ p: up, gold: true }, { p: down, gold: false });
      expect(up).toBeGreaterThan(0.5);
      expect(up).toBeLessThanOrEqual(1);
      expect(down).toBeGreaterThanOrEqual(0);
      expect(down).toBeLessThan(0.5);
    }

    const sorted = [...latenciesMs].sort((a, b) => a - b);
    const calibration = calibrateAcceptance(samples);
    console.info(JSON.stringify({
      calls: sorted.length, medianLatencyMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
      brier: calibration.brier, ece: calibration.ece,
    }));
    // Two oracle decisions per pair, one in each direction.
    expect(latenciesMs).toHaveLength(PAIRS.length * 2);
    // Eight samples can never calibrate a threshold: the loop would still escalate every step.
    expect(calibration.acceptAt).toBeNull();
    expect(calibration.rejectAt).toBeNull();
  }, REQUEST_TIMEOUT_MS * PAIRS.length * 4);
});
