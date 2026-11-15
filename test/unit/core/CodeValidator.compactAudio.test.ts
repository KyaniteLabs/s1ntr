import { expect, it } from 'vitest';
import { CodeValidator } from '../../../src/core/CodeValidator.js';

it('accepts a complete compact Strudel pattern without padding', () => {
  expect(CodeValidator.validate('note("c3 e3 g3 e3").sound("sine").gain(0.12).slow(2)', 'strudel').valid).toBe(true);
});

it.each(['', 'hello', 'note("c3)', 'eval("note(1)")'])('still rejects invalid compact sound: %s', code => {
  expect(CodeValidator.validate(code, 'strudel').valid).toBe(false);
});
