import { createHash } from 'node:crypto';
import type { CampaignLedgerPersistence } from './CampaignPersistence.js';
import type { CampaignEvidenceReceipt, CampaignOriginReceipt } from '../runtime-core/CampaignOrigin.js';

export const CAMPAIGN_PROGRESS_JOURNAL_SCHEMA = 'sinter.campaign-progress-journal' as const;
export const CAMPAIGN_PROGRESS_JOURNAL_VERSION = 1 as const;

const SHA256 = /^[a-f0-9]{64}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireText(value: string, code: string): void {
  if (!value.trim()) throw new Error(code);
}

function assertDigest(value: string, code: string): void {
  if (!SHA256.test(value)) throw new Error(code);
}

export interface CampaignProgressBinding {
  readonly campaignRunId: string;
  readonly rootRunId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly routeFreezeDigest: string;
  readonly campaignFundingReservationDigest: string;
}

/** Immutable expected evidence membership, declared before either transfer arm can run. */
export interface CampaignProgressReceiptRequirement {
  readonly receiptId: string;
  readonly kind: string;
}

export interface CampaignProgressJournalSpec {
  readonly binding: CampaignProgressBinding;
  readonly requiredReceipts: readonly CampaignProgressReceiptRequirement[];
}

export interface CampaignProgressJournalRecord extends CampaignProgressJournalSpec {
  readonly schema: typeof CAMPAIGN_PROGRESS_JOURNAL_SCHEMA;
  readonly schemaVersion: typeof CAMPAIGN_PROGRESS_JOURNAL_VERSION;
  readonly status: 'collecting' | 'ready-for-origin' | 'finalized';
  readonly receipts: readonly CampaignEvidenceReceipt[];
  readonly origin?: CampaignOriginReceipt;
  readonly journalDigest: string;
}

export type CampaignOriginReceiptVerifier = (
  origin: CampaignOriginReceipt,
  receipts: readonly CampaignEvidenceReceipt[],
) => void | Promise<void>;

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function assertBinding(binding: CampaignProgressBinding): void {
  requireText(binding.campaignRunId, 'CAMPAIGN_PROGRESS_RUN_ID_REQUIRED');
  requireText(binding.rootRunId, 'CAMPAIGN_PROGRESS_ROOT_RUN_ID_REQUIRED');
  assertDigest(binding.manifestDigest, 'CAMPAIGN_PROGRESS_MANIFEST_DIGEST_INVALID');
  assertDigest(binding.planDigest, 'CAMPAIGN_PROGRESS_PLAN_DIGEST_INVALID');
  assertDigest(binding.routeFreezeDigest, 'CAMPAIGN_PROGRESS_ROUTE_DIGEST_INVALID');
  assertDigest(binding.campaignFundingReservationDigest,
    'CAMPAIGN_PROGRESS_FUNDING_DIGEST_INVALID');
}

function assertRequirements(requirements: readonly CampaignProgressReceiptRequirement[]): void {
  if (requirements.length === 0) throw new Error('CAMPAIGN_PROGRESS_REQUIREMENTS_REQUIRED');
  const ids = new Set<string>();
  for (const requirement of requirements) {
    requireText(requirement.receiptId, 'CAMPAIGN_PROGRESS_RECEIPT_ID_REQUIRED');
    requireText(requirement.kind, 'CAMPAIGN_PROGRESS_RECEIPT_KIND_REQUIRED');
    if (ids.has(requirement.receiptId)) throw new Error('CAMPAIGN_PROGRESS_RECEIPT_ID_DUPLICATE');
    ids.add(requirement.receiptId);
  }
}

function assertReceipt(receipt: CampaignEvidenceReceipt): void {
  requireText(receipt.receiptId, 'CAMPAIGN_PROGRESS_RECEIPT_ID_REQUIRED');
  requireText(receipt.kind, 'CAMPAIGN_PROGRESS_RECEIPT_KIND_REQUIRED');
  assertDigest(receipt.resultDigest, 'CAMPAIGN_PROGRESS_RECEIPT_DIGEST_INVALID');
}

function recordBody(record: Omit<CampaignProgressJournalRecord, 'journalDigest'>): Omit<CampaignProgressJournalRecord, 'journalDigest'> {
  return record;
}

function freezeRecord(record: Omit<CampaignProgressJournalRecord, 'journalDigest'>): CampaignProgressJournalRecord {
  return Object.freeze({ ...record, journalDigest: digest(recordBody(record)) });
}

function requirementsMatch(
  left: readonly CampaignProgressReceiptRequirement[],
  right: readonly CampaignProgressReceiptRequirement[],
): boolean {
  return left.length === right.length && left.every((item, index) => same(item, right[index]));
}

function assertOriginMembership(
  binding: CampaignProgressBinding,
  receipts: readonly CampaignEvidenceReceipt[],
  origin: CampaignOriginReceipt,
): void {
  if (origin.kind !== 'campaign-origin'
    || origin.campaignRunId !== binding.campaignRunId
    || origin.rootRunId !== binding.rootRunId
    || origin.manifestDigest !== binding.manifestDigest
    || origin.campaignPlanDigest !== binding.planDigest
    || origin.campaignRouteFreezeDigest !== binding.routeFreezeDigest
    || origin.campaignFundingReservationDigest !== binding.campaignFundingReservationDigest
    || !SHA256.test(origin.resultDigest)
    || !Array.isArray(origin.orderedReceiptDigests)
    || !same(origin.orderedReceiptDigests, receipts.map((receipt) => receipt.resultDigest))) {
    throw new Error('CAMPAIGN_PROGRESS_ORIGIN_MEMBERSHIP_INVALID');
  }
}

/** Validates persisted syntax and every self-authenticating journal digest. */
export function parseCampaignProgressJournal(value: unknown): CampaignProgressJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CAMPAIGN_PROGRESS_JOURNAL_INVALID');
  }
  const record = value as CampaignProgressJournalRecord;
  if (record.schema !== CAMPAIGN_PROGRESS_JOURNAL_SCHEMA
    || record.schemaVersion !== CAMPAIGN_PROGRESS_JOURNAL_VERSION
    || !['collecting', 'ready-for-origin', 'finalized'].includes(record.status)
    || !Array.isArray(record.requiredReceipts) || !Array.isArray(record.receipts)) {
    throw new Error('CAMPAIGN_PROGRESS_JOURNAL_INVALID');
  }
  assertBinding(record.binding);
  assertRequirements(record.requiredReceipts);
  record.receipts.forEach(assertReceipt);
  if (new Set(record.receipts.map((receipt) => receipt.receiptId)).size !== record.receipts.length) {
    throw new Error('CAMPAIGN_PROGRESS_RECEIPT_ID_DUPLICATE');
  }
  const requirements = new Map(record.requiredReceipts.map((item) => [item.receiptId, item]));
  for (const receipt of record.receipts) {
    const requirement = requirements.get(receipt.receiptId);
    if (!requirement || requirement.kind !== receipt.kind) {
      throw new Error('CAMPAIGN_PROGRESS_RECEIPT_OUTSIDE_INVENTORY');
    }
  }
  const complete = record.receipts.length === record.requiredReceipts.length;
  if ((record.status === 'collecting') === complete
    || (record.status === 'finalized') !== Boolean(record.origin)
    || (record.status !== 'finalized' && record.origin)) {
    throw new Error('CAMPAIGN_PROGRESS_STATUS_INVALID');
  }
  if (record.origin) assertOriginMembership(record.binding, record.receipts, record.origin);
  const { journalDigest, ...body } = record;
  if (digest(recordBody(body)) !== journalDigest) throw new Error('CAMPAIGN_PROGRESS_JOURNAL_DIGEST_INVALID');
  return Object.freeze(structuredClone(record));
}

/**
 * A durable evidence inventory only. It cannot mint campaign, owner, or promotion authority.
 * The terminal origin remains caller-owned and must be independently verified on finalization.
 */
export class CampaignProgressJournal {
  constructor(
    private readonly persistence: CampaignLedgerPersistence,
    private readonly spec: CampaignProgressJournalSpec,
  ) {
    assertBinding(spec.binding);
    assertRequirements(spec.requiredReceipts);
  }

  private get key(): string {
    return `campaign-progress:${this.spec.binding.campaignRunId}:${this.spec.binding.manifestDigest}`;
  }

  async open(): Promise<CampaignProgressJournalRecord> {
    return this.persistence.claim(this.key, async () => {
      const existing = await this.readUnsafe();
      if (existing) {
        if (!same(existing.binding, this.spec.binding)
          || !requirementsMatch(existing.requiredReceipts, this.spec.requiredReceipts)) {
          throw new Error('CAMPAIGN_PROGRESS_SPEC_MISMATCH');
        }
        return existing;
      }
      const record = freezeRecord({
        schema: CAMPAIGN_PROGRESS_JOURNAL_SCHEMA,
        schemaVersion: CAMPAIGN_PROGRESS_JOURNAL_VERSION,
        binding: structuredClone(this.spec.binding),
        requiredReceipts: structuredClone(this.spec.requiredReceipts),
        status: 'collecting',
        receipts: [],
      });
      await this.write(record);
      return record;
    });
  }

  async append(receipt: CampaignEvidenceReceipt): Promise<CampaignProgressJournalRecord> {
    assertReceipt(receipt);
    return this.persistence.claim(this.key, async () => {
      const record = await this.requireOpenUnsafe();
      if (record.status === 'finalized') throw new Error('CAMPAIGN_PROGRESS_FINALIZED');
      const requirement = record.requiredReceipts.find((item) => item.receiptId === receipt.receiptId);
      if (!requirement || requirement.kind !== receipt.kind) {
        throw new Error('CAMPAIGN_PROGRESS_RECEIPT_OUTSIDE_INVENTORY');
      }
      const existing = record.receipts.find((item) => item.receiptId === receipt.receiptId);
      if (existing) {
        if (!same(existing, receipt)) throw new Error('CAMPAIGN_PROGRESS_RECEIPT_IMMUTABLE');
        return record;
      }
      if (record.requiredReceipts[record.receipts.length]?.receiptId !== receipt.receiptId) {
        throw new Error('CAMPAIGN_PROGRESS_RECEIPT_ORDER_INVALID');
      }
      const receipts = [...record.receipts, Object.freeze(structuredClone(receipt))];
      const next = freezeRecord({ ...this.withoutDigest(record), receipts,
        status: receipts.length === record.requiredReceipts.length ? 'ready-for-origin' : 'collecting' });
      await this.write(next);
      return next;
    });
  }

  async read(): Promise<CampaignProgressJournalRecord | null> {
    return this.readUnsafe();
  }

  async assertComplete(): Promise<CampaignProgressJournalRecord> {
    const record = await this.requireOpenUnsafe();
    if (record.status === 'collecting') throw new Error('CAMPAIGN_PROGRESS_INVENTORY_INCOMPLETE');
    return record;
  }

  async recordFinalOrigin(
    origin: CampaignOriginReceipt,
    verifyOrigin: CampaignOriginReceiptVerifier,
  ): Promise<CampaignProgressJournalRecord> {
    return this.persistence.claim(this.key, async () => {
      const record = await this.requireOpenUnsafe();
      if (record.status === 'collecting') throw new Error('CAMPAIGN_PROGRESS_INVENTORY_INCOMPLETE');
      if (record.origin) {
        if (!same(record.origin, origin)) throw new Error('CAMPAIGN_PROGRESS_FINAL_ORIGIN_IMMUTABLE');
        return record;
      }
      assertOriginMembership(record.binding, record.receipts, origin);
      await verifyOrigin(origin, record.receipts);
      const next = freezeRecord({ ...this.withoutDigest(record), status: 'finalized',
        origin: Object.freeze(structuredClone(origin)) });
      await this.write(next);
      return next;
    });
  }

  private async readUnsafe(): Promise<CampaignProgressJournalRecord | null> {
    const raw = await this.persistence.read(this.key);
    return raw ? parseCampaignProgressJournal(JSON.parse(raw)) : null;
  }

  private async requireOpenUnsafe(): Promise<CampaignProgressJournalRecord> {
    const record = await this.readUnsafe();
    if (!record) throw new Error('CAMPAIGN_PROGRESS_NOT_OPEN');
    return record;
  }

  private withoutDigest(record: CampaignProgressJournalRecord): Omit<CampaignProgressJournalRecord, 'journalDigest'> {
    const { journalDigest: _digest, ...body } = record;
    return body;
  }

  private write(record: CampaignProgressJournalRecord): Promise<void> {
    return this.persistence.write(this.key, `${JSON.stringify(record, null, 2)}\n`);
  }
}
