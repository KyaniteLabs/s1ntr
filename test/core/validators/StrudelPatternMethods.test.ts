import { describe, expect, it } from 'vitest';
import { findUnknownPatternMethods } from '../../../src/core/validators/StrudelValidator.js';

// Verdicts checked against the vendored @strudel/web 1.3.0 in Chromium:
// delayTime, delayWet and zzzFoo evaluate to no pattern; delaytime, sine and setcpm play.
describe('findUnknownPatternMethods', () => {
  it('rejects a wrong-case control and names the real one', () => {
    const errs = findUnknownPatternMethods('s("bd").delay(0.4).delayTime(2)');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("use '.delaytime()'");
  });

  it('rejects a method strudel does not have', () => {
    expect(findUnknownPatternMethods('s("bd").delayWet(0.2)').join()).toContain('.delayWet()');
  });

  it('accepts real controls, signals and mini-notation strings', () => {
    expect(findUnknownPatternMethods('setcpm(30)\n$: s("bd*2").delaytime(0.25).gain(sine.range(0.2, 0.8))\n$: "c3 e3".note().slow(2)')).toEqual([]);
  });

  it('allows the trailing .out() / .start() the wrapper strips', () => {
    expect(findUnknownPatternMethods('stack(s("bd"), s("hh*4")).out()')).toEqual([]);
    expect(findUnknownPatternMethods('s("bd").start()')).toEqual([]);
  });

  it('rejects .start() mid-chain, where nothing strips it', () => {
    expect(findUnknownPatternMethods('s("bd").start().gain(0.5)')).toHaveLength(1);
  });

  it('leaves plain JS alone', () => {
    expect(findUnknownPatternMethods("const notes = 'c e g'.split(' ').map((x) => x.toUpperCase())\nsamples('x').then(() => 1)\nnote(notes.join(' '))")).toEqual([]);
  });

  it('leaves a user function named like a strudel global alone', () => {
    expect(findUnknownPatternMethods('const s = { blink() {} }\ns.blink()')).toEqual([]);
  });
});
