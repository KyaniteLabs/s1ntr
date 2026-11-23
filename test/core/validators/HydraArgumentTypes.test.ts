import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { HydraValidator, HYDRA_TRANSFORMS } from '../../../src/core/validators/HydraValidator.js';

// Every hydra sketch that passed validation and then rendered black in the
// LFM3 Kaggle shard smoke runs (v2, v3, v7), byte for byte, named by sha256.
// hydra-synth compiles a source in a number slot, or a blend with no source,
// into GLSL that does not compile; .out() only logs the compile error, so the
// gate waited 45 s and reported "blank output" with no cause.
const BLANK_DIR = 'test/fixtures/hydra-rendered-blank';
const RENDERED_BLANK = readdirSync(BLANK_DIR).sort().map((file) => [file, readFileSync(join(BLANK_DIR, file), 'utf8')]);

const RENDERS = [
  `osc(10, 0.1, 1.2)
  .rotate(() => time * 0.05)
  .modulate(noise(3, 0.2), 0.15)
  .add(shape(4).rotate(0.5), 0.3)
  .blend(o1, 0.4)
  .diff(src(o0).scale(1.01))
  .scale([1, 1.2, 1.4].fast(0.5))
  .kaleid(4)
  .out()`,
  `const field = noise(3, 0.1);
osc(8, 0.05, 1.1)
  .modulateScale(field, 0.4)
  .layer(field.luma(0.5))
  .mask(shape(4, 0.6))
  .color(0.6, 0.4, () => 0.8 + 0.2 * time)
  .out()`,
];

// Every hydra sketch in the 11-16 dance and hydra case-study runs (DeepSeek 1017,
// DeepSeek 0731, HY4 Flash) that died at render with "arr.slice is not a
// function": each passes a number-returning function as a combine source,
// like .mult(() => 0.93 + Math.sin(time) * 0.05).
const SCALAR_DIR = 'test/fixtures/hydra-scalar-combine';
const SCALAR_COMBINE = readdirSync(SCALAR_DIR).sort().map((file) => [file, readFileSync(join(SCALAR_DIR, file), 'utf8')]);

const read = (file: string): string => readFileSync(join(BLANK_DIR, file), 'utf8');

describe('HydraValidator argument types', () => {
  it('has all eight Kaggle blank renders', () => {
    expect(RENDERED_BLANK).toHaveLength(8);
  });

  it.each(RENDERED_BLANK)('rejects %s before the browser', (_file, code) => {
    const result = HydraValidator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => /takes numbers|needs a source/.test(error))).toBe(true);
  });

  it('names the call, the slot and the source, in chain order', () => {
    const typeErrors = HydraValidator.validate(read('8e87183583b1fefc.js')).errors.filter((error) => /takes numbers/.test(error));
    expect(typeErrors).toEqual([
      'Hydra .scale() argument 1 is a source (noise(...)), but .scale() takes numbers: hydra compiles it into a float slot and the frame renders black. Use a number, an array, or () => ...',
      'Hydra .rotate() argument 1 is a source (noise(...)), but .rotate() takes numbers: hydra compiles it into a float slot and the frame renders black. Use a number, an array, or () => ...',
      'Hydra .kaleid() argument 1 is a source (shape(...)), but .kaleid() takes numbers: hydra compiles it into a float slot and the frame renders black. Use a number, an array, or () => ...',
      'Hydra .repeat() argument 1 is a source (voronoi(...)), but .repeat() takes numbers: hydra compiles it into a float slot and the frame renders black. Use a number, an array, or () => ...',
    ]);
  });

  it.each(SCALAR_COMBINE)('rejects %s, a number-returning function as a combine source', (_file, code) => {
    const result = HydraValidator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => /function returning a number/.test(error))).toBe(true);
  });

  it('has all eleven arr.slice render crashes', () => {
    expect(SCALAR_COMBINE).toHaveLength(11);
  });

  it('accepts a function returning an array or an unknown value as a combine source', () => {
    for (const code of [
      'osc(10).mult(() => [1, 0.5, 0.5, 1]).out()',
      'const tint = [1, 1, 1, 1];\nosc(10).add(() => tint).out()',
      'osc(10).mult(shape(4), () => 0.5 + Math.sin(time) * 0.2).out()',
    ]) {
      expect(HydraValidator.validate(code).errors.filter((error) => /function returning a number/.test(error))).toEqual([]);
    }
  });

  it('rejects a blend with no source', () => {
    const errors = HydraValidator.validate(read('8574695f6af749e7.js')).errors;
    expect(errors).toContain('Hydra .add() needs a source as argument 1, like .add(osc(10)) or .add(o1): without one hydra cannot build the shader and the frame renders black');
    expect(errors).toContain('Hydra .blend() needs a source as argument 1, like .blend(osc(10)) or .blend(o1): without one hydra cannot build the shader and the frame renders black');
  });

  it.each([
    ['an empty modulate', 'osc(10).modulate().out()'],
    ['a number modulate', 'osc(10).modulate(0.5).out()'],
    ['a function-returning-number modulate', 'osc(10).modulate(() => Math.sin(time) * 0.2).out()'],
  ])('teaches the modulate shape for %s', (_label, code) => {
    const message = HydraValidator.validate(code).errors.find((error) => error.includes('.modulate()')) ?? '';
    // The model treats modulate like a number transform. The message must show
    // the working form (source, then amount) and name the number-transform to use.
    expect(message).toContain('.modulate(noise(3), 0.1)');
    expect(message).toMatch(/\.scale\(|\.rotate\(/);
  });

  it('rejects a source in the number slot after a blend source', () => {
    const errors = HydraValidator.validate(read('7a191045a59330be.js')).errors;
    expect(errors).toContain('Hydra .add() argument 2 is a source (shape(...)), but .add() takes numbers: hydra compiles it into a float slot and the frame renders black. Use a number, an array, or () => ...');
  });

  it.each([
    ['a number const as the blend source', 'const mix = 0.5;\nosc(10).blend(mix).out()', 'Hydra .blend() needs a source as argument 1'],
    ['a string as the add source', "osc(10).add('o1').out()", 'Hydra .add() needs a source as argument 1'],
    ['a source in either branch of a ternary', 'const on = true;\nosc(10).kaleid(on ? shape(4) : 4).out()', 'Hydra .kaleid() argument 1 is a source (shape(...))'],
    ['a source in an optional chain', 'osc(10)?.kaleid(noise(2)).out()', 'Hydra .kaleid() argument 1 is a source (noise(...))'],
  ])('rejects %s', (_case, code, message) => {
    expect(HydraValidator.validate(code).errors.some((error) => error.startsWith(message))).toBe(true);
  });

  it.each([
    ['an array as the add colour', 'osc(10).add([1, 0, 0, 1]).out()'],
    ['a function as the add colour', 'osc(10).add(() => [1, 0, 0, 1]).out()'],
    ['a local function that shadows noise', 'const noise = (x) => x * 2;\nosc(noise(3)).out()'],
    ['a parameter that shadows a source variable', 'const field = noise(3);\nconst spin = (field) => osc(10).rotate(field);\nspin(0.2).modulate(field, 0.1).out()'],
    ['a time value in a number slot', 'osc(10).scale(() => 1 + Math.sin(time)).out()'],
  ])('accepts %s', (_case, code) => {
    expect(HydraValidator.validate(code).errors).toEqual([]);
  });

  it.each(RENDERS.map((code, i) => [i, code]))('accepts well-typed sketch %i', (_i, code) => {
    expect(HydraValidator.validate(code).errors).toEqual([]);
  });

  it('matches the transform table in the vendored hydra-synth', () => {
    const bundle = readFileSync('vendor/hydra-synth/1.3.10/hydra-synth.js', 'utf8');
    const table = bundle.slice(bundle.indexOf("module.exports = () => [\n  {\n  name: 'noise'"));
    const vendored: Record<string, string> = {};
    for (const match of table.matchAll(/\{\s*name: '(\w+)',\s*type: '(\w+)',\s*inputs: \[/g)) {
      vendored[match[1]] = match[2];
    }
    expect(Object.keys(vendored)).toHaveLength(52);
    expect(HYDRA_TRANSFORMS).toEqual(vendored);
  });
});
