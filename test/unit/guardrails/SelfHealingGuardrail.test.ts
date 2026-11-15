import { describe, it, expect, beforeEach } from 'vitest';
import { Constitution } from '../../../src/guardrails/evolution/Constitution.js';
import type { FailureRecord } from '../../../src/guardrails/evolution/Constitution.js';
import { SelfHealingGuardrail } from '../../../src/guardrails/evolution/SelfHealingGuardrail.js';
import type { ExecutionContext, GuardrailResult } from '../../../src/guardrails/core/types.js';

function makeContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    taskId: 'task-1',
    step: 1,
    maxSteps: 10,
    startTime: Date.now(),
    resources: {
      tokensUsed: 0,
      tokensLimit: 10000,
      memoryUsedMB: 0,
      memoryLimitMB: 512,
      timeElapsedMs: 0,
      timeLimitMs: 60000,
      apiCalls: 0,
      apiCallLimit: 100,
    },
    trace: { steps: [] },
    ...overrides,
  };
}

function makeFailure(overrides: Partial<FailureRecord>): FailureRecord {
  return {
    id: `fail-${Math.random()}`,
    timestamp: Date.now(),
    taskId: 'task-1',
    guardrailId: 'guard-x',
    errorType: 'SYNTAX_ERROR',
    errorMessage: 'deploy',
    context: makeContext(),
    resolution: 'humanResolved',
    ...overrides,
  };
}

const violation: GuardrailResult = {
  passed: false,
  guardrailId: 'guard-x',
  severity: 'error',
  message: 'deploy',
};

describe('SelfHealingGuardrail', () => {
  let constitution: Constitution;
  let guardrail: SelfHealingGuardrail;

  beforeEach(() => {
    constitution = new Constitution();
    guardrail = new SelfHealingGuardrail(constitution, { confidenceThreshold: 0.5 });
  });

  it('checks each active rule individually instead of repeating the first global match', async () => {
    const deployRule = await constitution.learnFromFailure(makeFailure({ errorType: 'SYNTAX_ERROR', errorMessage: 'deploy' }));
    const migrateRule = await constitution.learnFromFailure(makeFailure({ errorType: 'TIMEOUT', errorMessage: 'migrate' }));

    const result = await guardrail.evaluate(makeContext({ proposedTool: 'migrate' }));

    expect(result.passed).toBe(false);
    expect(result.message).toBe('Prevented 1 potential failure(s) based on learned patterns');
    expect((result.details as { applicableRules: Array<{ ruleId: string }> }).applicableRules.map((r) => r.ruleId))
      .toEqual([migrateRule!.id]);
    expect(deployRule!.id).not.toBe(migrateRule!.id);
  });

  it('reports every distinct matching rule once', async () => {
    const a = await constitution.learnFromFailure(makeFailure({ errorType: 'SYNTAX_ERROR', errorMessage: 'deploy' }));
    const b = await constitution.learnFromFailure(makeFailure({ errorType: 'TIMEOUT', errorMessage: 'production' }));

    const result = await guardrail.evaluate(makeContext({ proposedTool: 'deploy production' }));
    const ids = (result.details as { applicableRules: Array<{ ruleId: string }> }).applicableRules.map((r) => r.ruleId);

    expect(ids.sort()).toEqual([a!.id, b!.id].sort());
  });

  it('passes when no learned rule matches the proposed action', async () => {
    await constitution.learnFromFailure(makeFailure({ errorMessage: 'deploy' }));

    const result = await guardrail.evaluate(makeContext({ proposedTool: 'format' }));

    expect(result.passed).toBe(true);
    expect(result.message).toBe('Self-healing active. Monitoring with 1 learned rules.');
  });

  it('reports a learned remediation as an unapplied suggestion, not a successful repair', async () => {
    const rule = await constitution.learnFromFailure(makeFailure({ errorMessage: 'deploy', fixDetails: 'pin the version' }));

    const remediation = await guardrail.remediate(makeContext(), violation);

    expect(remediation.success).toBe(false);
    expect(remediation.action).toBe('suggest_learned_remediation');
    expect(remediation.details).toMatchObject({ ruleId: rule!.id, applied: false, verified: false });
  });

  it('escalates when no learned remediation matches', async () => {
    const remediation = await guardrail.remediate(makeContext(), violation);

    expect(remediation.success).toBe(false);
    expect(remediation.action).toBe('escalate_to_human');
  });

  it('does not raise rule confidence for an unverified autoFixed label', async () => {
    const context = makeContext();
    await guardrail.recordFailure(context, 'guard-x', 'syntax deploy broke', 'humanResolved');
    const [rule] = constitution.getAllRules();
    const before = { confidence: rule.confidence, successCount: rule.successCount };

    await guardrail.recordFailure(context, 'guard-x', 'syntax deploy broke', 'autoFixed', 'patched');

    expect(constitution.getRule(rule.id)!.confidence).toBe(before.confidence);
    expect(constitution.getRule(rule.id)!.successCount).toBe(before.successCount);
    expect(constitution.getRule(rule.id)!.failureCount).toBe(2);
  });

  it('counts a verified auto-fix exactly once', async () => {
    const context = makeContext();
    await guardrail.recordFailure(context, 'guard-x', 'syntax deploy broke', 'humanResolved');
    const [rule] = constitution.getAllRules();

    await guardrail.recordFailure(context, 'guard-x', 'syntax deploy broke', 'autoFixed', 'patched', { verified: true });

    expect(constitution.getRule(rule.id)!.successCount).toBe(1);
    expect(constitution.getRule(rule.id)!.confidence).toBeCloseTo(0.55, 10);
  });

  it('does not learn from a failed resolution', async () => {
    await guardrail.recordFailure(makeContext(), 'guard-x', 'syntax deploy broke', 'failed');

    expect(constitution.getAllRules()).toEqual([]);
  });
});
