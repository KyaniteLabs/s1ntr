import { describe, expect, it } from 'vitest';
import { stripModelScaffolding } from '../src/runtime-core/LiminalProductionEffects.js';
import { stripFence } from '../src/core/recovery/SourceRecovery.js';

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

  it('keeps the code when the libraries line leads instead of trails', () => {
    const out = stripModelScaffolding('libraries: voronoi\nvoronoi(200)\n  .rotate(() => time * 0.1)\n  .out()');
    expect(out).toContain('voronoi(200)');
    expect(out).toContain('.out()');
    expect(out).not.toMatch(/^libraries?:/im);
  });

  it('keeps the code when the declaration is glued to the closing fence (v2r1: 6 runs ended "No code provided")', () => {
    // LFM3 writes the declaration straight after the closing fence: "```libraries: none".
    for (const reply of [
      '<html><body>real art</body></html>\n```libraries: none',
      '```html\n<html><body>real art</body></html>\n```libraries: culori',
      '```html\n<html><body>real art</body></html>\n```\nlibraries: culori',
    ]) {
      const out = stripFence(stripModelScaffolding(reply));
      expect(out).toBe('<html><body>real art</body></html>');
    }
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

  // v2r1: a repair turn answered with a JSON object instead of code, once with a
  // "CORRECTED CODE" key (dataviz) and once with a "code" key (revideo). The
  // object was validated as source and died with a syntax error.
  describe('JSON-wrapped reply', () => {
    const page = '<!DOCTYPE html>\n<html><body><svg></svg></body></html>';
    it('takes the code out of a CORRECTED CODE field', () => {
      const reply = JSON.stringify({ 'ROOT CAUSE': 'no svg', 'CORRECTED CODE': page }, null, 2);
      expect(stripModelScaffolding(reply)).toBe(page);
    });
    it('takes the code out of a code field beside other keys', () => {
      const reply = JSON.stringify({ imports: ['@revideo/2d'], code: 'export default 1;' }, null, 2);
      expect(stripModelScaffolding(reply)).toBe('export default 1;');
    });
    it('leaves a JSON object with no code field alone, and real code that starts with a brace', () => {
      const data = '{"a": 1}';
      expect(stripModelScaffolding(data)).toBe(data);
      const js = '{ const a = 1; }\nconsole.log(a)';
      expect(stripModelScaffolding(js)).toBe(js);
    });
    it('does not touch text media, where a JSON piece is the artwork', () => {
      const art = JSON.stringify({ code: 'x' });
      expect(stripModelScaffolding(art, true)).toBe(art);
    });
  });
});
