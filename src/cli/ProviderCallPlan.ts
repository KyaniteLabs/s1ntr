/**
 * One --max-provider-calls cap shared by every charged step of a reverse-mode generate:
 * the image-arc vision read, the first Create, and the single fit revision (Sol F10/G04).
 * Without an explicit cap each Create keeps its default of 2 attempts, as before.
 */
export const DEFAULT_CREATE_ATTEMPTS = 2;

export interface ReverseCallPlan {
  /** Attempts the first Create may use. */
  readonly createCap: number;
}

/** The vision read is one provider call; it comes out of the cap before the first Create. */
export function planReverseCalls(cap: number | undefined, visionCalls: number): ReverseCallPlan {
  if (cap === undefined) return { createCap: DEFAULT_CREATE_ATTEMPTS };
  if (!Number.isInteger(cap) || cap < 1) throw new Error('PROVIDER_CAP_INVALID: --max-provider-calls must be a positive integer');
  const left = cap - visionCalls;
  if (left < 1) throw new Error(`PROVIDER_CAP_EXHAUSTED: --max-provider-calls ${cap} is spent by the image read (${visionCalls}); raise the cap`);
  return { createCap: left };
}

/** Attempts left for the revision after the vision read and the first Create. Null = no revision may run. */
export function revisionCap(cap: number | undefined, visionCalls: number, createConsumed: number): number | null {
  if (cap === undefined) return DEFAULT_CREATE_ATTEMPTS;
  const left = cap - visionCalls - createConsumed;
  return left >= 1 ? left : null;
}
