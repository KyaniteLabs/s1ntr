import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DreamHoldoutVault, FileDreamHoldoutVault }
  from '../../../src/dreaming/research/DreamHoldoutVault.js';

describe('DreamHoldoutVault', () => {
  it('declares its custody as same-process, never independent isolation (#1259)', () => {
    expect(new DreamHoldoutVault().isolation).toBe('same-process');
    expect(new FileDreamHoldoutVault(path.join(tmpdir(), 'unused-holdout.json'), 'host-key').isolation)
      .toBe('same-process');
  });

  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));
  const protocol = { originContextDigest: '1'.repeat(64),
    controlContextDigest: '2'.repeat(64), treatmentContextDigest: '2'.repeat(64),
    findingDigest: '3'.repeat(64), controlFindingDigest: null,
    treatmentFindingDigest: '3'.repeat(64) };
  const snapshot = (state: 'frozen' | 'finding-proposed' | 'transfer-frozen') => ({
    aggregateId: 'dream', revision: 1, state,
    finding: state === 'frozen' ? 'none' as const : 'proposed' as const,
    maximumAttempts: 1, attemptsStarted: 0, hasUnknownAttempt: false });

  it('seals content until transfer pins freeze and journals before release', () => {
    const vault = new DreamHoldoutVault();
    const capability = vault.seal('unseen assignment', {
      selectorDigest: 'a'.repeat(64), custodianDigest: 'b'.repeat(64),
      protocol });
    const journal = vi.fn();
    expect(() => vault.open(capability, snapshot('frozen'), journal))
      .toThrow('DREAM_HOLDOUT_ACCESS_PREMATURE');
    // #1259: a proposed finding is not enough; the transfer must be frozen.
    expect(() => vault.open(capability, snapshot('finding-proposed'), journal))
      .toThrow('DREAM_HOLDOUT_ACCESS_PREMATURE');
    expect(journal).not.toHaveBeenCalled();
    expect(vault.open(capability, snapshot('transfer-frozen'), journal))
      .toMatchObject({ bytes: 'unseen assignment', protocol });
    expect(journal).toHaveBeenCalledOnce();
  });

  it('rejects copied capability-shaped data', () => {
    const vault = new DreamHoldoutVault();
    const real = vault.seal('secret', { selectorDigest: 'a'.repeat(64),
      custodianDigest: 'b'.repeat(64), protocol });
    expect(() => vault.open({ commitment: real.commitment },
      snapshot('transfer-frozen'), vi.fn())).toThrow('DREAM_HOLDOUT_CAPABILITY_INVALID');
  });

  it('keeps encrypted custody restart-safe and denies early access', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-holdout-file-')); roots.push(root);
    const file = path.join(root, 'vault.json');
    const vault = new FileDreamHoldoutVault(file, 'host-key');
    const capability = vault.precommit('study-a', 'unseen assignment', {
      selectorDigest: 'a'.repeat(64), custodianDigest: 'b'.repeat(64), protocol });
    expect(await readFile(file, 'utf8')).not.toContain('unseen assignment');
    expect(() => vault.open(capability, snapshot('frozen'), vi.fn()))
      .toThrow('DREAM_HOLDOUT_ACCESS_PREMATURE');
    expect(() => vault.open(capability, snapshot('finding-proposed'), vi.fn()))
      .toThrow('DREAM_HOLDOUT_ACCESS_PREMATURE');
    const restarted = new FileDreamHoldoutVault(file, 'host-key');
    const journal = vi.fn();
    expect(restarted.open(capability, snapshot('transfer-frozen'), journal).bytes)
      .toBe('unseen assignment');
    expect(journal).toHaveBeenCalledOnce();
    expect(new FileDreamHoldoutVault(file, 'wrong-key'));
    expect(() => new FileDreamHoldoutVault(file, 'wrong-key')
      .open(capability, snapshot('transfer-frozen'), vi.fn()))
      .toThrow('DREAM_HOLDOUT_SIGNATURE_INVALID');
  });
});
