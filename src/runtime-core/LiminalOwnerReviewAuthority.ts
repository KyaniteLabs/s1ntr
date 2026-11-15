import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LiminalOwnerReviewAuthority, LiminalOwnerReviewCommand,
  LiminalOwnerReviewReceipt } from './LiminalProductCommandPort.js';

const DOMAIN = 'sinter.liminal-owner-review.v1\0';
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

class HmacOwnerReviewAuthority implements LiminalOwnerReviewAuthority {
  readonly #keyDigest: string;
  constructor(private readonly secret: string) {
    if (secret.length < 8) throw new Error('LIMINAL_OWNER_REVIEW_KEY_INVALID');
    this.#keyDigest = sha256(secret);
  }
  submit(command: LiminalOwnerReviewCommand): Promise<LiminalOwnerReviewReceipt> {
    const body = { schema: 'sinter.liminal-owner-review-receipt' as const,
      schemaVersion: 1 as const, decisionDigest: sha256(stable(command)),
      authorityKeyDigest: this.#keyDigest };
    return Promise.resolve(Object.freeze({ ...body, signature: this.sign(body) }));
  }
  verify(command: LiminalOwnerReviewCommand, receipt: LiminalOwnerReviewReceipt): boolean {
    if (receipt.schema !== 'sinter.liminal-owner-review-receipt'
      || receipt.schemaVersion !== 1 || receipt.authorityKeyDigest !== this.#keyDigest
      || receipt.decisionDigest !== sha256(stable(command))) return false;
    const { signature, ...body } = receipt;
    const expected = Buffer.from(this.sign(body), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  private sign(value: unknown): string {
    return createHmac('sha256', this.secret).update(DOMAIN).update(stable(value)).digest('hex');
  }
}

export function createTestLiminalOwnerReviewAuthority(secret: string):
LiminalOwnerReviewAuthority {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('LIMINAL_OWNER_REVIEW_TEST_AUTHORITY_FORBIDDEN');
  }
  return new HmacOwnerReviewAuthority(secret);
}

export async function bootstrapProductionLiminalOwnerReviewAuthority(keyFile: string):
Promise<LiminalOwnerReviewAuthority> {
  const canonical = path.join(os.homedir(), '.sinter', 'authority',
    'liminal-command-receipt.key');
  if (path.resolve(keyFile) !== canonical) {
    throw new Error('LIMINAL_OWNER_REVIEW_KEY_PATH_NOT_CANONICAL');
  }
  const secret = (await readFile(canonical, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error('LIMINAL_OWNER_REVIEW_KEY_INVALID');
  }
  return new HmacOwnerReviewAuthority(secret);
}
