import { describe, expect, it } from 'vitest';
import { HydraValidator } from '../../../src/core/validators/HydraValidator.js';

const shapeErrors = (code: string): string[] => HydraValidator.validate(code).errors
  .filter((e) => /src\(\) needs|output has no chain|fed into itself/.test(e));

// Each reject case is the shape of a real run that threw at the first frame.
describe('HydraValidator chain shape', () => {
  it('rejects bare src() (x.getTexture is not a function)', () => {
    expect(shapeErrors('src().scale(1.02).rotate(0.01).blend(osc(10, 0.1, 1), 0.5).out()')).toHaveLength(1);
  });

  it('accepts src(o0) feedback and src(s0) input', () => {
    expect(shapeErrors('src(o0).scale(1.01).blend(osc(10, 0.1, 1), 0.9).out(o0)\nsrc(s0).out(o1)')).toEqual([]);
  });

  it('rejects a chain method called on an output (o1.color is not a function)', () => {
    const errs = shapeErrors('shape(5).out(o1)\nosc(45, 0.07, 0.5).add(o1.color(2.2, 0.9, 0.6)).out()');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('src(o1).color');
  });

  it('accepts an output passed as a source argument', () => {
    expect(shapeErrors('shape(5).out(o1)\nosc(45, 0.07, 0.5).add(o1).modulate(o1, 0.2).out()')).toEqual([]);
  });

  it('rejects a chain fed into itself directly (Maximum call stack size exceeded)', () => {
    expect(shapeErrors('s0x = osc(5, 0.05, 0.85).rotate(0.1)\ns0x.color(0.3, 0.8, 0.4).add(s0x.rotate(0.009)).out()')).toHaveLength(1);
  });

  it('rejects a chain fed into itself through an alias (Invalid string length)', () => {
    const code = [
      'deep = voronoi(4, 0.45, 0.7).rotate(0.1)',
      'comp = deep.blend(shape(4), 0.7)',
      'core = comp.color(0.38, 1.0, 0.6)',
      'bleed = comp.scale(1.006).color(1.0, 0.56, 0.14)',
      'core.add(bleed).out()',
    ].join('\n');
    expect(shapeErrors(code).join()).toContain("through 'bleed'");
  });

  it('accepts two branches that each start from their own source call', () => {
    const code = [
      'base = () => voronoi(4, 0.45, 0.7).rotate(0.1)',
      'core = base().color(0.38, 1.0, 0.6)',
      'bleed = base().scale(1.006)',
      'core.add(bleed).out()',
      'tint = osc(10).color(1, 0, 0)',
      'other = noise(3).add(tint).out(o1)',
    ].join('\n');
    expect(shapeErrors(code)).toEqual([]);
  });

  it('does not count a reference inside an arrow parameter function', () => {
    // An arrow runs per frame for a number; it never joins the shader graph.
    expect(shapeErrors('k = osc(5)\nk.rotate(() => (k ? time * 0.1 : 0)).out()')).toEqual([]);
  });
});
