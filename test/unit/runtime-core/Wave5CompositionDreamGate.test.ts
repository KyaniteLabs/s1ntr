import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseCompositionDreamGateReceipt } from '../../../src/runtime-core/Wave5GateReceipt.js';

const receiptPath = path.join(
  process.cwd(),
  'docs/agents/waves/receipts/wave-5-W5-07-composition-dream.json',
);

describe('W5-07 composition dream gate', () => {
  it('parses the canonical chained receipt and rejects tampering', () => {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(parseCompositionDreamGateReceipt(receipt).outcome).toBe('PASS');

    const tampered = structuredClone(receipt);
    tampered.admitted.recipe.mappings[0].scale += 1;
    expect(() => parseCompositionDreamGateReceipt(tampered))
      .toThrow('INVALID_W5_07_RECEIPT: digest mismatch');
  });
});
