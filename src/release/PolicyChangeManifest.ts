/**
 * PolicyChangeManifest — Phase 16
 *
 * Tracks provenance for policy changes: what triggered the change,
 * which experiment justified it, which metrics improved, and
 * what rollback target exists.
 */

export interface PolicyChangeRecord {
  id: string;
  policyKind: string;
  changeDescription: string;
  triggerWeakness?: string;
  experimentId?: string;
  metricsBefore: Record<string, number>;
  metricsAfter: Record<string, number>;
  rollbackTargetId?: string;
  promotedAt: string;
  status: 'staged' | 'promoted' | 'rolled-back';
}

function isMetricSnapshot(value: unknown): value is Record<string, number> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(metric => Number.isFinite(metric));
}

/** Names measured in both snapshots, or undefined for an incomplete comparison. */
export function comparablePolicyMetrics(before: unknown, after: unknown): string[] | undefined {
  if (!isMetricSnapshot(before) || !isMetricSnapshot(after)) return undefined;
  const names = Object.keys(before);
  if (names.length === 0 || names.length !== Object.keys(after).length) return undefined;
  return names.every(name => Object.hasOwn(after, name)) ? names : undefined;
}

export class PolicyChangeManifest {
  private readonly records = new Map<string, PolicyChangeRecord>();
  private recordCount = 0;

  /**
   * Stage a new policy change before promotion.
   */
  stage(
    policyKind: string,
    changeDescription: string,
    metricsBefore: Record<string, number>,
    opts?: { triggerWeakness?: string; experimentId?: string; rollbackTargetId?: string },
  ): PolicyChangeRecord {
    const id = `change-${++this.recordCount}`;
    const record: PolicyChangeRecord = {
      id,
      policyKind,
      changeDescription,
      triggerWeakness: opts?.triggerWeakness,
      experimentId: opts?.experimentId,
      metricsBefore,
      metricsAfter: {},
      rollbackTargetId: opts?.rollbackTargetId,
      promotedAt: new Date().toISOString(),
      status: 'staged',
    };
    this.records.set(id, record);
    return record;
  }

  /**
   * Promote a staged change with measured results.
   */
  promote(id: string, metricsAfter: Record<string, number>): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== 'staged' || !comparablePolicyMetrics(record.metricsBefore, metricsAfter)) {
      return false;
    }

    record.metricsAfter = metricsAfter;
    record.status = 'promoted';
    return true;
  }

  /**
   * Roll back a promoted change.
   */
  rollback(id: string): string | null {
    const record = this.records.get(id);
    if (!record || record.status !== 'promoted') return null;

    record.status = 'rolled-back';
    return record.rollbackTargetId ?? null;
  }

  /**
   * Get changes by status.
   */
  getByStatus(status: PolicyChangeRecord['status']): PolicyChangeRecord[] {
    return [...this.records.values()].filter(r => r.status === status);
  }

  /**
   * Get the most recent promoted change for a policy kind.
   */
  getLatest(policyKind: string): PolicyChangeRecord | undefined {
    const records = [...this.records.values()]
      .filter(r => r.policyKind === policyKind && r.status === 'promoted')
      .sort((a, b) => b.promotedAt.localeCompare(a.promotedAt));
    return records[0];
  }

  getRecord(id: string): PolicyChangeRecord | undefined {
    return this.records.get(id);
  }

  getAll(): PolicyChangeRecord[] {
    return [...this.records.values()];
  }

  getRecordCount(): number {
    return this.recordCount;
  }

  /** Serializable snapshot (what `sinter ship` keeps on disk). */
  toJSON(): { recordCount: number; records: PolicyChangeRecord[] } {
    return { recordCount: this.recordCount, records: this.getAll() };
  }

  /** Rebuild a manifest from {@link toJSON} output; ids keep counting from where they stopped. */
  static fromJSON(data: unknown): PolicyChangeManifest {
    const manifest = new PolicyChangeManifest();
    const d = data as { recordCount?: unknown; records?: unknown } | null;
    if (!d || typeof d !== 'object' || !Array.isArray(d.records)) {
      throw new Error('PolicyChangeManifest: malformed snapshot (records missing)');
    }
    const count = d.recordCount ?? 0;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER) {
      throw new Error('PolicyChangeManifest: invalid record counter');
    }
    for (const r of d.records as PolicyChangeRecord[]) {
      const ordinal = typeof r?.id === 'string' && /^change-[1-9][0-9]*$/.test(r.id) ? Number(r.id.slice(7)) : NaN;
      if (!Number.isSafeInteger(ordinal) || ordinal >= Number.MAX_SAFE_INTEGER || manifest.records.has(r.id)
          || !['staged', 'promoted', 'rolled-back'].includes(r.status)
          || typeof r.policyKind !== 'string' || typeof r.changeDescription !== 'string'
          || typeof r.promotedAt !== 'string' || !Number.isFinite(Date.parse(r.promotedAt))
          || !isMetricSnapshot(r.metricsBefore) || !isMetricSnapshot(r.metricsAfter)
          || [r.triggerWeakness, r.experimentId, r.rollbackTargetId].some(value =>
            value !== undefined && typeof value !== 'string')) {
        throw new Error('PolicyChangeManifest: malformed record in snapshot');
      }
      manifest.records.set(r.id, r);
      manifest.recordCount = Math.max(manifest.recordCount, ordinal);
    }
    manifest.recordCount = Math.max(manifest.recordCount, count);
    return manifest;
  }
}
