import { afterEach, describe, expect, it } from 'vitest';
import {
  MaxIterationGuardrail,
  OutputSchemaGuardrail,
  ResourceExhaustionGuardrail,
  ToolPermissionGuardrail,
  createCatastrophicGuardrails,
} from '../../../src/guardrails/rules/CatastrophicGuardrails.js';
import { createResourceLimiter, removeResourceLimiter } from '../../../src/guardrails/core/ResourceLimiter.js';
import { GuardrailTier, type ExecutionContext, type GuardrailResult } from '../../../src/guardrails/core/types.js';

const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({ taskId: 'task-cat', step: 0, maxSteps: 10, ...over });
const failed = (message = 'm'): GuardrailResult => ({ passed: false, guardrailId: 'g', message });

describe('createCatastrophicGuardrails', () => {
  it('returns the four rules in enforcement order, all in the catastrophic category', () => {
    const rules = createCatastrophicGuardrails();
    expect(rules.map(r => r.id)).toEqual([
      'guardrail-max-iterations', 'guardrail-resource-limits', 'guardrail-tool-permissions', 'guardrail-output-schema',
    ]);
    expect(rules.every(r => r.category === 'catastrophic')).toBe(true);
  });

  it('keeps the loop, resource and tool rules autonomous and the schema rule enforcing', () => {
    const tiers = Object.fromEntries(createCatastrophicGuardrails().map(r => [r.id, r.tier]));
    expect(tiers).toEqual({
      'guardrail-max-iterations': GuardrailTier.AUTONOMOUS,
      'guardrail-resource-limits': GuardrailTier.AUTONOMOUS,
      'guardrail-tool-permissions': GuardrailTier.AUTONOMOUS,
      'guardrail-output-schema': GuardrailTier.ENFORCING,
    });
  });

  it('escalates loops by aborting at once, and tools/schema to human review', () => {
    const esc = Object.fromEntries(createCatastrophicGuardrails().map(r => [r.id, r.escalation]));
    expect(esc['guardrail-max-iterations']).toEqual({ afterFailures: 1, action: 'abort' });
    expect(esc['guardrail-resource-limits']).toEqual({ afterFailures: 3, action: 'circuitBreaker' });
    expect(esc['guardrail-tool-permissions']).toEqual({ afterFailures: 1, action: 'humanReview' });
    expect(esc['guardrail-output-schema']).toEqual({ afterFailures: 2, action: 'humanReview' });
  });
});

describe('MaxIterationGuardrail', () => {
  const rule = new MaxIterationGuardrail();

  it('passes below the limit', async () => {
    expect(await rule.evaluate(ctx({ step: 9 }))).toEqual({
      passed: true, guardrailId: 'guardrail-max-iterations', message: 'Iteration count OK: 9/10',
    });
  });

  it.each([10, 11])('fails critically at step %i (limit is exclusive)', async step => {
    const res = await rule.evaluate(ctx({ step }));
    expect(res).toMatchObject({
      passed: false, severity: 'critical', message: `Maximum iteration count exceeded: ${step}/10`,
      details: { step, maxSteps: 10 },
    });
  });

  it('remediates by aborting with a partial result', async () => {
    const out = await rule.remediate(ctx({ step: 10 }), failed());
    expect(out).toMatchObject({ success: true, action: 'abort_with_partial_result', message: 'Task aborted after 10 iterations' });
    expect(out.newContext!.output).toEqual({
      success: false, partialOutput: 'Task exceeded maximum iteration limit',
      reason: 'Aborted after 10 iterations to prevent infinite loop', stepsCompleted: 10,
    });
  });
});

describe('ResourceExhaustionGuardrail', () => {
  const rule = new ResourceExhaustionGuardrail();
  const taskId = 'task-resource';
  afterEach(() => removeResourceLimiter(taskId));

  it('passes when no limiter is registered for the task', async () => {
    expect(await rule.evaluate(ctx({ taskId }))).toMatchObject({ passed: true, message: 'No resource limiter registered' });
  });

  it('passes while usage is within bounds and reports usage', async () => {
    createResourceLimiter(taskId, { maxTokens: 100 }).recordTokens(10);
    const res = await rule.evaluate(ctx({ taskId }));
    expect(res).toMatchObject({ passed: true, message: 'All resource limits within bounds' });
    expect((res.details as { usage: { tokensUsed: number } }).usage.tokensUsed).toBe(10);
  });

  it('fails critically when tokens reach the limit', async () => {
    createResourceLimiter(taskId, { maxTokens: 100 }).recordTokens(100);
    const res = await rule.evaluate(ctx({ taskId }));
    expect(res).toMatchObject({ passed: false, severity: 'critical', message: 'Resource limit exceeded: Token usage: 100/100' });
    expect(res.details).toMatchObject({ resource: 'tokensUsed', current: 100, limit: 100 });
  });

  it('fails when the API call budget is spent', async () => {
    const limiter = createResourceLimiter(taskId, { maxApiCalls: 1 });
    limiter.recordApiCall();
    const res = await rule.evaluate(ctx({ taskId }));
    expect(res.passed).toBe(false);
    expect(res.details).toMatchObject({ resource: 'apiCalls', current: 1, limit: 1 });
  });

  const violation = (resource: string) => ({ ...failed(), details: { resource, current: 1, limit: 1 } });

  it('cannot remediate without a limiter', async () => {
    expect(await rule.remediate(ctx({ taskId }), violation('tokensUsed'))).toEqual({
      success: false, action: 'none', message: 'No resource limiter available for remediation',
    });
  });

  it.each([
    ['tokensUsed', true, 'truncate_context'],
    ['memoryUsedMB', true, 'force_gc'],
    ['timeElapsedMs', false, 'timeout'],
    ['apiCalls', false, 'rate_limited'],
    ['disk', false, 'unknown'],
  ])('remediates %s as success=%s action=%s', async (resource, success, action) => {
    createResourceLimiter(taskId);
    const out = await rule.remediate(ctx({ taskId }), violation(resource));
    expect(out.success).toBe(success);
    expect(out.action).toBe(action);
  });

  it('replaces the prompt when truncating context and names unknown resources', async () => {
    createResourceLimiter(taskId);
    expect((await rule.remediate(ctx({ taskId }), violation('tokensUsed'))).newContext).toEqual({
      prompt: '[Context truncated due to token limit]',
    });
    expect((await rule.remediate(ctx({ taskId }), violation('disk'))).message).toBe('Unknown resource type: disk');
  });
});

describe('ToolPermissionGuardrail', () => {
  const rule = new ToolPermissionGuardrail();

  it('passes when no tool is proposed', async () => {
    expect(await rule.evaluate(ctx())).toMatchObject({ passed: true, message: 'No tool proposed' });
  });

  it('passes when no allow-list is configured (documented permissive default)', async () => {
    expect(await rule.evaluate(ctx({ proposedTool: 'rm' }))).toMatchObject({ passed: true, message: 'No tool restrictions configured' });
    expect(await rule.evaluate(ctx({ proposedTool: 'rm', allowedTools: [] }))).toMatchObject({ passed: true });
  });

  it('allows a listed tool', async () => {
    expect(await rule.evaluate(ctx({ proposedTool: 'read', allowedTools: ['read', 'write'] })))
      .toMatchObject({ passed: true, message: "Tool 'read' is authorized" });
  });

  it('blocks an unlisted tool critically, with the allow-list as the suggestion', async () => {
    const res = await rule.evaluate(ctx({ proposedTool: 'shell', allowedTools: ['read', 'write'] }));
    expect(res).toMatchObject({
      passed: false, severity: 'critical', message: "Tool 'shell' is not in the allowed list",
      details: { proposedTool: 'shell', allowedTools: ['read', 'write'] }, suggestion: 'Use one of: read, write',
    });
  });

  it('matches tool names exactly (no prefix or case folding)', async () => {
    expect((await rule.evaluate(ctx({ proposedTool: 'Read', allowedTools: ['read'] }))).passed).toBe(false);
    expect((await rule.evaluate(ctx({ proposedTool: 'rea', allowedTools: ['read'] }))).passed).toBe(false);
  });

  it('suggests the first allowed tool when remediating, and nothing when there is none', async () => {
    expect(await rule.remediate(ctx({ allowedTools: ['read', 'write'] }), failed())).toEqual({
      success: true, action: 'suggest_alternative', message: 'Suggested alternative tool: read',
      newContext: { proposedTool: 'read' },
    });
    expect(await rule.remediate(ctx(), failed())).toEqual({ success: false, action: 'none', message: 'No alternative tools available' });
  });
});

describe('OutputSchemaGuardrail', () => {
  const rule = new OutputSchemaGuardrail();

  it('passes when no schema is given', async () => {
    expect(await rule.evaluate(ctx({ output: 'anything' }))).toMatchObject({ passed: true, message: 'No output schema specified' });
  });

  it('fails with an error when there is a schema but no output', async () => {
    expect(await rule.evaluate(ctx({ schema: { a: 1 } }))).toMatchObject({
      passed: false, severity: 'error', message: 'No output to validate',
    });
  });

  it('accepts a JSON string or object that carries every schema key', async () => {
    expect((await rule.evaluate(ctx({ schema: { a: 1, b: 2 }, output: '{"a":1,"b":null}' }))).passed).toBe(true);
    expect((await rule.evaluate(ctx({ schema: { a: 1 }, output: { a: 0, extra: true } }))).message).toBe('Output schema validation passed');
  });

  it('names the missing fields', async () => {
    const res = await rule.evaluate(ctx({ schema: { a: 1, b: 2, c: 3 }, output: { a: 1 } }));
    expect(res).toMatchObject({
      passed: false, severity: 'error', message: 'Output missing required fields: b, c', details: { missingFields: ['b', 'c'] },
    });
  });

  it('fails on a string that is not JSON', async () => {
    const res = await rule.evaluate(ctx({ schema: { a: 1 }, output: 'not json' }));
    expect(res.passed).toBe(false);
    expect(res.severity).toBe('error');
    expect(res.message).toMatch(/^Output is not valid JSON: /);
  });

  it('remediates by appending a correction to the prompt', async () => {
    const out = await rule.remediate(ctx({ prompt: 'make a thing' }), failed());
    expect(out).toMatchObject({ success: true, action: 'regenerate_with_schema' });
    expect(out.newContext!.prompt).toBe(
      'make a thing\n\n[GUARDRAIL REMEDIATION] Previous output was invalid. Please ensure your response follows the required schema exactly.',
    );
  });
});
