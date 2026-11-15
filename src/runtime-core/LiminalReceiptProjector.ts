import { createHash } from 'node:crypto';
import type {
  LiminalAuthorityReceipt,
  LiminalOperationEvent,
  LiminalOperationJournal,
  LiminalReceiptAuthority,
} from './LiminalCommandService.js';

function traceDigest(events: readonly LiminalOperationEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events.map(event => ({
    operationId: event.operationId, ordinal: event.ordinal,
    type: event.type, payloadDigest: event.payloadDigest,
  })))).digest('hex');
}

export function rebuildOperationTrace(events: readonly LiminalOperationEvent[]): string {
  if (events.length === 0 || events[0]?.type !== 'command-accepted') {
    throw new Error('OPERATION_TRACE_INCOMPLETE');
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.ordinal <= events[index - 1]!.ordinal) {
      throw new Error('OPERATION_TRACE_ORDINAL_INVALID');
    }
  }
  const types = events.map(event => event.type);
  const required = ['domain-authorized', 'effect-reserved', 'effect-started',
    'effect-result', 'domain-decided', 'evaluation-decided'] as const;
  if (required.some(type => !types.includes(type))
    || types.filter(type => type === 'effect-started').length
      !== types.filter(type => type === 'effect-result').length
    || types.includes('receipt-projected')) {
    throw new Error('OPERATION_TRACE_INCOMPLETE');
  }
  return traceDigest(events);
}

/** The only component allowed to sign a complete operation root. */
export class LiminalReceiptProjector {
  constructor(private readonly journal: LiminalOperationJournal,
    private readonly authority: LiminalReceiptAuthority) {}

  async project(input: Omit<LiminalAuthorityReceipt, 'schema' | 'schemaVersion'
  | 'authorityTier' | 'authorityKeyDigest' | 'operationTraceDigest' | 'signature'>) {
    const events = await this.journal.eventsForOperation(input.operationId);
    const operationTraceDigest = rebuildOperationTrace(events);
    return this.authority.project({ ...input, operationTraceDigest });
  }
}
