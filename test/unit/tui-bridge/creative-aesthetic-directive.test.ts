import { describe, expect, it } from 'vitest';
import { aestheticDirective, promptForCreativeDomain, scoreContentAdherence } from '../../../src/tui-bridge/CreativeIntentHelpers.js';
import { Domain } from '../../../src/types/domains.js';

describe('scoreContentAdherence', () => {
  it('scores the fraction of concrete request words present in the artifact', () => {
    // request words ≥4 letters, non-generic: "three", "rotating", "rings", "teal"
    const code = '// three rotating rings\nfunction draw(){ /* rings */ }';
    // 3 of 4 present (no "teal") → 0.75
    expect(scoreContentAdherence(code, 'three rotating rings in teal')).toBeCloseTo(0.75, 5);
  });

  it('rewards a more adherent artifact over a less adherent one', () => {
    const adherent = '// a calm forest of tall pines';
    const offPrompt = '// an unrelated grid of squares';
    expect(scoreContentAdherence(adherent, 'a calm forest of pines'))
      .toBeGreaterThan(scoreContentAdherence(offPrompt, 'a calm forest of pines'));
  });

  it('returns neutral 1 when the request has no concrete words to check', () => {
    expect(scoreContentAdherence('anything', 'make it')).toBe(1);
  });

  it('ignores generic verbs and short words', () => {
    // "create"/"with" are stopwords; "waves" is the only concrete token
    expect(scoreContentAdherence('// ocean waves', 'create waves')).toBe(1);
    expect(scoreContentAdherence('// ocean swell', 'create waves')).toBe(0);
  });
});

/**
 * The draft prompt now carries a concise aesthetic bar so terse requests still
 * produce a strong image instead of a bland default. These tests pin the bar's
 * content per domain bucket AND prove it never displaces the technical
 * "return raw code" contract (adherence) or the user's own words.
 */
describe('aestheticDirective', () => {
  it('gives rich visual domains a composition/contrast/depth bar', () => {
    for (const domain of [Domain.GLSL, Domain.SHADER, Domain.THREE, Domain.P5, Domain.HYDRA]) {
      const directive = aestheticDirective(domain);
      expect(directive).toContain('Quality bar');
      expect(directive).toContain('contrast');
      expect(directive).toContain('depth');
      expect(directive).toContain('Honor every concrete detail named in the request.');
    }
  });

  it('gives text-art domains a bar without the color/depth language', () => {
    const directive = aestheticDirective(Domain.ASCII);
    expect(directive).toContain('Quality bar');
    expect(directive).toContain('composition');
    expect(directive).not.toContain('palette');
  });

  it('gives audio domains a musical bar, not a visual one', () => {
    const directive = aestheticDirective(Domain.STRUDEL);
    expect(directive).toContain('musical');
    expect(directive).not.toContain('palette');
  });

  it('returns nothing for domains without a defined bar', () => {
  });
});

describe('promptForCreativeDomain aesthetic integration', () => {
  it('adds the aesthetic bar while keeping the raw-code contract and the user text', () => {
    const prompt = promptForCreativeDomain('a glowing plasma shader, magenta and gold', Domain.GLSL, false);
    expect(prompt).toContain('a glowing plasma shader, magenta and gold');
    expect(prompt).toContain('Quality bar');
    // Adherence contract must survive — the model is still told exactly what to return.
    expect(prompt).toContain('Return raw GLSL fragment shader code only');
    expect(prompt).toContain('Target creative domain: glsl.');
  });

  it('omits the aesthetic bar for a domain that has none, without losing the contract', () => {
    const prompt = promptForCreativeDomain('a 20-second product reveal', Domain.GENERIC, false);
    expect(prompt).not.toContain('Quality bar');
    expect(prompt).toContain('Target creative domain: generic.');
  });
});
