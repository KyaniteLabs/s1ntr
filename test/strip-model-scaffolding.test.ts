import { describe, expect, it } from 'vitest';
import { stripModelScaffolding } from '../src/runtime-core/LiminalProductionEffects.js';

describe('stripModelScaffolding (wave-1 cure, in-repo 2026-10-09)', () => {
  it('strips <think> reasoning blocks entirely', () => {
    const out = stripModelScaffolding('<think>plan the artwork</think>\nconst art = 1;');
    expect(out).not.toContain('<think>');
    expect(out).not.toContain('plan the artwork');
    expect(out).toContain('const art = 1;');
  });

  it('keeps only content after the last CORRECTED CODE marker', () => {
    const out = stripModelScaffolding(
      'ROOT CAUSE: bug\nCORRECTED CODE: const first = 1;\nCORRECTED CODE: const real = 2;',
    );
    expect(out).toContain('const real = 2;');
    expect(out).not.toContain('const first = 1;');
  });

  it('drops the libraries tail', () => {
    const out = stripModelScaffolding('const art = 1;\nlibraries: three, tone.js');
    expect(out).toContain('const art = 1;');
    expect(out).not.toMatch(/^libraries?:/im);
  });

  it('drops ROOT CAUSE / CHECK / ANALYSIS / VERDICT annotation lines', () => {
    const out = stripModelScaffolding('ROOT CAUSE: x — broken\nCHECK 1: ok\nconst art = 1;');
    expect(out).not.toContain('ROOT CAUSE');
    expect(out).not.toContain('CHECK 1');
    expect(out).toContain('const art = 1;');
  });

  it('passes clean code through unchanged', () => {
    const clean = 'const palette = ["#123", "#456"];\nconsole.log(palette);';
    expect(stripModelScaffolding(clean)).toBe(clean);
  });

  it('handles the full wave-1 trace shape end to end', () => {
    const trace = '<think>I will fix it</think>ROOT CAUSE: Check 1 failed\nCORRECTED CODE: <html><body>real art</body></html>\nlibraries: none';
    const out = stripModelScaffolding(trace);
    expect(out).toContain('<html><body>real art</body></html>');
    expect(out).not.toContain('<think>');
    expect(out).not.toContain('ROOT CAUSE');
    expect(out).not.toMatch(/^libraries?:/im);
  });
});
