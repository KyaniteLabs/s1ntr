import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nameChampions, confirmThreadSemantically, plateDomainsFor } from '../../../src/atelier/NamingOrgan.js';

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function namingFetch(variants: Array<{ name: string; availability_score?: number; reasoning?: string }>): FetchLike {
  return (async (url: string) => {
    if (String(url).includes('/api/naming')) {
      return { ok: true, json: async () => ({ variants }) };
    }
    // /api/game for semantic confirmation
    return { ok: true, json: async () => ({ threads: [{ isomorphic: true }, { isomorphic: true }], cross_domain_thread_count: 3, tensions: [{}] }) };
  }) as FetchLike;
}
const downFetch = (async () => { throw new Error('connection refused'); }) as FetchLike;

describe('NamingOrgan (SINTER x Elixis)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sinter-name-test-'));
    mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
    process.env.ELIXIS_HOME = join(cwd, 'no-repo'); // discipline repo absent in these tests
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('names an unnamed domain-best from engine variants and never renames', async () => {
    const art = join(cwd, 'art', 'champ1');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, 'prompt.txt'), 'ink wash calligraphy');
    writeFileSync(join(cwd, '.omx', 'atelier', 'best-per-domain.json'),
      JSON.stringify({ p5: { dir: art, mean: 3.74 } }));

    const fetchImpl = namingFetch([{ name: 'Inkfall', availability_score: 0.9, reasoning: 'Ink that falls like light.' }]);
    const r1 = await nameChampions(cwd, { fetchImpl });
    expect(r1.named).toHaveLength(1);
    expect(r1.named[0].plate.name).toBe('Inkfall');
    expect(r1.named[0].plate.discipline_pass).toBe(true);
    const stored = JSON.parse(readFileSync(join(cwd, '.omx', 'atelier', 'game', 'plates.json'), 'utf8'));
    expect(stored).toHaveLength(1);

    const r2 = await nameChampions(cwd, { fetchImpl: downFetch });
    expect(r2.named).toHaveLength(0);
    expect(r2.skipped).toBe('nothing to name');
  });

  it('declines when the engine returns no variants', async () => {
    const art = join(cwd, 'art', 'champ2');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(cwd, '.omx', 'atelier', 'best-per-domain.json'),
      JSON.stringify({ glsl: { dir: art, mean: 3.2 } }));
    const r = await nameChampions(cwd, { fetchImpl: namingFetch([]) });
    expect(r.named).toHaveLength(0);
  });

  it('skips gracefully when Elixis is down (organ never fatal)', async () => {
    const art = join(cwd, 'art', 'champ3');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(cwd, '.omx', 'atelier', 'best-per-domain.json'),
      JSON.stringify({ hydra: { dir: art, mean: 2.7 } }));
    const r = await nameChampions(cwd, { fetchImpl: downFetch });
    expect(r.elixisUp).toBe(false);
    expect(r.named).toHaveLength(0);
  });

  it('plate domain shaping: champions single-domain, moves carry both bead domains primary first', () => {
    expect(plateDomainsFor('best', 'p5')).toEqual(['p5']);
    expect(plateDomainsFor('move', 'p5xhydra', { domainA: 'p5', domainB: 'hydra' })).toEqual(['p5', 'hydra']);
    expect(plateDomainsFor('move', 'strudelxtone', { domainA: 'strudel', domainB: 'tone' })[0]).toBe('strudel');
  });

  it('plates it writes carry a domains array (champion + move)', async () => {
    // champion plate
    const art = join(cwd, 'art', 'champ-domains');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, 'prompt.txt'), 'tin soldiers marching');
    writeFileSync(join(cwd, '.omx', 'atelier', 'best-per-domain.json'),
      JSON.stringify({ three: { dir: art, mean: 3.4 } }));
    // move plate
    const gameDir = join(cwd, '.omx', 'atelier', 'game');
    mkdirSync(gameDir, { recursive: true });
    writeFileSync(join(gameDir, 'moves.json'), JSON.stringify([
      { at: '2026-08-30T10:00:00Z', kind: 'pairing', thread: { a: 'a', b: 'b', domainA: 'three', domainB: 'glsl', similarity: 0.996 }, output: 'm.md' },
    ]));

    const r = await nameChampions(cwd, { fetchImpl: namingFetch([{ name: 'Tinwork', availability_score: 0.9, reasoning: '' }]), maxPerWave: 2 });
    expect(r.named).toHaveLength(2);
    const champion = r.named.find(e => e.kind === 'best');
    const move = r.named.find(e => e.kind === 'move');
    expect(champion?.domains).toEqual(['three']);
    expect(move?.domains).toEqual(['three', 'glsl']); // primary (domainA) first
    const stored = JSON.parse(readFileSync(join(gameDir, 'plates.json'), 'utf8'));
    for (const entry of stored) expect(Array.isArray(entry.domains)).toBe(true);
  });

  it('semantically confirms the latest thread once, counting isomorphic + cross-domain', async () => {
    const dirA = join(cwd, 'art', 'a'); const dirB = join(cwd, 'art', 'b');
    for (const d of [dirA, dirB]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'source.txt'), 's("x").gain(0.2)'); }
    const gameDir = join(cwd, '.omx', 'atelier', 'game');
    mkdirSync(gameDir, { recursive: true });
    writeFileSync(join(gameDir, 'beads.json'), JSON.stringify([{ id: 'a', dir: dirA, domain: 'strudel' }, { id: 'b', dir: dirB, domain: 'tone' }]));
    writeFileSync(join(gameDir, 'moves.json'), JSON.stringify([{ at: '2026-08-29T23:00:00Z', kind: 'duet', thread: { a: 'a', b: 'b', domainA: 'strudel', domainB: 'tone', similarity: 0.99 } }]));

    const r1 = await confirmThreadSemantically(cwd, { fetchImpl: namingFetch([]) });
    expect(r1).toMatchObject({ confirmed: true, threads: 5 }); // 2 isomorphic + 3 cross-domain
    const moves = JSON.parse(readFileSync(join(gameDir, 'moves.json'), 'utf8'));
    expect(moves[0].semantic.confirmed).toBe(true);
    expect(await confirmThreadSemantically(cwd, { fetchImpl: namingFetch([]) })).toBeNull();
  });
});
