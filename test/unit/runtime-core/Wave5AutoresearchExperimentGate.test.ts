import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAutoresearchExperimentGateReceipt,
} from '../../../src/runtime-core/Wave5GateReceipt.js';

const receiptPath = path.join(
  process.cwd(),
  'docs/agents/waves/receipts/wave-5-W5-09-autoresearch-experiment.json',
);

describe('W5-09 Autoresearch experiment gate', () => {
  it('parses the chained receipt and rejects tampering', () => {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(parseAutoresearchExperimentGateReceipt(receipt).outcome).toBe('PASS');

    const tampered = structuredClone(receipt);
    tampered.passing.changedPaths = [];
    expect(() => parseAutoresearchExperimentGateReceipt(tampered))
      .toThrow('INVALID_W5_09_RECEIPT: digest mismatch');
  });
});
