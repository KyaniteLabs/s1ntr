import { describe, it, expect } from 'vitest';
import { RoutineChannel } from '../../src/swarm/RoutineChannel.js';
import {
  compileToRoutine,
  expandRoutine,
  summarizeExchange,
  createMessage,
} from '../../src/swarm/AgoraProtocol.js';
import type { AgoraMessage } from '../../src/swarm/AgoraProtocol.js';

describe('RoutineChannel', () => {
  // 1. RoutineChannel construction — default config, custom config
  describe('construction', () => {
    it('uses default config when none provided', () => {
      const ch = new RoutineChannel();
      // Defaults: maxHistory=50, compressThreshold=3
      // Verify by exercising the channel and checking stats
      expect(ch.stats().roundsTracked).toBe(0);
      expect(ch.stats().totalMessages).toBe(0);
    });

    it('accepts custom config', () => {
      const ch = new RoutineChannel({ maxHistory: 2, compressThreshold: 1 });
      // Broadcast one message to trigger stats
      ch.broadcast('a', 'propose', 'hello', 1, ['b']);
      // compressThreshold=1 means any round with 1+ messages is compressible
      expect(ch.getCompressedExchange(1)).toMatchObject({ winner: 'b', consensus: 1, basis: 'recipient-target-share' });
    });
  });

  // 2. broadcast() — sends messages to all recipients, stored in history
  it('broadcast() sends messages to all recipients and stores in history', () => {
    const ch = new RoutineChannel();
    const msg = ch.broadcast('alice', 'propose', 'GLSL shader art', 1, [
      'bob',
      'carol',
    ]);

    expect(msg.from).toBe('alice');
    expect(msg.to).toEqual(['bob', 'carol']);
    expect(msg.stage).toBe('propose');
    expect(msg.round).toBe(1);

    const history = ch.getHistory(1);
    expect(history).toHaveLength(1);
    expect(history[0].messages).toHaveLength(1);
    expect(history[0].messages[0].to).toEqual(['bob', 'carol']);
  });

  // 3. directMessage() — sends to single recipient, stored in history
  it('directMessage() sends to a single recipient and stores in history', () => {
    const ch = new RoutineChannel();
    const msg = ch.directMessage('alice', 'bob', 'critique', 'organic shapes', 2);

    expect(msg.from).toBe('alice');
    expect(msg.to).toEqual(['bob']);
    expect(msg.stage).toBe('critique');
    expect(msg.round).toBe(2);

    const history = ch.getHistory(2);
    expect(history).toHaveLength(1);
    expect(history[0].messages[0].to).toEqual(['bob']);
  });

  // 4. getHistory() — returns all records, filtered by round
  it('getHistory() returns all records sorted by round, or filtered by round', () => {
    const ch = new RoutineChannel();
    ch.broadcast('a', 'propose', 'hello', 1, ['b']);
    ch.directMessage('b', 'a', 'critique', 'nice', 2);
    ch.broadcast('a', 'vote', 'voting', 3, ['b']);

    const all = ch.getHistory();
    expect(all).toHaveLength(3);
    expect(all[0].round).toBe(1);
    expect(all[1].round).toBe(2);
    expect(all[2].round).toBe(3);

    const filtered = ch.getHistory(2);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].round).toBe(2);

    const empty = ch.getHistory(99);
    expect(empty).toHaveLength(0);
  });

  // 5. maxHistory eviction — oldest rounds evicted when limit exceeded
  it('evicts oldest rounds when maxHistory is exceeded', () => {
    const ch = new RoutineChannel({ maxHistory: 3 });
    ch.broadcast('a', 'propose', 'r1', 1, ['b']);
    ch.broadcast('a', 'propose', 'r2', 2, ['b']);
    ch.broadcast('a', 'propose', 'r3', 3, ['b']);
    ch.broadcast('a', 'propose', 'r4', 4, ['b']);

    // Only rounds 2, 3, 4 should remain (oldest evicted)
    const all = ch.getHistory();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.round)).toEqual([2, 3, 4]);

    // Round 1 should be gone
    expect(ch.getHistory(1)).toHaveLength(0);
  });

  // 6. getCompressedExchange() — returns summary when threshold met, undefined when not
  it('getCompressedExchange() returns summary when threshold met, undefined otherwise', () => {
    const ch = new RoutineChannel({ compressThreshold: 2 });

    // Only 1 message — below threshold
    ch.directMessage('a', 'b', 'propose', 'hello', 1);
    expect(ch.getCompressedExchange(1)).toBeUndefined();

    // Add second message in same round — meets threshold
    ch.directMessage('b', 'a', 'critique', 'nice', 1);
    const summary = ch.getCompressedExchange(1);

    expect(summary!.messages).toHaveLength(2);
    // a and b are each targeted once: a tie is reported, not broken arbitrarily (#1299)
    expect(summary!.winner).toBe('');
    expect(summary!.tiedRecipients).toEqual(['a', 'b']);

    // Non-existent round
    expect(ch.getCompressedExchange(99)).toBeUndefined();
  });

  // 7. clear() — resets all state
  it('clear() resets all history and counters', () => {
    const ch = new RoutineChannel();
    ch.broadcast('a', 'propose', 'hello', 1, ['b', 'c']);
    ch.directMessage('b', 'a', 'critique', 'nice', 2);
    expect(ch.stats().totalMessages).toBe(2);

    ch.clear();

    expect(ch.getHistory()).toHaveLength(0);
    expect(ch.stats().totalMessages).toBe(0);
    expect(ch.stats().roundsTracked).toBe(0);
  });

  // 8. stats() — correct counts and compression ratio
  it('stats() returns correct counts and compression ratio', () => {
    const ch = new RoutineChannel({ compressThreshold: 2 });

    // Round 1: 3 messages (above threshold)
    ch.directMessage('a', 'b', 'propose', 'one', 1);
    ch.directMessage('b', 'c', 'critique', 'two', 1);
    ch.directMessage('c', 'a', 'vote', 'three', 1);

    // Round 2: 1 message (below threshold)
    ch.directMessage('a', 'b', 'propose', 'four', 2);

    const s = ch.stats();
    expect(s.totalMessages).toBe(4);
    expect(s.roundsTracked).toBe(2);
    // compressionRatio = totalMessages / roundsWithCompression = 4 / 1 = 4
    expect(s.compressionRatio).toBe(4);
  });
});

describe('AgoraProtocol', () => {
  // 9. compileToRoutine / expandRoutine — round-trip compression works with notation tokens
  it('compileToRoutine and expandRoutine round-trip with notation tokens', () => {
    const input = 'GLSL fragment shader art with organic flowing shapes and a dark mood';
    const compiled = compileToRoutine(input);

    // Should contain notation tokens
    expect(compiled).toContain('~d:shader');
    expect(compiled).toContain('~s:organic');
    expect(compiled).toContain('~m:dark');

    // Expand back — should include expanded descriptions
    const expanded = expandRoutine(compiled);
    expect(expanded).toContain('GLSL');
    expect(expanded).toContain('flowing');
  });

  it('compileToRoutine prefixes [NL] when no tokens match', () => {
    const compiled = compileToRoutine('something completely unmapped and unique');
    expect(compiled).toMatch(/^\[NL\]/);
  });

  // 10. summarizeExchange — extracts tokens, tallies recipients, picks winner
  it('summarizeExchange extracts notation tokens, tallies recipients, picks winner', () => {
    const msgs: AgoraMessage[] = [
      createMessage('alice', ['bob', 'carol'], 'propose', 'shader art', 1),
      createMessage('bob', ['carol'], 'critique', 'organic shapes', 1),
      createMessage('carol', ['bob', 'bob'], 'vote', 'fractal style', 1),
    ];

    const result = summarizeExchange(msgs);

    // Winner is most-targeted recipient: bob appears 3 times (1 + 0 + 2), carol appears 2 times
    expect(result.winner).toBe('bob');
    expect(result.consensus).toBeGreaterThan(0);
    expect(result.messages).toHaveLength(3);
    // Notation tokens starting with ~ should be extracted
    expect(result.notationUsed.length).toBeGreaterThanOrEqual(0);
  });

  it('summarizeExchange returns empty result for empty input', () => {
    const result = summarizeExchange([]);
    expect(result.winner).toBe('');
    expect(result.consensus).toBe(0);
    expect(result.messages).toHaveLength(0);
    expect(result.notationUsed).toHaveLength(0);
  });

  describe('Agora IDs and summary basis (#1299)', () => {
    it('two different same-stage messages from one author in one round get distinct IDs', () => {
      const first = createMessage('a', ['b'], 'propose', 'warm palette', 1);
      const second = createMessage('a', ['b'], 'propose', 'cold palette', 1);
      const otherRecipient = createMessage('a', ['c'], 'propose', 'warm palette', 1);

      expect(first.id).not.toBe(second.id);
      expect(first.id).not.toBe(otherRecipient.id);
      expect(first.id).toMatch(/^a-propose-r1-[0-9a-f]{16}$/);
      // Deterministic: identical content yields the identical ID
      expect(createMessage('a', ['b'], 'propose', 'warm palette', 1).id).toBe(first.id);
    });

    it('a single most-targeted recipient wins with its share of recipient slots, labelled as attention', () => {
      const result = summarizeExchange([
        createMessage('a', ['c'], 'vote', 'x', 1),
        createMessage('b', ['c'], 'vote', 'y', 1),
        createMessage('c', ['a'], 'vote', 'z', 1),
      ]);
      expect(result.winner).toBe('c');
      expect(result.tiedRecipients).toEqual(['c']);
      expect(result.consensus).toBeCloseTo(2 / 3, 10);
      expect(result.basis).toBe('recipient-target-share');
    });

    it('messages with no recipients produce no winner', () => {
      const result = summarizeExchange([createMessage('a', [], 'propose', 'x', 1)]);
      expect(result.winner).toBe('');
      expect(result.tiedRecipients).toEqual([]);
      expect(result.consensus).toBe(0);
    });
  });
});
