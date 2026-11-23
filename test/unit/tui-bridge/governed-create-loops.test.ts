/**
 * Chat/TUI/GUI create with `loops: 3` runs three governed Creates through the same LiminalProductionLoops module as
 * `generate --loops`: loop k+1's prompt carries loop k's accepted code and the judge's critique.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/tui-bridge/PreviewService.js', () => ({
  emitPreviewArtifacts: vi.fn(async (ctx: { emit: (s: string, e: Record<string, unknown>) => void }, sessionId: string) => {
    ctx.emit(sessionId, { type: 'preview.completed', sessionId, previewType: 'html', content: '<html></html>', artifactPath: 'x.html' });
  }),
}));
const { TuiBridgeService } = await import('../../../src/tui-bridge/TuiBridgeService.js');

function product(prompts: string[], scores: number[]) {
  let n = 0;
  return { productCreateCommand: vi.fn(async (input: { prompt: string }) => { prompts.push(input.prompt); n += 1; return { idempotencyKey: `k${n}` }; }),
    productCommands: {
      submitCreate: vi.fn(async () => { const i = prompts.length; return { kind: 'create', status: 'completed', result: {
        lineageId: 'l', roles: { generator: 'g' }, attempts: { consumed: 2, maximum: 2 },
        evaluation: { score: scores[i - 1], confidence: 1, failureClass: 'none', admissionEligible: true, degraded: false,
          identityValid: true, evaluatorIdentity: 'e', evidenceDigest: 'd', rejectionReasons: [], reasoning: `CRITIQUE-${i}` } } }; }),
      verifiedArtifact: vi.fn(async () => ({ source: `function setup(){ /* CODE-${prompts.length} */ }` })),
    } };
}
const waitFor = async <T,>(read: () => T | undefined): Promise<T> => {
  for (let i = 0; i < 1000; i++) { const v = read(); if (v !== undefined) return v; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timeout');
};

describe('chat/TUI/GUI governed create with loops', () => {
  it('chains three loops with code + critique carried and completes on the best loop', async () => {
    const prompts: string[] = [];
    const service = new TuiBridgeService(product(prompts, [0.5, 0.9, 0.6]) as never);
    const session = service.createSession();
    await service.submitInput(session.sessionId, { mode: 'chat', text: 'a p5 sketch of drifting embers', clientIntent: 'creative',
      executionMode: 'prove', loops: 3 } as never, { getConfig: () => ({ baseUrl: 'x', model: 'm' }), generate: vi.fn() } as never);
    const done = await waitFor(() => service.getEvents(session.sessionId).find(e => e.type === 'generation.complete')) as { finalScore: number };
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain('This is loop');
    expect(prompts[1]).toContain('This is loop 2 of 3');
    expect(prompts[1]).toContain('CODE-1');
    expect(prompts[1]).toContain('CRITIQUE-1');
    expect(prompts[2]).toContain('CODE-2');
    expect(prompts[2]).toContain('CRITIQUE-2');
    expect(done.finalScore).toBeCloseTo(0.9, 6); // best loop, not the last
  });
});
