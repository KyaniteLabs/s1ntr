/**
 * AgoraProtocol — Structured routine communication for creative agents.
 * Agents exchange creative instructions via compressed notation instead of
 * verbose natural language. Stages: propose, critique, vote, merge, refine.
 */
import { createHash } from 'node:crypto';
import { compressToNotation, expandNotation } from './CreativeNotation.js';

/** Stages of an Agora exchange. */
export type RoutineStage = 'propose' | 'critique' | 'vote' | 'merge' | 'refine';

/** A single message in the Agora protocol. */
export interface AgoraMessage {
  id: string;
  from: string;
  to: string[];
  stage: RoutineStage;
  notation: string;
  payload: string;
  round: number;
  timestamp: number;
}

/**
 * Summary result of a completed Agora exchange.
 *
 * NOT a consensus or vote outcome: `winner` is simply the recipient addressed
 * most often, and `consensus` is that recipient's share of all recipient
 * slots. It measures attention, not agreement. `tiedRecipients` lists every
 * recipient sharing the top count; when it has more than one entry, `winner`
 * is '' rather than an arbitrary pick.
 */
export interface AgoraResult {
  winner: string;
  consensus: number;
  basis: 'recipient-target-share';
  tiedRecipients: string[];
  messages: AgoraMessage[];
  notationUsed: string[];
}

/** Compress NL into routine notation. Prefixes [NL] if no tokens match. */
export function compileToRoutine(naturalLanguage: string): string {
  const notation = compressToNotation(naturalLanguage);
  return notation.length > 0 ? notation : `[NL] ${naturalLanguage}`;
}

/** Expand a compiled routine back to NL, stripping | stage | round:N suffix. */
export function expandRoutine(routine: string): string {
  const parts = routine.split('|').map((s) => s.trim());
  const notationPart = parts[0];
  const stageInfo = parts.slice(1).join(', ');
  const expanded = expandNotation(notationPart);
  return stageInfo ? `${expanded} (${stageInfo})` : expanded;
}

/**
 * Factory: compile content, generate deterministic ID, return full AgoraMessage.
 *
 * The ID includes a hash of the recipients and the full payload, so two
 * different messages from the same author in the same stage and round no
 * longer collide. Identical messages still share an ID, by design.
 */
export function createMessage(
  from: string,
  to: string[],
  stage: RoutineStage,
  content: string,
  round: number,
): AgoraMessage {
  const digest = createHash('sha256')
    .update(JSON.stringify([from, [...to], stage, round, content]))
    .digest('hex')
    .slice(0, 16);
  const id = `${from}-${stage}-r${round}-${digest}`;
  return {
    id,
    from,
    to,
    stage,
    notation: compileToRoutine(content),
    payload: content,
    round,
    timestamp: Date.now(),
  };
}

/**
 * Summarize a completed Agora exchange. Counts per stage, extracts unique
 * notation tokens, picks winner (most-targeted recipient), computes consensus.
 */
export function summarizeExchange(messages: AgoraMessage[]): AgoraResult {
  if (messages.length === 0) {
    return { winner: '', consensus: 0, basis: 'recipient-target-share', tiedRecipients: [], messages: [], notationUsed: [] };
  }

  // Collect unique notation tokens from all messages
  const notationUsed = [...new Set(
    messages.flatMap((m) => m.notation.split(/\s+/).filter((t) => t.startsWith('~'))),
  )];

  // Tally how often each agent is targeted as a recipient
  const targetCounts = new Map<string, number>();
  for (const msg of messages) {
    for (const recipient of msg.to) {
      targetCounts.set(recipient, (targetCounts.get(recipient) ?? 0) + 1);
    }
  }

  // Most-targeted recipient(s). A tie is reported, never broken by Map order.
  const maxCount = Math.max(0, ...targetCounts.values());
  const tiedRecipients = maxCount > 0
    ? [...targetCounts].filter(([, count]) => count === maxCount).map(([agent]) => agent).sort()
    : [];
  const winner = tiedRecipients.length === 1 ? tiedRecipients[0] : '';

  // Share of all recipient slots that went to the top recipient (attention, not agreement)
  const totalTargets = messages.reduce((sum, m) => sum + m.to.length, 0);
  const consensus = winner && totalTargets > 0 ? maxCount / totalTargets : 0;

  return { winner, consensus, basis: 'recipient-target-share', tiedRecipients, messages, notationUsed };
}
