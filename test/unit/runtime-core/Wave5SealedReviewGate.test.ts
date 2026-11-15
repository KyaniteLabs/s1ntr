import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSealedReviewGateReceipt } from '../../../src/runtime-core/Wave5GateReceipt.js';

const receiptPath = path.resolve(
  'docs/agents/waves/receipts/wave-5-W5-10-sealed-review.json',
);

describe('W5-10 sealed review gate receipt', () => {
  it('parses the canonical passing receipt', async () => {
    const receipt = parseSealedReviewGateReceipt(
      JSON.parse(await fs.readFile(receiptPath, 'utf8')),
    );
    expect(receipt.outcome).toBe('PASS');
    expect(Object.values(receipt.checks).every(Boolean)).toBe(true);
  });

  it('rejects tampered reviewer evidence', async () => {
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    receipt.approved.review.requestedFollowUp = [];
    expect(() => parseSealedReviewGateReceipt(receipt))
      .toThrow(/digest mismatch/);
  });
});
