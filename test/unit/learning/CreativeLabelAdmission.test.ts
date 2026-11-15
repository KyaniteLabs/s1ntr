import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createCreativeLabelAdmission, validateCreativeLabelAdmission } from
  '../../../src/learning/CreativeLabelAdmission.js';
import * as creativeAuthority from
  '../../../src/runtime-core/CreativeAdmissionAuthority.js';

const digest = (char: string) => char.repeat(64);
const valid = { trustKind: 'universal-criterion' as const,
  allowedUses: ['few-shot', 'evaluator-training'] as const,
  artifactDigest: digest('a'), evidenceDigest: digest('b'),
  decisionDigest: digest('c'), rendered: true as const, identityValid: true as const,
  digestMatched: true as const, degraded: false as const };

describe('creative label admission', () => {
  it('seals distinct trust kinds and declared reader uses', () => {
    const label = createCreativeLabelAdmission(valid);
    const owner = createCreativeLabelAdmission({ ...valid, trustKind: 'owner-preference' });
    const transfer = createCreativeLabelAdmission({ ...valid, trustKind: 'transfer-principle' });
    expect(validateCreativeLabelAdmission(label, 'few-shot')).toEqual(label);
    expect(() => validateCreativeLabelAdmission(label, 'hard-negative'))
      .toThrow('CREATIVE_LABEL_USE_NOT_ADMITTED');
    expect(label.trustKind).toBe('universal-criterion');
    expect(new Set([label.labelDigest, owner.labelDigest, transfer.labelDigest]).size).toBe(3);
  });

  it('fails closed without rendered identity-valid digest-bound evidence', () => {
    for (const patch of [{ rendered: false }, { identityValid: false },
      { digestMatched: false }, { degraded: true }]) {
      expect(() => createCreativeLabelAdmission({ ...valid, ...patch } as never))
        .toThrow('CREATIVE_LABEL_EVIDENCE_INVALID');
    }
  });

  it('rejects a self-hashed admission without a trusted authority signature', () => {
    const admitted = createCreativeLabelAdmission(valid);
    const forged = { ...admitted, authorityProof: { ...admitted.authorityProof,
      signature: digest('f') } };
    const { labelDigest: _digest, ...body } = forged;
    const stable = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key =>
        `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
    };
    const rebound = { ...forged,
      labelDigest: createHash('sha256').update(stable(body)).digest('hex') };
    expect(() => validateCreativeLabelAdmission(rebound, 'few-shot'))
      .toThrow('CREATIVE_LABEL_ADMISSION_INVALID');
  });

  it('does not expose arbitrary production trust-root registration', () => {
    expect(creativeAuthority).not.toHaveProperty('registerCreativeAdmissionSecret');
    const signer = creativeAuthority.createTestCreativeAdmissionSigner('foreign-root');
    expect(signer.sealAdmission({ forged: true }).authorityTier).toBe('test-proof');
  });
});
