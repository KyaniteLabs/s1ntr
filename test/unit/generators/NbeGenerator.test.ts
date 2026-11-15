import { describe, it, expect } from 'vitest';
import {
  NbeGenerator,
  type NbeGeneratorParams,
  type NbeWeightSet,
} from '../../../src/generators/nbe/NbeGenerator.js';
import { nbeConfidence } from '../../../src/generators/registerGenerators.js';

/**
 * Extract one of the embedded `var NAME = <json>;` constants from the rendered
 * document and parse it. Robust against JSON whitespace/formatting choices.
 */
function extractJson(code: string, name: 'CASCADE' | 'PALETTE' | 'INITIAL'): any {
  const match = code.match(new RegExp('var ' + name + ' = (.*?);\\s*var '));
  if (!match) throw new Error('embedded constant ' + name + ' not found');
  return JSON.parse(match[1]);
}
// NbeGenerator is a deterministic, self-contained renderer — no LLM client,
// harness, or config to mock. The "no template fallback" exemption it relies on
// is documented in the generator's own docstring; these tests pin the contract
// the meta-harness and screenshot capture depend on.

describe('NbeGenerator', () => {
  describe('generate', () => {
    it('returns a GeneratorResult with self-contained HTML', () => {
      const gen = new NbeGenerator();
      const result = gen.generate('a flowing neural bloom');

      expect(result.code).toContain('<!DOCTYPE html>');
      expect(result.code).toContain('</html>');
      expect(result.code).toContain('<canvas id="stage">');
      // Embedded cascade neural-field weights are present and non-empty.
      expect(result.code).toMatch(/var CASCADE = \[[^\]]+\]/);
      expect(result.code).toMatch(/var PALETTE = \{/);
      expect(result.code).toMatch(/var INITIAL = \{/);
      // No external resources — fully self-contained.
      expect(result.code).not.toMatch(/src=["']https?:/);
      expect(result.code).not.toMatch(/<link/i);
      expect(result.model).toBe('nbe-neural-field');
      expect(result.thinking).toMatch(/\S/);
    });

    it('emits the convergence signal contract after N steps', () => {
      const gen = new NbeGenerator();
      const { code } = gen.generate('bloom', { convergenceSteps: 42 });

      // The exact message screenshot capture waits on.
      expect(code).toContain("window.postMessage('nbe:converged', '*')");
      // The configured step count is embedded, not hardcoded.
      expect(code).toContain('var CONVERGENCE_STEPS = 42;');
      expect(code).not.toMatch(/var CONVERGENCE_STEPS = 600;/);
    });

    it('is deterministic: identical params produce identical output', () => {
      const gen = new NbeGenerator();
      const params: NbeGeneratorParams = {
        weights: 'magma',
        convergenceSteps: 100,
        initialParams: { damping: 0.9, seed: 7 },
      };
      const a = gen.generate('same prompt', params);
      const b = gen.generate('same prompt', params);
      expect(a.code).toBe(b.code);
      expect(a.model).toBe(b.model);
    });

    it('accepts each named weight preset', () => {
      const gen = new NbeGenerator();
      const ids = ['aurora', 'magma', 'abyss'] as const;
      for (const preset of ids) {
        const { code } = gen.generate('x', { weights: preset });
        expect(extractJson(code, 'PALETTE').id).toBe(preset);
      }
    });

    it('defaults to the aurora preset when weights are omitted', () => {
      const gen = new NbeGenerator();
      const { code } = gen.generate('x');
      expect(extractJson(code, 'PALETTE').id).toBe('aurora');
      expect(code).toContain('var CONVERGENCE_STEPS = 600;');
    });

    it('falls back to aurora for an unknown preset name', () => {
      const gen = new NbeGenerator();
      const { code } = gen.generate('x', { weights: 'nonexistent' as never });
      expect(extractJson(code, 'PALETTE').id).toBe('aurora');
    });

    it('accepts a custom cascade weight set', () => {
      const gen = new NbeGenerator();
      const custom: NbeWeightSet = {
        weights: [
          { freq: 1.0, amp: 0.5, phaseX: 0, phaseY: 0, speed: 0.2 },
          { freq: 3.0, amp: 0.25, phaseX: 1, phaseY: 2, speed: 0.4 },
        ],
        palette: {
          id: 'custom-test',
          stops: [
            [0, [0, 0, 0]],
            [1, [255, 255, 255]],
          ],
        },
      };
      const { code } = gen.generate('x', { weights: custom });
      expect(extractJson(code, 'PALETTE').id).toBe('custom-test');
      const cascade = extractJson(code, 'CASCADE') as Array<{ freq: number }>;
      expect(cascade.map((l) => l.freq)).toEqual([1, 3]);
    });

    it('applies initial parameter overrides into the embedded document', () => {
      const gen = new NbeGenerator();
      const { code } = gen.generate('x', {
        initialParams: { gridWidth: 64, gridHeight: 48, damping: 0.5, seed: 99 },
      });
      const initial = extractJson(code, 'INITIAL');
      expect(initial).toMatchObject({
        gridWidth: 64,
        gridHeight: 48,
        damping: 0.5,
        seed: 99,
      });
    });

    it('clamps out-of-range convergence steps into the valid window', () => {
      const gen = new NbeGenerator();
      const tooSmall = gen.generate('x', { convergenceSteps: -5 });
      expect(tooSmall.code).toContain('var CONVERGENCE_STEPS = 1;');

      const tooBig = gen.generate('x', { convergenceSteps: 999_999 });
      expect(tooBig.code).toContain('var CONVERGENCE_STEPS = 10000;');

      const nan = gen.generate('x', { convergenceSteps: Number.NaN });
      expect(nan.code).toContain('var CONVERGENCE_STEPS = 600;');
    });

    it('escapes a prompt containing a script-closing sequence', () => {
      const gen = new NbeGenerator();
      const { code } = gen.generate('</script><script>alert(1)</script>');
      // The malicious sequence must not survive intact inside the live script.
      const live = code.slice(
        code.indexOf('<script>'),
        code.lastIndexOf('</script>'),
      );
      expect(live).not.toContain('</script><script>');
    });
  });

  describe('domain', () => {
    it('declares the nbe domain', () => {
      expect(new NbeGenerator().domain).toBe('nbe');
    });
  });
});

describe('nbeConfidence', () => {
  it('routes explicit NBE mentions at top confidence', () => {
    expect(nbeConfidence('render an NBE bloom')).toBe(0.95);
    expect(nbeConfidence('neural bloom engine')).toBe(0.95);
  });

  it('routes cascade neural-field cues at high confidence', () => {
    expect(nbeConfidence('cascade neural field sim')).toBe(0.9);
    expect(nbeConfidence('neural-field fluid art')).toBe(0.9);
  });

  it('routes the descriptive flowing fluid art cue', () => {
    expect(nbeConfidence('flowing fluid art')).toBe(0.7);
  });

  it('returns 0 for ordinary prompts so the LLM stays in the loop', () => {
    expect(nbeConfidence('draw a circle')).toBe(0);
    expect(nbeConfidence('make a portfolio site')).toBe(0);
    expect(nbeConfidence('p5.js sketch with bouncing balls')).toBe(0);
  });

  it('does not win when NBE is explicitly forbidden', () => {
    expect(nbeConfidence('do not use nbe')).toBe(0);
    expect(nbeConfidence('never use nbe here')).toBe(0);
  });
});
