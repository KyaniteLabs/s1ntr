import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes }
  from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../../utils/atomicWrite.js';
import type { DreamTransferCommitmentProtocol } from './DreamResearchEvidence.js';
import type { DreamResearchSnapshot } from './DreamResearchTypes.js';

export interface DreamHoldoutCommitment {
  schema: 'sinter.dream-holdout-commitment';
  schemaVersion: 1;
  commitmentDigest: string;
  poolDigest: string;
  selectorDigest: string;
  custodianDigest: string;
  protocolDigest: string;
}

export interface DreamHoldoutCapability {
  readonly custodyId?: string;
  readonly commitment: DreamHoldoutCommitment;
}

/**
 * How far the holdout custodian is separated from the code being evaluated.
 * 'same-process': the custodian runs in the evaluated process and its key is
 * a host key that process can read. Encryption and signatures protect the
 * bytes at rest and detect tampering, but this is not independent isolation
 * (#1259). Only a separately operated custodian could be 'independent'; none
 * exists in this repository.
 */
export type DreamHoldoutIsolation = 'same-process' | 'independent';

export interface DreamHoldoutCustody {
  /** Absent means 'same-process'. */
  readonly isolation?: DreamHoldoutIsolation;
  open(capability: DreamHoldoutCapability, snapshot: DreamResearchSnapshot,
    journalFirstAccess: (commandId: string, commitmentDigest: string) => void):
    { bytes: string; protocol: DreamTransferCommitmentProtocol };
}

/**
 * Held-out bytes open only once every transfer pin is frozen (#1259). Opening
 * at `finding-proposed` let the candidate/selector see held-out bytes before
 * the transfer protocol was committed.
 */
export const HOLDOUT_OPEN_STATE = 'transfer-frozen' as const;

interface SealedHoldout { bytes: string; protocol: DreamTransferCommitmentProtocol; opened: boolean }
const sealed = new WeakMap<object, SealedHoldout>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class DreamHoldoutVault {
  readonly isolation: DreamHoldoutIsolation = 'same-process';

  seal(bytes: string, input: { selectorDigest: string;
    custodianDigest: string; protocol: DreamTransferCommitmentProtocol }): DreamHoldoutCapability {
    const poolDigest = digest(bytes);
    const body = { schema: 'sinter.dream-holdout-commitment' as const,
      schemaVersion: 1 as const, poolDigest, selectorDigest: input.selectorDigest,
      custodianDigest: input.custodianDigest,
      protocolDigest: sealedProtocolDigest(input.protocol) };
    const capability = Object.freeze({ commitment: Object.freeze({ ...body,
      commitmentDigest: digest(JSON.stringify(body)) }) });
    sealed.set(capability, { bytes, protocol: Object.freeze({ ...input.protocol }), opened: false });
    return capability;
  }

  open(capability: DreamHoldoutCapability, snapshot: DreamResearchSnapshot,
    journalFirstAccess: (commandId: string, commitmentDigest: string) => void):
    { bytes: string; protocol: DreamTransferCommitmentProtocol } {
    const value = sealed.get(capability);
    if (!value) throw new Error('DREAM_HOLDOUT_CAPABILITY_INVALID');
    if (snapshot.state !== HOLDOUT_OPEN_STATE) {
      throw new Error('DREAM_HOLDOUT_ACCESS_PREMATURE');
    }
    if (!value.opened) {
      journalFirstAccess(`holdout-access:${capability.commitment.commitmentDigest}`,
        capability.commitment.commitmentDigest);
      value.opened = true;
    }
    return { bytes: value.bytes, protocol: value.protocol };
  }
}

interface DurableHoldoutRecord {
  commitment: DreamHoldoutCommitment;
  iv: string;
  ciphertext: string;
  tag: string;
  signature: string;
  opened: boolean;
}

interface DurableHoldoutState {
  schema: 'sinter.dream-holdout-vault';
  schemaVersion: 1;
  records: Record<string, DurableHoldoutRecord>;
}

/** Restart-safe custody: sealed bytes never enter a Dream command or projection. */
export class FileDreamHoldoutVault implements DreamHoldoutCustody {
  /** Encrypted and signed at rest, but keyed by a host key this process holds. */
  readonly isolation: DreamHoldoutIsolation = 'same-process';

  constructor(private readonly file: string, private readonly hostKey: string) {
    if (!path.isAbsolute(file)) throw new Error('DREAM_HOLDOUT_PATH_NOT_ABSOLUTE');
    if (!hostKey) throw new Error('DREAM_HOLDOUT_HOST_KEY_REQUIRED');
  }

  precommit(custodyId: string, bytes: string, input: { selectorDigest: string;
    custodianDigest: string; protocol: DreamTransferCommitmentProtocol }): DreamHoldoutCapability {
    if (!custodyId.trim() || !bytes) throw new Error('DREAM_HOLDOUT_INPUT_INVALID');
    const body = { schema: 'sinter.dream-holdout-commitment' as const,
      schemaVersion: 1 as const, poolDigest: digest(bytes), selectorDigest: input.selectorDigest,
      custodianDigest: input.custodianDigest, protocolDigest: sealedProtocolDigest(input.protocol) };
    const commitment = Object.freeze({ ...body, commitmentDigest: digest(JSON.stringify(body)) });
    const state = this.readState();
    const existing = state.records[custodyId];
    if (existing) {
      this.verify(existing);
      if (existing.commitment.commitmentDigest !== commitment.commitmentDigest) {
        throw new Error('DREAM_HOLDOUT_CUSTODY_REBOUND');
      }
      return Object.freeze({ custodyId, commitment: existing.commitment });
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ bytes,
      protocol: input.protocol }), 'utf8'), cipher.final()]).toString('base64');
    const unsigned = { commitment, iv: iv.toString('base64'), ciphertext,
      tag: cipher.getAuthTag().toString('base64'), opened: false };
    const record = { ...unsigned, signature: this.sign(unsigned) };
    this.writeState({ ...state, records: { ...state.records, [custodyId]: record } });
    return Object.freeze({ custodyId, commitment });
  }

  open(capability: DreamHoldoutCapability, snapshot: DreamResearchSnapshot,
    journalFirstAccess: (commandId: string, commitmentDigest: string) => void):
    { bytes: string; protocol: DreamTransferCommitmentProtocol } {
    if (!capability.custodyId) throw new Error('DREAM_HOLDOUT_CAPABILITY_INVALID');
    const state = this.readState();
    const record = state.records[capability.custodyId];
    if (!record || record.commitment.commitmentDigest
      !== capability.commitment.commitmentDigest) throw new Error('DREAM_HOLDOUT_CAPABILITY_INVALID');
    this.verify(record);
    if (snapshot.state !== HOLDOUT_OPEN_STATE) {
      throw new Error('DREAM_HOLDOUT_ACCESS_PREMATURE');
    }
    if (!record.opened) {
      journalFirstAccess(`holdout-access:${record.commitment.commitmentDigest}`,
        record.commitment.commitmentDigest);
      const unsigned = { commitment: record.commitment, iv: record.iv,
        ciphertext: record.ciphertext, tag: record.tag, opened: true };
      this.writeState({ ...state, records: { ...state.records,
        [capability.custodyId]: { ...unsigned, signature: this.sign(unsigned) } } });
    }
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(),
      Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const clear = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final()]).toString('utf8');
    return JSON.parse(clear) as { bytes: string; protocol: DreamTransferCommitmentProtocol };
  }

  private encryptionKey(): Buffer { return createHash('sha256').update(
    `dream-holdout-encryption\0${this.hostKey}`).digest(); }
  private sign(value: unknown): string { return createHmac('sha256', this.hostKey)
    .update(JSON.stringify(value)).digest('hex'); }
  private verify(record: DurableHoldoutRecord): void {
    const { signature, ...unsigned } = record;
    if (signature !== this.sign(unsigned)) throw new Error('DREAM_HOLDOUT_SIGNATURE_INVALID');
  }

  private readState(): DurableHoldoutState {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as DurableHoldoutState;
      if (value.schema !== 'sinter.dream-holdout-vault' || value.schemaVersion !== 1
        || !value.records || typeof value.records !== 'object') {
        throw new Error('DREAM_HOLDOUT_STORE_INVALID');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {
        schema: 'sinter.dream-holdout-vault', schemaVersion: 1, records: {} };
      throw error;
    }
  }

  private writeState(state: DurableHoldoutState): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomicSync(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function sealedProtocolDigest(value: DreamTransferCommitmentProtocol): string {
  return digest(JSON.stringify({ originContextDigest: value.originContextDigest,
    controlContextDigest: value.controlContextDigest,
    treatmentContextDigest: value.treatmentContextDigest,
    findingDigest: value.findingDigest,
    controlFindingDigest: value.controlFindingDigest,
    treatmentFindingDigest: value.treatmentFindingDigest }));
}
