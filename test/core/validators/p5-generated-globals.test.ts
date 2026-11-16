import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { P5Validator } from '../../../src/core/validators/P5Validator.js';
import { P5_GENERATED_GLOBALS } from '../../../src/core/validators/p5Globals.generated.js';
import { collectP5Globals, renderGenerated, OUTPUT } from '../../../scripts/generate-p5-globals.mjs';

const undeclared = (code: string) =>
  P5Validator.validate(code).errors.filter((e) => e.includes('undeclared identifier'));

describe('P5Validator allowlist derived from the vendored p5 build', () => {
  it('accepts loop/noLoop/redraw/isLooping and createVideo', () => {
    const code = `
let vid;
function setup() {
  createCanvas(200, 200);
  vid = createVideo(['a.mp4']);
  noLoop();
}
function mousePressed() { if (isLooping()) { noLoop(); } else { loop(); } redraw(); }
function draw() { background(0); }
`;
    expect(undeclared(code)).toEqual([]);
    expect(P5Validator.validate(code).valid).toBe(true);
  });

  it('accepts the p5.sound add-on API sketches load from the vendored sound build', () => {
    const code = `
let osc;
function setup() {
  soundFormats('mp3', 'ogg');
  outputVolume(0.5);
  osc = loadSound('a.mp3');
  getAudioContext();
  userStartAudio();
  setBPM(90);
  void midiToFreq(60);
}
`;
    expect(undeclared(code)).toEqual([]);
  });

  it('committed generated list equals what the vendored build yields', () => {
    expect(fs.readFileSync(OUTPUT, 'utf8')).toBe(renderGenerated(collectP5Globals()));
  });

  it('accepts every generated name', () => {
    const rejected = P5_GENERATED_GLOBALS.filter(
      (name) => undeclared(`function setup() { void ${name}; }`).length > 0,
    );
    expect(P5_GENERATED_GLOBALS.length).toBeGreaterThan(400);
    expect(rejected).toEqual([]);
  });

  it('still rejects an undeclared identifier', () => {
    expect(undeclared('function setup() { notARealP5Name(1); }')).toEqual([
      'p5.js code references undeclared identifier: notARealP5Name',
    ]);
  });
});
