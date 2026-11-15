/**
 * ADV-MISO-001 — bridge proves honesty fields on generation.complete.
 *
 * A degraded prove-path run (confidence 0 / failureClass 'scorer') must emit
 * qualityState 'degraded' with evaluationConfidence + evaluationFailureClass,
 * never a bare 'scored' state that fabricates a real fitness score.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { draftGenerate } = vi.hoisted(() => ({
  draftGenerate: vi.fn(async () => ({
    needsClarification: false,
    code: 'function setup() {}',
    thinking: 'unused',
    model: 'test-model',
  })),
}));

const { mockEmitPreviewArtifacts } = vi.hoisted(() => ({
  mockEmitPreviewArtifacts: vi.fn(async (
    ctx: { emit: (sessionId: string, event: Record<string, unknown>) => void },
    sessionId: string,
    _code: string,
    domain: string,
  ) => {
    ctx.emit(sessionId, {
      type: 'artifact.found',
      sessionId,
      artifactLabel: `${domain} HTML preview`,
      artifactPath: `.omx/proof/live-previews/${sessionId}.html`,
    });
    ctx.emit(sessionId, {
      type: 'preview.completed',
      sessionId,
      previewType: 'html',
      content: '<html></html>',
      artifactPath: `.omx/proof/live-previews/${sessionId}.html`,
    });
    ctx.emit(sessionId, {
      type: 'preview.verified',
      sessionId,
      previewType: 'html',
      artifactPath: `.omx/proof/live-previews/${sessionId}.html`,
      checks: ['mock preview rendered'],
    });
    ctx.emit(sessionId, {
      type: 'generation.domain_truth',
      sessionId,
      requestedDomain: domain,
      selectedDomain: domain,
      domains: [domain],
      promptDomainLocked: true,
      source: 'prompt',
      generatedDomain: domain,
      previewDomain: domain,
      artifactPath: `.omx/proof/live-previews/${sessionId}.html`,
    });
  }),
}));

vi.mock('../../../src/tui-bridge/PreviewService.js', () => ({
  emitPreviewArtifacts: mockEmitPreviewArtifacts,
}));

vi.mock('../../../src/core/GenerationOrchestrator.js', () => ({
  GenerationOrchestrator: class {
    generate = draftGenerate;
  },
}));

const { TuiBridgeService } = await import('../../../src/tui-bridge/TuiBridgeService.js');

function fakeLlm() {
  return {
    getConfig: () => ({ baseUrl: 'https://api.openai.com/v1', model: 'test-model' }),
    generate: vi.fn().mockResolvedValue({ code: 'ok', explanation: '', success: true }),
  };
}

function governedProduct(admissionEligible: boolean, score: number,
  confidence: number, failureClass: 'none' | 'scorer') {
  const command = { idempotencyKey: `honesty-${admissionEligible}` };
  const productCreateCommand = vi.fn(async () => command);
  const submitCreate = vi.fn(async () => ({ kind: 'create', status: 'completed', result: {
    lineageId: 'verified-lineage', roles: { generator: 'verified/generator' },
    evaluation: { score, confidence, failureClass, admissionEligible,
      degraded: !admissionEligible, identityValid: true,
      evaluatorIdentity: 'verified/evaluator', evidenceDigest: 'evidence',
      rejectionReasons: admissionEligible ? [] : ['evaluation-degraded'] },
  } }));
  return { productCreateCommand, submitCreate,
    productCommands: { submitCreate,
      verifiedArtifact: vi.fn(async () => ({ source:
        'function setup() { createCanvas(100, 100); background(20); }' })) } };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 800; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for event');
}

describe('ADV-MISO-001 bridge honesty on generation.complete', () => {
  beforeEach(() => {
    draftGenerate.mockClear();
    mockEmitPreviewArtifacts.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits qualityState degraded with honesty fields when evaluator confidence is 0 / scorer', async () => {
    const product = governedProduct(false, 0.61, 0, 'scorer');
    const service = new TuiBridgeService(product as never);
    const session = service.createSession();

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'p5 drifting particles',
        clientIntent: 'creative',
        executionMode: 'prove',
        maxIterations: 1,
        candidateCount: 1,
        timeoutMinutes: 1,
      },
      fakeLlm() as never,
    );

    const complete = await waitFor(() =>
      service.getEvents(session.sessionId).find(event => event.type === 'generation.complete'),
    );

    expect(product.submitCreate).toHaveBeenCalledTimes(1);
    expect(complete).toMatchObject({
      type: 'generation.complete',
      qualityState: 'degraded',
      evaluationConfidence: 0,
      evaluationFailureClass: 'scorer',
      executionMode: 'prove',
      finalScore: 0.61,
    });
    expect(complete).not.toMatchObject({ qualityState: 'scored' });

    // Early domain-plan receipts mark evaluation as pending; wait for the
    // post-complete evaluation organ (emitted immediately with generation.complete).
    const evaluation = await waitFor(() => {
      const receipts = service.getEvents(session.sessionId)
        .filter(event => event.type === 'generation.cognitive_receipt')
        .flatMap(event =>
          ((event as { receipts?: Array<{ organ: string; status: string; detail: string }> }).receipts ?? [])
            .filter(r => r.organ === 'evaluation' && r.status !== 'pending'),
        );
      return receipts[receipts.length - 1];
    });
    expect(evaluation.status).toBe('unavailable');
    expect(evaluation.detail).toMatch(/degraded/i);
    expect(evaluation.detail).toMatch(/scorer/);

    // immune-truth must not claim "scored output" when evaluation is degraded.
    const immuneTruth = await waitFor(() => {
      const receipts = service.getEvents(session.sessionId)
        .filter(event => event.type === 'generation.cognitive_receipt')
        .flatMap(event =>
          ((event as { receipts?: Array<{ organ: string; status: string; detail: string }> }).receipts ?? [])
            .filter(r => r.organ === 'immune-truth'),
        );
      // Prefer the post-complete receipt that pairs with evaluation honesty.
      return receipts.find(r => /degraded mode/i.test(r.detail)) ?? receipts[receipts.length - 1];
    });
    expect(immuneTruth.detail).toMatch(/degraded mode/i);
    expect(immuneTruth.detail).toMatch(/without a real fitness score/i);
    expect(immuneTruth.detail).not.toMatch(/scored output/i);
  });

  it('emits qualityState scored with honesty fields when the evaluator is honest', async () => {
    const product = governedProduct(true, 0.88, 1, 'none');
    const service = new TuiBridgeService(product as never);
    const session = service.createSession();

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'p5 soft circles',
        clientIntent: 'creative',
        executionMode: 'prove',
        maxIterations: 1,
        candidateCount: 1,
        timeoutMinutes: 1,
      },
      fakeLlm() as never,
    );

    const complete = await waitFor(() =>
      service.getEvents(session.sessionId).find(event => event.type === 'generation.complete'),
    );

    expect(complete).toMatchObject({
      type: 'generation.complete',
      qualityState: 'scored',
      evaluationConfidence: 1,
      evaluationFailureClass: 'none',
      executionMode: 'prove',
      finalScore: 0.88,
      model: 'verified/generator',
    });
    expect(product.submitCreate).toHaveBeenCalledTimes(1);
  });
});
