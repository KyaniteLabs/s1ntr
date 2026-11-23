/**
 * Organ: harness memory. Real HarnessMemory against a temp HOME: what one process records,
 * the next process reads back (persistence is the connection), and an unreadable file never crashes it.
 * Governed art generation does NOT read this organ by design (pinned in teach-organ.test.ts, disabledTeachingReaders);
 * its reader is the self-improvement runtime (withLearnedGuidance).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const dirs: string[] = [];
const home = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'organ-mem-')); dirs.push(d); vi.stubEnv('HOME', d); return d; };
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe('organ: harness memory', () => {
  it('episodes and adaptations recorded by one instance are read back by the next', async () => {
    await home();
    const { HarnessMemory } = await import('../../src/harness/HarnessMemory.js');
    const a = new HarnessMemory(); await a.initialize();
    a.recordAdaptation({ patternName: 'mud-camo', patternSeverity: 'high', fixType: 'guardrail', description: 'judge penalises', success: true });
    a.recordEpisode({ type: 'generation', domain: 'p5', prompt: 'organ probe', success: true } as never);
    await a.shutdown();
    const b = new HarnessMemory(); await b.initialize(); await b.shutdown();
    expect(b.getAdaptationsForPattern('mud-camo')).toHaveLength(1);
    expect(b.getEpisodesByDomain('p5').length + b.getRecentEpisodes().length).toBeGreaterThan(0);
    expect(b.getStats().totalAdaptations).toBe(1);
  });

  it('perturbation: a corrupt memory file starts fresh instead of crashing', async () => {
    const h = await home();
    await mkdir(path.join(h, '.sinter', 'memory'), { recursive: true });
    await writeFile(path.join(h, '.sinter', 'memory', 'harness-memory.json'), '{broken');
    const { HarnessMemory } = await import('../../src/harness/HarnessMemory.js');
    const m = new HarnessMemory(); await m.initialize(); await m.shutdown();
    expect(m.getAdaptations()).toEqual([]);
  });
});
