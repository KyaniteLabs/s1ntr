import { describe, expect, it } from 'vitest';
import { providerRequestDigest } from '../../../src/llm/ProviderRequestDigest.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

const base: ProviderRequest = { systemPrompt: 'sys', userPrompt: 'user' };

describe('providerRequestDigest', () => {
  it('is a 64-char sha256 hex string and deterministic', () => {
    const d = providerRequestDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(providerRequestDigest({ ...base })).toBe(d);
  });

  it.each([
    ['systemPrompt', { systemPrompt: 'sys2' }],
    ['userPrompt', { userPrompt: 'user2' }],
    ['temperature', { temperature: 0.5 }],
    ['maxTokens', { maxTokens: 100 }],
    ['jsonMode', { jsonMode: true }],
  ] as const)('changes when %s changes', (_name, patch) => {
    expect(providerRequestDigest({ ...base, ...patch })).not.toBe(providerRequestDigest(base));
  });

  it('treats an unset optional field and its explicit default identically', () => {
    expect(providerRequestDigest({ ...base, jsonMode: false })).toBe(providerRequestDigest(base));
  });

  it('digests image bytes, so different images differ and the same image matches', () => {
    const img = (data: string): ProviderRequest => ({
      ...base, imageInputs: [{ mimeType: 'image/png', dataBase64: data }],
    });
    expect(providerRequestDigest(img('AAAA'))).not.toBe(providerRequestDigest(img('BBBB')));
    expect(providerRequestDigest(img('AAAA'))).toBe(providerRequestDigest(img('AAAA')));
    expect(providerRequestDigest(img('AAAA'))).not.toBe(providerRequestDigest(base));
  });

  it('ignores the abort signal, which cannot affect model output', () => {
    expect(providerRequestDigest({ ...base, signal: new AbortController().signal })).toBe(providerRequestDigest(base));
  });
});
