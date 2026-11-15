import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CampaignAdmissionStore,
  type CampaignOriginReceipt,
  createCampaignAuthority,
  createCampaignReleaseRoot,
  InMemoryCampaignAdmissionStore,
  FileCampaignAdmissionStore,
  validateCampaignReleaseRoot,
} from '../../../src/runtime-core/CampaignOrigin.js';

const D = (char: string) => char.repeat(64);
const manifest = {
  campaignRunId: 'campaign-1', rootRunId: 'root-1', manifestDigest: D('a'),
  releaseHead: 'b'.repeat(40), sourceFingerprint: D('c'), schemaDigest: D('d'),
  implementationDigest: D('e'), wave8ReleaseRootDigest: D('f'),
};

describe('CampaignOrigin', () => {
  it('admits once and signs the exact ordered non-origin membership', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authority = createCampaignAuthority({
      keyId: 'host-1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore(),
    });
    const capability = await authority.admit(manifest);
    await expect(authority.admit(manifest)).rejects.toThrow(/already.*admitted/i);
    const receipts = [
      { receiptId: 'r1', kind: 'candidate', resultDigest: D('1') },
      { receiptId: 'r2', kind: 'review', resultDigest: D('2') },
    ];
    const origin = await authority.finalize(capability, receipts);
    const root = createCampaignReleaseRoot(manifest, receipts, origin);
    expect(validateCampaignReleaseRoot(root, {
      trustedKeys: new Map([['host-1', publicKey.export({ type: 'spki', format: 'pem' }).toString()]]),
    }).campaignRootDigest).toBe(root.campaignRootDigest);
  });

  it.each([
    ['reorder', (root: any) => ({ ...root, receipts: [root.receipts[1], root.receipts[0], root.receipts[2]] })],
    ['omit', (root: any) => ({ ...root, receipts: root.receipts.slice(1) })],
    ['second origin', (root: any) => ({ ...root, receipts: [...root.receipts, root.receipts.at(-1)] })],
    ['cross run', (root: any) => ({ ...root, rootRunId: 'other' })],
  ])('rejects %s tampering', async (_name, mutate) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authority = createCampaignAuthority({
      keyId: 'host-1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore(),
    });
    const capability = await authority.admit(manifest);
    const receipts = [
      { receiptId: 'r1', kind: 'candidate', resultDigest: D('1') },
      { receiptId: 'r2', kind: 'review', resultDigest: D('2') },
    ];
    const root = createCampaignReleaseRoot(manifest, receipts, await authority.finalize(capability, receipts));
    expect(() => validateCampaignReleaseRoot(mutate(root), {
      trustedKeys: new Map([['host-1', publicKey.export({ type: 'spki', format: 'pem' }).toString()]]),
    })).toThrow();
  });

  it('atomically installs one durable origin under concurrent finalization', async () => {
    const root = await mkdtemp(`${tmpdir()}/campaign-admission-`);
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const authority = createCampaignAuthority({ keyId: 'host-1',
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        admissionStore: new FileCampaignAdmissionStore(root) });
      const capability = await authority.admit(manifest);
      const receipts = [{ receiptId: 'r1', kind: 'candidate', resultDigest: D('1') }];
      const results = await Promise.allSettled([
        authority.finalize(capability, receipts), authority.finalize(capability, receipts),
      ]);
      const fulfilled = results.filter(result => result.status === 'fulfilled');
      expect(fulfilled).toHaveLength(2);
      expect(fulfilled[0]).toEqual(fulfilled[1]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('persists the full immutable binding and rejects restart drift', async () => {
    const root = await mkdtemp(`${tmpdir()}/campaign-admission-restart-`);
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const config = { keyId: 'host-1',
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
      const fundedManifest = { ...manifest, campaignRunId: 'campaign-durable',
        campaignFundingReservationDigest: D('6'), campaignPlanDigest: D('7'),
        campaignRouteFreezeDigest: D('8') };
      const firstHost = createCampaignAuthority({ ...config,
        admissionStore: new FileCampaignAdmissionStore(root) });
      await firstHost.admit(fundedManifest);
      const [campaignDirectory] = await readdir(root);
      const persisted = JSON.parse(await readFile(path.join(root, campaignDirectory, 'binding.json'), 'utf8'));
      expect(persisted).toEqual(fundedManifest);
      const restartedHost = createCampaignAuthority({ ...config,
        admissionStore: new FileCampaignAdmissionStore(root) });
      await expect(restartedHost.resume({ ...fundedManifest, rootRunId: 'drifted-root' }))
        .rejects.toThrow(/immutable admitted origin/i);
      await expect(restartedHost.resume({ ...fundedManifest, campaignPlanDigest: D('9') }))
        .rejects.toThrow(/immutable admitted origin/i);
      await expect(restartedHost.resume(fundedManifest)).resolves.toEqual({});
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns the exact durable terminal origin after a crash without a second terminal effect', async () => {
    const root = await mkdtemp(`${tmpdir()}/campaign-origin-crash-`);
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const config = { keyId: 'host-1',
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
      const durableStore = new FileCampaignAdmissionStore(root);
      let terminalEffects = 0;
      const crashAfterInstall: CampaignAdmissionStore = {
        claim: binding => durableStore.claim(binding),
        resume: binding => durableStore.resume(binding),
        finalize: async (binding, origin) => {
          terminalEffects += 1;
          await durableStore.finalize(binding, origin);
          throw new Error('simulated process crash after durable terminal install');
        },
      };
      const firstHost = createCampaignAuthority({ ...config, admissionStore: crashAfterInstall });
      const capability = await firstHost.admit(manifest);
      const receipts = [{ receiptId: 'r1', kind: 'candidate', resultDigest: D('1') }];
      await expect(firstHost.finalize(capability, receipts)).rejects.toThrow(/simulated process crash/i);

      const [campaignDirectory] = await readdir(root);
      const exactInstalled = JSON.parse(await readFile(
        path.join(root, campaignDirectory, 'origin.json'), 'utf8',
      )) as CampaignOriginReceipt;
      const restartedHost = createCampaignAuthority({ ...config,
        admissionStore: new FileCampaignAdmissionStore(root) });
      const recovered = await restartedHost.resume(manifest);
      await expect(restartedHost.finalize(recovered, receipts)).resolves.toEqual(exactInstalled);
      expect(terminalEffects).toBe(1);

      const driftedRetry = await restartedHost.resume(manifest);
      await expect(restartedHost.finalize(driftedRetry, [
        { receiptId: 'different', kind: 'candidate', resultDigest: D('2') },
      ])).rejects.toThrow(/does not match.*evidence/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('signs the complete finite-funding tuple and rejects tuple drift or omission', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const trustedKeys = new Map([['host-1', publicKey.export({ type: 'spki', format: 'pem' }).toString()]]);
    const finiteManifest = { ...manifest, campaignRunId: 'campaign-funded',
      campaignFundingReservationDigest: D('6'), campaignPlanDigest: D('7'),
      campaignRouteFreezeDigest: D('8') };
    const authority = createCampaignAuthority({ keyId: 'host-1',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore() });
    const capability = await authority.admit(finiteManifest);
    const receipts = [{ receiptId: 'r1', kind: 'candidate', resultDigest: D('1') }];
    const origin = await authority.finalize(capability, receipts);
    const root = createCampaignReleaseRoot(finiteManifest, receipts, origin);
    expect(validateCampaignReleaseRoot(root, { trustedKeys })).toMatchObject({
      campaignFundingReservationDigest: D('6'), campaignPlanDigest: D('7'),
      campaignRouteFreezeDigest: D('8'),
    });
    expect(() => validateCampaignReleaseRoot({ ...root, campaignPlanDigest: D('9') }, { trustedKeys }))
      .toThrow(/binding|digest|signature|invalid/i);
    await expect(authority.admit({ ...manifest, campaignRunId: 'incomplete',
      campaignFundingReservationDigest: D('6') })).rejects.toThrow(/funding.*incomplete/i);
  });
});
