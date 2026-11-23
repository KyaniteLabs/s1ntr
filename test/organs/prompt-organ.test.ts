/**
 * Organ: prompt evolution (PromptOrgan + compost seed injection + library section).
 * Real PromptOrgan on a temp cwd; outcomes are recorded through its own API and must change what it proposes next.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PromptOrgan } from '../../src/atelier/PromptOrgan.js';
import { libraryPromptSection } from '../../src/runtime-core/LibraryPromptSection.js';

const dirs: string[] = [];
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'organ-prompt-')); dirs.push(d); return d; };
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe('organ: prompt evolution', () => {
  it('recorded outcomes persist and bias the next combinatorial prompts toward the winning intent', async () => {
    const cwd = await tmp();
    const probe = new PromptOrgan(cwd, 1);
    const intents = new Set(Array.from({ length: 200 }, () => probe.combinatorial('p5').components.intent!));
    const [winner, ...losers] = [...intents];
    expect(losers.length).toBeGreaterThan(2);

    const before = new PromptOrgan(cwd, 7);
    const count = (o: PromptOrgan) => Array.from({ length: 400 }, () => o.combinatorial('p5').components.intent).filter(i => i === winner).length;
    const base = count(before);
    const teacher = new PromptOrgan(cwd, 3);
    for (const intent of intents) teacher.recordOutcome({ text: 'x', domain: 'p5', source: 'combinatorial', components: { intent }, createdAt: 'now' }, intent === winner ? 1 : 0);
    const after = count(new PromptOrgan(cwd, 7));            // a fresh instance: the state came back from disk
    expect(after).toBeGreaterThan(base * 1.5);
  });

  it('with no recorded outcomes the intent mix stays flat (perturbation)', async () => {
    const cwd = await tmp();
    const o = new PromptOrgan(cwd, 11);
    const seen = new Map<string, number>();
    for (let i = 0; i < 600; i++) { const k = o.combinatorial('p5').components.intent!; seen.set(k, (seen.get(k) ?? 0) + 1); }
    const counts = [...seen.values()]; expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(3);
  });

  it('compost seeds in .sinter/compost/seeds/seeds.json are injected into next() prompts', async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, '.sinter', 'compost', 'seeds'), { recursive: true });
    await writeFile(path.join(cwd, '.sinter', 'compost', 'seeds', 'seeds.json'), JSON.stringify([{
      id: 'organ-seed-1', content: 'Tidal feedback: a slow wave folds back on itself.', score: 0.9,
      source: { fragments: [], collisionType: 'mutation', domains: ['p5'] }, promotedAt: '2026-11-19T00:00:00Z', usedBy: [], useCount: 0 }]));
    const prompt = new PromptOrgan(cwd, 5).next();
    expect(prompt.text).toContain('[seed:organ-seed-1]');
  });

  it('library capability section is domain-aware (strudel is offered tonaljs)', () => {
    expect(libraryPromptSection(() => 0.5, 'strudel')).toContain('tonaljs');
  });
});
