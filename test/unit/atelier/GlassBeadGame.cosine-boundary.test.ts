import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../../../src/atelier/GlassBeadGame.js';

// Regression: parked dashboard cosine value exceeded the mathematical bounds.
describe('glass bead cosine boundaries', () => {
  it('clamps parallel and antiparallel rounding at the endpoints', () => {
    expect(cosineSimilarity([1, 1, 1], [1, 1, 1])).toBe(1);
    expect(cosineSimilarity([1, 1, 1], [-1, -1, -1])).toBe(-1);
  });

  it('preserves orthogonal and zero-vector behavior', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
