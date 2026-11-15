import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCortexCycleGateReceipt,
  parseCortexCycleGateReceipt,
  type CortexCycleGateReceipt,
} from '../../../src/runtime-core/Wave5GateReceipt.js';

const receiptPath = path.resolve(
  'docs/agents/waves/receipts/wave-5-W5-14-cortex-cycle.json',
);

function loadReceipt(): CortexCycleGateReceipt {
  return JSON.parse(readFileSync(receiptPath, 'utf8')) as CortexCycleGateReceipt;
}

describe('W5-14 Cortex cycle gate receipt', () => {
  it('round-trips the generated restart-safety evidence', () => {
    const receipt = loadReceipt();
    expect(parseCortexCycleGateReceipt(receipt).outcome).toBe('PASS');
    const {
      schemaVersion: _schemaVersion,
      gate: _gate,
      outcome: _outcome,
      checks: _checks,
      receiptDigest: _receiptDigest,
      ...input
    } = receipt;
    const recreated = createCortexCycleGateReceipt(input);
    expect(recreated.outcome).toBe('PASS');
    expect(recreated.checks).toEqual(receipt.checks);
  });

  it('rejects malformed and tampered evidence', () => {
    expect(() => parseCortexCycleGateReceipt(null))
      .toThrow('receipt must be an object');
    const tampered = loadReceipt();
    tampered.completed.authority.stageOneNoMerge = false;
    expect(() => parseCortexCycleGateReceipt(tampered))
      .toThrow('digest mismatch');
  });
});
