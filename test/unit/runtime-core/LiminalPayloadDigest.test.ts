import { describe, expect, it } from 'vitest';
import { encodeLiminalDurableValue,
  liminalDurablePayloadDigest } from '../../../src/runtime-core/LiminalPayloadDigest.js';

describe('durable payload encoding', () => {
  it('preserves the versioned Buffer and digest contract without prototype mutation', () => {
    const value = JSON.parse('{"__proto__":{"polluted":"no"},"nested":[{"x":1},null]}') as {
      nested: unknown[]; date?: Date; omitted?: undefined;
    };
    value.nested[1] = Buffer.from([0, 1, 255]);
    value.date = new Date('2026-01-01T00:00:00.000Z');
    value.omitted = undefined;

    expect(JSON.stringify(encodeLiminalDurableValue(value))).toBe(
      '{"__proto__":{"polluted":"no"},"nested":[{"x":1},{"$type":"sinter.buffer.v1","base64":"AAH/"}],"date":"2026-01-01T00:00:00.000Z"}',
    );
    expect(liminalDurablePayloadDigest(value)).toBe(
      'a82c891f41f2d7fd1171e13d0fc1cc804032b6703ea3a9fb53610aa6f378652a',
    );
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });
});

describe('void effect results', () => {
  it('digests undefined like null instead of throwing (a cycle effect that returns nothing must journal)', () => {
    expect(() => liminalDurablePayloadDigest(undefined)).not.toThrow();
    expect(liminalDurablePayloadDigest(undefined)).toBe(liminalDurablePayloadDigest(null));
    expect(liminalDurablePayloadDigest(undefined)).toMatch(/^[0-9a-f]{64}$/);
    expect(liminalDurablePayloadDigest('x')).not.toBe(liminalDurablePayloadDigest(undefined));
    expect(liminalDurablePayloadDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(liminalDurablePayloadDigest(0)).not.toBe(liminalDurablePayloadDigest(undefined));
  });
});
