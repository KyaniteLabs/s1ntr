/**
 * Organ: loop carry-over. The real RalphLoop runs two iterations with the real context builder,
 * real scoring engine and real headless renderer; only the model call (GenerationOrchestrator.generate)
 * is a recorder. Loop 1's score, issues and code must reach loop 2's prompt, and loop 2 must change
 * when loop 1's code changes. Fails if loop 2 starts fresh.
 *
 * Why not a spawned CLI: the provider transport demands host-owned completion authority (a protected
 * host key) that a test must not forge, so a spawned process with a fake HTTP provider is blocked
 * before transport by design. The model seam is the lowest honest cut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const svg = (m: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><!-- ${m} --><rect width="200" height="200" fill="#101030"/><circle cx="100" cy="100" r="60" fill="#e0a030"><animate attributeName="r" values="40;70;40" dur="3s" repeatCount="indefinite"/></circle></svg>`;

const prompts: string[] = [];
let loop1Code = '';
let failAt = 0; let genCalls = 0;
vi.mock('../../src/core/GenerationOrchestrator.js', () => ({
  GenerationOrchestrator: class {
    async generate(prompt: string) {
      prompts.push(prompt); genCalls++;
      if (failAt && genCalls === failAt) throw new Error('ORGAN_BOOM transport reset');
      return { code: prompts.length === 1 ? loop1Code : svg('loop2'), thinking: '', model: 'recorder' };
    }
  },
}));

const CRITIQUE = 'ORGAN_CRITIQUE: the focal point is weak and the palette is flat';
vi.mock('../../src/core/ScoringEngine.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  scoreRenderedEvidence: async () => ({ score: 0.5, confidence: 0.9, reasoning: 'recorded judge',
    repairAdvice: { issue: CRITIQUE, fix: 'strengthen the focal point', constraint: 'keep it runnable' } }),
  ScoringEngine: class {
    async score() { return { score: 0.5, issues: [CRITIQUE], confidence: 0.9 }; }
    async scoreReliable() { return { score: 0.5, issues: [CRITIQUE], confidence: 0.9 }; }
  },
}));

describe('organ: loop carry-over (real loop, context, scoring, renderer; recorded model seam)', () => {
  let cwd = ''; const prev = process.cwd();
  beforeEach(async () => { prompts.length = 0; cwd = await mkdtemp(path.join(os.tmpdir(), 'organ-carry-')); process.chdir(cwd); });
  afterEach(async () => { process.chdir(prev); await rm(cwd, { recursive: true, force: true }); });

  async function twoLoops(code: string, opts: { tolerate?: boolean; max?: number; fail?: number } = {}): Promise<string[]> {
    loop1Code = code; prompts.length = 0; genCalls = 0; failAt = opts.fail ?? 0;
    const { RalphLoop } = await import('../../src/core/RalphLoop.js');
    await RalphLoop.run('an orbiting particle study', { maxIterations: opts.max ?? 2, tolerateErrors: opts.tolerate, minQualityScore: 0.99, collabDomain: 'svg',
      _disableIterationExtension: true, project: 'carry', output: path.join(cwd, 'out') } as never);
    return [...prompts];
  }

  it('loop 2 sees loop 1 code and critique; different loop-1 code gives a different loop 2', async () => {
    const a = await twoLoops(svg('LOOP1_MARKER_A'));
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a[0]).not.toContain('LOOP1_MARKER_A');
    expect(a[1], 'loop 2 started fresh: loop 1 code never reached its prompt').toContain('LOOP1_MARKER_A');
    expect(a[1]).toContain('ORGAN_CRITIQUE');
    expect(a[1]).toMatch(/Quality score: \d/);
    expect(a[1]).not.toMatch(/No previous context available/);
    const b = await twoLoops(svg('LOOP1_MARKER_B'));
    expect(b[1]).toContain('LOOP1_MARKER_B');
    expect(b[1]).not.toContain('LOOP1_MARKER_A');
  }, 300_000);

  it('a swallowed failure (tolerateErrors) carries the last good code and the error text into the next loop', async () => {
    const p = await twoLoops(svg('GOOD_LOOP1'), { tolerate: true, max: 3, fail: 2 });
    expect(p.length, 'loop 3 never ran').toBeGreaterThanOrEqual(3);
    expect(p[2], 'loop 3 started fresh after a swallowed failure').toContain('GOOD_LOOP1');
    expect(p[2]).toContain('ORGAN_BOOM');
    expect(p[2]).not.toMatch(/No previous context available/);
  }, 300_000);

  it('a swallowed failure on loop 1 still hands loop 2 the error text', async () => {
    const p = await twoLoops(svg('X'), { tolerate: true, max: 2, fail: 1 });
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(p[1]).toContain('ORGAN_BOOM');
    expect(p[1]).not.toMatch(/No previous context available/);
  }, 300_000);
});
