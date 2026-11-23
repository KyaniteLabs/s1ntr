import type {
  LiminalEffectKind,
  LiminalEffectReservation,
  LiminalOperationJournal,
} from './LiminalCommandService.js';

const AMBIGUOUS_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);
const AMBIGUOUS_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);
const AMBIGUOUS_MESSAGE = /\btime[sd]? ?out\b|\btimeout\b|\baborted\b|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE/i;

/**
 * Whether a failed effect may still have committed on the far side (#1323).
 * A timeout, abort or dropped connection means the provider may have done the
 * work and billed for it, so the outcome is UNKNOWN, not FAILED. Anything else
 * is a definite failure that is safe to retry.
 */
function classifyRenderFailure(error: unknown): 'failed' | 'ambiguous' {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (AMBIGUOUS_ERROR_NAMES.has(error.name)) return 'ambiguous';
    if (typeof code === 'string' && AMBIGUOUS_ERROR_CODES.has(code)) return 'ambiguous';
    if (error.cause !== undefined && error.cause !== error
      && classifyRenderFailure(error.cause) === 'ambiguous') return 'ambiguous';
    return AMBIGUOUS_MESSAGE.test(error.message) ? 'ambiguous' : 'failed';
  }
  return typeof error === 'string' && AMBIGUOUS_MESSAGE.test(error) ? 'ambiguous' : 'failed';
}

/** Raised only where the runtime refused an attempt before dispatch. */
export class UnsentTransportError extends Error {}

export function classifyEffectFailure(error: unknown): 'unsent' | 'ambiguous' {
  return error instanceof UnsentTransportError ? 'unsent' : 'ambiguous';
}

/**
 * A void effect (e.g. a daemon cycle) is journaled as this marker: JSON cannot store undefined, and a stored
 * null would read back as "not completed" and be re-reserved on replay.
 */
const VOID_RESULT = Object.freeze({ $type: 'sinter.void-effect-result.v1' });
const isVoidResult = (value: unknown): boolean =>
  typeof value === 'object' && value !== null
  && (value as { $type?: unknown }).$type === VOID_RESULT.$type;

/** The sole invoker boundary for privileged product effects. */
export class LiminalEffectBroker {
  constructor(private readonly journal: LiminalOperationJournal) {}

  async invoke<T>(input: {
    operationId: string;
    kind: LiminalEffectKind;
    authority: unknown;
    replayOnly?: boolean;
    effect: (reservation: LiminalEffectReservation) => Promise<T>;
  }): Promise<T> {
    const completed = await this.journal.completedEffect<T>(input.operationId, input.kind);
    if (completed !== null) return (isVoidResult(completed) ? undefined : completed) as T;
    if (input.replayOnly) throw new Error('LOOP_REPLAY_EFFECT_MISSING');
    const reservation = await this.journal.reserveEffect(
      input.operationId, input.kind, input.authority,
    );
    await this.journal.startEffect(reservation);
    const before = input.kind === 'render' ? 0 : await this.journal.attemptsConsumed(input.operationId);
    let result: T;
    try {
      result = await input.effect(reservation);
    } catch (error) {
      // An ambiguous outcome blocks re-reservation; only a definite failure retries.
      const outcome = input.kind === 'render' ? classifyRenderFailure(error)
        : classifyEffectFailure(error) === 'unsent' && await this.journal.attemptsConsumed(input.operationId) === before
          ? 'unsent' : 'ambiguous';
      await this.journal.finishEffect(reservation, outcome, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    // A persistence failure leaves the effect started: replay must not invoke it twice.
    await this.journal.completeEffect(reservation, result === undefined ? VOID_RESULT : result);
    return result;
  }
}
