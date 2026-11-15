import { randomUUID } from 'node:crypto';
import type {
  LiminalAuthorityReceipt,
  LiminalOperationAdmission,
  LiminalOperationJournal,
  LiminalReceiptAuthority,
} from './LiminalCommandService.js';

/** Mints operation identity; callers cannot submit their own lineage identifier. */
export class LiminalOperationKernel {
  constructor(private readonly journal: LiminalOperationJournal,
    private readonly authority: LiminalReceiptAuthority,
    private readonly idFactory: () => string = () => randomUUID()) {}

  beginRoot(key: string, commandDigest: string): Promise<LiminalOperationAdmission> {
    return this.journal.begin(key, {
      operationId: `operation:${this.idFactory()}`,
      lineageId: `lineage:${this.idFactory()}`,
      commandDigest, attemptsConsumed: 0,
    });
  }

  async beginChild(key: string, commandDigest: string,
    parent: LiminalAuthorityReceipt): Promise<LiminalOperationAdmission> {
    if (!this.authority.verify(parent)) throw new Error('PARENT_CAPABILITY_INVALID');
    return await this.journal.begin(key, {
      operationId: `operation:${this.idFactory()}`,
      lineageId: parent.lineageId,
      commandDigest, attemptsConsumed: 0,
    });
  }
}
