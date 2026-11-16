import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { DecisionOracle } from '../../../src/atelier/HillClimb.js';
import { buildLivePorts, mutationPrompt, verdictFromScores, type LivePortsOptions } from '../../../src/atelier/HillClimbLivePorts.js';
import { runHillClimbCommand } from '../../../src/cli/HillClimbCli.js';

// #1423 PR 7: the live ports. Fakes stand in for the generator, d1 and the judges.

const SKETCH = 'function setup() { createCanvas(100, 100); }\nfunction draw() { background(0); }';
const validOk = (code: string) => ({ valid: true, cleanedCode: code.trim(), errors: [] });
const oracle = (p = 0.7): DecisionOracle => ({
  decide: vi.fn(async () => ({ answers: { better: { type: 'noul', probability: p } } })),
});

function ports(extra: Partial<LivePortsOptions> = {}) {
  let n = 0;
  const generator = { generate: vi.fn(async () => ({ success: true, code: `${SKETCH}\n// v${(n += 1)}` })) };
  const score = vi.fn(async (code: string) => (code.includes('v1') ? 0.8 : 0.5) + (score.mock.calls.length % 2) * 0.01);
  const built = buildLivePorts({
    generator, validate: validOk, decisionModel: oracle(), score, brief: 'calm tide', rubric: 'better art', ...extra,
  });
  return { built, generator, score };
}

describe('propose (bug 8)', () => {
  it('bypasses the cache and names the target and the widen flag', async () => {
    const { built, generator } = ports();
    await built.propose({ incumbent: SKETCH, target: 'palette', widen: true });
    const [system, user, , bypass] = generator.generate.mock.calls[0] as unknown as [string, string, unknown, boolean];
    expect(bypass).toBe(true);
    expect(system).toMatch(/ONE aspect/);
    expect(user).toMatch(/palette/);
    expect(user).toMatch(/BOLD/);
  });

  it('fails on a generator failure, a cached reply, an invalid sketch or no change', async () => {
    const fail = buildLivePorts({ generator: { generate: async () => ({ success: false, code: '', error: 'token cap' }) },
      validate: validOk, decisionModel: oracle(), score: async () => 0.5, brief: 'b', rubric: 'r' });
    await expect(fail.propose({ incumbent: SKETCH, target: 'motion', widen: false })).rejects.toThrow('HILLCLIMB_PROPOSE_FAILED: token cap');

    const cached = buildLivePorts({ generator: { generate: async () => ({ success: true, code: 'x', fromCache: true }) },
      validate: validOk, decisionModel: oracle(), score: async () => 0.5, brief: 'b', rubric: 'r' });
    await expect(cached.propose({ incumbent: SKETCH, target: 'motion', widen: false })).rejects.toThrow('HILLCLIMB_PROPOSE_CACHED');

    const invalid = buildLivePorts({ generator: { generate: async () => ({ success: true, code: 'nope' }) },
      validate: () => ({ valid: false, cleanedCode: '', errors: ['no setup()'] }), decisionModel: oracle(),
      score: async () => 0.5, brief: 'b', rubric: 'r' });
    await expect(invalid.propose({ incumbent: SKETCH, target: 'motion', widen: false })).rejects.toThrow('no setup()');

    const same = buildLivePorts({ generator: { generate: async () => ({ success: true, code: `  ${SKETCH}  ` }) },
      validate: validOk, decisionModel: oracle(), score: async () => 0.5, brief: 'b', rubric: 'r' });
    await expect(same.propose({ incumbent: SKETCH, target: 'motion', widen: false })).rejects.toThrow('HILLCLIMB_PROPOSE_UNCHANGED');
  });

  it('the mutation prompt carries brief, instruction and incumbent', () => {
    const text = mutationPrompt({ incumbent: SKETCH, target: 'x', widen: false, brief: 'B', instruction: 'I' });
    expect(text).toContain('Brief: B');
    expect(text).toContain('(x): I');
    expect(text).toContain(SKETCH);
  });
});

describe('verify', () => {
  it('delta is the mean difference and margin the floored noise band', () => {
    const v = verdictFromScores([0.5, 0.5, 0.5], [0.8, 0.8, 0.8]);
    expect(v.delta).toBeCloseTo(0.3);
    expect(v.margin).toBe(0.02);
    const noisy = verdictFromScores([0.2, 0.8], [0.3, 0.9]);
    expect(noisy.margin).toBeGreaterThan(noisy.delta);
    expect(() => verdictFromScores([0.5], [0.6, 0.7])).toThrow('TOO_FEW_JUDGES');
  });

  it('scores each artifact judges times, once, and reuses the incumbent scores', async () => {
    const { built, score } = ports({ judges: 3 });
    const c1 = `${SKETCH}\n// v1`;
    const c2 = `${SKETCH}\n// v2`;
    const first = await built.verify(SKETCH, c1);
    expect(typeof first === 'object' && first.delta > first.margin).toBe(true);
    await built.verify(SKETCH, c2);
    expect(score).toHaveBeenCalledTimes(9);
  });

  it('a judge with no verdict is a port failure and is not cached', async () => {
    let fail = true;
    const score = vi.fn(async () => { if (fail) throw new Error('HILLCLIMB_JUDGE_NO_VERDICT'); return 0.5; });
    const built = buildLivePorts({ generator: { generate: async () => ({ success: true, code: 'x' }) },
      validate: validOk, decisionModel: oracle(), score, brief: 'b', rubric: 'r', judges: 2 });
    await expect(built.verify(SKETCH, 'other')).rejects.toThrow('NO_VERDICT');
    fail = false;
    await expect(built.verify(SKETCH, 'other')).resolves.toMatchObject({ delta: 0 });
  });

  it('rejects an out-of-range score and fewer than two judges', async () => {
    const built = buildLivePorts({ generator: { generate: async () => ({ success: true, code: 'x' }) },
      validate: validOk, decisionModel: oracle(), score: async () => 7, brief: 'b', rubric: 'r' });
    await expect(built.verify(SKETCH, 'other')).rejects.toThrow('HILLCLIMB_SCORE_INVALID');
    expect(() => buildLivePorts({ generator: { generate: async () => ({ success: true, code: 'x' }) },
      validate: validOk, decisionModel: oracle(), score: async () => 1, brief: 'b', rubric: 'r', judges: 1 })).toThrow(RangeError);
  });
});

describe('sinter hillclimb run', () => {
  it('runs the loop on injected ports, writes the step log and closes the ports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-run-'));
    const start = join(dir, 'start.js');
    const out = join(dir, 'steps.jsonl');
    writeFileSync(start, SKETCH);
    const { built } = ports();
    const close = vi.fn(async () => {});
    const factory = vi.fn(async () => ({ ports: built, close }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runHillClimbCommand(['run', start, 'brief=calm tide', 'oracle-url=http://127.0.0.1:9931', `out=${out}`,
      'steps=3', 'patience=5', 'judges=2'], factory);
    log.mockRestore();
    expect(factory.mock.calls[0][0]).toMatchObject({ brief: 'calm tide', steps: 3, judges: 2, oracleModel: 'LiquidAI/d1-2B' });
    expect(close).toHaveBeenCalledTimes(1);
    const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ domain: 'p5', seed: 1 });
  });

  it('refuses a run without brief, oracle-url or out', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const factory = vi.fn();
    await runHillClimbCommand(['run', 'start.js', 'out=x.jsonl', 'oracle-url=http://127.0.0.1:1'], factory);
    expect(factory).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    err.mockRestore();
  });
});
