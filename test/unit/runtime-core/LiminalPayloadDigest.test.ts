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
