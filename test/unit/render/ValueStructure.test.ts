import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeImagePixels } from '../../../src/render/DecodedImageVisibility.js';
import {
  measureValueStructure,
  OVERMIXED_SCORE_CAP,
  overmixedRepairAdvice,
} from '../../../src/render/ValueStructure.js';

const fixture = async (name: string) => measureValueStructure(
  await decodeImagePixels(readFileSync(new URL(`../../fixtures/mud-camo/${name}.png`, import.meta.url))),
);

function solid(w: number, h: number, rgb: [number, number, number], accent?: [number, number, number]) {
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const c = accent && p % 7 === 0 ? accent : rgb;
    data.set([c[0], c[1], c[2], 255], p * 4);
  }
  return { width: w, height: h, data };
}

describe('ValueStructure (overmixed / lost value structure)', () => {
  it('flags thumbed-down mud camo frames from real wall posters', async () => {
    expect((await fixture('down0'))?.overmixed).toBe(true);
    expect((await fixture('down1'))?.overmixed).toBe(true);
  });

  it('passes a thumbed-up frame', async () => {
    expect((await fixture('up0'))?.overmixed).toBe(false);
  });

  it('is palette-agnostic about muted work that keeps a real light', () => {
    // dull olive field with a true bright accent: a deliberate value plan
    const m = measureValueStructure(solid(32, 32, [60, 70, 50], [250, 245, 220]));
    expect(m?.lightP98).toBeGreaterThan(0.8);
    expect(m?.overmixed).toBe(false);
  });

  it('keeps a dark scene lit by a thin bright line: a real light under 2% of the frame is not mud (trace-router, mainframe-boot)', () => {
    // 1 pixel in 250 (0.4%) is a near-white accent on a dark green-teal field; p98 stays dark, but the light is real
    const w = 50; const h = 50; const data = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) data.set(p % 250 === 0 ? [235, 255, 245, 255] : [16, 55, 47, 255], p * 4);
    const m = measureValueStructure({ width: w, height: h, data });
    expect(m?.lightP98).toBeLessThan(0.8);
    expect(m?.accentShare).toBeCloseTo(0.004, 3);
    expect(m?.overmixed).toBe(false);
  });

  it('still flags the same dark field with no accent at all', () => {
    expect(measureValueStructure(solid(50, 50, [16, 55, 47]))?.overmixed).toBe(true);
  });

  it('does not flag a clean saturated frame or a muddy hue outside the band', () => {
    expect(measureValueStructure(solid(32, 32, [20, 20, 40], [255, 30, 30]))?.overmixed).toBe(false);
    expect(measureValueStructure(solid(32, 32, [70, 40, 60]))?.overmixed).toBe(false);
  });

  it('names the collapse and the mechanism fix in painter language', () => {
    const advice = overmixedRepairAdvice({ lightP98: 0.5, lightP02: 0.2, chromaP95: 0.08, muddyHueShare: 0.9, overmixed: true });
    expect(advice.issue).toMatch(/Overmixed \/ lost value structure/);
    expect(advice.fix).toMatch(/blend\/modulate\/feedback average toward grey/);
    expect(OVERMIXED_SCORE_CAP).toBeLessThan(0.3);
  });
});
