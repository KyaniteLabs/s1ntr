import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OwnerReactionCausality,
  OwnerReactionError,
} from '../../../src/runtime-core/OwnerReactionCausality.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function boundAuthority(now = Date.parse('2026-07-31T12:00:00.000Z')) {
  const authority = new OwnerReactionCausality({
    now: () => now,
    nonce: () => 'owner-nonce-1234567890',
  });
  const session = authority.openSession('studio-session');
  authority.bindArtifact({
    ownerSessionId: session.ownerSessionId,
    nonce: session.nonce,
    artifactId: 'artifact-current',
    artifactDigest: SHA_A,
    lineageId: 'lineage-current',
    revision: 2,
    sourceFingerprint: SHA_B,
  });
  return { authority, session, now };
}

describe('OwnerReactionCausality', () => {
  it('binds an explicit local owner action to the exact current artifact', () => {
    const { authority, session, now } = boundAuthority();
    const receipt = authority.record({
      ownerSessionId: session.ownerSessionId,
      nonce: session.nonce,
      artifactId: 'artifact-current',
      action: 'pin',
      source: 'studio-ui',
      eventId: 'ui-event-1',
      occurredAt: new Date(now).toISOString(),
    });

    expect(receipt).toMatchObject({
      ownerSessionId: 'studio-session',
      artifactId: 'artifact-current',
      artifactDigest: SHA_A,
      lineageId: 'lineage-current',
      revision: 2,
      action: 'pin',
      source: 'studio-ui',
      eventId: 'ui-event-1',
      sourceFingerprint: SHA_B,
    });
    expect(receipt.reactionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['wrong nonce', { nonce: 'copied-nonce-1234567890' }],
    ['cross artifact', { artifactId: 'artifact-other' }],
    ['internal tool source', { source: 'internal-tool' }],
  ])('rejects %s', (_label, patch) => {
    const { authority, session, now } = boundAuthority();
    expect(() => authority.record({
      ownerSessionId: session.ownerSessionId,
      nonce: session.nonce,
      artifactId: 'artifact-current',
      action: 'pin',
      source: 'studio-ui',
      eventId: 'event-1',
      occurredAt: new Date(now).toISOString(),
      ...patch,
    } as never)).toThrow(OwnerReactionError);
  });

  it('rejects replay and expired sessions', () => {
    let now = Date.parse('2026-07-31T12:00:00.000Z');
    const authority = new OwnerReactionCausality({ now: () => now, nonce: () => 'owner-nonce-1234567890', ttlMs: 100 });
    const session = authority.openSession('studio-session');
    authority.bindArtifact({ ownerSessionId: session.ownerSessionId, nonce: session.nonce, artifactId: 'a', artifactDigest: SHA_A, lineageId: 'l', revision: 1, sourceFingerprint: SHA_B });
    const input = { ownerSessionId: session.ownerSessionId, nonce: session.nonce, artifactId: 'a', action: 'reject' as const, source: 'cli' as const, eventId: 'cli-1', occurredAt: new Date(now).toISOString() };
    const receipt = authority.record(input);
    expect(() => authority.record(input)).toThrow(/REPLAYED_EVENT/);
    now += 101;
    expect(() => authority.record({ ...input, eventId: 'cli-2', occurredAt: new Date(now).toISOString() })).toThrow(/SESSION_EXPIRED/);
    expect(() => authority.resolveNextCreateContext(session.ownerSessionId, receipt.reactionDigest)).toThrow(/SESSION_EXPIRED/);
  });

  it('makes pin and reject produce distinct immediate next-Create contexts', () => {
    const create = (action: 'pin' | 'reject') => {
      const { authority, session, now } = boundAuthority();
      const receipt = authority.record({ ownerSessionId: session.ownerSessionId, nonce: session.nonce, artifactId: 'artifact-current', action, source: 'studio-ui', eventId: `${action}-event`, occurredAt: new Date(now).toISOString() });
      return authority.resolveNextCreateContext(session.ownerSessionId, receipt.reactionDigest);
    };
    const pin = create('pin');
    const reject = create('reject');
    expect(pin.contextDigest).not.toBe(reject.contextDigest);
    expect(pin.hypothesis).not.toBe(reject.hypothesis);
  });

  it('persists exact owner causality for Studio restart and CLI inspection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-causality-'));
    const persistPath = path.join(root, 'organism', 'owner-reactions.json');
    const now = Date.parse('2026-07-31T12:00:00.000Z');
    try {
      const studio = new OwnerReactionCausality({ persistPath, now: () => now, nonce: () => 'persisted-nonce' });
      const session = studio.openSession('shared-session');
      studio.bindArtifact({ ownerSessionId: 'shared-session', nonce: session.nonce, artifactId: 'shared-artifact', artifactDigest: SHA_A, lineageId: 'shared-lineage', revision: 1, sourceFingerprint: SHA_B });
      studio.record({ ownerSessionId: 'shared-session', nonce: session.nonce, artifactId: 'shared-artifact', action: 'pin', source: 'studio-ui', eventId: 'studio-event', occurredAt: new Date(now).toISOString() });

      const cli = new OwnerReactionCausality({ persistPath, now: () => now });
      expect(cli.snapshot('shared-session')).toMatchObject({
        artifact: { artifactDigest: SHA_A, lineageId: 'shared-lineage', sourceFingerprint: SHA_B },
        reactions: [{ action: 'pin', source: 'studio-ui' }],
      });
      expect(cli.resolveNextCreateContext('shared-session', cli.snapshot('shared-session').reactions[0].reactionDigest).hypothesis).toContain(SHA_A);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
