/**
 * Wave 4 pipeline structural craft helpers (no live LLM).
 */
import { describe, expect, it } from 'vitest';
import { structuralCraftCheck } from '../../../scripts/rotation/wave4-full-pipeline-dogfood.mjs';

describe('wave4 structuralCraftCheck', () => {
  it('passes a minimal valid p5 craft body', () => {
    const code = `
function setup() {
  createCanvas(400, 400);
}
function draw() {
  background(10, 20, 40);
  ellipse(200, 200, 20, 20);
}
`;
    const r = structuralCraftCheck(code, 'p5');
    expect(r.craftPass).toBe(true);
    expect(r.emptyOrPlaceholder).toBe(false);
    expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.bytes).toBeGreaterThan(40);
  });

  it('fails dry-run placeholder and empty code', () => {
    const dry = structuralCraftCheck(
      '// DRY-RUN PLACEHOLDER — not live dogfood\nfunction setup(){createCanvas(400,400);} function draw(){background(10,20,40);}\n',
      'p5',
    );
    expect(dry.craftPass).toBe(false);
    expect(dry.emptyOrPlaceholder).toBe(true);

    const empty = structuralCraftCheck('// too short', 'p5');
    expect(empty.craftPass).toBe(false);
  });

  it('requires hydra-like signals for hydra domain', () => {
    const ok = structuralCraftCheck(
      'osc(4, 0.1, 1.2).color(0.1, 0.2, 0.6).out(o0)\n// padding to clear length gate xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'hydra',
    );
    expect(ok.craftPass).toBe(true);

    const bad = structuralCraftCheck(
      'function setup(){createCanvas(400,400);} function draw(){background(0);}\n// not hydra',
      'hydra',
    );
    expect(bad.craftPass).toBe(false);
  });
});
