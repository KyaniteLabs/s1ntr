import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeImagePixels, type DecodedImagePixels } from '../../../src/render/DecodedImageVisibility.js';
import {
  ALIVE_GLITCH_SCORE_FLOOR,
  measureGlitchLiveness,
} from '../../../src/render/GlitchLiveness.js';
import { measureValueStructure } from '../../../src/render/ValueStructure.js';
import { ADMISSION_BROKEN_FLOOR } from '../../../src/aesthetic/qualityFloor.js';

const load = (name: string) => decodeImagePixels(
  readFileSync(new URL(`../../fixtures/glitch-alive/${name}.png`, import.meta.url)),
);

async function pair(take: string) {
  return measureGlitchLiveness(await load(`${take}-early`), await load(`${take}-late`));
}

function solid(w: number, h: number, rgb: [number, number, number]): DecodedImagePixels {
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) data.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
  return { width: w, height: h, data };
}

function noise(w: number, h: number, seed: number): DecodedImagePixels {
  const data = new Uint8Array(w * h * 4);
  let s = seed;
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) { s = (s * 1664525 + 1013904223) >>> 0; data[p * 4 + c] = s >>> 24; }
    data[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe('GlitchLiveness: broken vs glitchy-but-alive', () => {
  // Owner thumbed these up ("they are glitches... but to me it's REAL beauty");
  // the judge scored them 0.10 and 0.31 and admission floored them as broken.
  it('passes the thumbed-up mimo hydra-organic-xhigh-r2 glitch frames as alive', async () => {
    const m = await pair('organic-xhigh-r2-r3');
    expect(m?.alive).toBe(true);
  });

  it('passes the thumbed-up mimo hydra-feedback-high-r2 glitch frames as alive', async () => {
    const m = await pair('feedback-high-r2-r3');
    expect(m?.alive).toBe(true);
  });

  it('never fires the mud-camo check on alive glitch (high chroma, high structure)', async () => {
    for (const take of ['organic-xhigh-r2-r3', 'feedback-high-r2-r3']) {
      expect(measureValueStructure(await load(`${take}-late`))?.overmixed).toBe(false);
    }
  });

  it('keeps real near-uniform failures from the same runs as broken', async () => {
    expect((await pair('organic-xhigh-r2-r2'))?.alive).toBe(false);
    expect((await pair('feedback-high-r2-r1'))?.alive).toBe(false);
  });

  it('keeps a black frame broken', () => {
    expect(measureGlitchLiveness(solid(320, 200, [0, 0, 0]), solid(320, 200, [0, 0, 0]))?.alive).toBe(false);
  });

  it('keeps a saturated but uniform frame broken', () => {
    expect(measureGlitchLiveness(solid(320, 200, [255, 0, 255]), solid(320, 200, [0, 255, 0]))?.alive).toBe(false);
  });

  it('keeps a frozen glitch frame broken (no motion between frames)', async () => {
    const f = await load('organic-xhigh-r2-r3-late');
    const m = measureGlitchLiveness(f, f);
    expect(m?.motion).toBe(0);
    expect(m?.alive).toBe(false);
  });

  it('keeps white noise broken (no structure that survives averaging)', () => {
    expect(measureGlitchLiveness(noise(320, 200, 1), noise(320, 200, 2))?.alive).toBe(false);
  });

  it('never rescues an undecodable frame', () => {
    expect(measureGlitchLiveness({ width: 0, height: 0, data: new Uint8Array(0) }, solid(8, 8, [1, 2, 3]))).toBeUndefined();
  });

  it('lifts scores only to the broken-band line, never to a pass', () => {
    expect(ALIVE_GLITCH_SCORE_FLOOR).toBe(ADMISSION_BROKEN_FLOOR);
  });
});
