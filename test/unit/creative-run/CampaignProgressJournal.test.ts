import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileCampaignLedgerPersistence } from '../../../src/creative-run/CampaignPersistence.js';
import {
  CampaignProgressJournal,
  parseCampaignProgressJournal,
  type CampaignProgressJournalSpec,
} from '../../../src/creative-run/CampaignProgressJournal.js';
import type { CampaignEvidenceReceipt, CampaignOriginReceipt } from '../../../src/runtime-core/CampaignOrigin.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function spec(): CampaignProgressJournalSpec {
  return {
    binding: {
      campaignRunId: 'campaign-w8c-08',
      rootRunId: 'root-w8c-08',
      manifestDigest: sha('manifest'),
      planDigest: sha('plan'),
      routeFreezeDigest: sha('route'),
      campaignFundingReservationDigest: sha('funding'),
    },
    requiredReceipts: [
      { receiptId: 'transfer-treatment', kind: 'transfer-treatment' },
      { receiptId: 'transfer-control', kind: 'transfer-control' },
      { receiptId: 'dream', kind: 'dream-recommendation' },
    ],
  };
}

function receipt(receiptId: string, kind: string): CampaignEvidenceReceipt {
  return { receiptId, kind, resultDigest: sha(receiptId) };
}

function origin(input: CampaignProgressJournalSpec, receipts: readonly CampaignEvidenceReceipt[]): CampaignOriginReceipt {
  return {
    schema: 'sinter.campaign-origin-receipt', schemaVersion: 1,
    receiptId: `campaign-origin:${input.binding.campaignRunId}`, kind: 'campaign-origin',
    keyId: 'test-key', campaignRunId: input.binding.campaignRunId,
    rootRunId: input.binding.rootRunId, manifestDigest: input.binding.manifestDigest,
    releaseHead: 'a'.repeat(40), sourceFingerprint: sha('source'), schemaDigest: sha('schema'),
    implementationDigest: sha('implementation'), wave8ReleaseRootDigest: sha('wave8'),
    campaignFundingReservationDigest: input.binding.campaignFundingReservationDigest,
    campaignPlanDigest: input.binding.planDigest,
    campaignRouteFreezeDigest: input.binding.routeFreezeDigest,
    orderedReceiptDigests: receipts.map((item) => item.resultDigest),
    signatureBase64: 'test-signature', resultDigest: sha('origin'),
  };
}

async function journal() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-campaign-progress-'));
  directories.push(directory);
  const input = spec();
  return { directory, input,
    journal: new CampaignProgressJournal(new FileCampaignLedgerPersistence(directory), input) };
}

describe('CampaignProgressJournal', () => {
  it('durably inventories exact transfer/control/Dream receipts before the sole terminal origin', async () => {
    const fixture = await journal();
    expect((await fixture.journal.open()).status).toBe('collecting');
    await fixture.journal.append(receipt('transfer-treatment', 'transfer-treatment'));
    await fixture.journal.append(receipt('transfer-control', 'transfer-control'));
    await expect(fixture.journal.recordFinalOrigin(origin(fixture.input, []), vi.fn()))
      .rejects.toThrow('CAMPAIGN_PROGRESS_INVENTORY_INCOMPLETE');
    const ready = await fixture.journal.append(receipt('dream', 'dream-recommendation'));
    expect(ready.status).toBe('ready-for-origin');

    const restarted = new CampaignProgressJournal(
      new FileCampaignLedgerPersistence(fixture.directory), fixture.input,
    );
    const verify = vi.fn();
    const finalized = await restarted.recordFinalOrigin(origin(fixture.input, ready.receipts), verify);
    expect(finalized.status).toBe('finalized');
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(finalized.origin, ready.receipts);
  });

  it('is idempotent for exact receipts and rejects an altered or out-of-inventory receipt', async () => {
    const fixture = await journal();
    await fixture.journal.open();
    const treatment = receipt('transfer-treatment', 'transfer-treatment');
    await fixture.journal.append(treatment);
    expect((await fixture.journal.append(treatment)).receipts).toHaveLength(1);
    await expect(fixture.journal.append({ ...treatment, resultDigest: sha('tampered') }))
      .rejects.toThrow('CAMPAIGN_PROGRESS_RECEIPT_IMMUTABLE');
    await expect(fixture.journal.append(receipt('other', 'dream-recommendation')))
      .rejects.toThrow('CAMPAIGN_PROGRESS_RECEIPT_OUTSIDE_INVENTORY');
    await expect(fixture.journal.append(receipt('dream', 'dream-recommendation')))
      .rejects.toThrow('CAMPAIGN_PROGRESS_RECEIPT_ORDER_INVALID');
  });

  it('serializes concurrent exact receipt retries across independently restarted journals', async () => {
    const fixture = await journal();
    const first = new CampaignProgressJournal(
      new FileCampaignLedgerPersistence(fixture.directory), fixture.input,
    );
    const second = new CampaignProgressJournal(
      new FileCampaignLedgerPersistence(fixture.directory), fixture.input,
    );
    await Promise.all([first.open(), second.open()]);
    const treatment = receipt('transfer-treatment', 'transfer-treatment');
    const [left, right] = await Promise.all([first.append(treatment), second.append(treatment)]);
    expect(left.receipts).toEqual([treatment]);
    expect(right.receipts).toEqual([treatment]);
    expect((await fixture.journal.read())?.receipts).toEqual([treatment]);
  });

  it('rejects a journal whose receipt or journal digest is altered on disk', async () => {
    const fixture = await journal();
    await fixture.journal.open();
    const ledger = new FileCampaignLedgerPersistence(fixture.directory);
    const key = `campaign-progress:${fixture.input.binding.campaignRunId}:${fixture.input.binding.manifestDigest}`;
    const raw = await ledger.read(key);
    const tampered = { ...JSON.parse(raw!), journalDigest: sha('not-the-record') };
    await ledger.write(key, JSON.stringify(tampered));
    await expect(fixture.journal.read()).rejects.toThrow('CAMPAIGN_PROGRESS_JOURNAL_DIGEST_INVALID');
    expect(() => parseCampaignProgressJournal({})).toThrow('CAMPAIGN_PROGRESS_JOURNAL_INVALID');
  });

  it('does not rerun verification or replace a recorded terminal origin after restart', async () => {
    const fixture = await journal();
    await fixture.journal.open();
    for (const requirement of fixture.input.requiredReceipts) {
      await fixture.journal.append(receipt(requirement.receiptId, requirement.kind));
    }
    const ready = await fixture.journal.assertComplete();
    const signed = origin(fixture.input, ready.receipts);
    await fixture.journal.recordFinalOrigin(signed, vi.fn());
    const restarted = new CampaignProgressJournal(
      new FileCampaignLedgerPersistence(fixture.directory), fixture.input,
    );
    const verify = vi.fn();
    expect((await restarted.recordFinalOrigin(signed, verify)).status).toBe('finalized');
    expect(verify).not.toHaveBeenCalled();
    await expect(restarted.recordFinalOrigin({ ...signed, resultDigest: sha('other-origin') }, vi.fn()))
      .rejects.toThrow('CAMPAIGN_PROGRESS_FINAL_ORIGIN_IMMUTABLE');
  });

  it('leaves a complete inventory unsigned when independent origin verification fails', async () => {
    const fixture = await journal();
    await fixture.journal.open();
    for (const requirement of fixture.input.requiredReceipts) {
      await fixture.journal.append(receipt(requirement.receiptId, requirement.kind));
    }
    const ready = await fixture.journal.assertComplete();
    await expect(fixture.journal.recordFinalOrigin(
      origin(fixture.input, ready.receipts),
      () => { throw new Error('UNTRUSTED_ORIGIN'); },
    )).rejects.toThrow('UNTRUSTED_ORIGIN');
    expect((await fixture.journal.read())?.status).toBe('ready-for-origin');
    expect((await fixture.journal.read())?.origin).toBeUndefined();
  });
});
