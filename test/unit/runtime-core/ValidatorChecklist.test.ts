import { describe, expect, it } from 'vitest';
import { buildRepairUserPrompt, validatorChecklistBlock } from
  '../../../src/runtime-core/ValidatorChecklist.js';
import { SUPPORTED_LIMINAL_PRODUCTION_DOMAINS } from
  '../../../src/runtime-core/LiminalProductionEffects.js';

describe('validator checklist block', () => {
  it('returns numbered build rules for a known domain', () => {
    const block = validatorChecklistBlock('glsl');
    expect(block).toContain('REQUIRED BUILD RULES');
    expect(block).toContain('1. one complete fragment shader with void main()');
    expect(block).toContain('declare precision');
  });

  it('aliases the shader domain to the glsl checklist (same validator)', () => {
    expect(validatorChecklistBlock('shader')).toBe(validatorChecklistBlock('glsl'));
  });

  it('returns an empty block for unknown domains (no prompt bloat)', () => {
    expect(validatorChecklistBlock('does-not-exist')).toBe('');
  });

  it('drift guard: EVERY supported production domain resolves to a checklist row (the textgen gap class)', () => {
    for (const domain of SUPPORTED_LIMINAL_PRODUCTION_DOMAINS) {
      expect(validatorChecklistBlock(domain), `domain ${domain} has no checklist`).not.toBe('');
    }
  });
});

describe('holospot-aware three checklist (v7 failure: generic lines beat the card)', () => {
  const holoBrief = 'One hero crystal. Use the vendored holospot library, holo.render each frame.';

  it('drops the generic renderer.render / light-intensity / 0x2a3a4e lines for a holospot request', () => {
    const block = validatorChecklistBlock('three', holoBrief);
    expect(block).toContain('REQUIRED BUILD RULES');
    // renderer.render may appear only as a prohibition, never as an instruction
    expect(block).not.toContain('call renderer.render');
    for (const line of block.split('\n').filter(l => l.includes('renderer.render'))) {
      expect(line).toContain('never renderer.render');
    }
    expect(block).not.toMatch(/intensity|key 0\.8-2\.0|ambient 0\.25/);
    expect(block).not.toContain('0x2a3a4e');
    expect(block).not.toContain('never near-black');
  });

  it('carries the holospot items instead', () => {
    const block = validatorChecklistBlock('three', holoBrief);
    expect(block).toContain('holo.render');
    expect(block).toContain('never renderer.render');
    expect(block).toContain('no three.js lights');
    expect(block).toContain('studio.preset');
    expect(block).toContain('holo.setScene');
    expect(block).toContain('new Holo(renderer, { background');
    expect(block).toMatch(/one hero object/i);
    expect(block).toMatch(/motion/i);
  });

  it('leaves a plain three request unchanged', () => {
    const plain = validatorChecklistBlock('three');
    expect(validatorChecklistBlock('three', 'a calm orbiting cube')).toBe(plain);
    expect(plain).toContain('call renderer.render');
    expect(plain).toContain('0x2a3a4e');
  });

  it('only applies to the three domain', () => {
    expect(validatorChecklistBlock('p5', holoBrief)).toBe(validatorChecklistBlock('p5'));
  });
});

describe('buildRepairUserPrompt', () => {
  it('carries the original brief, the exact failing checks, and the explain-then-fix contract', () => {
    const prompt = buildRepairUserPrompt('Make a calm pond', 'let broken = ', [
      'setup() is not defined',
      'draw() is not defined',
    ]);
    expect(prompt).toContain('Make a calm pond');
    expect(prompt).toContain('1. setup() is not defined');
    expect(prompt).toContain('2. draw() is not defined');
    expect(prompt).toContain('ROOT CAUSE');
    expect(prompt).toContain('CORRECTED CODE');
    expect(prompt).toContain('let broken ='); // failed code tail for reference
  });
});
