import { describe, expect, it } from 'vitest';
import {
  createMemoryFeedForwardGateReceipt,
  parseMemoryFeedForwardGateReceipt,
} from '../../../src/runtime-core/Wave5GateReceipt.js';

function condition(injected: boolean) {
  return {
    lineageId: injected ? 'run-treatment' : 'run-control',
    sessionId: injected ? 'session-treatment' : 'session-control',
    contextDigest: injected ? 'context-treatment' : 'context-control',
    requestDigest: injected ? 'request-treatment' : 'request-control',
    artifactDigest: injected ? 'artifact-treatment' : 'artifact-control',
    injected,
    sourceEpisodeIds: injected ? ['ep-control'] : [],
    tainted: injected,
  };
}

describe('W5-03 memory feed-forward gate receipt', () => {
  it('emits an immutable typed PASS only when every causal check passes', () => {
    const receipt = createMemoryFeedForwardGateReceipt({
      generatedAt: '2026-07-30T00:00:00.000Z',
      promptDigest: 'prompt-digest',
      control: condition(false),
      treatment: condition(true),
      checks: {
        controlUninjected: true,
        treatmentInjected: true,
        exactDigestStamped: true,
        sourceLinked: true,
        requestChanged: true,
        downstreamChanged: true,
        taintPreserved: true,
      },
      evidenceRefs: ['lineage:run-control', 'lineage:run-treatment'],
    });

    expect(receipt.outcome).toBe('PASS');
    expect(parseMemoryFeedForwardGateReceipt(receipt)).toEqual(receipt);
    expect(() => parseMemoryFeedForwardGateReceipt({
      ...receipt,
      treatment: { ...receipt.treatment, requestDigest: 'tampered' },
    })).toThrow('digest mismatch');
  });

  it('cannot claim PASS while a required comparison check is false', () => {
    const receipt = createMemoryFeedForwardGateReceipt({
      generatedAt: '2026-07-30T00:00:00.000Z',
      promptDigest: 'prompt-digest',
      control: condition(false),
      treatment: condition(true),
      checks: {
        controlUninjected: true,
        treatmentInjected: true,
        exactDigestStamped: true,
        sourceLinked: true,
        requestChanged: true,
        downstreamChanged: false,
        taintPreserved: true,
      },
      evidenceRefs: [],
    });

    expect(receipt.outcome).toBe('FAIL');
  });
});
