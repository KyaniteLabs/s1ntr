import { LaneBreakers, laneKey } from './LaneBreakers.js';
import type {
  JudgeTransport,
  JudgingSense,
  LaneDescriptor,
  LaneHealth,
} from './types.js';

export interface ProviderPoolOptions {
  readonly breakers?: LaneBreakers;
  readonly transports?: ReadonlyMap<string, JudgeTransport> | Readonly<Record<string, JudgeTransport>>;
}

type LaneInput = readonly LaneDescriptor[] | Readonly<Record<JudgingSense, readonly LaneDescriptor[]>>;

export class ProviderPool {
  readonly breakers: LaneBreakers;
  private readonly lanes = new Map<JudgingSense, LaneDescriptor[]>();
  private readonly transports = new Map<string, JudgeTransport>();
  private readonly healthByKey = new Map<string, LaneHealth>();

  constructor(initial: LaneInput = [], options: ProviderPoolOptions = {}) {
    this.breakers = options.breakers ?? new LaneBreakers();
    this.loadTransports(options.transports);
    if (Array.isArray(initial)) {
      initial.forEach((lane) => this.register(lane));
    } else {
      Object.entries(initial).forEach(([sense, entries]) => {
        (entries as readonly LaneDescriptor[]).forEach((lane) => {
          this.register({ ...lane, sense: sense as JudgingSense });
        });
      });
    }
  }

  register(lane: LaneDescriptor, transport?: JudgeTransport): void {
    const entries = this.lanes.get(lane.sense) ?? [];
    if (!entries.some((candidate) => laneKey(candidate) === laneKey(lane))) entries.push(lane);
    entries.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    this.lanes.set(lane.sense, entries);
    this.healthFor(lane);
    if (transport) this.transports.set(laneKey(lane), transport);
  }

  registerJudge(lane: LaneDescriptor, transport?: JudgeTransport): void {
    this.register(lane, transport);
  }

  lookup(sense: JudgingSense): readonly LaneDescriptor[] {
    return (this.lanes.get(sense) ?? []).filter((lane) => this.breakers.canUse(lane));
  }

  primary(sense: JudgingSense): LaneDescriptor | null {
    return this.lookup(sense)[0] ?? null;
  }

  substitutes(sense: JudgingSense): readonly LaneDescriptor[] {
    return this.lookup(sense).slice(1);
  }

  transportFor(lane: LaneDescriptor): JudgeTransport | undefined {
    return this.transports.get(laneKey(lane));
  }

  recordSuccess(lane: LaneDescriptor): void {
    const health = this.healthFor(lane);
    this.healthByKey.set(health.key, {
      ...health,
      attempts: health.attempts + 1,
      successes: health.successes + 1,
      consecutiveFailures: 0,
    });
    this.breakers.recordSuccess(lane);
  }

  recordFailure(lane: LaneDescriptor): void {
    const health = this.healthFor(lane);
    this.healthByKey.set(health.key, {
      ...health,
      attempts: health.attempts + 1,
      failures: health.failures + 1,
      consecutiveFailures: health.consecutiveFailures + 1,
    });
    this.breakers.recordFailure(lane);
  }

  health(lane: LaneDescriptor): LaneHealth {
    return { ...this.healthFor(lane) };
  }

  healthForSense(sense: JudgingSense): readonly LaneHealth[] {
    return (this.lanes.get(sense) ?? []).map((lane) => this.health(lane));
  }

  private healthFor(lane: LaneDescriptor): LaneHealth {
    const key = laneKey(lane);
    const existing = this.healthByKey.get(key);
    if (existing) return existing;
    const initial: LaneHealth = { key, attempts: 0, successes: 0, failures: 0, consecutiveFailures: 0 };
    this.healthByKey.set(key, initial);
    return initial;
  }

  private loadTransports(transports: ProviderPoolOptions['transports']): void {
    if (!transports) return;
    if (transports instanceof Map) {
      transports.forEach((transport, key) => this.transports.set(key, transport));
    } else {
      Object.entries(transports).forEach(([key, transport]) => this.transports.set(key, transport));
    }
  }
}
