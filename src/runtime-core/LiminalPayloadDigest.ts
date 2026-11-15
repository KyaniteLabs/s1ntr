import { createHash } from 'node:crypto';

export const LIMINAL_BUFFER_TAG = 'sinter.buffer.v1';

export function encodeLiminalDurableValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { $type: LIMINAL_BUFFER_TAG, base64: value.toString('base64') };
  }
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(encodeLiminalDurableValue);
  if (value && typeof value === 'object') {
    const encoded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const child = encodeLiminalDurableValue(item);
      if (key === '__proto__') {
        Object.defineProperty(encoded, key, { value: child, enumerable: true,
          configurable: true, writable: true });
      } else {
        encoded[key] = child;
      }
    }
    return encoded;
  }
  return value;
}

export function liminalDurablePayloadDigest(value: unknown): string {
  return createHash('sha256').update(
    JSON.stringify(encodeLiminalDurableValue(value)),
  ).digest('hex');
}
