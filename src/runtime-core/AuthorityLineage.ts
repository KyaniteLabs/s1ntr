import { createHash } from 'node:crypto';

export type AuthorityTrustKind = 'operational' | 'source-change' | 'capability' | 'creative';
export interface AuthorityLineageRecord {
  readonly id: string;
  readonly trustKind: AuthorityTrustKind;
  readonly relationIds: readonly string[];
  readonly evidenceDigest: string;
  readonly recordDigest: string;
}
const digest = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

export class AuthorityLineage {
  private readonly records = new Map<string, AuthorityLineageRecord>();

  add(input: Omit<AuthorityLineageRecord, 'recordDigest'>): AuthorityLineageRecord {
    if (!input.id.trim() || !/^[a-f0-9]{64}$/.test(input.evidenceDigest)) {
      throw new Error('AUTHORITY_LINEAGE_INVALID');
    }
    const record = Object.freeze({ ...input,
      relationIds: Object.freeze([...new Set(input.relationIds)]), recordDigest: digest(input) });
    this.records.set(record.id, record);
    return record;
  }

  assertWriteAuthority(id: string, trustKind: AuthorityTrustKind): AuthorityLineageRecord {
    const record = this.records.get(id);
    if (!record || record.trustKind !== trustKind) {
      throw new Error('AUTHORITY_TRUST_CAST_FORBIDDEN');
    }
    return record;
  }

  query(id: string): readonly AuthorityLineageRecord[] {
    const found: AuthorityLineageRecord[] = [];
    const pending = [id];
    const seen = new Set<string>();
    while (pending.length) {
      const next = pending.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const record = this.records.get(next);
      if (!record) continue;
      found.push(Object.freeze({ ...record, relationIds: Object.freeze([...record.relationIds]) }));
      pending.push(...record.relationIds);
    }
    return Object.freeze(found);
  }
}
