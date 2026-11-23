import { describe, expect, it } from 'vitest';
import {
  formatDegradedWhy,
  formatGovernedHeadline,
  governedExitCode,
  NOT_ACCEPTED_EXIT_CODE,
  formatScoreLine,
  isDegradedResult,
  isEmptySkeleton,
  type GenerateExitInput,
} from '../../src/cli/generateExitDecision.js';

// A complete, healthy, usable run (the exit-0 baseline). Individual cases
// override only the fields under test so each assertion is unambiguous.
const usableComplete: GenerateExitInput = {
  code: 'function setup() {}',
  completed: true,
  finalScore: 0.8,
};

describe('isEmptySkeleton (CLI generate exit-1 guard, Fault #7)', () => {
  it('empty string code → empty skeleton (exit 1)', () => {
    expect(isEmptySkeleton({ ...usableComplete, code: '' })).toBe(true);
  });

  it('whitespace-only code → empty skeleton (exit 1)', () => {
    expect(isEmptySkeleton({ ...usableComplete, code: '   \n\t  ' })).toBe(true);
  });

  it('usable code + completed + finalScore > 0 → not empty (exit 0)', () => {
    expect(isEmptySkeleton({ ...usableComplete, finalScore: 0.8 })).toBe(false);
  });

  it('usable code + NOT completed + NOT degraded + finalScore === 0 → empty skeleton (Fault #7, exit 1)', () => {
    expect(
      isEmptySkeleton({ ...usableComplete, completed: false, finalScore: 0 }),
    ).toBe(true);
  });

  it('usable code + NOT completed + finalScore === 0 but DEGRADED via evaluationConfidence <= 0 → not empty (exit 0)', () => {
    expect(
      isEmptySkeleton({
        ...usableComplete,
        completed: false,
        finalScore: 0,
        evaluationConfidence: 0,
      }),
    ).toBe(false);
  });

  it("usable code + NOT completed + finalScore === 0 but DEGRADED via failureClass 'scorer' → not empty (exit 0)", () => {
    expect(
      isEmptySkeleton({
        ...usableComplete,
        completed: false,
        finalScore: 0,
        evaluationFailureClass: 'scorer',
      }),
    ).toBe(false);
  });

  it("usable code + NOT completed + finalScore === 0 but DEGRADED via failureClass 'infra' → not empty (exit 0)", () => {
    expect(
      isEmptySkeleton({
        ...usableComplete,
        completed: false,
        finalScore: 0,
        evaluationFailureClass: 'infra',
      }),
    ).toBe(false);
  });

  it('NOT completed but finalScore > 0 (healthy evaluator) → not empty (exit 0)', () => {
    expect(
      isEmptySkeleton({ ...usableComplete, completed: false, finalScore: 0.5 }),
    ).toBe(false);
  });

  it('empty code overrides everything: degraded + completed cannot rescue empty code (exit 1)', () => {
    expect(
      isEmptySkeleton({
        code: '',
        completed: true,
        finalScore: 0.9,
        evaluationFailureClass: 'infra',
      }),
    ).toBe(true);
  });
});

describe('isDegradedResult (degraded-evaluator triggers)', () => {
  it('evaluationConfidence === 0 → degraded', () => {
    expect(isDegradedResult({ ...usableComplete, evaluationConfidence: 0 })).toBe(true);
  });

  it('evaluationConfidence < 0 → degraded', () => {
    expect(isDegradedResult({ ...usableComplete, evaluationConfidence: -1 })).toBe(true);
  });

  it("evaluationFailureClass 'scorer' → degraded", () => {
    expect(
      isDegradedResult({ ...usableComplete, evaluationFailureClass: 'scorer' }),
    ).toBe(true);
  });

  it("evaluationFailureClass 'infra' → degraded", () => {
    expect(
      isDegradedResult({ ...usableComplete, evaluationFailureClass: 'infra' }),
    ).toBe(true);
  });

  it("evaluationFailureClass 'parse' → degraded", () => {
    expect(
      isDegradedResult({ ...usableComplete, evaluationFailureClass: 'parse' }),
    ).toBe(true);
  });

  it('positive confidence and no failure class → not degraded', () => {
    expect(
      isDegradedResult({ ...usableComplete, evaluationConfidence: 1 }),
    ).toBe(false);
  });

  it('undefined evaluation fields → not degraded', () => {
    expect(isDegradedResult({ ...usableComplete })).toBe(false);
  });

  it("non-degraded failure class 'render' → not degraded", () => {
    expect(
      isDegradedResult({ ...usableComplete, evaluationFailureClass: 'render' }),
    ).toBe(false);
  });
});

describe('formatScoreLine (W1.1 honesty display contract)', () => {
  it("degraded via failureClass 'infra' → no number, 'unscored (judge could not score)' + suffix", () => {
    const line = formatScoreLine({
      ...usableComplete,
      finalScore: 0,
      evaluationConfidence: 0,
      evaluationFailureClass: 'infra',
    });
    expect(line).toBe(
      '⭐ Quality score: unscored (judge could not score) (failureClass=infra, confidence=0.00)',
    );
    // No fabricated numeric score anywhere on the line.
    expect(line).not.toMatch(/Quality score:\s*[\d.]/);
  });

  it("degraded via failureClass 'scorer' → no number + suffix fields", () => {
    const line = formatScoreLine({
      ...usableComplete,
      finalScore: 0,
      evaluationConfidence: 0,
      evaluationFailureClass: 'scorer',
    });
    expect(line).toBe(
      '⭐ Quality score: unscored (judge could not score) (failureClass=scorer, confidence=0.00)',
    );
    expect(line).not.toMatch(/Quality score:\s*[\d.]/);
  });

  it('degraded via confidence <= 0 with no failureClass → failureClass=unknown', () => {
    const line = formatScoreLine({
      ...usableComplete,
      finalScore: 0,
      evaluationConfidence: 0,
    });
    expect(line).toBe(
      '⭐ Quality score: unscored (judge could not score) (failureClass=unknown, confidence=0.00)',
    );
  });

  it('healthy → EXACT legacy numeric format (ledger parser depends on it)', () => {
    expect(
      formatScoreLine({ ...usableComplete, finalScore: 0.8, evaluationConfidence: 1 }),
    ).toBe('⭐ Quality score: 0.80');
  });

  it('healthy line never carries degradation provenance', () => {
    const line = formatScoreLine({ ...usableComplete, finalScore: 0.5 });
    expect(line).not.toContain('degraded');
    expect(line).not.toContain('failureClass=');
    expect(line).not.toContain('confidence=');
  });
});

describe('formatDegradedWhy (degraded runs say why)', () => {
  it('names rejection reasons, the first render error and the judge reasoning', () => {
    expect(formatDegradedWhy({
      rejectionReasons: ['rendered-evidence-failed', 'render-runtime-errors'],
      runtimeErrors: ['', 'canvas is not defined', 'Canvas not found'],
      reasoning: 'The screenshots are withheld,\n so the artwork cannot be evaluated.',
    })).toBe('🔎 Why: reasons=rendered-evidence-failed,render-runtime-errors | render error: canvas is not defined'
      + ' | judge: The screenshots are withheld, so the artwork cannot be evaluated.');
  });

  it('clips long text and returns null when nothing is known', () => {
    expect(formatDegradedWhy({ reasoning: 'x'.repeat(50) }, 10)).toBe(`🔎 Why: judge: ${'x'.repeat(9)}…`);
    expect(formatDegradedWhy({})).toBeNull();
    expect(formatDegradedWhy({ rejectionReasons: [], runtimeErrors: ['  '], reasoning: ' ' })).toBeNull();
  });
});

describe('formatGovernedHeadline', () => {
  it('prints a green complete only for an admitted piece with a healthy evaluator', () => {
    expect(formatGovernedHeadline({ admissionEligible: true, degraded: false, identityValid: true }))
      .toEqual(['✅ Generation complete!', '🎯 Reason: governed production Create completed']);
  });

  it('says not accepted and lists the rejection reasons when admission failed', () => {
    expect(formatGovernedHeadline({ admissionEligible: false, rejectionReasons: ['score-below-gate', 'blank-render'] }))
      .toEqual(['⚠️  Generated, but not accepted', '🎯 Reason: score-below-gate, blank-render']);
  });

  it('never prints complete for a degraded or identity-invalid evaluation, even if eligible', () => {
    expect(formatGovernedHeadline({ admissionEligible: true, degraded: true })[1])
      .toBe('🎯 Reason: the evaluator could not score it');
    expect(formatGovernedHeadline({ admissionEligible: true, identityValid: false })).toEqual(
      ['⚠️  Generated, but not accepted', '🎯 Reason: it did not pass the quality gate']);
  });
});

describe('governedExitCode', () => {
  it('exits 0 only for an admitted piece with a healthy evaluator', () => {
    expect(governedExitCode({ admissionEligible: true, degraded: false, identityValid: true })).toBe(0);
  });

  it('exits with the distinct not-accepted code whenever the headline says not accepted', () => {
    expect(NOT_ACCEPTED_EXIT_CODE).toBe(3);
    for (const input of [
      { admissionEligible: false, rejectionReasons: ['rendered-evidence-failed'] },
      { admissionEligible: true, degraded: true },
      { admissionEligible: true, identityValid: false },
    ]) {
      expect(governedExitCode(input)).toBe(NOT_ACCEPTED_EXIT_CODE);
      expect(formatGovernedHeadline(input)[0]).toContain('not accepted');
    }
  });
});
