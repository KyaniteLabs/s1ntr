import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapProductionReceiptAuthority, readTrustedVerificationKeys,
  createTestReceiptAuthority, TRUSTED_KEYS_FILE } from '../../src/runtime-core/LiminalCommandService.js';

const fields = { operationId: 'op', lineageId: 'lin', commandDigest: 'a'.repeat(64),
  providerInputDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64),
  operationTraceDigest: 'e'.repeat(64), disabledTeachingReaders: [], empiricalContextDigests: [],
  learningEligible: false } as never;

describe('trusted verification keyring (off unless configured)', () => {
  let home: string; let previous: string | undefined; let dir: string;
  beforeEach(async () => {
    previous = process.env.HOME; home = await mkdtemp(path.join(os.tmpdir(), 'keyring-'));
    process.env.HOME = home; dir = path.join(home, '.sinter', 'authority'); await mkdir(dir, { recursive: true });
  });
  afterEach(async () => { process.env.HOME = previous; await rm(home, { recursive: true, force: true }); });
  const keyFile = () => path.join(dir, 'liminal-command-receipt.key');
  const otherHost = 'f'.repeat(63) + '1';
  // A production-tier receipt from another host cannot be forged here, so the other host's real
  // authority is built with its own key file under a second HOME.
  async function foreignReceipt() {
    const other = await mkdtemp(path.join(os.tmpdir(), 'keyring-other-'));
    const saved = process.env.HOME; process.env.HOME = other;
    try {
      await mkdir(path.join(other, '.sinter', 'authority'), { recursive: true });
      await writeFile(path.join(other, '.sinter', 'authority', 'liminal-command-receipt.key'), `${otherHost}\n`, { mode: 0o600 });
      const authority = await bootstrapProductionReceiptAuthority(path.join(other, '.sinter', 'authority', 'liminal-command-receipt.key'));
      return authority.project(fields);
    } finally { process.env.HOME = saved; await rm(other, { recursive: true, force: true }); }
  }

  it('rejects another host\'s receipt when no keyring is configured', async () => {
    const receipt = await foreignReceipt();
    expect((await bootstrapProductionReceiptAuthority(keyFile())).verify(receipt)).toBe(false);
  });

  it('accepts it once the owner placed that host\'s key, and the local key still verifies and signs', async () => {
    const receipt = await foreignReceipt();
    await writeFile(path.join(dir, TRUSTED_KEYS_FILE), `# <fleet-node>, placed by its owner\n${otherHost}\n`, { mode: 0o600 });
    const local = await bootstrapProductionReceiptAuthority(keyFile());
    expect(local.verify(receipt)).toBe(true);
    const mine = local.project(fields);
    expect(mine.authorityKeyDigest).not.toBe(receipt.authorityKeyDigest);
    expect(local.verify(mine)).toBe(true);
  });

  it('still rejects an unlisted key and a tampered foreign receipt', async () => {
    const receipt = await foreignReceipt();
    await writeFile(path.join(dir, TRUSTED_KEYS_FILE), `${'1'.repeat(64)}\n`, { mode: 0o600 });
    const local = await bootstrapProductionReceiptAuthority(keyFile());
    expect(local.verify(receipt)).toBe(false);
    await writeFile(path.join(dir, TRUSTED_KEYS_FILE), `${otherHost}\n`, { mode: 0o600 });
    const trusting = await bootstrapProductionReceiptAuthority(keyFile());
    expect(trusting.verify({ ...receipt, artifactDigest: '0'.repeat(64) })).toBe(false);
  });

  it('refuses a group-readable or malformed keyring and never signs a test-tier receipt as production', async () => {
    const file = path.join(dir, TRUSTED_KEYS_FILE);
    await writeFile(file, `${otherHost}\n`, { mode: 0o644 }); await chmod(file, 0o644);
    await expect(readTrustedVerificationKeys(file)).rejects.toThrow('TRUSTED_VERIFICATION_KEYS_FILE_PERMISSIONS');
    await writeFile(file, 'not-a-key\n', { mode: 0o600 }); await chmod(file, 0o600);
    await expect(readTrustedVerificationKeys(file)).rejects.toThrow('TRUSTED_VERIFICATION_KEYS_FILE_INVALID');
    expect(await readTrustedVerificationKeys(path.join(dir, 'absent'))).toEqual([]);
    const testReceipt = createTestReceiptAuthority(otherHost).project(fields);
    await writeFile(file, `${otherHost}\n`, { mode: 0o600 });
    expect((await bootstrapProductionReceiptAuthority(keyFile())).verify(testReceipt)).toBe(false);
  });
});
