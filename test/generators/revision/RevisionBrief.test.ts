import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRevisionPrompt, parseRevisionPrompt, loadPriorRun, DEMANDING_CRITIQUE } from '../../../src/generators/revision/RevisionBrief.js';

function fakeRun(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'revbrief-'));
  const op = 'operation:abc';
  const art = path.join(dir, 'artifacts', createHash('sha256').update(op).digest('hex'));
  mkdirSync(art, { recursive: true });
  writeFileSync(path.join(art, 'source.txt'), 'function setup(){createCanvas(400,400)}\n// LOOP ONE');
  writeFileSync(path.join(art, 'early-frame.png'), 'png');
  writeFileSync(path.join(dir, 'product-projections.json'), JSON.stringify({ k: { kind: 'create', result: {
    operationId: op, evaluation: { score: 0.61, reasoning: 'The stray diagonal line reads as an artifact.', admissionEligible: true, rejectionReasons: [] } } } }));
  return dir;
}

describe('revision brief', () => {
  it('carries the previous source, critique and frames; the judge request stays the original', () => {
    const prior = loadPriorRun(fakeRun());
    expect(prior.score).toBe(0.61);
    expect(prior.frames).toHaveLength(1);
    const prompt = buildRevisionPrompt({ request: 'A drowned TV.', loop: 2, of: 3, priorSource: prior.source,
      priorScore: prior.score, critique: prior.critique, rejectionReasons: [], frames: prior.frames });
    expect(prompt).toContain('// LOOP ONE');
    expect(prompt).toContain('stray diagonal line');
    expect(prompt).toContain('This is loop 2 of 3');
    const parsed = parseRevisionPrompt(prompt)!;
    expect(parsed.request).toBe('A drowned TV.');
    expect(parsed.meta).toMatchObject({ loop: 2, of: 3, priorScore: 0.61 });
    expect(parsed.meta.frames).toEqual(['early-frame.png']);
    expect(prompt).not.toContain(prior.frames[0]);
    expect(DEMANDING_CRITIQUE).toContain('three CONCRETE weaknesses');
  });
  it('ordinary prompts are not revisions, and meta frames outside the renderer names are dropped', () => {
    expect(parseRevisionPrompt('make a thing')).toBeNull();
    const p = buildRevisionPrompt({ request: 'r', loop: 3, of: 3, priorSource: 's', priorScore: null, critique: '', rejectionReasons: [],
      frames: ['/etc/passwd', '/tmp/x/early-frame.png'] });
    expect(parseRevisionPrompt(p)!.meta.frames).toEqual(['early-frame.png']);
    const untrusted = p.replace('early-frame.png', '/tmp/x/early-frame.png');
    expect(parseRevisionPrompt(untrusted)!.meta.frames).toEqual(['early-frame.png']);
  });
  it('refuses a run folder with no completed Create', () => {
    expect(() => loadPriorRun(mkdtempSync(path.join(tmpdir(), 'revbrief-')))).toThrow(/REVISE_FROM_NO_PROJECTION/);
  });
});
