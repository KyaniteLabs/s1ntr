import { describe, expect, it } from 'vitest';
import { bootstrapProductionLiminalOwnerReviewAuthority,
  createTestLiminalOwnerReviewAuthority }
  from '../../../src/runtime-core/LiminalOwnerReviewAuthority.js';

const command = Object.freeze({
  schema: 'sinter.liminal-owner-review-command' as const,
  schemaVersion: 1 as const,
  idempotencyKey: 'review-one', createIdempotencyKey: 'create-one',
  operationId: 'operation-one', artifactRootDigest: 'a'.repeat(64),
  evidenceRootDigest: 'b'.repeat(64), decision: 'accepted' as const,
  feedback: 'accepted on exact rendered evidence', criterionDigest: 'c'.repeat(64),
});

describe('Liminal owner review authority', () => {
  it('verifies exact receipts across authority restart and rejects tampering', async () => {
    const first = createTestLiminalOwnerReviewAuthority('restart-owner-review-secret');
    const receipt = await first.submit(command);
    const restarted = createTestLiminalOwnerReviewAuthority('restart-owner-review-secret');
    expect(receipt).toMatchObject({ schema: 'sinter.liminal-owner-review-receipt',
      schemaVersion: 1 });
    expect(receipt.authorityKeyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(restarted.verify(command, receipt)).toBe(true);
    expect(restarted.verify({ ...command, feedback: 'forged' }, receipt)).toBe(false);
    expect(createTestLiminalOwnerReviewAuthority('different-owner-review-secret')
      .verify(command, receipt)).toBe(false);
  });

  it('rejects non-canonical production key paths before reading key material', async () => {
    await expect(bootstrapProductionLiminalOwnerReviewAuthority('/tmp/not-canonical.key'))
      .rejects.toThrow('LIMINAL_OWNER_REVIEW_KEY_PATH_NOT_CANONICAL');
  });
});
