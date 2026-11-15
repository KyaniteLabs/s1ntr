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
