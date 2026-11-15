import { describe, it, expect } from 'vitest';
import { isHonestFitnessScore, isEvaluationDegraded } from '../../../src/core/fitnessHonesty.js';

describe('isEvaluationDegraded (canonical gate/CLI/ledger predicate)', () => {
  it('flags zero confidence regardless of failure class', () => {
    expect(isEvaluationDegraded(0, 'none')).toBe(true);
    expect(isEvaluationDegraded(0, 'scorer')).toBe(true);
  });

  it('flags scorer/infra/parse even with positive confidence', () => {
    expect(isEvaluationDegraded(0.9, 'scorer')).toBe(true);
    expect(isEvaluationDegraded(1, 'infra')).toBe(true);
    expect(isEvaluationDegraded(1, 'parse')).toBe(true);
  });

  it('does not flag clean none/render with positive confidence', () => {
    expect(isEvaluationDegraded(1, 'none')).toBe(false);
    expect(isEvaluationDegraded(0.5, 'render')).toBe(false);
    expect(isEvaluationDegraded(undefined, undefined)).toBe(false);
  });

  it('does not treat validator/legacy as evaluation-degraded for stop/emit (banking uses isHonestFitnessScore)', () => {
    expect(isEvaluationDegraded(1, 'validator')).toBe(false);
    expect(isEvaluationDegraded(1, 'legacy')).toBe(false);
  });
});

describe('isHonestFitnessScore', () => {
  it('accepts a clean evaluator score (none, positive confidence)', () => {
    expect(isHonestFitnessScore(1, 'none')).toBe(true);
  });

  it('accepts a render-measured score (deterministic luminance is a real signal)', () => {
    expect(isHonestFitnessScore(0.8, 'render')).toBe(true);
  });

  it('rejects a scorer-failure fallback even with a high nominal score', () => {
    expect(isHonestFitnessScore(0, 'scorer')).toBe(false);
  });

  it('rejects an infra-failure fallback', () => {
    expect(isHonestFitnessScore(0, 'infra')).toBe(false);
  });

  it('rejects a validator failure (broken artifact must not be an exemplar)', () => {
    expect(isHonestFitnessScore(1, 'validator')).toBe(false);
  });

  it('rejects a legacy heuristic score — displays but is never banked as an exemplar', () => {
    expect(isHonestFitnessScore(1, 'legacy')).toBe(false);
  });

  it('rejects a legacy heuristic score even when confidence is undefined (audio/legacy-eval path)', () => {
    expect(isHonestFitnessScore(undefined, 'legacy')).toBe(false);
  });

  it('rejects any class when confidence is zero', () => {
    expect(isHonestFitnessScore(0, 'none')).toBe(false);
    expect(isHonestFitnessScore(0, 'render')).toBe(false);
  });

  it('defaults undefined confidence/failureClass to honest (legacy clean-eval path)', () => {
    expect(isHonestFitnessScore(undefined, undefined)).toBe(true);
  });

  it('treats undefined confidence as confident but still rejects a degraded class', () => {
    expect(isHonestFitnessScore(undefined, 'scorer')).toBe(false);
  });
});
