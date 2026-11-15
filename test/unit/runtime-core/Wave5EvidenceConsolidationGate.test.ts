import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseEvidenceConsolidationGateReceipt,
} from '../../../src/runtime-core/Wave5GateReceipt.js';

const receiptPath = path.join(
  process.cwd(),
  'docs/agents/waves/receipts/wave-5-W5-08-evidence-consolidation.json',
);

describe('W5-08 evidence consolidation gate', () => {
  it('parses the canonical chained receipt and rejects tampering', () => {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(parseEvidenceConsolidationGateReceipt(receipt).outcome).toBe('PASS');

    const tampered = structuredClone(receipt);
    tampered.ready.confidence = 1;
    expect(() => parseEvidenceConsolidationGateReceipt(tampered))
      .toThrow('INVALID_W5_08_RECEIPT: digest mismatch');
  });
});
