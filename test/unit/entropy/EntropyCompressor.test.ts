import { describe, it, expect } from 'vitest';
import { EntropyCompressor, SEED_HEX_DIGITS } from '../../../src/entropy/EntropyCompressor.js';

describe('EntropyCompressor', () => {
  it('produces deterministic seed for identical input', () => {
    const compressor = new EntropyCompressor();
    const r1 = compressor.compress('hello world');
    const r2 = compressor.compress('hello world');
    expect(r1.seed).toBe(r2.seed);
    expect(r1.phrase).toBe(r2.phrase);
    expect(r1.hashChain).toEqual(r2.hashChain);
  });

  it('produces divergent seeds for different inputs', () => {
    const compressor = new EntropyCompressor();
    const r1 = compressor.compress('hello world');
    const r2 = compressor.compress('goodbye world');
    expect(r1.seed).not.toBe(r2.seed);
  });

  it('returns exactly 4 hashes in the chain with default rounds', () => {
    const compressor = new EntropyCompressor();
    const r = compressor.compress('test');
    expect(r.hashChain.length).toBe(4);
  });

  it('returns a 64-char hex string for each hash', () => {
    const compressor = new EntropyCompressor();
    const r = compressor.compress('test');
    for (const hash of r.hashChain) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns a four-word phrase', () => {
    const compressor = new EntropyCompressor();
    const r = compressor.compress('test');
    expect(r.phrase).toMatch(/^(\w+ ){3}\w+$/);
    expect(r.phrase.split(' ').length).toBe(4);
  });

  it('throws for non-positive rounds (0)', () => {
    const compressor = new EntropyCompressor();
    expect(() => compressor.compress('test', 0)).toThrow('rounds must be a positive integer');
  });

  it('throws for non-positive rounds (-1)', () => {
    const compressor = new EntropyCompressor();
    expect(() => compressor.compress('test', -1)).toThrow('rounds must be a positive integer');
  });

  it('returns exactly the requested number of hashes', () => {
    const compressor = new EntropyCompressor();
    const r = compressor.compress('test', 2);
    expect(r.hashChain.length).toBe(2);
  });

  it('handles empty string input', () => {
    const compressor = new EntropyCompressor();
    expect(() => compressor.compress('')).not.toThrow();
    const r = compressor.compress('');
    expect(r.hashChain.length).toBe(4);
    expect(Number.isFinite(r.seed)).toBe(true);
  });

  it('returns a finite seed', () => {
    const compressor = new EntropyCompressor();
    const r = compressor.compress('test');
    expect(Number.isFinite(r.seed)).toBe(true);
  });

  describe('seed precision (#1287)', () => {
    const inputs = Array.from({ length: 64 }, (_, i) => `sample-input-${i}`);

    it('seed is an exact safe integer equal to its hex digits', () => {
      const c = new EntropyCompressor();
      for (const input of inputs) {
        const r = c.compress(input);
        expect(Number.isSafeInteger(r.seed)).toBe(true);
        expect(r.seedHex).toBe(r.hashChain[r.hashChain.length - 1].slice(0, SEED_HEX_DIGITS));
        expect(r.seed.toString(16).padStart(SEED_HEX_DIGITS, '0')).toBe(r.seedHex);
      }
    });

    it('seed low bits carry entropy (both parities appear)', () => {
      // A 64-bit value rounded to a double has its low bits zeroed, so every
      // old seed was even. Downstream code branches on seed % 2.
      const c = new EntropyCompressor();
      const parities = new Set(inputs.map(input => c.compress(input).seed % 2));
      expect([...parities].sort()).toEqual([0, 1]);
    });

    it('rejects invalid rounds before producing a seed', () => {
      expect(() => new EntropyCompressor().compress('x', 0)).toThrow('rounds must be a positive integer');
    });
  });

  it('derives an exactly representable seed from the final hash (#1288)', () => {
    const r = new EntropyCompressor().compress('metabolic input');
    expect(Number.isSafeInteger(r.seed)).toBe(true);
    expect(r.seed).toBe(parseInt(r.hashChain[r.hashChain.length - 1].slice(0, 13), 16));
  });
});
