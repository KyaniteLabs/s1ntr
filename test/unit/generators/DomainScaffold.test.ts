import { describe, it, expect } from 'vitest';
import { domainScaffold } from '../../../src/generators/GeneratorHarnessTools.js';
import { CodeValidator } from '../../../src/core/CodeValidator.js';

// LFM3 hill-climb shard A (2026-11-15): hyperframes 0/8, hydra 0/5 and p5 1/4 chains survived,
// and every hyperframes attempt lacked the composition div and any GSAP timeline. A scaffold
// is only worth showing a model if it passes the same gate the model's code must pass.
const DOMAINS = ['tone', 'strudel', 'three', 'glsl', 'hyperframes', 'hydra', 'p5'];

describe('domain scaffolds', () => {
  for (const domain of DOMAINS) {
    it(`${domain} has a scaffold that passes its own gate`, () => {
      const scaffold = domainScaffold(domain);
      expect(scaffold, `no scaffold for ${domain}`).toMatchObject({
        skeleton: expect.stringMatching(/\S/),
        apis: expect.any(Array),
        rules: expect.any(Array),
      });
      const result = CodeValidator.validate(scaffold!.skeleton, domain);
      expect(result.errors ?? []).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }

  it('the hyperframes scaffold carries the structure the gate requires', () => {
    const s = domainScaffold('hyperframes')!.skeleton;
    expect(s).toContain('data-composition-id="main"');
    expect(s).toContain('gsap.timeline');
    expect(s).toContain('window.__timelines');
  });

  it('is deterministic and maps the shader alias to glsl', () => {
    expect(domainScaffold('three')).toEqual(domainScaffold('three'));
    expect(domainScaffold('shader')?.skeleton).toBe(domainScaffold('glsl')?.skeleton);
    expect(domainScaffold('no-such-domain')).toBeNull();
  });
});
