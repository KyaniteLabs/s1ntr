import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CreativeAdmissionProof {
  readonly authorityTier: 'test-proof' | 'production';
  readonly authorityKeyDigest: string;
  readonly signature: string;
}

export interface CreativeAdmissionSigner {
  sealAdmission(value: unknown): CreativeAdmissionProof;
}

const secrets = new Map<string, { secret: string; tier: CreativeAdmissionProof['authorityTier'] }>();
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const sign = (value: unknown, secret: string): string =>
  createHmac('sha256', secret).update(stable(value)).digest('hex');

function registerCreativeAdmissionSecret(
  secret: string, tier: CreativeAdmissionProof['authorityTier'],
): CreativeAdmissionSigner {
  const authorityKeyDigest = hash(secret);
  secrets.set(authorityKeyDigest, { secret, tier });
  return Object.freeze({ sealAdmission: (value: unknown) => Object.freeze({
    authorityTier: tier, authorityKeyDigest, signature: sign(value, secret),
  }) });
}

export function createTestCreativeAdmissionSigner(secret: string): CreativeAdmissionSigner {
  return registerCreativeAdmissionSecret(secret, 'test-proof');
}

/** Bind only the canonical host key; callers cannot register arbitrary production trust roots. */
export async function bootstrapProductionCreativeAdmissionSigner(
  keyFile: string,
): Promise<CreativeAdmissionSigner> {
  const canonical = path.join(os.homedir(), '.sinter', 'authority',
    'liminal-command-receipt.key');
  if (path.resolve(keyFile) !== canonical) {
    throw new Error('Production admission key path is not host canonical');
  }
  const secret = (await readFile(canonical, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Production admission key is invalid');
  return registerCreativeAdmissionSecret(secret, 'production');
}

const testSigner = process.env.NODE_ENV === 'test'
  ? createTestCreativeAdmissionSigner('liminal-test-admission-authority') : undefined;

export function sealCreativeAdmission(
  value: unknown, authority?: CreativeAdmissionSigner,
): CreativeAdmissionProof {
  if (!authority && !testSigner) throw new Error('CREATIVE_ADMISSION_AUTHORITY_REQUIRED');
  return (authority ?? testSigner!).sealAdmission(value);
}

export function verifyCreativeAdmission(value: unknown, proof: CreativeAdmissionProof): boolean {
  const authority = secrets.get(proof.authorityKeyDigest);
  if (!authority || authority.tier !== proof.authorityTier
    || (process.env.NODE_ENV !== 'test' && proof.authorityTier !== 'production')) return false;
  const expected = Buffer.from(sign(value, authority.secret), 'hex');
  const actual = Buffer.from(proof.signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
