import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createEnvelope,
  appendProofStep,
  validateEnvelopeForGreen,
  evaluateWaveGate,
  linkGuidanceContinuity,
  attachRequeueContinuity,
  validateGuidanceContinuity,
  writeEnvelope,
  lessonIdentity,
  isFailureRetryable,
  classifyTimeoutError,
  digestPlanContent,
} from '../../../src/harness/CompoundRunEnvelope.js';
import { publishDiagnosePlan, normalizePlanText } from '../../../src/harness/PlanPublisher.js';
import {
  isPathAllowlisted,
  assertPathAllowlisted,
} from '../../../src/harness/DiagnosePathAllowlist.js';
import { verifyPatternBeforeLearn } from '../../../src/harness/SelfImproveCompoundLoop.js';

describe('CompoundRunEnvelope', () => {
  it('creates envelope with run/attempt ids and empty proofChain', () => {
    const env = createEnvelope({
      taskId: 't1',
      seat: { resolvedModel: 'gpt-5.6-sol', endpointHost: 'localhost' },
    });
    expect(env.version).toBe(1);
    expect(env.runId.startsWith('run_')).toBe(true);
    expect(env.attemptId).toContain('t1');
    expect(env.proofChain.steps).toEqual([]);
    expect(env.outcome).toBe('pending');
  });

  it('validateEnvelopeForGreen fails closed without proofChain steps or model', () => {
    const bare = createEnvelope({
      taskId: 't2',
      seat: { resolvedModel: '' },
    });
    const v = validateEnvelopeForGreen(bare);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => r.includes('resolvedModel') || r.includes('proofChain') || r.includes('empty'))).toBe(true);
  });

  it('evaluateWaveGate is pure function of envelope', () => {
    let env = createEnvelope({
      taskId: 't3',
      seat: { resolvedModel: 'grok-4.5' },
    });
    env = appendProofStep(env, { stage: 'prompt', ok: true });
    env = appendProofStep(env, { stage: 'plan', ok: true, detail: 'ok' });
    env.outcome = 'ok';
    const green = evaluateWaveGate(env);
    expect(green.decision).toBe('green');

    env.outcome = 'timeout';
    env.failureClass = 'provider-timeout';
    const red = evaluateWaveGate(env);
    expect(red.decision).toBe('red');
    expect(red.reason).toContain('timeout');
  });

  it('requireGuidanceContinuity fails without link; passes with producer≠consumer', () => {
    let env = createEnvelope({
      taskId: 't-cont',
      seat: { resolvedModel: 'sol' },
    });
    env = appendProofStep(env, { stage: 'prompt', ok: true });
    env.outcome = 'ok';
    expect(evaluateWaveGate(env, { requireGuidanceContinuity: true }).decision).toBe('red');
    env = linkGuidanceContinuity(env, {
      producerAttemptId: 'a1',
      consumerAttemptId: 'a2',
      guidanceId: 'g1',
    });
    expect(validateGuidanceContinuity(env).ok).toBe(true);
    expect(evaluateWaveGate(env, { requireGuidanceContinuity: true }).decision).toBe('green');
  });

  it('timeout failure classes are retryable; auth and missing-plan are not', () => {
    expect(isFailureRetryable('provider-timeout')).toBe(true);
    expect(isFailureRetryable('harness-deadline')).toBe(true);
    expect(isFailureRetryable('auth')).toBe(false);
    expect(isFailureRetryable('missing-plan')).toBe(false);
    expect(isFailureRetryable('json-parse')).toBe(false);
  });

  it('classifyTimeoutError maps abort messages', () => {
    expect(classifyTimeoutError('The operation was aborted due to timeout')).toBe('provider-timeout');
  });

  it('classifyTimeoutError prefers structured timeoutSource over message (H-TELEM-05)', () => {
    // Provider ownership wins even when message contains "deadline"
    expect(
      classifyTimeoutError({
        message: 'provider deadline exceeded',
        timeoutSource: 'provider',
      }),
    ).toBe('provider-timeout');
    // Harness ownership wins even when message contains "timeout"
    expect(
      classifyTimeoutError({
        message: 'request timeout after 30s',
        timeoutSource: 'harness',
      }),
    ).toBe('harness-deadline');
    expect(classifyTimeoutError({ message: 'queue delay', timeoutSource: 'queue' })).toBe(
      'provider-timeout',
    );
    expect(classifyTimeoutError({ message: 'cancelled', timeoutSource: 'cancel' })).toBe(
      'harness-deadline',
    );
    // unknown falls back to message
    expect(
      classifyTimeoutError({
        message: 'The operation was aborted due to timeout',
        timeoutSource: 'unknown',
      }),
    ).toBe('provider-timeout');
  });

  it('attachRequeueContinuity: first attempt does not require continuity (#471)', () => {
    let current = createEnvelope({ taskId: 'rq-1', seat: { resolvedModel: 'sol' } });
    current = appendProofStep(current, { stage: 'prompt', ok: true });
    current.outcome = 'ok';
    const r = attachRequeueContinuity({ prior: null, current });
    expect(r.linked).toBe(false);
    expect(r.requireGuidanceContinuity).toBe(false);
    expect(evaluateWaveGate(r.env).decision).toBe('green');
    expect(evaluateWaveGate(r.env, { requireGuidanceContinuity: r.requireGuidanceContinuity }).decision).toBe(
      'green',
    );
  });

  it('attachRequeueContinuity: retryable prior links and requires continuity (#471)', () => {
    let prior = createEnvelope({
      taskId: 'rq-2',
      seat: { resolvedModel: 'sol' },
      attemptId: 'run_x_a1_prior',
    });
    prior = appendProofStep(prior, { stage: 'prompt', ok: true });
    prior.outcome = 'timeout';
    prior.failureClass = 'provider-timeout';

    let current = createEnvelope({
      taskId: 'rq-2',
      seat: { resolvedModel: 'sol' },
      attemptId: 'run_x_a2_current',
      parentAttemptId: prior.attemptId,
    });
    current = appendProofStep(current, { stage: 'prompt', ok: true });
    current.outcome = 'ok';

    const r = attachRequeueContinuity({ prior, current, guidanceId: 'g-from-timeout' });
    expect(r.linked).toBe(true);
    expect(r.requireGuidanceContinuity).toBe(true);
    expect(r.guidanceId).toBe('g-from-timeout');
    expect(r.env.proofChain.continuity?.producerAttemptId).toBe('run_x_a1_prior');
    expect(r.env.proofChain.continuity?.consumerAttemptId).toBe('run_x_a2_current');
    expect(evaluateWaveGate(r.env, { requireGuidanceContinuity: true }).decision).toBe('green');
  });

  it('attachRequeueContinuity: non-retryable prior does not force continuity (#471)', () => {
    let prior = createEnvelope({ taskId: 'rq-3', seat: { resolvedModel: 'sol' }, attemptId: 'a1' });
    prior.outcome = 'fail';
    prior.failureClass = 'auth';
    let current = createEnvelope({ taskId: 'rq-3', seat: { resolvedModel: 'sol' }, attemptId: 'a2' });
    current = appendProofStep(current, { stage: 'prompt', ok: true });
    current.outcome = 'ok';
    const r = attachRequeueContinuity({ prior, current });
    expect(r.linked).toBe(false);
    expect(r.requireGuidanceContinuity).toBe(false);
  });


  it('timeout outcome stays red and can carry boundaryMs on envelope (W9-L3-01)', () => {
    let env = createEnvelope({ taskId: 't-bound', seat: { resolvedModel: 'sol' } });
    env = appendProofStep(env, { stage: 'prompt', ok: true });
    env.outcome = 'timeout';
    env.failureClass = 'provider-timeout';
    env.timeoutSource = 'provider';
    env.boundaryMs = { 'model-invoke': 120000 };
    expect(evaluateWaveGate(env).decision).toBe('red');
    expect(env.boundaryMs['model-invoke']).toBe(120000);
    expect(env.timeoutSource).toBe('provider');
    expect(isFailureRetryable(env.failureClass)).toBe(true);
  });


  it('lessonIdentity is stable for same evidence (not timestamp-based)', () => {
    const a = lessonIdentity({ failureClass: 'other', errorSnippet: 'timeout step 10', domain: 'harness' });
    const b = lessonIdentity({ failureClass: 'other', errorSnippet: 'timeout step 10', domain: 'harness' });
    expect(a).toBe(b);
    expect(a).toHaveLength(24);
  });

  it('writeEnvelope persists JSON under receipts/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    try {
      let env = createEnvelope({
        taskId: 'task-x',
        seat: { resolvedModel: 'm' },
      });
      env = appendProofStep(env, { stage: 'prompt', ok: true });
      env.outcome = 'ok';
      const p = writeEnvelope(dir, env);
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      expect(raw.taskId).toBe('task-x');
      expect(raw.proofChain.steps.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PlanPublisher', () => {
  it('publish is idempotent for same content digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-'));
    try {
      const plan = '# Title\n\n' + 'x'.repeat(220);
      const first = publishDiagnosePlan({ runDir: dir, taskId: 'tid', planText: plan, attemptId: 'a1' });
      const second = publishDiagnosePlan({ runDir: dir, taskId: 'tid', planText: plan, attemptId: 'a2' });
      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(first.contentDigest).toBe(second.contentDigest);
      expect(readFileSync(first.planPath, 'utf8').length).toBeGreaterThanOrEqual(200);
      const meta = JSON.parse(readFileSync(join(dir, 'receipts', 'tid-plan.meta.json'), 'utf8'));
      expect(meta.attemptIds).toEqual(expect.arrayContaining(['a1', 'a2']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizePlanText is idempotent', () => {
    const t = normalizePlanText('hello\r\nworld');
    expect(normalizePlanText(t)).toBe(t);
  });

  it('rejects short plans', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-short-'));
    try {
      expect(() =>
        publishDiagnosePlan({ runDir: dir, taskId: 't', planText: 'too short' }),
      ).toThrow(/plan_too_short/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DiagnosePathAllowlist', () => {
  it('allows docs and tmp; rejects .quality', () => {
    expect(isPathAllowlisted('docs/agents/waves/x.md')).toBe(true);
    expect(isPathAllowlisted('tmp/wave6/META.md')).toBe(true);
    expect(isPathAllowlisted('src/harness/x.ts')).toBe(true);
    expect(isPathAllowlisted('.quality/wave6/plan.md')).toBe(false);
  });

  it('assertPathAllowlisted throws INPUT_UNREACHABLE', () => {
    expect(() => assertPathAllowlisted('.quality/x')).toThrow(/INPUT_UNREACHABLE/);
  });
});

describe('verifyPatternBeforeLearn', () => {
  it('rejects harmful fixtures and allows normal names', () => {
    expect(verifyPatternBeforeLearn({ name: 'harmful-delete-all' })).toBe('harmful-pattern-rejected');
    expect(verifyPatternBeforeLearn({ name: 'ok-pattern', description: 'raise timeout' })).toBeNull();
    expect(verifyPatternBeforeLearn({ name: '' })).toBe('empty_pattern_name');
  });
});

describe('digestPlanContent', () => {
  it('is stable', () => {
    expect(digestPlanContent('abc')).toBe(digestPlanContent('abc'));
  });
});
