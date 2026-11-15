import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DreamLeaseAuthority } from './DreamResearchService.js';
import type { DreamExperimentPlan } from './DreamResearchTypes.js';

interface LeaseRecord { token: string; fencingSequence: number; active: boolean }

export class DreamLeaseRegistry implements DreamLeaseAuthority {
  private readonly leases = new Map<string, LeaseRecord>();

  constructor(private readonly persistencePath?: string) {
    if (!persistencePath) return;
    try {
      const saved = JSON.parse(readFileSync(persistencePath, 'utf8')) as Record<string, LeaseRecord>;
      for (const [campaignId, lease] of Object.entries(saved)) {
        if (!lease || typeof lease.token !== 'string'
          || !Number.isSafeInteger(lease.fencingSequence) || typeof lease.active !== 'boolean') {
          throw new Error('invalid lease record');
        }
        this.leases.set(campaignId, lease);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('DREAM_LEASE_STORE_INVALID', { cause: error });
      }
    }
  }

  resumeOrIssue(campaignId: string): DreamExperimentPlan['lease'] {
    const active = this.leases.get(campaignId);
    return active?.active
      ? Object.freeze({ token: active.token, fencingSequence: active.fencingSequence })
      : this.issue(campaignId);
  }

  issue(campaignId: string): DreamExperimentPlan['lease'] {
    const previous = this.leases.get(campaignId);
    if (previous?.active) throw new Error('DREAM_LEASE_ALREADY_ACTIVE');
    const lease = { token: randomUUID(),
      fencingSequence: (previous?.fencingSequence ?? 0) + 1 };
    this.leases.set(campaignId, { ...lease, active: true });
    this.persist();
    return Object.freeze(lease);
  }

  cancel(campaignId: string, lease: DreamExperimentPlan['lease']): void {
    this.assertActive(campaignId, lease);
    this.leases.set(campaignId, { ...lease, active: false });
    this.persist();
  }

  assertActive(campaignId: string, lease: DreamExperimentPlan['lease']): void {
    const active = this.leases.get(campaignId);
    if (!active?.active || active.token !== lease.token
      || active.fencingSequence !== lease.fencingSequence) {
      throw new Error('DREAM_LEASE_STALE_OR_INACTIVE');
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true });
    const temporary = `${this.persistencePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.leases))}\n`, 'utf8');
    renameSync(temporary, this.persistencePath);
  }
}
