import { describe, expect, it } from 'vitest';
import { P5Validator } from '../../../../src/core/validators/P5Validator.js';

// Whitelist-surface guard (2026-08-31): a real piece died C0_GENERATION_INVALID
// on noCanvas() — a legitimate p5 API missing from P5_GLOBALS. This fixture
// exercises the full legit surface the model is known to use; any "undeclared
// identifier" finding here means the whitelist regressed again.
const FIXTURE = `
function setup() {
  createCanvas(640, 480);
  noiseDetail(4, 0.5);
  noiseSeed(7);
  randomSeed(11);
  frameRate(30);
  noCanvas();
  const g = randomGaussian(0, 1);
  const t = textWidth('liminal') + textLeading();
  const a = [hour(), minute(), second(), day(), month(), year()];
  const parts = split('a,b,c', ',').map(trim);
  const joined = join(parts, '-');
  const s = shuffle(subset(a, 0, 2));
  const q = nf(constrain(0.5, 0, 1), 2, 2);
  const hit = match('x123', /\\d+/);
  const c = char(65);
  const v = createVector(1, 2);
  noise(); noLoop();
  print(g, t, joined, s, q, hit, c, v);
}
`;

describe('P5Validator whitelist covers the legitimate API surface', () => {
  it('no undeclared-identifier findings on the legit-surface fixture', () => {
    const result = P5Validator.validate(FIXTURE);
    const undeclared = result.errors.filter(e => e.includes('undeclared identifier'));
    expect(undeclared).toEqual([]);
  });
});
