import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNameCommand } from '../../../src/cli/NameCli.js';

describe('runNameCommand', () => {
  let dir: string;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'name-cli-'));
    logs = [];
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedChampion(): void {
    const atelier = join(dir, '.omx', 'atelier');
    mkdirSync(join(atelier, 'game'), { recursive: true });
    writeFileSync(join(atelier, 'best-per-domain.json'), JSON.stringify({ svg: { dir: join(dir, 'none'), mean: 4.25 } }));
  }

  it('reports "nothing to name" on an empty workspace without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await runNameCommand();
    expect(logs).toEqual(['[name] nothing to name']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips plates and exits cleanly when elixis is unreachable', async () => {
    seedChampion();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await runNameCommand();
    expect(logs).toEqual(['[name] elixis unreachable — plates skipped this wave (organ never fatal)']);
  });

  it('prints one line per plate and persists the plate when the engine answers', async () => {
    seedChampion();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ variants: [{ name: 'Ember Lattice', availability_score: 0.9, reasoning: 'warm grid' }] }),
    }));
    await runNameCommand();
    const plateLine = logs.find(l => l.startsWith('[name] best svg'));
    expect(plateLine).toBe('[name] best svg -> "Ember Lattice" · silk "SVG · CRAFT 4.3 · RECEIPTS" · warm grid');
    const saved = JSON.parse(readFileSync(join(dir, '.omx', 'atelier', 'game', 'plates.json'), 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].plate.name).toBe('Ember Lattice');
  });
});
