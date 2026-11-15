/**
 * SleepScheduler — Adaptive sleep timing based on user activity patterns.
 *
 * "Sleep when the user sleeps." The scheduler tracks when the user is active
 * and builds a simple activity model. When idle periods are detected, it
 * triggers dreaming at appropriate times:
 *
 *   - **Micro-dreams**: 5+ minutes idle. Quick consolidation pass, cache warming.
 *   - **Deep dreams**: 30+ minutes idle. Full two-stage dream pipeline.
 *
 * No configurable cron — the system figures it out from observed patterns.
 *
 * Guarantees (#1256):
 *   - No activity history is a HOLD, never "infinitely idle".
 *   - User idle is an advisory wake signal, not compute authorization. A
 *     `capacityPermit` (e.g. a trough-window check) must also allow the start;
 *     without one, the state reports `capacityAuthorization: 'not-checked'`.
 *   - Starts are fenced by a persisted reservation: a second start is refused
 *     while one is active, and the start counts against the hourly cap
 *     immediately rather than at completion. Activity arriving mid-dream
 *     sets `abortRequested`.
 *
 * @module intuition/SleepScheduler
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SleepDepth = 'micro' | 'deep';

export interface SleepScheduleConfig {
  /** Idle minutes before a micro-dream. Default: 5 */
  microIdleMinutes?: number;
  /** Idle minutes before a deep dream. Default: 30 */
  deepIdleMinutes?: number;
  /** Maximum dreams per hour. Default: 6 */
  maxDreamsPerHour?: number;
  /** Minimum minutes between consecutive dreams. Default: 3 */
  minDreamSpacingMinutes?: number;
  /** Activity sample window in hours. Default: 24 */
  activityWindowHours?: number;
  /** A reservation older than this is treated as abandoned. Default: 60 */
  reservationTtlMinutes?: number;
  /**
   * Compute-capacity permission (e.g. a trough-window check). User idle alone
   * never authorizes compute; when provided, a false result holds the dream.
   */
  capacityPermit?: () => boolean;
}

export type SleepHoldReason =
  | 'no-history'
  | 'user-active'
  | 'rate-limited'
  | 'spacing'
  | 'reserved'
  | 'no-capacity';

/** A fenced dream start. Persisted so a restart cannot double-start. */
export interface DreamReservation {
  id: string;
  depth: SleepDepth;
  startedAt: number;
  abortRequested: boolean;
}

export interface ActivitySample {
  timestamp: number; // ms since epoch
  type: 'generation' | 'interaction' | 'command';
}

/** Persisted scheduler state (activity window + dream rate limiting). */
export interface SleepSchedulerSnapshot {
  activityLog: ActivitySample[];
  lastDreamAt: number | null;
  dreamsThisHour: number;
  currentHourBucket: number;
  /** Active start reservation, if a dream is in flight. */
  activeReservation?: DreamReservation | null;
}

export interface SleepState {
  /** Whether the system is currently "awake" (user is active) */
  isAwake: boolean;
  /** Current sleep pressure (0-1, higher = more pressure to sleep) */
  sleepPressure: number;
  /** Minutes since last user activity */
  idleMinutes: number;
  /** Time of last dream */
  lastDreamAt: number | null;
  /** Dreams completed in current hour */
  dreamsThisHour: number;
  /** Current hour bucket for rate limiting */
  currentHourBucket: number;
  /** Recommended sleep depth */
  recommendedDepth: SleepDepth | null;
  /** Why no depth is recommended (null when one is). */
  holdReason: SleepHoldReason | null;
  /** Whether a capacity permit was consulted for this recommendation. */
  capacityAuthorization: 'permitted' | 'denied' | 'not-checked';
}

// ---------------------------------------------------------------------------
// SleepScheduler
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<Omit<SleepScheduleConfig, 'capacityPermit'>> = {
  microIdleMinutes: 5,
  deepIdleMinutes: 30,
  maxDreamsPerHour: 6,
  minDreamSpacingMinutes: 3,
  activityWindowHours: 24,
  reservationTtlMinutes: 60,
};

export class SleepScheduler {
  private readonly config: Required<Omit<SleepScheduleConfig, 'capacityPermit'>>;
  private readonly capacityPermit?: () => boolean;
  private activityLog: ActivitySample[] = [];
  private activeReservation: DreamReservation | null = null;
  private reservationSeq = 0;
  private lastDreamAt: number | null = null;
  private dreamsThisHour = 0;
  private currentHourBucket = 0;

  constructor(config?: SleepScheduleConfig) {
    const { capacityPermit, ...rest } = config ?? {};
    this.config = { ...DEFAULT_CONFIG, ...rest };
    this.capacityPermit = capacityPermit;
  }

  // ---------------------------------------------------------------------------
  // Activity tracking
  // ---------------------------------------------------------------------------

  /**
   * Record a user activity event.
   * Call this whenever the user generates, edits, or interacts.
   */
  recordActivity(type: ActivitySample['type'] = 'interaction'): void {
    this.activityLog.push({
      timestamp: Date.now(),
      type,
    });

    // Trim old activity samples
    const cutoff = Date.now() - this.config.activityWindowHours * 60 * 60 * 1000;
    this.activityLog = this.activityLog.filter(a => a.timestamp > cutoff);

    // Work arrived while a dream is in flight: ask the dreamer to abort.
    const reservation = this.currentReservation(Date.now());
    if (reservation) reservation.abortRequested = true;
  }

  // ---------------------------------------------------------------------------
  // Sleep state
  // ---------------------------------------------------------------------------

  /**
   * Get current sleep state — should the system dream?
   */
  getState(): SleepState {
    const now = Date.now();
    const lastActivity = this.getLastActivityTime();
    const idleMinutes = lastActivity ? (now - lastActivity) / 60_000 : Infinity;

    // Sleep pressure: sigmoid on idle time
    // Pressure is low for first few minutes, ramps up as idle grows
    const sleepPressure = 1 / (1 + Math.exp(-(idleMinutes - 15) / 5));

    // Check rate limiting
    const hourBucket = Math.floor(now / (60 * 60 * 1000));
    if (hourBucket !== this.currentHourBucket) {
      this.currentHourBucket = hourBucket;
      this.dreamsThisHour = 0;
    }

    const rateLimitOk = this.dreamsThisHour < this.config.maxDreamsPerHour;
    const spacingOk = !this.lastDreamAt ||
      (now - this.lastDreamAt) > this.config.minDreamSpacingMinutes * 60 * 1000;

    const reserved = this.currentReservation(now) !== null;

    // Determine depth. No history is a HOLD, not infinite idle (#1256).
    let holdReason: SleepHoldReason | null = null;
    if (lastActivity === null) holdReason = 'no-history';
    else if (idleMinutes < this.config.microIdleMinutes) holdReason = 'user-active';
    else if (reserved) holdReason = 'reserved';
    else if (!rateLimitOk) holdReason = 'rate-limited';
    else if (!spacingOk) holdReason = 'spacing';

    let capacityAuthorization: SleepState['capacityAuthorization'] = 'not-checked';
    if (holdReason === null && this.capacityPermit) {
      capacityAuthorization = this.capacityPermit() ? 'permitted' : 'denied';
      if (capacityAuthorization === 'denied') holdReason = 'no-capacity';
    }

    let recommendedDepth: SleepDepth | null = null;
    if (holdReason === null) {
      recommendedDepth = idleMinutes >= this.config.deepIdleMinutes ? 'deep' : 'micro';
    }

    return {
      isAwake: idleMinutes < this.config.microIdleMinutes,
      sleepPressure,
      idleMinutes,
      lastDreamAt: this.lastDreamAt,
      dreamsThisHour: this.dreamsThisHour,
      currentHourBucket: this.currentHourBucket,
      recommendedDepth,
      holdReason,
      capacityAuthorization,
    };
  }

  /**
   * Should the system dream right now?
   */
  shouldDream(): SleepDepth | null {
    return this.getState().recommendedDepth;
  }

  /**
   * Reserve a dream start. Returns null when the scheduler holds (including
   * when another reservation is active). The start counts against the hourly
   * cap now, so concurrent callers cannot both pass the check.
   */
  beginDream(): DreamReservation | null {
    const depth = this.shouldDream();
    if (!depth) return null;
    return this.reserve(depth);
  }

  /**
   * Reserve a start regardless of idle state (forced dreams). Still refuses
   * while another reservation is active.
   */
  reserveForced(depth: SleepDepth): DreamReservation | null {
    if (this.currentReservation(Date.now())) return null;
    return this.reserve(depth);
  }

  /** The active reservation, or null. Expired reservations are released. */
  getActiveReservation(): DreamReservation | null {
    const r = this.currentReservation(Date.now());
    return r ? { ...r } : null;
  }

  /** Release a reservation without counting a completed dream. */
  abortDream(reservationId: string): boolean {
    if (this.activeReservation?.id !== reservationId) return false;
    this.activeReservation = null;
    return true;
  }

  /** Snapshot mutable state for persistence. */
  serialize(): SleepSchedulerSnapshot {
    return {
      activityLog: [...this.activityLog],
      lastDreamAt: this.lastDreamAt,
      dreamsThisHour: this.dreamsThisHour,
      currentHourBucket: this.currentHourBucket,
      activeReservation: this.activeReservation ? { ...this.activeReservation } : null,
    };
  }

  /** Restore state saved by {@link serialize}. */
  deserialize(state: SleepSchedulerSnapshot): void {
    this.activityLog = [...state.activityLog];
    this.lastDreamAt = state.lastDreamAt;
    this.dreamsThisHour = state.dreamsThisHour;
    this.currentHourBucket = state.currentHourBucket;
    this.activeReservation = state.activeReservation ? { ...state.activeReservation } : null;
  }

  /**
   * Mark that a dream was completed. With a reservation id, releases that
   * reservation (its start was already counted); without one, counts an
   * unreserved dream as before.
   */
  markDreamCompleted(reservationId?: string): void {
    this.lastDreamAt = Date.now();
    if (reservationId !== undefined) {
      if (this.activeReservation?.id === reservationId) this.activeReservation = null;
      return;
    }
    this.dreamsThisHour++;
  }

  private reserve(depth: SleepDepth): DreamReservation {
    const now = Date.now();
    const hourBucket = Math.floor(now / (60 * 60 * 1000));
    if (hourBucket !== this.currentHourBucket) {
      this.currentHourBucket = hourBucket;
      this.dreamsThisHour = 0;
    }
    this.dreamsThisHour++;
    this.reservationSeq++;
    this.activeReservation = {
      id: `dream-${now}-${this.reservationSeq}`,
      depth,
      startedAt: now,
      abortRequested: false,
    };
    return { ...this.activeReservation };
  }

  private currentReservation(now: number): DreamReservation | null {
    const r = this.activeReservation;
    if (!r) return null;
    if (now - r.startedAt > this.config.reservationTtlMinutes * 60_000) {
      this.activeReservation = null;
      return null;
    }
    return r;
  }

  // ---------------------------------------------------------------------------
  // Activity pattern analysis
  // ---------------------------------------------------------------------------

  /**
   * Get the user's typical active hours (0-23).
   * Returns an array of hours where activity density is above median.
   */
  getActiveHours(): number[] {
    if (this.activityLog.length < 10) return []; // Not enough data

    const hourCounts = new Array(24).fill(0) as number[];
    for (const sample of this.activityLog) {
      const hour = new Date(sample.timestamp).getHours();
      hourCounts[hour]++;
    }

    // Sort a copy: sorting hourCounts in place would reassign counts to the wrong hours (#1255).
    const median = [...hourCounts].sort((a, b) => a - b)[12]; // Rough median
    const activeHours: number[] = [];
    for (let h = 0; h < 24; h++) {
      if (hourCounts[h] > median) activeHours.push(h);
    }

    return activeHours;
  }

  /**
   * Get estimated "bedtime" — the hour when activity typically drops off.
   * Returns the first hour after sustained activity where activity drops below 25% of peak.
   */
  getEstimatedBedtime(): number | null {
    const activeHours = this.getActiveHours();
    if (activeHours.length < 3) return null;

    // Find the latest sustained active hour
    const sorted = [...activeHours].sort((a, b) => a - b);
    // Look for gaps in the sorted hours — bedtime is after the last gap
    for (let i = sorted.length - 1; i > 0; i--) {
      if (sorted[i] - sorted[i - 1] > 2) {
        return sorted[i - 1] + 1; // Hour after the last sustained block
      }
    }

    // No gap found — activity is spread across all hours
    return null;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private getLastActivityTime(): number | null {
    if (this.activityLog.length === 0) return null;
    return Math.max(...this.activityLog.map(a => a.timestamp));
  }

  /** Reset state. */
  reset(): void {
    this.activityLog = [];
    this.lastDreamAt = null;
    this.dreamsThisHour = 0;
    this.activeReservation = null;
  }

  /** Get activity log size. */
  get activityCount(): number {
    return this.activityLog.length;
  }
}
