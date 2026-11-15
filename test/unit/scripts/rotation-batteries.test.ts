/**
 * Unit + mock integration tests for standing rotation batteries (#401).
 * No live LLM calls.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sharedPath = path.join(root, 'scripts/rotation/shared.mjs');
const batteriesPath = path.join(root, 'scripts/rotation/cli.mjs');
const batteriesModPath = path.join(root, 'scripts/rotation/batteries.mjs');

const shared = await import(sharedPath);
const { main } = await import(batteriesPath);
const {
  runBattery,
  loadSummary,
  loadAudition,
  runLiveTask,
  pngDimensionsFromBuffer,
} = await import(batteriesModPath);

describe('rotation parseArgs', () => {
  it('parses seat run', () => {
    const a = shared.parseRotationArgs(['generator', '--model', 'kimi-k3', '--reasoning', 'medium']);
    expect(a.subcommand).toBe('run');
    expect(a.seat).toBe('generator');
    expect(a.model).toBe('kimi-k3');
    expect(a.reasoning).toBe('medium');
  });

  it('parses report with a/b', () => {
    const a = shared.parseRotationArgs([
      'report',
      'harness',
      '--a',
      '/tmp/a',
      '--b',
      '/tmp/b',
    ]);
    expect(a.subcommand).toBe('report');
    expect(a.seat).toBe('harness');
    expect(a.compareA).toBe('/tmp/a');
    expect(a.compareB).toBe('/tmp/b');
  });

  it('rejects unknown seat', () => {
    expect(() => shared.parseRotationArgs(['wizard'])).toThrow(/Unknown rotation/);
  });

  it('rejects bad reasoning', () => {
    expect(() => shared.parseRotationArgs(['chat', '--reasoning', 'ultra'])).toThrow(/reasoning/);
  });

  it('parses --max-tasks', () => {
    const a = shared.parseRotationArgs(['evaluator', '--live', '--max-tasks', '3']);
    expect(a.maxTasks).toBe(3);
    expect(a.live).toBe(true);
  });
});

describe('rotation task loading', () => {
  it('loads generator pack with 6 tasks across 3 domains × 2 tiers', async () => {
    const pack = await shared.loadTaskPack('generator');
    expect(pack.issue).toBe(401);
    expect(pack.tasks).toHaveLength(6);
    const domains = new Set(pack.tasks.map((t: { domain: string }) => t.domain));
    expect(domains).toEqual(new Set(['p5', 'hydra', 'kinetic']));
    const tiers = new Set(pack.tasks.map((t: { tier: string }) => t.tier));
    expect(tiers).toEqual(new Set(['easy', 'hard']));
    expect(pack.fixedEvaluatorSeat).toBe('gemini-3.1-pro-low');
    expect(pack.reasoningLevel).toBe('medium');
  });

  it('loads evaluator pack with 20 cases (10 clean + 10 friction)', async () => {
    const pack = await shared.loadTaskPack('evaluator');
    expect(pack.cases).toHaveLength(20);
    const clean = pack.cases.filter((c: { label: string }) => c.label === 'clean-control');
    const friction = pack.cases.filter((c: { label: string }) => c.label === 'friction');
    expect(clean).toHaveLength(10);
    expect(friction).toHaveLength(10);
    for (const c of clean) expect(c.groundTruthPass).toBe(true);
    for (const c of friction) expect(c.groundTruthPass).toBe(false);
  });

  it('loads harness pack with 6 tasks including resume', async () => {
    const pack = await shared.loadTaskPack('harness');
    // 6 tasks: diagnose-plan, requeue-dogfood, packet-shaping, lint-class, guarded-test, resume.
    expect(pack.tasks).toHaveLength(6);
    expect(pack.tasks.some((t: { id: string }) => t.id.includes('resume'))).toBe(true);
    expect(pack.optionalJudges.glmCrossReview.required).toBe(false);
  });

  it('loads chat pack with 10 scripts', async () => {
    const pack = await shared.loadTaskPack('chat');
    expect(pack.tasks).toHaveLength(10);
    expect(pack.rubric.dimensions).toEqual(['honesty', 'usefulness', 'stanceAdherence']);
  });
});

describe('rotation metric computation', () => {
  it('computes generator gate rates', () => {
    const m = shared.computeGeneratorMetrics([
      {
        gateAt1: true,
        gatesFinal: { allPass: true },
        success: true,
        attemptsUsed: 1,
        latencyMs: 100,
        scores: { eval: 0.8 },
      },
      {
        gateAt1: false,
        gatesFinal: { allPass: true },
        success: true,
        attemptsUsed: 2,
        latencyMs: 200,
        scores: { eval: 0.6 },
      },
    ]);
    expect(m.n).toBe(2);
    expect(m.gateAt1Rate).toBe(0.5);
    expect(m.gateAtLte3Rate).toBe(1);
    expect(m.meanAttempts).toBe(1.5);
    expect(m.meanLatencyMs).toBe(150);
    expect(m.meanEvalScore).toBe(0.7);
    // north-star = blind-eval of gate-passers only (both passed gates)
    expect(m.northStarId).toBe('blindEvalScoreOfGatePassers');
    expect(m.northStar).toBe(0.7);
    expect(m.blindEvalScoreOfGatePassers).toBe(0.7);
  });

  it('generator north-star ignores eval scores on gate failures', () => {
    const m = shared.computeGeneratorMetrics([
      { gatesFinal: { allPass: true }, success: true, attemptsUsed: 1, scores: { eval: 0.9 }, latencyMs: 1 },
      { gatesFinal: { allPass: false }, success: false, attemptsUsed: 3, scores: { eval: 0.1 }, latencyMs: 1 },
    ]);
    expect(m.blindEvalScoreOfGatePassers).toBe(0.9);
    expect(m.northStar).toBe(0.9);
  });

  it('computes evaluator hit/FP/cant-tell/consistency', () => {
    const m = shared.computeEvaluatorMetrics([
      { taskId: 'a', pass: true, groundTruthPass: true, cantTell: false },
      { taskId: 'a', pass: true, groundTruthPass: true, cantTell: false },
      { taskId: 'b', pass: true, groundTruthPass: false, cantTell: false },
      { taskId: 'b', pass: false, groundTruthPass: false, cantTell: false },
      { taskId: 'c', pass: null, groundTruthPass: true, cantTell: true, verdict: 'cant_tell' },
    ]);
    expect(m.hitRate).toBe(0.75);
    expect(m.falsePositiveRate).toBe(0.5);
    expect(m.cantTellRate).toBe(0.2);
    expect(m.consistencyRate).toBe(0.5);
    // FP 0.5 > budget 0.1 → north-star null
    expect(m.northStarId).toBe('hitRateAtFixedFpBudget');
    expect(m.hitRateAtFixedFpBudget).toBeNull();
    expect(m.northStar).toBeNull();
    expect(m.fpBudgetHeld).toBe(false);
  });

  it('evaluator north-star holds when FP under budget', () => {
    const m = shared.computeEvaluatorMetrics([
      { taskId: 'a', pass: true, groundTruthPass: true, cantTell: false },
      { taskId: 'b', pass: false, groundTruthPass: false, cantTell: false },
    ]);
    expect(m.falsePositiveRate).toBe(0);
    expect(m.hitRateAtFixedFpBudget).toBe(1);
    expect(m.northStar).toBe(1);
  });

  it('all friction cases cant_tell → northStar null (no silent-pass hole)', () => {
    // fpDenom=0 → falsePositiveRate=null → must NOT budgetOk → northStar null
    const m = shared.computeEvaluatorMetrics([
      { taskId: 'eval-friction-blank-shot', pass: null, groundTruthPass: false, cantTell: true, verdict: 'cant_tell' },
      { taskId: 'eval-friction-swapped-shot', pass: null, groundTruthPass: false, cantTell: true, verdict: 'cant_tell' },
      { taskId: 'eval-friction-off-brief', pass: null, groundTruthPass: false, cantTell: true, verdict: 'cant_tell' },
      { taskId: 'eval-friction-subtle-syntax', pass: null, groundTruthPass: false, cantTell: true, verdict: 'cant_tell' },
      { taskId: 'eval-friction-rubric-gaming', pass: null, groundTruthPass: false, cantTell: true, verdict: 'cant_tell' },
    ]);
    expect(m.fpDenom).toBe(0);
    expect(m.falsePositiveRate).toBeNull();
    expect(m.fpBudgetHeld).toBe(false);
    expect(m.northStar).toBeNull();
    expect(m.hitRateAtFixedFpBudget).toBeNull();
  });

  it('F15: preCheckRejected never enters hit or FP counts', () => {
    // Pre-check catching blank frictions must NOT inflate hit rate (old F15 bug).
    const m = shared.computeEvaluatorMetrics([
      // real judge hits
      { taskId: 'a', pass: true, groundTruthPass: true, cantTell: false, verdict: 'pass' },
      { taskId: 'b', pass: false, groundTruthPass: false, cantTell: false, verdict: 'fail' },
      // pre-check rejections (would previously look like "hits" on friction GT=false)
      {
        taskId: 'blank',
        pass: null,
        groundTruthPass: false,
        cantTell: false,
        preCheckRejected: true,
        verdict: 'pre_check_rejected',
        failureClass: 'render',
      },
      {
        taskId: 'clean-no-shot',
        pass: false,
        groundTruthPass: true,
        cantTell: false,
        preCheckRejected: true,
        verdict: 'pre_check_rejected',
        failureClass: 'render',
      },
      // telemetry gap also excluded
      { taskId: 'gap', pass: null, groundTruthPass: true, cantTell: false, verdict: 'telemetry-gap', livePath: 'gap' },
    ]);
    expect(m.preCheckRejected).toBe(2);
    expect(m.hits).toBe(2);
    expect(m.hitDenom).toBe(2);
    expect(m.hitRate).toBe(1);
    expect(m.falsePositives).toBe(0);
    expect(m.fpDenom).toBe(1); // only judge friction case b
    expect(m.falsePositiveRate).toBe(0);
    expect(m.hitRateAtFixedFpBudget).toBe(1);
    expect(m.northStar).toBe(1);
  });

  it('computes harness step and self-check metrics', () => {
    const m = shared.computeHarnessMetrics([
      {
        success: true,
        stepsToVerifiedEdit: 5,
        rollbackCorrect: true,
        selfCheckUsed: { build: true, test: true, typecheck: true },
        proposalQuality: 0.8,
        resumed: true,
      },
      {
        success: false,
        stepsToVerifiedEdit: 10,
        rollbackCorrect: false,
        selfCheckUsed: { build: true, test: false, typecheck: false },
        proposalQuality: 0.4,
        resumed: false,
      },
    ]);
    expect(m.meanStepsToVerifiedEdit).toBe(7.5);
    expect(m.rollbackCorrectRate).toBe(0.5);
    expect(m.selfCheckUsage.buildRate).toBe(1);
    expect(m.selfCheckUsage.testRate).toBe(0.5);
    expect(m.meanProposalQuality).toBeCloseTo(0.6, 10);
    expect(m.resumeSuccessRate).toBe(0.5);
    expect(m.northStarId).toBe('verifiedEditsPerBoundedPass');
    expect(m.verifiedEditsPerBoundedPass).toBe(0.5);
    expect(m.northStar).toBe(0.5);
  });

  it('computes chat scores and claim-tag rate', () => {
    const m = shared.computeChatMetrics([
      {
        success: true,
        scores: { honesty: 0.9, usefulness: 0.8, stanceAdherence: 0.7 },
        claimTagsPresent: true,
      },
      {
        success: true,
        scores: { honesty: 0.5, usefulness: 0.4, stanceAdherence: 0.3 },
        claimTagsPresent: false,
      },
    ]);
    expect(m.meanHonesty).toBe(0.7);
    expect(m.claimTagRate).toBe(0.5);
    expect(m.northStarId).toBe('stanceAdherence');
    expect(m.stanceAdherence).toBe(0.5);
    expect(m.northStar).toBe(0.5);
  });
});

describe('rotation design law — failure space, version, tiers', () => {
  it('every seat maps all known failure classes (trace or blind)', () => {
    for (const seat of shared.SEATS) {
      const v = shared.validateFailureSpaceMap(seat);
      expect(v.ok).toBe(true);
      expect(v.errors).toEqual([]);
      expect(v.version).toBe(1);
      expect(typeof v.northStarId).toBe('string');
      expect(v.northStarId.length).toBeGreaterThan(0);
      expect(v.tracedCount).toBeGreaterThan(0);
    }
  });

  it('broken/empty failure-space map → ok:false (no vacuous pass)', () => {
    const empty = shared.validateFailureSpaceMap({
      version: 1,
      northStar: { id: 'x' },
      failureSpace: [],
      blindSpots: [],
    });
    expect(empty.ok).toBe(false);
    expect(empty.errors.some((e: string) => /failureSpace empty|no traced/i.test(e))).toBe(true);

    const onlyBlinds = shared.validateFailureSpaceMap({
      version: 1,
      northStar: { id: 'x' },
      failureSpace: [],
      blindSpots: shared.KNOWN_FAILURE_CLASSES.map((c: string) => ({ class: c, reason: 'n/a' })),
    });
    expect(onlyBlinds.ok).toBe(false);
    expect(onlyBlinds.errors).toContain('failureSpace empty');
    expect(onlyBlinds.errors).toContain('no traced failure classes');
  });

  it('declares the four north-star ids', () => {
    expect(shared.BATTERY_DESIGN.generator.northStar.id).toBe('blindEvalScoreOfGatePassers');
    expect(shared.BATTERY_DESIGN.evaluator.northStar.id).toBe('hitRateAtFixedFpBudget');
    expect(shared.BATTERY_DESIGN.harness.northStar.id).toBe('verifiedEditsPerBoundedPass');
    expect(shared.BATTERY_DESIGN.chat.northStar.id).toBe('stanceAdherence');
  });

  it('tier-0 failure blocks tier-1 for generator', () => {
    const raw = {
      gatesFinal: { parse: { pass: false }, render: { pass: true }, nonblank: { pass: true }, allPass: false },
      scores: { eval: 0.99 },
      success: false,
    };
    const r = shared.applyTierDiscipline('generator', { id: 'gen-p5-easy' }, raw);
    expect(r.tiers[0].pass).toBe(false);
    expect(r.tiers[1].skipped).toBe(true);
    expect(r.tiers.stoppedAt).toBe(shared.TIER.DETERMINISTIC);
    expect(r.tiers.order).toEqual([0, 1, 2]);
  });

  it('tier-0 pass enables tier-1 then defers tier-2 to human', () => {
    const raw = {
      gatesFinal: { parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true },
      gateAtLte3: true,
      scores: { eval: 0.8 },
      success: true,
    };
    const r = shared.applyTierDiscipline('generator', { id: 'gen-p5-easy' }, raw);
    expect(r.tiers[0].pass).toBe(true);
    expect(r.tiers[1].skipped).toBe(false);
    expect(r.tiers[1].pass).toBe(true);
    expect(r.tiers[2].status).toBe('deferred-to-human');
    expect(r.tiers[2].includeInBlindPack).toBe(true);
  });

  it('receipt includes batteryVersion + taskCount + northStarId', () => {
    const r = shared.buildTaskReceipt({
      seat: 'generator',
      model: 'kimi-k3',
      taskId: 'gen-p5-easy',
      promptHash: 'b'.repeat(64),
      reasoningLevel: 'medium',
      latencyMs: 1,
      verdict: 'ok',
      batteryVersion: 1,
      taskCount: 6,
      northStarId: 'blindEvalScoreOfGatePassers',
    });
    expect(r.batteryVersion).toBe(1);
    expect(r.taskCount).toBe(6);
    expect(r.northStarId).toBe('blindEvalScoreOfGatePassers');
  });

  it('summary includes northStar object + batteryVersion + taskCount', () => {
    const s = shared.buildSummary({
      seat: 'chat',
      model: 'flash',
      batteryId: 'chat-v1',
      batteryVersion: 1,
      taskCount: 10,
      reasoningLevel: 'low',
      runDir: '/tmp/x',
      taskReceipts: [{ taskId: 'chat-ambiguous-ask' }],
      metrics: { northStar: 0.8, stanceAdherence: 0.8 },
    });
    expect(s.batteryVersion).toBe(1);
    expect(s.taskCount).toBe(10);
    expect(s.northStar.id).toBe('stanceAdherence');
    expect(s.northStar.value).toBe(0.8);
    expect(s.mece.doesNotMeasure).toMatch(/generator/i);
    expect(s.verifiesLastWaveFixes).toMatch(/stance/i);
  });
});

describe('rotation receipt schema', () => {
  it('validates task receipt', () => {
    const r = shared.buildTaskReceipt({
      seat: 'generator',
      model: 'kimi-k3',
      taskId: 'gen-p5-easy',
      promptHash: 'a'.repeat(64),
      reasoningLevel: 'medium',
      latencyMs: 12,
      tokenUsage: { prompt: 1, completion: 2, reasoning: null, total: 3 },
      verdict: 'ok',
      metrics: { gateAt1: true },
    });
    const v = shared.validateReceiptSchema(r);
    expect(v.ok).toBe(true);
    expect(r.issue).toBe(401);
    expect(r.schemaVersion).toBe(1);
    expect(r.reasoningLevel).toBe('medium');
  });

  it('rejects incomplete receipt', () => {
    const v = shared.validateReceiptSchema({ schemaVersion: 1, issue: 401, kind: 'rotation.task' });
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('seat');
    expect(v.errors).toContain('taskId');
  });
});

describe('rotation seat resolution (model-agnostic)', () => {
  it('uses --model flag override but KEEPS RoleConfig baseUrl/apiKey (M1)', async () => {
    const res = await shared.resolveSeatModel('harness', {
      modelOverride: 'gpt-5.6-sol',
      loadRoleConfig: async () => ({
        generator: { model: 'should-not-use', baseUrl: 'https://gen.example/v1', apiKey: 'gk' },
        harness: { model: 'kimi-k3', baseUrl: 'https://harness.example/v1', apiKey: 'hk-secret' },
        evaluator: { model: 'e', baseUrl: 'https://eval.example/v1', apiKey: 'ek' },
        studio: { model: 's', baseUrl: 'https://studio.example/v1', apiKey: 'sk' },
      }),
    });
    expect(res.model).toBe('gpt-5.6-sol');
    expect(res.source).toBe('flag');
    expect(res.baseUrl).toBe('https://harness.example/v1');
    expect(res.apiKey).toBe('hk-secret');
    expect(res.keyPresent).toBe(true);
    expect(res.keySource).toBe('RoleConfig');
    expect(res.endpointHost).toBe('harness.example');
  });

  it('resolves from RoleConfig when no override', async () => {
    const res = await shared.resolveSeatModel('chat', {
      loadRoleConfig: async () => ({
        generator: { model: 'g', baseUrl: 'x' },
        harness: { model: 'h', baseUrl: 'y' },
        evaluator: { model: 'e', baseUrl: 'z' },
        studio: { model: 'studio-flash', baseUrl: 'w', apiKey: 'studio-key' },
      }),
    });
    expect(res.role).toBe('studio');
    expect(res.model).toBe('studio-flash');
    expect(res.source).toBe('RoleConfig');
    expect(res.apiKey).toBe('studio-key');
  });

  it('forces Gemini models off Kilo onto AGY/cliproxy credentials', async () => {
    const res = await shared.resolveSeatModel('evaluator', {
      modelOverride: 'gemini-3.1-pro-low',
      loadRoleConfig: async () => ({
        generator: { model: 'g', baseUrl: 'https://api.x.ai/v1', apiKey: 'xai' },
        harness: {
          model: 'gpt-5.6-sol',
          baseUrl: 'http://localhost:8317/v1',
          apiKey: 'cliproxy-key',
        },
        // Tour evaluator is K3 on Kilo — must NOT be used for Gemini
        evaluator: {
          model: 'moonshotai/kimi-k3',
          baseUrl: 'https://api.kilo.ai/api/gateway',
          apiKey: 'kilo-key',
        },
        studio: { model: 's', baseUrl: 'https://api.z.ai/v1', apiKey: 'z' },
      }),
    });
    expect(res.model).toBe('gemini-3.1-pro-low');
    expect(res.baseUrl).toContain('8317');
    expect(res.apiKey).toBe('cliproxy-key');
    expect(res.keySource).toBe('RoleConfig.harness');
    expect(shared.isKiloEndpoint(res.baseUrl)).toBe(false);
  });

  it('resolveFixedEvaluatorSeat never uses Kilo', async () => {
    const res = await shared.resolveFixedEvaluatorSeat({
      loadRoleConfig: async () => ({
        harness: {
          model: 'gpt-5.6-sol',
          baseUrl: 'http://127.0.0.1:8317/v1',
          apiKey: 'hk',
        },
        evaluator: {
          model: 'moonshotai/kimi-k3',
          baseUrl: 'https://api.kilo.ai/api/gateway',
          apiKey: 'kilo',
        },
        generator: {},
        studio: {},
      }),
    });
    expect(res.model).toBe(shared.FIXED_EVALUATOR_MODEL);
    expect(res.baseUrl).toMatch(/8317/);
    expect(res.apiKey).toBe('hk');
    expect(shared.isKiloEndpoint(res.baseUrl)).toBe(false);
    expect(res.source).toBe('fixed-evaluator-agy');
  });

  it('preflightLiveSeat fails closed without baseUrl/apiKey', () => {
    const noBase = shared.preflightLiveSeat({ baseUrl: null, apiKey: null });
    expect(noBase.ok).toBe(false);
    const noKeyRemote = shared.preflightLiveSeat({
      baseUrl: 'https://api.example/v1',
      apiKey: null,
    });
    expect(noKeyRemote.ok).toBe(false);
    const ok = shared.preflightLiveSeat({
      baseUrl: 'https://api.example/v1',
      apiKey: 'k',
    });
    expect(ok.ok).toBe(true);
    // seatRunner skips transport checks
    const injected = shared.preflightLiveSeat(
      { baseUrl: null, apiKey: null },
      { seatRunner: async () => ({}) },
    );
    expect(injected.ok).toBe(true);
  });

  it('detectInauthenticLive flags ms latency without tokens', () => {
    const bad = shared.detectInauthenticLive({
      useMock: false,
      taskResults: [
        { latencyMs: 12, tokenUsage: null, livePath: 'real', verdict: 'ok' },
        { latencyMs: 8, tokenUsage: { total: 0 }, livePath: 'real', verdict: 'ok' },
      ],
    });
    expect(bad.invalid).toBe(true);
    const good = shared.detectInauthenticLive({
      useMock: false,
      taskResults: [
        { latencyMs: 12, tokenUsage: { total: 30, prompt: 10, completion: 20 }, livePath: 'real', verdict: 'ok' },
      ],
    });
    expect(good.invalid).toBe(false);
  });

  it('isAuthFailureMessage classifies 401/key errors', () => {
    expect(shared.isAuthFailureMessage('HTTP 401 Unauthorized')).toBe(true);
    expect(shared.isAuthFailureMessage('invalid api key')).toBe(true);
    expect(shared.isAuthFailureMessage('model refused unsafe code')).toBe(false);
  });
  it('isAuthFailureMessage classifies Wave2 Kilo/cliproxy auth gates', () => {
    expect(shared.isAuthFailureMessage('Kilo gateway API error 401: PAID_MODEL_AUTH_REQUIRED')).toBe(true);
    expect(shared.isAuthFailureMessage('auth_unavailable: no auth available (providers=codex, model=gpt-5.6-sol)')).toBe(true);
    expect(shared.isAuthFailureMessage('You need to sign in to use this model.')).toBe(true);
    expect(shared.isAuthFailureMessage('no verified edit after 12 steps')).toBe(false);
  });
  it('findingsIndicateAuthFailure suppresses product-path on auth findings', () => {
    expect(shared.findingsIndicateAuthFailure([
      'provenance branch=main',
      'Kilo gateway API error 401: {"error":{"code":"PAID_MODEL_AUTH_REQUIRED"}}',
    ])).toBe(true);
    expect(shared.findingsIndicateAuthFailure(['no-verified-edit', 'tierStoppedAt=1'])).toBe(false);
  });

});

describe('rotation report compare', () => {
  it('marks winners incomparable across mode mismatch / INVALID', () => {
    const report = shared.compareSummaries(
      {
        seat: 'generator',
        model: 'a',
        mode: 'mock',
        n: 6,
        metrics: { gateAt1Rate: 0.9, meanLatencyMs: 10 },
      },
      {
        seat: 'generator',
        model: 'b',
        mode: 'live',
        n: 6,
        metrics: { gateAt1Rate: 0.5, meanLatencyMs: 2000 },
      },
      { seat: 'generator' },
    );
    expect(report.modesComparable).toBe(false);
    expect(report.rows.every((r: { winner: string }) => r.winner === 'incomparable')).toBe(true);
    expect(report.caveats.some((c: string) => /MODE MISMATCH/i.test(c))).toBe(true);
  });

  it('builds delta table with caveats', () => {
    const report = shared.compareSummaries(
      {
        seat: 'generator',
        model: 'model-a',
        n: 6,
        metrics: { gateAt1Rate: 0.5, meanLatencyMs: 100 },
      },
      {
        seat: 'generator',
        model: 'model-b',
        n: 6,
        metrics: { gateAt1Rate: 0.8, meanLatencyMs: 150 },
      },
      { seat: 'generator' },
    );
    expect(report.kind).toBe('rotation.report');
    expect(report.caveats.length).toBeGreaterThanOrEqual(2);
    const gate = report.rows.find((r: { metric: string }) => r.metric === 'gateAt1Rate');
    expect(gate.winner).toBe('b');
    const lat = report.rows.find((r: { metric: string }) => r.metric === 'meanLatencyMs');
    expect(lat.winner).toBe('a');
  });
});

describe('rotation mock integration (no live calls)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rot-401-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('runs generator battery with mock seat and writes receipts + summary', async () => {
    const out = path.join(tmp, 'gen-run');
    const result = await runBattery('generator', {
      modelOverride: 'mock-gen',
      mock: true,
      out,
      loadRoleConfig: async () => ({
        generator: { model: 'ignored', baseUrl: 'x' },
        harness: { model: 'h', baseUrl: 'y' },
        evaluator: { model: 'e', baseUrl: 'z' },
        studio: { model: 's', baseUrl: 'w' },
      }),
    });
    expect(result.mode).toBe('mock');
    expect(result.receipts.length).toBe(6);
    expect(result.summary.metrics.n).toBe(6);
    expect(result.summary.reasoningLevel).toBe('medium');
    const summary = JSON.parse(await fs.readFile(path.join(out, 'summary.json'), 'utf8'));
    expect(summary.issue).toBe(401);
    expect(summary.model).toBe('mock-gen');
    expect(summary.batteryVersion).toBe(1);
    expect(summary.taskCount).toBe(6);
    expect(summary.northStar.id).toBe('blindEvalScoreOfGatePassers');
    expect(summary.northStar.value).toBeTypeOf('number');
    expect(summary.metrics.northStarId).toBe('blindEvalScoreOfGatePassers');
    const design = JSON.parse(await fs.readFile(path.join(out, 'design.json'), 'utf8'));
    expect(design.blindSpots.length).toBeGreaterThan(0);
    expect(design.failureSpace.length).toBeGreaterThan(0);
    for (const r of result.receipts) {
      const v = shared.validateReceiptSchema(r);
      expect(v.ok).toBe(true);
      expect(r.promptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(r.batteryVersion).toBe(1);
      expect(r.taskCount).toBe(6);
      expect(r.northStarId).toBe('blindEvalScoreOfGatePassers');
      expect(r.tiers.order).toEqual([0, 1, 2]);
    }
  });

  it('blind pack non-null when audition-379 (#427) is present', async () => {
    // scripts/audition-379.mjs is on main (98bd2d12 / #427). Skip-with-finding
    // is only honest when the dependency is genuinely absent — not when present.
    const audition = await loadAudition();
    expect(audition.error).toBeNull();
    expect(audition.mod?.buildBlindPack).toBeTypeOf('function');

    const out = path.join(tmp, 'gen-blind');
    // Force tier-0 survivors so the pack has entries (not empty-but-present).
    const seatRunner = async ({ task }: { task: { id: string; domain?: string } }) => ({
      success: true,
      verdict: 'ok',
      latencyMs: 10,
      tokenUsage: { prompt: 1, completion: 1, reasoning: null, total: 2 },
      gatesAtShot1: { parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true },
      gatesFinal: { parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true },
      attemptsUsed: 1,
      scores: { eval: 0.8 },
      gateAt1: true,
      gateAtLte3: true,
      domain: task.domain,
    });
    const result = await runBattery('generator', {
      modelOverride: 'mock-gen-blind',
      mock: true,
      out,
      seatRunner,
    });
    expect(Object.keys(result.blindPack?.index ?? {}).length > 0
      || typeof result.blindPack?.key === 'string').toBe(true);
    const skipped = (result.findings || []).some((f: string) => /blind pack skipped/i.test(f));
    expect(skipped).toBe(false);
    const onDisk = JSON.parse(await fs.readFile(path.join(out, 'blind-pack.json'), 'utf8'));
    expect(Object.keys(onDisk.index || {}).length).toBeGreaterThan(0);
  });

  it('telemetry emit throw → receipt telemetryGap emit-failed + finding (not silent)', async () => {
    const out = path.join(tmp, 'telemetry-gap');
    const boom = async () => {
      throw new Error('ledger write refused');
    };
    const result = await runBattery('chat', {
      modelOverride: 'mock-chat-tel',
      mock: true,
      out,
      recordEvent: boom,
    });
    expect(result.receipts.length).toBeGreaterThan(0);
    for (const r of result.receipts) {
      expect(r.telemetry?.emitted).toBe(false);
      expect(r.telemetry?.gap).toBe('emit-failed');
      const joined = (r.findings || []).join(' | ');
      expect(joined).toMatch(/Telemetry gap|Telemetry emit failed|ledger write refused/i);
    }
  });

  it('runs all four seats via CLI main with --mock', async () => {
    for (const seat of ['generator', 'evaluator', 'harness', 'chat'] as const) {
      const out = path.join(tmp, seat);
      const code = await main([seat, '--mock', '--model', `mock-${seat}`, '--out', out], {
        loadRoleConfig: async () => ({
          generator: { model: 'g', baseUrl: 'x' },
          harness: { model: 'h', baseUrl: 'y' },
          evaluator: { model: 'e', baseUrl: 'z' },
          studio: { model: 's', baseUrl: 'w' },
        }),
      });
      expect(code).toBe(0);
      const summary = await loadSummary(out);
      expect(summary.seat).toBe(seat);
      expect(summary.n).toBeGreaterThanOrEqual(4);
    }
  });

  it('report compares two mock runs', async () => {
    const aDir = path.join(tmp, 'a');
    const bDir = path.join(tmp, 'b');
    await runBattery('generator', { modelOverride: 'model-a', mock: true, out: aDir });
    await runBattery('generator', { modelOverride: 'model-b', mock: true, out: bDir });
    const code = await main([
      'report',
      'generator',
      '--a',
      aDir,
      '--b',
      bDir,
      '--out',
      path.join(tmp, 'report.json'),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(await fs.readFile(path.join(tmp, 'report.json'), 'utf8'));
    expect(report.kind).toBe('rotation.report');
    expect(report.modelA).toBe('model-a');
    expect(report.modelB).toBe('model-b');
    expect(report.rows.length).toBeGreaterThan(0);
  });
});

describe('wave schedule encoding', () => {
  it('encodes approved wave table', () => {
    expect(shared.WAVE_SCHEDULE.approvedAt).toBe('2026-07-27');
    expect(shared.WAVE_SCHEDULE.waves[1].seats.harness).toBe('kimi-k3');
    // Wave 2 historical: Opus harness + Grok generator (OIDC)
    expect(shared.WAVE_SCHEDULE.waves[2].seats.harness).toBe('anthropic/claude-opus-5');
    expect(shared.WAVE_SCHEDULE.waves[2].seats.generator).toBe('grok-4.5');
    // Wave 3+: K3 architect-diagnose on harness (no implement); Sol/Grok implement later
    expect(shared.WAVE_SCHEDULE.waves[3].seats.harness).toBe('moonshotai/kimi-k3');
    expect(shared.WAVE_SCHEDULE.waves[3].seats.harnessMode).toBe('diagnose-plan-only');
    expect(shared.WAVE_SCHEDULE.waves[3].seats.harnessReasoning).toBe('high');
    expect(shared.WAVE_SCHEDULE.waves[3].seats.generator).toBe('gpt-5.6-sol');
    expect(shared.WAVE_SCHEDULE.waves[3].seats.evaluator).toBe('grok-4.5');
    expect(shared.WAVE_SCHEDULE.waves[3].seats.evaluatorReasoning).toBe('high');
    expect(shared.WAVE_SCHEDULE.waves[4].seats.harness).toBe('gpt-5.6-sol');
    expect(shared.WAVE_SCHEDULE.waves[5].seats.generator).toBe('gpt-5.6-sol');
    expect(shared.WAVE_SCHEDULE.waves[5].seats.harnessReasoning).toBe('high');
    expect(shared.WAVE_SCHEDULE.waves[6]?.seats?.order).toEqual([
      'gpt-5.6-sol',
      'moonshotai/kimi-k3',
      'grok-4.5',
    ]);
    expect(shared.WAVE_SCHEDULE.waves[6]?.name || shared.WAVE_SCHEDULE.waves[shared.WAVE_SCHEDULE.waves.length-1].name).toMatch(/chat-tour|wave-6/);
    expect(shared.WAVE_SCHEDULE.retrospectiveGate).toContain('dreaming-pass');
  });
});

describe('rotation F12 honest live (no mockSeatResult in live mode)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rot-401-live-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('resolveRunMode: live only when no gaps; live-partial when gap tasks exist; INVALID wins', () => {
    expect(shared.resolveRunMode({ useMock: true, gapTaskIds: [] })).toBe('mock');
    expect(shared.resolveRunMode({ useMock: false, gapTaskIds: [] })).toBe('live');
    expect(shared.resolveRunMode({ useMock: false, gapTaskIds: ['chat-x'] })).toBe('live-partial');
    expect(shared.resolveRunMode({ useMock: false, gapTaskIds: [], invalid: true })).toBe('INVALID');
    expect(shared.resolveRunMode({ useMock: false, gapTaskIds: ['x'], invalid: true })).toBe('INVALID');
  });

  it('honestLiveGap nulls metrics and never invents latency/tokens/scores', () => {
    const g = shared.honestLiveGap('chat', { id: 'chat-ambiguous-ask' }, ['no client']);
    expect(g.verdict).toBe('telemetry-gap');
    expect(g.latencyMs).toBeNull();
    expect(g.tokenUsage).toBeNull();
    expect(g.scores).toBeNull();
    expect(g.livePath).toBe('gap');
    expect(g.findings).toContain('no client');

    const e = shared.honestLiveGap('evaluator', { id: 'eval-clean-01', groundTruthPass: true }, ['shot missing']);
    expect(e.pass).toBeNull();
    expect(e.score).toBeNull();
    expect(e.latencyMs).toBeNull();
  });

  it('live chat/eval/harness with injected seatRunner → mode live + real path fields', async () => {
    const seatRunner = async ({ seat, task }: { seat: string; task: { id: string; groundTruthPass?: boolean } }) => {
      if (seat === 'chat') {
        return {
          success: true,
          verdict: 'ok',
          latencyMs: 42,
          tokenUsage: { prompt: 10, completion: 20, reasoning: null, total: 30 },
          scores: { honesty: 0.9, usefulness: 0.8, stanceAdherence: 0.85 },
          claimTagsPresent: true,
          deterministic: { claimTagsObservedInferredGuessed: true },
          livePath: 'real',
          findings: [],
        };
      }
      if (seat === 'evaluator') {
        return {
          success: true,
          verdict: task.groundTruthPass ? 'pass' : 'fail',
          latencyMs: 55,
          tokenUsage: { prompt: 5, completion: 5, reasoning: null, total: 10 },
          pass: task.groundTruthPass,
          cantTell: false,
          score: task.groundTruthPass ? 0.8 : 0.2,
          groundTruthPass: task.groundTruthPass,
          fixturePresent: true,
          livePath: 'real',
          findings: [],
        };
      }
      // harness
      return {
        success: true,
        verdict: 'ok',
        latencyMs: 100,
        tokenUsage: { prompt: 1, completion: 1, reasoning: 1, total: 3 },
        stepsToVerifiedEdit: 4,
        rollbackCorrect: true,
        selfCheckUsed: { build: true, test: true, typecheck: true },
        proposalQuality: 0.7,
        resumed: task.id.includes('resume') ? true : null,
        livePath: 'real',
        findings: [],
      };
    };

    for (const seat of ['chat', 'evaluator', 'harness'] as const) {
      const out = path.join(tmp, seat);
      const result = await runBattery(seat, {
        modelOverride: `live-${seat}`,
        live: true,
        out,
        seatRunner,
        loadRoleConfig: async () => ({
          generator: { model: 'g', baseUrl: 'x' },
          harness: { model: 'h', baseUrl: 'y' },
          evaluator: { model: 'e', baseUrl: 'z' },
          studio: { model: 's', baseUrl: 'w' },
        }),
      });
      expect(result.mode).toBe('live');
      expect(result.gapTaskIds).toEqual([]);
      expect(result.summary.mode).toBe('live');
      const runJson = JSON.parse(await fs.readFile(path.join(out, 'run.json'), 'utf8'));
      expect(runJson.mode).toBe('live');
      // No mock-ish zero latency with fake total tokens pattern from mockSeatResult
      for (const r of result.receipts.filter((x: { taskId: string }) => !x.taskId.endsWith('__re'))) {
        expect(r.latencyMs).toBeGreaterThan(0);
        expect(r.verdict).not.toBe('telemetry-gap');
      }
    }
  });

  it('mode=live-partial when a gap task exists among real live paths', async () => {
    const out = path.join(tmp, 'chat-partial');
    let n = 0;
    const seatRunner = async () => {
      n += 1;
      // First task gaps; rest real
      if (n === 1) {
        return shared.honestLiveGap('chat', { id: 'gap' }, ['injected gap']);
      }
      return {
        success: true,
        verdict: 'ok',
        latencyMs: 12,
        tokenUsage: { prompt: 1, completion: 1, reasoning: null, total: 2 },
        scores: { honesty: 0.8, usefulness: 0.7, stanceAdherence: 0.75 },
        claimTagsPresent: true,
        deterministic: { claimTagsObservedInferredGuessed: true },
        livePath: 'real',
        findings: [],
      };
    };
    const result = await runBattery('chat', {
      modelOverride: 'partial-chat',
      live: true,
      out,
      seatRunner,
    });
    expect(result.mode).toBe('live-partial');
    expect(result.gapTaskIds.length).toBeGreaterThan(0);
    expect(result.summary.mode).toBe('live-partial');
    expect(result.summary.gapTaskIds).toEqual(result.gapTaskIds);
    expect((result.findings || []).some((f: string) => /Live-partial/i.test(f))).toBe(true);
  });

  it('runLiveTask never returns mockSeatResult-shaped numbers when adapters gap', async () => {
    // Adapters refuse to create clients → every seat honest-gaps
    const adapters = {
      createLlmClient: async () => {
        throw new Error('no live API in unit test');
      },
      supportsVision: async () => false,
      // F15: never launch real puppeteer in unit tests — null render → evaluator gap
      renderFixtureScreenshot: async () => null,
      scoreRenderedEvidence: async () => {
        throw new Error('unreachable');
      },
      runSelfImprove: async () => {
        throw new Error('unreachable');
      },
    };

    for (const seat of ['chat', 'evaluator', 'harness'] as const) {
      const pack = await shared.loadTaskPack(seat);
      const task = (pack.tasks || pack.cases)[0];
      const raw = await runLiveTask(seat, task, {
        model: 'test-model',
        seatRes: { model: 'test-model', baseUrl: null, source: 'flag', role: seat === 'chat' ? 'studio' : seat },
        reasoningLevel: 'low',
        pack,
        runDir: tmp,
        adapters,
      });
      // Honest nulls — never the mockSeatResult seed pattern (latency 50-249, synthetic scores)
      expect(raw.verdict === 'telemetry-gap' || raw.verdict === 'unavailable' || raw.livePath === 'gap').toBe(true);
      expect(raw.latencyMs === null || raw.latencyMs === 0 || typeof raw.latencyMs === 'number').toBe(true);
      // mockSeatResult always sets positive latency 50-249 and non-null tokenUsage
      // Honest gap must not invent token totals from the mock seed
      if (raw.verdict === 'telemetry-gap' || raw.livePath === 'gap') {
        // createLlmClient throws before any call — latency null (honest) or measured construct time
        expect(raw.tokenUsage).toBeNull();
        if (seat === 'chat') expect(raw.scores).toBeNull();
        if (seat === 'evaluator') {
          expect(raw.pass).toBeNull();
          expect(raw.score).toBeNull();
        }
        if (seat === 'harness') expect(raw.stepsToVerifiedEdit).toBeNull();
      }
      // Explicitly not the mock shape
      const mockShape = shared.mockSeatResult(seat, task);
      expect(raw.latencyMs).not.toBe(mockShape.latencyMs);
      expect(JSON.stringify(raw.tokenUsage)).not.toBe(JSON.stringify(mockShape.tokenUsage));
    }
  });

  it('CLI header prints merged live=true when deps.live is set', async () => {
    const out = path.join(tmp, 'cli-live-merge');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      const code = await main(['chat', '--mock', '--model', 'm', '--out', out], {
        live: true, // deps.live — must appear in header even though argv has no --live
        // mock still wins for execution via argv --mock; header still shows merged live
        loadRoleConfig: async () => ({
          generator: { model: 'g', baseUrl: 'x' },
          harness: { model: 'h', baseUrl: 'y' },
          evaluator: { model: 'e', baseUrl: 'z' },
          studio: { model: 's', baseUrl: 'w' },
        }),
      });
      expect(code).toBe(0);
      const header = logs.find((l) => l.startsWith('[rotation] seat='));
      expect(header).toMatch(/live=true/);
    } finally {
      console.log = origLog;
    }
  });

  it('live evaluator with scoreRenderedEvidence adapter produces real pass/score', async () => {
    const out = path.join(tmp, 'eval-adapter');
    const adapters = {
      createLlmClient: async () => ({
        complete: async () => ({ success: true, text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }),
      }),
      supportsVision: async () => true,
      // F15: inject successful fixture render (real dims) so judge path is reachable
      renderFixtureScreenshot: async () => ({
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
        width: 10,
        height: 10,
        source: 'injected-render',
      }),
      scoreRenderedEvidence: async (ev: { screenshot?: { width?: number | null; height?: number | null } }, _code: string, _brief: string) => {
        expect(ev.screenshot?.width).toBe(10);
        expect(ev.screenshot?.height).toBe(10);
        return {
          score: 0.82,
          confidence: 0.9,
          failureClass: 'none',
          usage: { inputTokens: 11, outputTokens: 7 },
        };
      },
      runSelfImprove: async () => {
        throw new Error('not harness');
      },
    };
    // Use seatRunner-free live path with adapters — only one case via custom pack is hard;
    // instead call runLiveTask directly for a clean control case.
    const pack = await shared.loadTaskPack('evaluator');
    const task = pack.cases.find((c: { id: string }) => c.id === 'eval-clean-01');
    const raw = await runLiveTask('evaluator', task, {
      model: 'gemini-3.1-pro-low',
      seatRes: { model: 'gemini-3.1-pro-low', baseUrl: 'http://localhost:8317/v1', source: 'flag', role: 'evaluator' },
      reasoningLevel: 'low',
      pack,
      runDir: out,
      adapters,
    });
    expect(raw.livePath).toBe('real');
    expect(raw.verdict).toBe('pass');
    expect(raw.pass).toBe(true);
    expect(raw.score).toBe(0.82);
    expect(raw.fixturePresent).toBe(true);
    expect(raw.preCheckRejected).toBe(false);
    expect(raw.screenshotSource).toBe('injected-render');
    expect(typeof raw.latencyMs).toBe('number');
  });

  it('F15: render failure → telemetry-gap, never pre-check-shaped fail', async () => {
    const pack = await shared.loadTaskPack('evaluator');
    const task = pack.cases.find((c: { id: string }) => c.id === 'eval-clean-01');
    let scoreCalls = 0;
    const adapters = {
      createLlmClient: async () => ({ complete: async () => ({ success: true, text: '{}' }) }),
      supportsVision: async () => true,
      renderFixtureScreenshot: async () => null, // render failed
      scoreRenderedEvidence: async () => {
        scoreCalls += 1;
        return { score: 0, confidence: 1, failureClass: 'render' };
      },
    };
    const raw = await runLiveTask('evaluator', task, {
      model: 'gemini-3.1-pro-low',
      seatRes: { model: 'gemini-3.1-pro-low', baseUrl: null, source: 'flag', role: 'evaluator' },
      reasoningLevel: 'low',
      pack,
      runDir: tmp,
      adapters,
    });
    expect(raw.verdict).toBe('telemetry-gap');
    expect(raw.livePath).toBe('gap');
    expect(raw.pass).toBeNull();
    expect(raw.score).toBeNull();
    expect(raw.preCheckRejected).toBe(false);
    expect(scoreCalls).toBe(0); // never called scoreRenderedEvidence
    expect((raw.findings || []).join(' ')).toMatch(/render\/screenshot unavailable|telemetry-gap/i);
  });

  it('F15: scoreRenderedEvidence failureClass=render → pre_check_rejected not judge fail', async () => {
    const pack = await shared.loadTaskPack('evaluator');
    const task = pack.cases.find((c: { friction: string }) => c.friction === 'blank-screenshot');
    expect(task?.friction).toBe('blank-screenshot');
    const adapters = {
      createLlmClient: async () => ({ complete: async () => ({ success: true, text: '{}' }) }),
      supportsVision: async () => true,
      // blank friction uses synthetic PNG; no render needed
      scoreRenderedEvidence: async () => ({
        score: 0,
        confidence: 1,
        failureClass: 'render',
        reasoning: 'no visible content',
      }),
    };
    const raw = await runLiveTask('evaluator', task, {
      model: 'gemini-3.1-pro-low',
      seatRes: { model: 'gemini-3.1-pro-low', baseUrl: null, source: 'flag', role: 'evaluator' },
      reasoningLevel: 'low',
      pack,
      runDir: tmp,
      adapters,
    });
    expect(raw.verdict).toBe('pre_check_rejected');
    expect(raw.preCheckRejected).toBe(true);
    expect(raw.pass).toBeNull();
    expect(raw.cantTell).toBe(false);
    expect(raw.livePath).toBe('real');
    expect(raw.failureClass).toBe('render');
    const tiered = shared.applyTierDiscipline('evaluator', task, raw);
    expect(tiered.tiers[1].reasons).toContain('pre-check-rejected');
    // Must not count as hit/FP
    const m = shared.computeEvaluatorMetrics([{ ...tiered, taskId: task.id }]);
    expect(m.preCheckRejected).toBe(1);
    expect(m.hitDenom).toBe(0);
    expect(m.fpDenom).toBe(0);
  });

  it('live evaluator swapped-screenshot without image → telemetry-gap not mock', async () => {
    const pack = await shared.loadTaskPack('evaluator');
    const task = pack.cases.find((c: { friction: string }) => c.friction === 'swapped-screenshot');
    expect(task?.friction).toBe('swapped-screenshot');
    const adapters = {
      createLlmClient: async () => ({ complete: async () => ({ success: true, text: '{}' }) }),
      supportsVision: async () => true,
      // Force render path failure (no screenshots dir + injected null render)
      renderFixtureScreenshot: async () => null,
      scoreRenderedEvidence: async () => ({ score: 0.9, confidence: 1, failureClass: 'none' }),
    };
    const raw = await runLiveTask('evaluator', task, {
      model: 'gemini-3.1-pro-low',
      seatRes: { model: 'gemini-3.1-pro-low', baseUrl: null, source: 'flag', role: 'evaluator' },
      reasoningLevel: 'low',
      pack,
      runDir: tmp,
      adapters,
    });
    // Without screenshots dir and failed render → honest gap — never mock pass scores
    expect(raw.verdict).toBe('telemetry-gap');
    expect(raw.livePath).toBe('gap');
    expect(raw.score).toBeNull();
    expect(raw.tokenUsage).toBeNull();
    expect((raw.findings || []).join(' ')).toMatch(/screenshot|render|honest|telemetry-gap/i);
  });

  it('pngDimensionsFromBuffer reads real IHDR width/height', () => {
    // 10x10 PNG (minimal)
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
    const dims = pngDimensionsFromBuffer(Buffer.from(b64, 'base64'));
    expect(dims.width).toBe(10);
    expect(dims.height).toBe(10);
  });

  it('live generator tier-1 fixed-evaluator score lands in metrics + north star', async () => {
    const artPath = path.join(tmp, 'gen-tier1-artifact.js');
    await fs.writeFile(artPath, 'function setup(){}\nfunction draw(){background(0);}\n');
    const judgeModels: string[] = [];
    const adapters = {
      runGeneratorCell: async () => ({
        success: true,
        latencyMs: 42,
        reasoning: { usage: { prompt: 1, completion: 2, reasoning_tokens: 0 } },
        gatesAtShot1: {
          parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true,
        },
        gatesFinal: {
          parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true,
        },
        attemptsUsed: 1,
        scores: {},
        artifactPath: artPath,
        screenshotPath: null,
      }),
      createLlmClient: async (cfg: { role: string; model: string }) => {
        judgeModels.push(`${cfg.role}:${cfg.model}`);
        return { complete: async () => ({ success: true, text: '{}' }) };
      },
      supportsVision: async () => false,
      scoreRenderedEvidence: async () => ({
        score: 0.77,
        confidence: 0.95,
        failureClass: 'none',
        usage: { inputTokens: 5, outputTokens: 3 },
      }),
    };
    const pack = await shared.loadTaskPack('generator');
    const task = pack.tasks[0];
    const raw = await runLiveTask('generator', task, {
      model: 'gemini-3.6-flash-high',
      seatRes: {
        model: 'gemini-3.6-flash-high',
        baseUrl: 'http://localhost:8317/v1',
        source: 'flag',
        role: 'generator',
        apiKey: 'test-key',
      },
      reasoningLevel: 'medium',
      pack,
      runDir: tmp,
      adapters,
    });
    expect(raw.livePath).toBe('real');
    expect(raw.verdict).toBe('ok');
    expect(raw.scores.eval).toBe(0.77);
    expect(raw.gateAtLte3).toBe(true);
    expect(judgeModels).toContain('evaluator:gemini-3.1-pro-low');

    const tiered = shared.applyTierDiscipline('generator', task, raw);
    expect(tiered.tiers[0].pass).toBe(true);
    expect(tiered.tiers[1].skipped).toBe(false);
    expect(tiered.tiers[1].pass).toBe(true);
    expect(tiered.tiers[1].reasons).toContain('fixed-evaluator-scored');
    expect(tiered.tiers[1].score).toBe(0.77);
    expect(tiered.tiers[1].fixedEvaluator).toBe('gemini-3.1-pro-low');

    const metrics = shared.computeGeneratorMetrics([tiered]);
    expect(metrics.meanEvalScore).toBe(0.77);
    expect(metrics.blindEvalScoreOfGatePassers).toBe(0.77);
    expect(metrics.northStar).toBe(0.77);
    expect(metrics.northStarId).toBe('blindEvalScoreOfGatePassers');
  });

  it('live generator tier-1 evaluator throws → null score + finding + live-partial', async () => {
    const artPath = path.join(tmp, 'gen-tier1-throw.js');
    await fs.writeFile(artPath, 'function setup(){}\nfunction draw(){}\n');
    const out = path.join(tmp, 'gen-tier1-throw-run');
    const adapters = {
      runGeneratorCell: async () => ({
        success: true,
        latencyMs: 30,
        gatesAtShot1: {
          parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true,
        },
        gatesFinal: {
          parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true,
        },
        attemptsUsed: 1,
        scores: {},
        artifactPath: artPath,
        screenshotPath: null,
      }),
      createLlmClient: async () => ({ complete: async () => ({ success: true, text: '{}' }) }),
      supportsVision: async () => true,
      scoreRenderedEvidence: async () => {
        throw new Error('evaluator seat unreachable');
      },
    };
    const result = await runBattery('generator', {
      modelOverride: 'test-gen-tier1',
      live: true,
      out,
      liveAdapters: adapters,
      loadRoleConfig: async () => ({
        generator: { model: 'g', baseUrl: 'https://proxy.test/v1', apiKey: 'gk' },
        harness: { model: 'h', baseUrl: 'https://proxy.test/v1', apiKey: 'hk' },
        evaluator: { model: 'e', baseUrl: 'https://proxy.test/v1', apiKey: 'ek' },
        studio: { model: 's', baseUrl: 'https://proxy.test/v1', apiKey: 'sk' },
      }),
    });
    expect(result.mode).toBe('live-partial');
    expect(result.gapTaskIds.length).toBe(6);
    for (const r of result.receipts) {
      expect(r.metrics.evalScore).toBeNull();
      expect(r.tiers[1].reasons).toContain('telemetry-gap-honest');
      expect(r.tiers[1].score).toBeNull();
      expect(r.tiers[0].pass).toBe(true); // gates still pass
      expect((r.findings || []).join(' ')).toMatch(/fixed-evaluator threw|evaluator seat unreachable/i);
    }
    expect(result.metrics.blindEvalScoreOfGatePassers).toBeNull();
    expect(result.metrics.meanEvalScore).toBeNull();
    expect(result.metrics.northStar).toBeNull();
    expect((result.findings || []).some((f: string) => /Live-partial/i.test(f))).toBe(true);
  });

  it('live generator skips fixed-evaluator when tier-0 gates fail', async () => {
    let scoreCalls = 0;
    const adapters = {
      runGeneratorCell: async () => ({
        success: false,
        latencyMs: 10,
        gatesAtShot1: {
          parse: { pass: false }, render: { pass: false }, nonblank: { pass: false }, allPass: false,
        },
        gatesFinal: {
          parse: { pass: false }, render: { pass: false }, nonblank: { pass: false }, allPass: false,
        },
        attemptsUsed: 1,
        scores: {},
        artifactPath: null,
      }),
      createLlmClient: async () => ({ complete: async () => ({}) }),
      supportsVision: async () => true,
      scoreRenderedEvidence: async () => {
        scoreCalls += 1;
        return { score: 0.9, confidence: 1, failureClass: 'none' };
      },
    };
    const pack = await shared.loadTaskPack('generator');
    const task = pack.tasks[0];
    const raw = await runLiveTask('generator', task, {
      model: 'test-model',
      seatRes: { model: 'test-model', baseUrl: null, source: 'flag', role: 'generator' },
      reasoningLevel: 'medium',
      pack,
      runDir: tmp,
      adapters,
    });
    expect(scoreCalls).toBe(0);
    expect(raw.scores?.eval).toBeUndefined();
    expect(raw.livePath).toBe('real'); // generation ran; no tier-1 gap
    const tiered = shared.applyTierDiscipline('generator', task, raw);
    expect(tiered.tiers[0].pass).toBe(false);
    expect(tiered.tiers[1].skipped).toBe(true);
  });

  it('live generator rejects scorer-fallback stub score as telemetry-gap', async () => {
    const artPath = path.join(tmp, 'gen-tier1-stub.js');
    await fs.writeFile(artPath, 'function setup(){}\n');
    const adapters = {
      runGeneratorCell: async () => ({
        success: true,
        latencyMs: 12,
        gatesAtShot1: {
          parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true,
        },
        gatesFinal: {
          parse: { pass: true }, render: { pass: true }, nonblank: { pass: true }, allPass: true,
        },
        attemptsUsed: 1,
        scores: {},
        artifactPath: artPath,
      }),
      createLlmClient: async () => ({ complete: async () => ({ success: true, text: '{}' }) }),
      supportsVision: async () => false,
      // Mirrors scoreRenderedEvidence offline fallback: 0.5 score + conf 0 + scorer class
      scoreRenderedEvidence: async () => ({
        score: 0.5,
        confidence: 0,
        failureClass: 'scorer',
      }),
    };
    const pack = await shared.loadTaskPack('generator');
    const task = pack.tasks[0];
    const raw = await runLiveTask('generator', task, {
      model: 'test-model',
      seatRes: { model: 'test-model', baseUrl: null, source: 'flag', role: 'generator' },
      reasoningLevel: 'medium',
      pack,
      runDir: tmp,
      adapters,
    });
    expect(raw.verdict).toBe('telemetry-gap');
    expect(raw.livePath).toBe('gap');
    expect(raw.scores.eval).toBeNull();
    expect((raw.findings || []).join(' ')).toMatch(/no stub score|low-confidence|unavailable/i);
    const tiered = shared.applyTierDiscipline('generator', task, raw);
    expect(tiered.tiers[1].reasons).toContain('telemetry-gap-honest');
    expect(tiered.tiers[1].score).toBeNull();
  });
});

describe('tour T0 telemetry helpers', () => {
  it('normalizeGapClass and inferGapClassFromMessage map instrument_pipe', () => {
    expect(shared.normalizeGapClass('instrument_pipe')).toBe('instrument_pipe');
    expect(shared.normalizeGapClass('nope')).toBe('unknown');
    expect(
      shared.inferGapClassFromMessage(
        'Live chat judge failed: Kilo gateway API error 400: gemini-3.1-pro-low is not a valid model ID',
      ),
    ).toBe('instrument_pipe');
  });

  it('fitnessAllowsSecondaryMetrics requires live + northStar', () => {
    expect(shared.fitnessAllowsSecondaryMetrics({ mode: 'live-partial', northStar: 1 })).toBe(false);
    expect(shared.fitnessAllowsSecondaryMetrics({ mode: 'live', northStar: null })).toBe(false);
    expect(shared.fitnessAllowsSecondaryMetrics({ mode: 'live', northStar: 0.8 })).toBe(true);
  });

  it('buildFixedJudgeBlock positive-validates cliproxy only', () => {
    const bad = shared.buildFixedJudgeBlock({
      model: 'gemini-3.1-pro-low',
      baseUrl: 'https://api.kilo.ai/api/gateway',
      endpointHost: 'api.kilo.ai',
      keySource: 'RoleConfig.evaluator',
    });
    expect(bad.route).toBe('invalid-kilo');
    expect(shared.isFixedJudgeRouteValid(bad.route)).toBe(false);
    const good = shared.buildFixedJudgeBlock({
      model: 'gemini-3.1-pro-low',
      baseUrl: 'http://localhost:8317/v1',
      endpointHost: 'localhost:8317',
      keySource: 'RoleConfig.harness',
    });
    expect(good.route).toBe('agy-cliproxy');
    expect(shared.isFixedJudgeRouteValid(good.route)).toBe(true);
    const ollama = shared.buildFixedJudgeBlock({
      model: 'gemini-3.1-pro-low',
      baseUrl: 'http://127.0.0.1:11434/v1',
      endpointHost: '127.0.0.1:11434',
    });
    expect(ollama.route).toBe('invalid-route');
    const missing = shared.buildFixedJudgeBlock({ model: 'gemini-3.1-pro-low', baseUrl: null });
    expect(missing.route).toBe('unset');
  });

  it('buildRotationLedgerEvent dual-emits tourWaveId and judge', () => {
    const ev = shared.buildRotationLedgerEvent({
      seat: 'chat',
      model: 'glm-5.2',
      taskId: 'chat-x',
      runId: 'r1',
      promptHash: 'abc',
      latencyMs: 10,
      tokenUsage: null,
      verdict: 'telemetry-gap',
      receiptPath: '/tmp/r.json',
      batteryId: 'chat-v1',
      reasoningLevel: 'high',
      wave: 2,
      endpointHost: 'api.z.ai',
      tip: 'deadbeefcafebabe',
      gapClass: 'instrument_pipe',
      fixedJudge: shared.buildFixedJudgeBlock({
        model: 'gemini-3.1-pro-low',
        baseUrl: 'http://localhost:8317/v1',
        endpointHost: 'localhost:8317',
      }),
      mode: 'live-partial',
    });
    expect(ev.payload.tourWaveId).toMatch(/^wave-2@deadbeef$/);
    expect(ev.payload.tourId).toBe('umd-rotation-tour-4x4');
    expect(ev.payload.gapClass).toBe('instrument_pipe');
    expect(ev.payload.judgeModel).toBe('gemini-3.1-pro-low');
    expect(ev.payload.judgeHost).toBe('localhost:8317');
    expect(ev.payload.mode).toBe('live-partial');
  });

  it('buildSummary fitness blocks secondary when not live', () => {
    const s = shared.buildSummary({
      seat: 'chat',
      model: 'glm-5.2',
      reasoningLevel: 'high',
      runDir: '/tmp/x',
      taskReceipts: [{ taskId: 't1' }],
      metrics: { northStar: null, claimTagRate: 1 },
      mode: 'live-partial',
      wave: 1,
      tip: 'aabbccdd',
      fixedJudge: shared.buildFixedJudgeBlock({
        model: 'gemini-3.1-pro-low',
        baseUrl: 'http://localhost:8317/v1',
        endpointHost: 'localhost:8317',
      }),
    });
    expect(s.fitness.scorable).toBe(false);
    expect(s.fitness.secondaryMetricsAllowed).toBe(false);
    expect(s.fixedJudge.route).toBe('agy-cliproxy');
    expect(s.join.tourWaveId).toBe('wave-1@aabbccdd');
  });

  it('evaluateFixedJudgeFreeze + pipeMentionsKiloGateway (preflight T0-5)', () => {
    expect(shared.pipeMentionsKiloGateway('https://api.x.ai/v1 direct (not Kilo)')).toBe(false);
    expect(shared.pipeMentionsKiloGateway('cliproxy http://localhost:8317/v1 (AGY OAuth)')).toBe(false);
    expect(shared.pipeMentionsKiloGateway('https://api.kilo.ai/api/gateway')).toBe(true);
    expect(shared.pipeMentionsKiloGateway('kilo https://api.kilo.ai')).toBe(true);

    expect(
      shared.evaluateFixedJudgeFreeze({
        model: 'gemini-3.1-pro-low',
        route: 'agy-cliproxy',
        pipe: 'cliproxy http://localhost:8317/v1 (AGY OAuth)',
      }).ok,
    ).toBe(true);
    expect(
      shared.evaluateFixedJudgeFreeze({
        model: 'gemini-3.1-pro-low',
        route: 'agy-cliproxy',
        pipe: 'https://api.kilo.ai/api/gateway',
      }).ok,
    ).toBe(false);
    expect(
      shared.evaluateFixedJudgeFreeze({
        model: 'gemini-3.1-pro-low',
        route: 'invalid-kilo',
      }).ok,
    ).toBe(false);
    expect(shared.evaluateFixedJudgeFreeze(null).ok).toBe(false);
    expect(
      shared.evaluateFixedJudgeFreeze({
        model: 'gpt-5.6-sol',
        route: 'agy-cliproxy',
      }).ok,
    ).toBe(false);
  });

  it('buildSummary nulls scorable when fixedJudge is kilo', () => {
    const s = shared.buildSummary({
      seat: 'generator',
      model: 'grok-4.5',
      runDir: '/tmp/x',
      taskReceipts: [{ taskId: 't1' }],
      metrics: { northStar: 0.9, claimTagRate: 1 },
      mode: 'live',
      fixedJudge: shared.buildFixedJudgeBlock({
        model: 'gemini-3.1-pro-low',
        baseUrl: 'https://api.kilo.ai/api/gateway',
        endpointHost: 'api.kilo.ai',
      }),
    });
    expect(s.fixedJudge.route).toBe('invalid-kilo');
    expect(s.fitness.scorable).toBe(false);
    expect(s.fitness.reason).toMatch(/invalid-kilo/);
  });

  // W1 full harvest: timeout taxonomy + usagePresent + productCandidate (G6/G12)
  it('classifyRotationTimeoutMessage matches CompoundRunEnvelope order', () => {
    expect(shared.classifyRotationTimeoutMessage('harness deadline exceeded')).toBe('harness-deadline');
    expect(shared.classifyRotationTimeoutMessage('provider timeout after 30s')).toBe('provider-timeout');
    expect(shared.classifyRotationTimeoutMessage('The operation was aborted due to timeout')).toBe(
      'provider-timeout',
    );
    expect(shared.classifyRotationTimeoutMessage('json parse failed')).toBe(null);
    expect(shared.classifyRotationTimeoutMessage('')).toBe(null);
    // H-TELEM-05 structured ownership
    expect(
      shared.classifyRotationTimeoutMessage('provider deadline exceeded', { timeoutSource: 'provider' }),
    ).toBe('provider-timeout');
    expect(
      shared.classifyRotationTimeoutMessage('request timeout', { timeoutSource: 'harness' }),
    ).toBe('harness-deadline');
  });

  it('usagePresence flags sparse tokenUsage honestly', () => {
    expect(shared.usagePresence(null).usagePresent).toBe(false);
    expect(shared.usagePresence(null).costPresent).toBe(false);
    expect(shared.usagePresence({}).usagePresent).toBe(false);
    const u = shared.usagePresence({ prompt: 10, completion: 20, total: 30 });
    expect(u.usagePresent).toBe(true);
    expect(u.tokenUsage?.total).toBe(30);
    const c = shared.usagePresence({ prompt: 1 }, { costUsd: 0.02 });
    expect(c.costPresent).toBe(true);
    expect(c.costUsd).toBe(0.02);
  });

  it('buildEvaluatorCaseEvent stamps planted-GT instrument (H-TELEM-02)', () => {
    const ev = shared.buildEvaluatorCaseEvent({
      model: 'glm-5.2',
      taskId: 'eval-clean-01',
      runId: 'r-eval',
      promptHash: 'ph',
      latencyMs: 12,
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      verdict: 'pass',
      receiptPath: '/tmp/e.json',
      batteryId: 'evaluator-v1',
      reasoningLevel: 'high',
      wave: 2,
      pass: true,
      groundTruthPass: true,
      label: 'clean',
    });
    // Must lane to eval/ (not seat/) and not reuse eval.verdict (fixedJudge scores)
    expect(ev.event).toBe('eval.planted_case');
    expect(ev.event.startsWith('eval.')).toBe(true);
    expect(ev.event).not.toBe('eval.verdict');
    expect(ev.payload.instrument).toBe('planted-GT');
    expect(ev.payload.subjectModel).toBe('glm-5.2');
    expect(ev.payload.pass).toBe(true);
    expect(ev.payload.tourWaveId).toMatch(/^wave-2@/);
    expect(ev.payload.usagePresent).toBe(true);
  });

  it('buildPackCompleteEvent carries final mode + NS (H-TELEM-04)', () => {
    const ev = shared.buildPackCompleteEvent({
      seat: 'generator',
      model: 'grok-4.5',
      runId: 'r-pack',
      batteryId: 'generator-v1',
      mode: 'live',
      northStar: 0.8,
      northStarId: 'blindEvalScoreOfGatePassers',
      wave: 2,
      tip: 'deadbeef',
      productCandidates: [],
    });
    expect(ev.event).toBe('seat.pack_complete');
    expect(ev.payload.mode).toBe('live');
    expect(ev.payload.northStar).toBe(0.8);
    expect(ev.payload.tourWaveId).toBe('wave-2@deadbeef');
  });

  it('buildRotationLedgerEvent stamps productCandidate and usagePresent', () => {
    const sparse = shared.buildRotationLedgerEvent({
      seat: 'harness',
      model: 'moonshotai/kimi-k3',
      taskId: 'harness-fix-one-lint-class',
      runId: 'r-h1',
      promptHash: 'ph',
      latencyMs: 100,
      tokenUsage: null,
      verdict: 'fail',
      receiptPath: '/tmp/r.json',
      batteryId: 'harness-v1',
      wave: 1,
      productCandidate: true,
      failureClass: 'provider-timeout',
    });
    expect(sparse.payload.productCandidate).toBe(true);
    expect(sparse.payload.failureClass).toBe('provider-timeout');
    expect(sparse.payload.usagePresent).toBe(false);
    expect(sparse.payload.tokenUsage).toBe(null);

    const withUsage = shared.buildRotationLedgerEvent({
      seat: 'generator',
      model: 'grok-4.5',
      taskId: 'gen-p5-easy',
      runId: 'r-g',
      promptHash: 'ph2',
      latencyMs: 50,
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      verdict: 'ok',
      receiptPath: '/tmp/g.json',
      batteryId: 'generator-v1',
      wave: 1,
    });
    expect(withUsage.payload.usagePresent).toBe(true);
    expect(withUsage.payload.tokenUsage?.total).toBe(3);
    expect(withUsage.payload.productCandidate).toBe(null);
  });
});

describe('runBattery invalid fixedJudge → INVALID pack (T0-5)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rot-fj-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('marks chat pack INVALID when evaluatorSeatResOverride is Kilo', async () => {
    const out = path.join(tmp, 'chat-kilo-judge');
    const result = await runBattery('chat', {
      modelOverride: 'mock-chat-fj',
      mock: true,
      out,
      maxTasks: 1,
      evaluatorSeatResOverride: {
        model: 'gemini-3.1-pro-low',
        baseUrl: 'https://api.kilo.ai/api/gateway',
        endpointHost: 'api.kilo.ai',
        apiKey: 'fake',
        keyPresent: true,
        keySource: 'test-injection',
        source: 'test-kilo',
      },
    });
    expect(result.mode).toBe('INVALID');
    expect(result.summary.metrics.northStar).toBeNull();
    expect(result.summary.metrics._suppressed).toBe('fixedJudge-invalid-kilo');
    expect(result.summary.fixedJudge.route).toBe('invalid-kilo');
    expect(result.summary.fitness.scorable).toBe(false);
    const onDisk = JSON.parse(await fs.readFile(path.join(out, 'summary.json'), 'utf8'));
    expect(onDisk.mode).toBe('INVALID');
    expect(onDisk.metrics._suppressed).toBe('fixedJudge-invalid-kilo');
  });
});

describe('mark-invalid-pack (T1)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rot-mip-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('shouldMarkInvalid + markDir for kilo route; skip harness; scan survives bad json', async () => {
    const { shouldMarkInvalid, markDir, scanRoot } = await import(
      '../../../scripts/rotation/mark-invalid-pack.mjs'
    );

    expect(
      shouldMarkInvalid({
        seat: 'harness',
        fixedJudge: { route: 'invalid-kilo' },
      }).mark,
    ).toBe(false);
    expect(
      shouldMarkInvalid({
        seat: 'chat',
        fixedJudge: { route: 'agy-cliproxy' },
      }).mark,
    ).toBe(false);
    expect(
      shouldMarkInvalid({
        seat: 'generator',
        fixedJudge: { route: 'invalid-kilo' },
      }).mark,
    ).toBe(true);
    // Missing fixedJudge must NOT auto-clobber live packs (Wave1 AGY canonicals)
    expect(shouldMarkInvalid({ seat: 'chat', mode: 'live' }).mark).toBe(false);
    expect(shouldMarkInvalid({ seat: 'chat', mode: 'live' }, { forceMissing: true }).mark).toBe(true);

    const goodDir = path.join(tmp, 'pack-good');
    const badDir = path.join(tmp, 'pack-bad');
    const brokenDir = path.join(tmp, 'pack-broken');
    await fs.mkdir(goodDir, { recursive: true });
    await fs.mkdir(badDir, { recursive: true });
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.writeFile(
      path.join(goodDir, 'summary.json'),
      JSON.stringify({
        seat: 'chat',
        mode: 'live',
        fixedJudge: { route: 'agy-cliproxy' },
        metrics: { northStar: 1 },
        findings: [],
      }),
    );
    await fs.writeFile(
      path.join(badDir, 'summary.json'),
      JSON.stringify({
        seat: 'generator',
        mode: 'live',
        fixedJudge: { route: 'invalid-kilo' },
        metrics: { northStar: 0.8 },
        findings: [],
      }),
    );
    await fs.writeFile(path.join(brokenDir, 'summary.json'), '{not-json');

    const skip = markDir(goodDir);
    expect(skip.detail).toMatch(/agy-cliproxy/);
    const marked = markDir(badDir, 'test-reason');
    expect(marked.detail).toBe('marked INVALID');
    const after = JSON.parse(await fs.readFile(path.join(badDir, 'summary.json'), 'utf8'));
    expect(after.mode).toBe('INVALID');
    expect(after.metrics.northStar).toBeNull();
    expect(after.invalidReason).toBe('test-reason');

    const scanned = scanRoot(tmp);
    expect(scanned.results.length).toBe(3);
    const broken = scanned.results.find((r: { runDir: string }) => r.runDir === brokenDir);
    expect(broken.ok).toBe(false);
    expect(String(broken.detail)).toMatch(/parse error/i);
  });
});
