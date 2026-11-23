/**
 * Organ: git per-run branches (src/git). Off by default so a creative run never touches the caller's
 * branch. SINTER_GIT_PER_RUN=1 turns it on: the real RalphLoop then makes a liminal/<run> branch and
 * commits each iteration in a real temp repo. Fails if the flag stops reaching GitIntegration.
 * The model seam is a recorder (see loop-carry-organ.test.ts for why).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#101030"/><circle cx="100" cy="100" r="60" fill="#e0a030"><animate attributeName="r" values="40;70;40" dur="3s" repeatCount="indefinite"/></circle></svg>`;
vi.mock('../../src/core/GenerationOrchestrator.js', () => ({
  GenerationOrchestrator: class { async generate() { return { code: svg, thinking: '', model: 'recorder' }; } },
}));
vi.mock('../../src/core/ScoringEngine.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  scoreRenderedEvidence: async () => ({ score: 0.5, confidence: 0.9, reasoning: 'recorded judge' }),
  ScoringEngine: class {
    async score() { return { score: 0.5, issues: [], confidence: 0.9 }; }
    async scoreReliable() { return { score: 0.5, issues: [], confidence: 0.9 }; }
  },
}));

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

describe('organ: git per-run (real loop, real git repo)', () => {
  let cwd = ''; const prev = process.cwd();
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'organ-git-'));
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.email', 't@t.t'); git(cwd, 'config', 'user.name', 't');
    await writeFile(path.join(cwd, 'seed.txt'), 'x'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'seed');
    process.chdir(cwd);
  });
  afterEach(async () => {
    process.chdir(prev); delete process.env.SINTER_GIT_PER_RUN; delete process.env.LIMINAL_GIT_PER_RUN;
    await rm(cwd, { recursive: true, force: true });
  });

  async function run() {
    const { RalphLoop } = await import('../../src/core/RalphLoop.js');
    await RalphLoop.run('an orbiting particle study', { maxIterations: 1, minQualityScore: 0.99, collabDomain: 'svg',
      _disableIterationExtension: true, project: 'gitrun', output: path.join(cwd, 'out') } as never);
    return git(cwd, 'branch', '--list', 'liminal/*');
  }

  it('default: no branch is created', { timeout: 120_000 }, async () => {
    expect(await run()).toBe('');
  });

  it('SINTER_GIT_PER_RUN=1: a liminal/ branch appears', { timeout: 120_000 }, async () => {
    process.env.SINTER_GIT_PER_RUN = '1';
    expect(await run(), 'flag did not reach GitIntegration').toMatch(/liminal\//);
  });

  it('gitConfigFromEnv honours both prefixes and is off otherwise', async () => {
    const { gitConfigFromEnv } = await import('../../src/core/LoopConfig.js');
    expect(gitConfigFromEnv()).toBeUndefined();
    process.env.LIMINAL_GIT_PER_RUN = '1';
    expect(gitConfigFromEnv()?.enabled).toBe(true);
  });
});
