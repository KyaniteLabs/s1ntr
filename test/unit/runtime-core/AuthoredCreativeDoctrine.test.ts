import { describe, expect, it } from 'vitest';
import { AuthoredCreativeDoctrineStore } from
  '../../../src/runtime-core/AuthoredCreativeDoctrine.js';

const digest = (char: string) => char.repeat(64);
const input = { version: 1, sourceReviewDigest: digest('a'), scope: ['visual'],
  principles: ['Depth cues precede decoration.'],
  promptContracts: ['Preserve coherent spatial hierarchy.'],
  vocabulary: ['occlusion', 'parallax'] };

describe('authored creative doctrine', () => {
  it('seals immutable versioned source-reviewed doctrine in its own namespace', () => {
    const store = new AuthoredCreativeDoctrineStore();
    const first = store.register(input);
    expect(first.record.namespace).toBe('authored-doctrine');
    expect(first.eventType).toBe('doctrine-input-changed');
    expect(first.learnedFindingEvent).toBe(false);
    expect(Object.isFrozen(first.record)).toBe(true);
    expect(store.read(first.record.doctrineDigest)).toEqual(first.record);
  });

  it('records a doctrine delta without mutating prior versions', () => {
    const store = new AuthoredCreativeDoctrineStore();
    const first = store.register(input);
    const second = store.register({ ...input, version: 2,
      principles: [...input.principles, 'Motion must preserve continuity.'] });
    expect(second.previousDoctrineDigest).toBe(first.record.doctrineDigest);
    expect(second.record.doctrineDigest).not.toBe(first.record.doctrineDigest);
    expect(store.read(first.record.doctrineDigest)?.version).toBe(1);
    expect(() => store.register({ ...input, version: 2,
      principles: ['silently rewritten same version'] }))
      .toThrow('AUTHORED_DOCTRINE_VERSION_REBOUND');
  });

  it('quarantines legacy semantic teaching bytes until classified', () => {
    const store = new AuthoredCreativeDoctrineStore();
    const bytes = Buffer.from('{"legacyScore":0.9}');
    const record = store.quarantineLegacy(bytes);
    expect(record.classification).toBe('quarantined');
    expect(Buffer.from(record.bytesBase64, 'base64')).toEqual(bytes);
    expect(store.list()).toEqual([]);
  });
});
