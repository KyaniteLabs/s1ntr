import type { LaneDescriptor } from './types.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  probeInFlight: boolean;
}

export interface LaneBreakersOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export function laneKey(lane: LaneDescriptor): string {
  return `${lane.provider}|${lane.model}|${lane.transport}`;
}

export class LaneBreakers {
  private readonly records = new Map<string, BreakerRecord>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: LaneBreakersOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 30_000);
    this.now = options.now ?? (() => Date.now());
  }

  canUse(lane: LaneDescriptor): boolean {
    const key = laneKey(lane);
    const record = this.recordFor(key);
    if (record.state === 'closed') return true;
    if (record.state === 'open' && this.now() - (record.openedAt ?? 0) >= this.cooldownMs) {
      record.state = 'half-open';
      record.probeInFlight = false;
    }
    if (record.state !== 'half-open' || record.probeInFlight) return false;
    record.probeInFlight = true;
    return true;
  }

  recordSuccess(lane: LaneDescriptor): void {
    const record = this.recordFor(laneKey(lane));
    record.state = 'closed';
    record.consecutiveFailures = 0;
    record.openedAt = null;
    record.probeInFlight = false;
  }

  recordFailure(lane: LaneDescriptor): void {
    const record = this.recordFor(laneKey(lane));
    record.consecutiveFailures += 1;
    record.probeInFlight = false;
    if (record.state === 'half-open' || record.consecutiveFailures >= this.failureThreshold) {
      record.state = 'open';
      record.openedAt = this.now();
    }
  }

  state(lane: LaneDescriptor): BreakerState {
    return this.recordFor(laneKey(lane)).state;
  }

  consecutiveFailures(lane: LaneDescriptor): number {
    return this.recordFor(laneKey(lane)).consecutiveFailures;
  }

  reset(lane: LaneDescriptor): void {
    this.records.delete(laneKey(lane));
  }

  private recordFor(key: string): BreakerRecord {
    let record = this.records.get(key);
    if (!record) {
      record = { state: 'closed', consecutiveFailures: 0, openedAt: null, probeInFlight: false };
      this.records.set(key, record);
    }
    return record;
  }
}
