import { describe, expect, it } from 'vitest';
import { buildCognitiveRunReceipt } from '../../../src/runtime-core/CognitiveRunReceipt.js';

describe('buildCognitiveRunReceipt', () => {
  it('turns a run outcome into memory compost dreaming and intuition signals', () => {
    const receipt = buildCognitiveRunReceipt({
      prompt: 'Improve Strudel repair after invalid rhythm output',
      lane: 'self-improvement',
      status: 'failed',
      artifactPaths: [],
      failures: ['Strudel validator rejected rhythm syntax'],
      mutatedFiles: ['src/generators/strudel/StrudelGenerator.ts'],
    });

    expect(receipt.loop).toBe('self-improvement');
    expect(receipt.organs.memory.status).toBe('unavailable');
    expect(receipt.organs.compost.status).toBe('observed');
    expect(receipt.organs.dreaming.status).toBe('pending');
    expect(receipt.organs.intuition.status).toBe('unavailable');
    expect(receipt.organs.compost.detail).toContain('Strudel validator rejected rhythm syntax');
    expect(receipt.nextAction.kind).toBe('repair');
    expect(receipt.nextAction.reason).toContain('failed');
  });

  const successInput = {
    prompt: 'Compose a drone',
    lane: 'creative' as const,
    status: 'success' as const,
    artifactPaths: ['out/drone.strudel'],
    failures: [],
    mutatedFiles: [],
  };

  it('does not invent memory or intuition participation from a successful status', () => {
    const receipt = buildCognitiveRunReceipt(successInput);

    expect(receipt.organs.memory).toEqual({ status: 'unavailable', detail: 'No memory participation receipt for this run.' });
    expect(receipt.organs.intuition).toEqual({ status: 'unavailable', detail: 'No intuition participation receipt for this run.' });
    expect(receipt.nextAction.kind).toBe('investigate');
    expect(receipt.nextAction.reason).toContain('without a memory participation receipt');
  });

  it('reports organs as observed only from matching participation receipts and then ships', () => {
    const receipt = buildCognitiveRunReceipt({
      ...successInput,
      organReceipts: [
        { organ: 'memory', status: 'observed', detail: 'stored episode ep-1' },
        { organ: 'intuition', status: 'pending', detail: 'cache warm-up deferred' },
        { organ: 'unrelated', status: 'observed', detail: 'ignored' },
      ],
    });

    expect(receipt.organs.memory).toEqual({ status: 'observed', detail: 'stored episode ep-1' });
    expect(receipt.organs.intuition).toEqual({ status: 'pending', detail: 'cache warm-up deferred' });
    expect(receipt.nextAction.kind).toBe('ship');
  });

  it('refuses to ship a success with no artifacts even when memory participated', () => {
    const receipt = buildCognitiveRunReceipt({
      ...successInput,
      artifactPaths: [],
      organReceipts: [{ organ: 'memory', status: 'observed', detail: 'stored' }],
    });

    expect(receipt.nextAction.kind).toBe('investigate');
    expect(receipt.nextAction.reason).toContain('no artifacts');
  });

  it('does not ship when the memory receipt reports the organ unavailable', () => {
    const receipt = buildCognitiveRunReceipt({
      ...successInput,
      organReceipts: [{ organ: 'memory', status: 'unavailable', detail: 'store offline' }],
    });

    expect(receipt.organs.memory).toEqual({ status: 'unavailable', detail: 'store offline' });
    expect(receipt.nextAction.kind).toBe('investigate');
  });

  it('repairs rather than ships when failures are present despite success status and receipts', () => {
    const receipt = buildCognitiveRunReceipt({
      ...successInput,
      failures: ['validator warning escalated'],
      organReceipts: [{ organ: 'memory', status: 'observed', detail: 'stored' }],
    });

    expect(receipt.nextAction.kind).toBe('repair');
    expect(receipt.organs.compost).toEqual({ status: 'observed', detail: 'validator warning escalated' });
  });
});
