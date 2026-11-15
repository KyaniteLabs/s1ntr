/**
 * Unit tests for scripts/audition-379.mjs — pure helpers + mocked cell run.
 * No live providers.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const modPath = path.join(root, 'scripts/audition-379.mjs');

const m = await import(modPath);

describe('audition-379 parseArgs', () => {
  it('defaults to both exams', () => {
    const a = m.parseArgs([]);
    expect(a.exam).toBe('both');
    expect(a.tracer).toBe(false);
  });

  it('--tracer and --exam generator', () => {
    const a = m.parseArgs(['--tracer', '--exam', 'generator']);
    expect(a.tracer).toBe(true);
    expect(a.exam).toBe('generator');
  });

  it('--reasoning high', () => {
    const a = m.parseArgs(['--reasoning', 'high', '--exam', 'generator']);
    expect(a.reasoning).toBe('high');
    expect(a.exam).toBe('generator');
  });

  it('rejects unknown reasoning level', () => {
    expect(() => m.parseArgs(['--reasoning', 'ultra'])).toThrow(/reasoning/i);
  });

  it('rejects unknown exam', () => {
    expect(() => m.parseArgs(['--exam', 'seat-swap'])).toThrow(/exam/i);
  });

  it('rejects unknown domain', () => {
    expect(() => m.parseArgs(['--domain', 'p5'])).toThrow(/domain/i);
  });
});

describe('audition-379 reasoning injection', () => {
  it('proxy seats get dual OpenAI reasoning params + env', () => {
    const luna = m.EXAM_MODELS.find((x: { id: string }) => x.id === 'gpt-5.6-luna');
    const inj = m.buildReasoningInjection(luna, 'high');
    expect(inj.requested).toBe('high');
    expect(inj.style).toBe('openai_reasoning_effort');
    expect(inj.params).toEqual({
      reasoning_effort: 'high',
      reasoning: { effort: 'high' },
    });
    expect(inj.env.SINTER_LLM_THINKING_EFFORT).toBe('high');
    expect(inj.env.LIMINAL_REASONING_EFFORT).toBe('high');
    expect(inj.pinnable).toBe(true);
  });

  it('gemini-3.1-pro-low keeps id but marks pinnable uncertain at high', () => {
    const pro = m.EXAM_MODELS.find((x: { id: string }) => x.id === 'gemini-3.1-pro-low');
    const inj = m.buildReasoningInjection(pro, 'high');
    expect(inj.params.reasoning_effort).toBe('high');
    expect(inj.pinnable).toBe('uncertain');
    expect(inj.note).toMatch(/unpinnable|gemini-3\.6-flash-high/i);
  });

  it('MiniMax uses anthropic thinking budget', () => {
    const mm = m.EXAM_MODELS.find((x: { id: string }) => x.id === 'MiniMax-M3');
    const inj = m.buildReasoningInjection(mm, 'high');
    expect(inj.style).toBe('anthropic_thinking');
    expect(inj.params.thinking).toEqual({ type: 'enabled', budget_tokens: 16_000 });
    expect(m.thinkingBudgetForEffort('high')).toBe(16_000);
    expect(m.thinkingBudgetForEffort('medium')).toBe(8_000);
  });

  it('modelEnvForSeat injects reasoning env when requested', () => {
    const secrets = { codexKey: 'proxy-secret', minimaxKey: 'mm-secret' };
    const luna = m.EXAM_MODELS.find((x: { id: string }) => x.id === 'gpt-5.6-luna');
    const env = m.modelEnvForSeat(luna, secrets, {}, { role: 'generator', reasoning: 'high' });
    expect(env.SINTER_LLM_THINKING_EFFORT).toBe('high');
    expect(env.LIMINAL_LLM_THINKING_EFFORT).toBe('high');
    expect(env.SINTER_REASONING_EFFORT).toBe('high');
  });

  it('extractReasoningEvidence detects reasoning_tokens', () => {
    const ev = m.extractReasoningEvidence({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 42 },
      },
      choices: [{ message: { content: 'pong', reasoning_content: 'think hard' } }],
    });
    expect(ev.tookEffect).toBe(true);
    expect(ev.usage.reasoning_tokens).toBe(42);
    expect(ev.usage.prompt).toBe(10);
    expect(ev.evidence).toMatch(/reasoning_tokens=42/);
    expect(ev.evidence).toMatch(/reasoning_content/);
  });

  it('extractReasoningEvidence honest empty when no signal', () => {
    const ev = m.extractReasoningEvidence({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ message: { content: 'pong' } }],
    });
    expect(ev.tookEffect).toBe(false);
    expect(ev.usage.reasoning_tokens).toBeNull();
    expect(ev.evidence).toMatch(/no reasoning/i);
  });

  it('buildReceipt carries reasoning usage block', () => {
    const receipt = m.buildReceipt({
      exam: 'generator',
      model: 'gpt-5.6-luna',
      models: { generator: 'gpt-5.6-luna', evaluator: null },
      domain: 'kinetic',
      promptId: 'kinetic-01',
      promptHash: 'a'.repeat(64),
      gatesAtShot1: m.emptyGates(),
      gatesFinal: m.emptyGates(),
      attemptsUsed: 1,
      scores: {},
      iterationsUsed: 1,
      latencyMs: 100,
      providerRoute: 'codex-proxy:x',
      reasoning: {
        requested: 'high',
        evidence: 'reasoning_tokens=12',
        usage: { prompt: 5, completion: 9, reasoning_tokens: 12 },
        pinnable: true,
      },
      artifactPath: null,
      htmlPath: null,
      screenshotPath: null,
      cellDir: '/tmp/c',
      tracesDir: '/tmp/c/traces',
      failureClass: null,
      fallbackTriggered: false,
      retryOn401: false,
      authError: null,
      rateLimitError: null,
      success: false,
    });
    expect(receipt.reasoning.requested).toBe('high');
    expect(receipt.reasoning.usage.reasoning_tokens).toBe(12);
    expect(receipt.artifactPaths.tracesDir).toBe('/tmp/c/traces');
  });

  it('summarizeGeneratorByModel includes reasoning token sum', () => {
    const cells = [
      {
        model: 'm1',
        gatesAtShot1: { allPass: true },
        gatesFinal: { allPass: true },
        success: true,
        attemptsUsed: 1,
        latencyMs: 100,
        reasoning: { usage: { reasoning_tokens: 50 } },
      },
      {
        model: 'm1',
        gatesAtShot1: { allPass: false },
        gatesFinal: { allPass: true },
        success: true,
        attemptsUsed: 2,
        latencyMs: 200,
        reasoning: { usage: { reasoning_tokens: 30 } },
      },
    ];
    const by = m.summarizeGeneratorByModel(cells);
    expect(by.m1.gateAt1).toBe(1);
    expect(by.m1.gateFinal).toBe(2);
    expect(by.m1.reasoningTokensSum).toBe(80);
    expect(by.m1.meanReasoningTokens).toBe(40);
  });
});

describe('audition-379 exam models', () => {
  it('lists 4 same-tier models and never Kilo', () => {
    expect(m.EXAM_MODELS).toHaveLength(4);
    const ids = m.EXAM_MODELS.map((x: { id: string }) => x.id);
    expect(ids).toContain('gpt-5.6-luna');
    expect(ids).toContain('gemini-3.6-flash-high');
    expect(ids).toContain('gemini-3.1-pro-low');
    expect(ids).toContain('MiniMax-M3');
    expect(ids.join(' ').toLowerCase()).not.toMatch(/kilo/);
  });

  it('selectExamModels tracer takes first only', () => {
    const models = m.selectExamModels({ tracer: true });
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('gpt-5.6-luna');
  });
});

describe('audition-379 seatEnvForConfig (legacy A/B shim)', () => {
  const secrets = { codexKey: 'proxy-secret', minimaxKey: 'mm-secret' };

  it('A: Luna gen + MiniMax eval; never sets KILO key', () => {
    const seat = m.seatEnvForConfig('A', secrets, { PATH: '/usr/bin' });
    expect(seat.models.generator).toBe('gpt-5.6-luna');
    expect(seat.models.evaluator).toBe('MiniMax-M3');
    expect(seat.env.LIMINAL_LLM_BASE_URL).toContain('8317');
    expect(seat.env.LIMINAL_EVALUATOR_BASE_URL).toContain('minimax.io');
    expect(seat.env.KILO_API_KEY).toBe('');
    expect(seat.env.LIMINAL_LLM_API_KEY).toBe('proxy-secret');
    expect(seat.env.LIMINAL_EVALUATOR_API_KEY).toBe('mm-secret');
  });

  it('B: MiniMax gen + Luna eval (swapped)', () => {
    const seat = m.seatEnvForConfig('B', secrets, {});
    expect(seat.models.generator).toBe('MiniMax-M3');
    expect(seat.models.evaluator).toBe('gpt-5.6-luna');
    expect(seat.env.LIMINAL_LLM_BASE_URL).toContain('minimax.io');
    expect(seat.env.LIMINAL_EVALUATOR_BASE_URL).toContain('8317');
  });
});

describe('audition-379 modelEnvForSeat', () => {
  const secrets = { codexKey: 'proxy-secret', minimaxKey: 'mm-secret' };

  it('scrubs Kilo and points generator at model', () => {
    const gem = m.EXAM_MODELS.find((x: { id: string }) => x.id === 'gemini-3.6-flash-high');
    const env = m.modelEnvForSeat(gem, secrets, {});
    expect(env.LIMINAL_LLM_MODEL).toBe('gemini-3.6-flash-high');
    expect(env.LIMINAL_LLM_BASE_URL).toContain('8317');
    expect(env.KILO_API_KEY).toBe('');
    expect(env.LIMINAL_EVAL_MODE).toBe('legacy');
  });

  it('evaluator role uses auto eval mode', () => {
    const luna = m.EXAM_MODELS.find((x: { id: string }) => x.id === 'gpt-5.6-luna');
    const env = m.modelEnvForSeat(luna, secrets, {}, { role: 'evaluator' });
    expect(env.LIMINAL_EVAL_MODE).toBe('auto');
    expect(env.LIMINAL_EVALUATOR_MODEL).toBe('gpt-5.6-luna');
  });
});

describe('audition-379 resolveCodexProxyKey', () => {
  it('prefers env over keychain', () => {
    const r = m.resolveCodexProxyKey({ CODEX_PROXY_API_KEY: 'from-env' }, () => {
      throw new Error('keychain should not run');
    });
    expect(r).toEqual({ key: 'from-env', source: 'env' });
  });

  it('falls back to keychain runner', () => {
    const r = m.resolveCodexProxyKey({}, () => 'from-keychain\n');
    expect(r).toEqual({ key: 'from-keychain', source: 'keychain' });
  });
});

describe('audition-379 parseGenerationOutput', () => {
  it('parses healthy score line and artifact path', () => {
    const stdout = [
      '✅ Generation complete!',
      '📊 Iterations: 1',
      '⭐ Quality score: 0.82',
      '🤖 Model: gpt-5.6-luna',
      '✅ Saved: /tmp/out/sketch.js',
      '✅ HTML: /tmp/out/sketch.html',
    ].join('\n');
    const p = m.parseGenerationOutput(stdout);
    expect(p.success).toBe(true);
    expect(p.score).toBe(0.82);
    expect(p.iterationsUsed).toBe(1);
    expect(p.artifactPath).toBe('/tmp/out/sketch.js');
    expect(p.htmlPath).toBe('/tmp/out/sketch.html');
    expect(p.fallbackTriggered).toBe(false);
  });

  it('detects 401 and fallback text', () => {
    expect(m.isAuth401('Error: 401 Unauthorized')).toBe(true);
    expect(m.detectFallbackTriggered('fallbackUsed: true to GLM-5.2')).toBe(true);
  });

  it('marks empty skeleton as not success', () => {
    const p = m.parseGenerationOutput('⚠️ No usable artifact produced.\n⭐ Quality score: 0.00');
    expect(p.success).toBe(false);
  });
});

describe('audition-379 hard prompts + blind pack', () => {
  const prompts = [
    { id: 'kinetic-01', domain: 'kinetic', text: 'k1', sha256: 'a'.repeat(64) },
    { id: 'kinetic-02', domain: 'kinetic', text: 'k2', sha256: 'c'.repeat(64) },
    { id: 'ascii-01', domain: 'ascii', text: 'a1', sha256: 'b'.repeat(64) },
  ];

  it('selectHardPrompts takes one per domain', () => {
    const hard = m.selectHardPrompts(prompts);
    expect(hard).toHaveLength(2);
    expect(hard.map((p: { id: string }) => p.id).sort()).toEqual(['ascii-01', 'kinetic-01']);
  });

  it('tracer hard prompts = 1', () => {
    const hard = m.selectHardPrompts(prompts, { tracer: true });
    expect(hard).toHaveLength(1);
  });

  it('buildBlindPack strips model from index and keeps it in key', () => {
    let i = 0;
    const rng = () => {
      i += 1;
      return i % 2 === 0 ? 0.9 : 0.1;
    };
    const cells = [
      {
        model: 'gpt-5.6-luna',
        domain: 'kinetic',
        promptHash: 'aa',
        artifactPath: '/a.js',
        htmlPath: null,
        screenshotPath: null,
        receiptPath: '/rA.json',
      },
      {
        model: 'MiniMax-M3',
        domain: 'kinetic',
        promptHash: 'aa',
        artifactPath: '/b.js',
        htmlPath: null,
        screenshotPath: null,
        receiptPath: '/rB.json',
      },
    ];
    const { index, key } = m.buildBlindPack(cells, { rng });
    expect(Object.keys(index)).toHaveLength(2);
    expect(index.b01.artifactPath).toMatch(/\S/);
    expect((index.b01 as { model?: string }).model).toBeUndefined();
    expect(key.b01.model).toMatch(/gpt-5.6-luna|MiniMax-M3/);
  });
});

describe('audition-379 deterministic gates + repair prompt', () => {
  it('formatGateErrors lists FAIL lines only with detail', () => {
    const gates = {
      parse: { pass: false, errors: ['unexpected token'] },
      render: { pass: true, errors: [] },
      nonblank: { pass: false, errors: ['variance 0'], variance: 0 },
      allPass: false,
    };
    const text = m.formatGateErrors(gates);
    expect(text).toMatch(/parse: FAIL/);
    expect(text).toMatch(/unexpected token/);
    expect(text).toMatch(/render: PASS/);
    expect(text).toMatch(/nonblank: FAIL/);
  });

  it('buildRepairPrompt embeds original + gate errors + previous code', () => {
    const gates = m.emptyGates();
    gates.parse = { pass: false, errors: ['syntax'] };
    const p = m.buildRepairPrompt('make art', gates, 'function broken(){');
    expect(p).toContain('make art');
    expect(p).toContain('DETERMINISTIC GATE FAILURE');
    expect(p).toContain('function broken(){');
  });

  it('runDeterministicGates: empty code fails parse', async () => {
    const gates = await m.runDeterministicGates({
      domain: 'ascii',
      code: '',
      artifactPath: null,
      htmlPath: null,
      screenshotPath: null,
      CodeValidator: null,
    });
    expect(gates.parse.pass).toBe(false);
    expect(gates.allPass).toBe(false);
  });

  it('runDeterministicGates: tone needs Tone.js surface', async () => {
    const gates = await m.runDeterministicGates({
      domain: 'tone',
      code: 'const x = 1; // not audio',
      artifactPath: '/tmp/x.js',
      htmlPath: null,
      screenshotPath: null,
      CodeValidator: {
        validate: () => ({ valid: true, cleanedCode: 'const x = 1', errors: [] }),
      },
    });
    expect(gates.parse.pass).toBe(true);
    expect(gates.nonblank.pass).toBe(false);
  });

  it('runDeterministicGates: nonblank uses variance fn', async () => {
    const gates = await m.runDeterministicGates({
      domain: 'kinetic',
      code: '<html></html>',
      artifactPath: '/tmp/a.html',
      htmlPath: '/tmp/a.html',
      screenshotPath: '/tmp/shot.png',
      CodeValidator: {
        validate: () => ({ valid: true, cleanedCode: '<html></html>', errors: [] }),
      },
      varianceFn: async () => 42,
    });
    // pathExists will fail for /tmp/shot.png unless we create it — variance only if path exists
    // When path missing, nonblank fails without calling variance
    expect(gates.nonblank.pass).toBe(false);
  });
});

describe('audition-379 evaluator metrics', () => {
  it('summarizeEvaluatorResults computes accuracy, FP, consistency', () => {
    const results = [
      { model: 'm1', itemId: 'bad-1', label: 'known-bad', groundTruthPass: false, pass: false, score: 0.2, visionUsed: true, visionAccepted: true },
      { model: 'm1', itemId: 'bad-2', label: 'known-bad', groundTruthPass: false, pass: true, score: 0.8, visionUsed: true, visionAccepted: true },
      { model: 'm1', itemId: 'good-1', label: 'known-good', groundTruthPass: true, pass: true, score: 0.9, visionUsed: true, visionAccepted: false },
    ];
    const summary = m.summarizeEvaluatorResults(results, {
      consistencyPairs: [
        { model: 'm1', score1: 0.9, score2: 0.7 },
        { model: 'm1', score1: 0.2, score2: 0.25 },
      ],
    });
    expect(summary.m1.accuracy).toBeCloseTo(2 / 3, 5);
    expect(summary.m1.falsePositiveRate).toBeCloseTo(0.5, 5);
    expect(summary.m1.meanAbsScoreDelta).toBeCloseTo((0.2 + 0.05) / 2, 5);
    expect(summary.m1.visionUsedRate).toBeCloseTo(2 / 3, 5);
  });

  it('passFailFromScore threshold 0.5', () => {
    expect(m.passFailFromScore(0.5)).toBe(true);
    expect(m.passFailFromScore(0.49)).toBe(false);
    expect(m.passFailFromScore(null)).toBe(false);
  });
});

describe('audition-379 runGeneratorCell (mocked sinter)', () => {
  it('repairs once when shot-1 gates fail then pass', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'audition-379-gen-'));
    let calls = 0;
    const runSinter = vi.fn(async ({ outDir }: { outDir: string }) => {
      calls += 1;
      await fs.mkdir(outDir, { recursive: true });
      // Shot 1: empty-ish broken; shot 2+: good ascii
      const body = calls === 1
        ? 'x'
        : 'ASCII FRAME 0\n  +------+\n  | #### |\n  +------+\n  legend: nested cube plan elev\n  F0 F1 F2 F3 F4';
      const p = path.join(outDir, 'cli-project-final.txt');
      await fs.writeFile(p, body, 'utf8');
      return {
        code: 0,
        stdout: [
          '✅ Generation complete!',
          '📊 Iterations: 1',
          '⭐ Quality score: 0.5',
          `✅ Saved: ${p}`,
        ].join('\n'),
        stderr: '',
        timedOut: false,
      };
    });

    const text = 'ASCII art of a lattice that folds';
    const promptHash = createHash('sha256').update(text).digest('hex');
    const modelSpec = m.EXAM_MODELS.find((x: { id: string }) => x.id === 'MiniMax-M3');

    const cell = await m.runGeneratorCell({
      modelSpec,
      prompt: { id: 'ascii-01', domain: 'ascii', text, sha256: promptHash },
      outRoot: tmp,
      secrets: { codexKey: 'c', minimaxKey: 'm' },
      runId: 'test-run',
      runSinter,
      screenshot: async ({ outPng }: { outPng: string }) => {
        await fs.writeFile(outPng, Buffer.from([137, 80, 78, 71]), 'binary');
        return { path: outPng, errors: [] };
      },
      maxRepairs: 2,
    });

    expect(runSinter.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cell.attemptsUsed).toBeGreaterThanOrEqual(2);
    expect(cell.gatesAtShot1.allPass).toBe(false);
    // Second attempt should produce non-sparse ascii
    expect(cell.gatesFinal.allPass).toBe(true);
    expect(cell.success).toBe(true);
    expect(cell.model).toBe('MiniMax-M3');

    const receipt = JSON.parse(await fs.readFile(cell.receiptPath, 'utf8'));
    expect(receipt.exam).toBe('generator');
    expect(receipt.attemptsUsed).toBe(cell.attemptsUsed);

    // Repair prompt must carry gate error text only (no aesthetic judge)
    const repairPrompt = runSinter.mock.calls[1][0].prompt as string;
    expect(repairPrompt).toMatch(/DETERMINISTIC GATE FAILURE/);
    expect(repairPrompt).not.toMatch(/gallery-grade|rubric/i);
  });

  it('records 401 and continues', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'audition-379-401-'));
    let calls = 0;
    const runSinter = vi.fn(async ({ outDir }: { outDir: string }) => {
      calls += 1;
      await fs.mkdir(outDir, { recursive: true });
      if (calls <= 2) {
        return { code: 1, stdout: '', stderr: 'Error: 401 Unauthorized invalid api key', timedOut: false };
      }
      const p = path.join(outDir, 'ok.txt');
      await fs.writeFile(p, 'line1\nline2\nline3\nenough ascii content here for gate', 'utf8');
      return {
        code: 0,
        stdout: `✅ Generation complete!\n📊 Iterations: 1\n⭐ Quality score: 0.5\n✅ Saved: ${p}\n`,
        stderr: '',
        timedOut: false,
      };
    });

    const text = 'retry me';
    const cell = await m.runGeneratorCell({
      modelSpec: m.EXAM_MODELS[0],
      prompt: {
        id: 'ascii-01',
        domain: 'ascii',
        text,
        sha256: createHash('sha256').update(text).digest('hex'),
      },
      outRoot: tmp,
      secrets: { codexKey: 'c', minimaxKey: 'm' },
      runId: 'retry-run',
      runSinter,
      screenshot: async () => ({ path: null, errors: [] }),
      maxRepairs: 2,
    });

    expect(cell.retryOn401).toBe(true);
    expect(cell.authError).toMatch(/auth|401/i);
  });
});

describe('audition-379 runCell legacy (mocked)', () => {
  it('writes receipt + ledger for config B', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'audition-379-legacy-'));
    const runSinter = vi.fn(async ({ outDir }: { outDir: string }) => {
      await fs.mkdir(outDir, { recursive: true });
      const p = path.join(outDir, 'cli-project-final.txt');
      await fs.writeFile(p, 'ascii body', 'utf8');
      return {
        code: 0,
        stdout: [
          '✅ Generation complete!',
          '📊 Iterations: 1',
          '⭐ Quality score: 0.77',
          '🤖 Model: MiniMax-M3',
          `✅ Saved: ${p}`,
        ].join('\n'),
        stderr: '',
        timedOut: false,
      };
    });

    const promptText = 'ASCII art of a lattice that folds';
    const promptHash = createHash('sha256').update(promptText).digest('hex');
    const cell = await m.runCell({
      config: 'B',
      prompt: { id: 'ascii-01', domain: 'ascii', text: promptText, sha256: promptHash },
      iterations: 1,
      outRoot: tmp,
      secrets: { codexKey: 'c', minimaxKey: 'm' },
      runId: 'test-run',
      runSinter,
      screenshot: async () => null,
    });

    expect(runSinter).toHaveBeenCalledTimes(1);
    expect(cell.success).toBe(true);
    expect(cell.scores.iter1).toBe(0.77);
    expect(cell.models.generator).toBe('MiniMax-M3');
    expect(cell.models.evaluator).toBe('gpt-5.6-luna');

    const ledgerDir = path.join(tmp, 'ledger', 'audition');
    const files = await fs.readdir(ledgerDir);
    expect(files.some((f: string) => f.endsWith('.jsonl'))).toBe(true);
  });
});

describe('audition-379 prompts pack', () => {
  it('ships 5 domains × 5 prompts with matching sha256', async () => {
    const pack = JSON.parse(await fs.readFile(path.join(root, 'audition/prompts.json'), 'utf8'));
    const domains = ['kinetic', 'textgen', 'ascii', 'hydra', 'tone'];
    for (const d of domains) {
      expect(pack.domains[d]).toHaveLength(5);
      for (const entry of pack.domains[d]) {
        const h = createHash('sha256').update(entry.text, 'utf8').digest('hex');
        expect(entry.sha256).toBe(h);
        expect(entry.text.length).toBeGreaterThan(80);
      }
    }
  });
});
