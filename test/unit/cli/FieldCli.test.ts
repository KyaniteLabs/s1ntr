// @no-cli-spawn: child_process is mocked; the CLI is never spawned
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: cp.execFileSync }));

import { runFieldCommand } from '../../../src/cli/FieldCli.js';

function unit(index: number): number[] {
  const v = new Array<number>(36).fill(0);
  v[index] = 1;
  return v;
}

describe('runFieldCommand', () => {
  let dir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-cli-'));
    mkdirSync(join(dir, '.omx', 'atelier', 'game'), { recursive: true });
    logs = [];
    errors = [];
    cp.execFileSync.mockReset();
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBeads(): void {
    writeFileSync(join(dir, '.omx', 'atelier', 'game', 'beads.json'), JSON.stringify([
      { id: 'bead-a', domain: 'svg', mean: 4, dir: join(dir, 'a'), lv: unit(0) },
      { id: 'bead-b', domain: 'p5', mean: 4.5, dir: join(dir, 'b'), lv: unit(1) },
    ]));
  }

  it('frontier on an empty board explains why nothing can be steered', async () => {
    await runFieldCommand([]);
    expect(logs).toEqual(['[field] no empty regions — board too thin to steer (fewer than 2 latent beads); it fills as waves complete']);
  });

  it('frontier lists the adjacent-possible pair with a ready-to-run interpolate hint', async () => {
    writeBeads();
    await runFieldCommand(['frontier']);
    expect(logs).toEqual([
      '[field] 1 frontier entries (adjacent possible):',
      '[field]   svg × p5 (min quality 4.00) -> interpolate bead-a bead-b 0.5',
    ]);
  });

  it('interpolate without two bead ids prints usage and exits 1', async () => {
    await expect(runFieldCommand(['interpolate', 'only-one'])).rejects.toThrow('exit:1');
    expect(errors).toEqual(['usage: sinter field interpolate <beadA> <beadB> [alpha]']);
    expect(cp.execFileSync).not.toHaveBeenCalled();
  });

  it('interpolate with unknown beads reports failure without calling the generator', async () => {
    writeBeads();
    await runFieldCommand(['interpolate', 'nope', 'bead-b']);
    expect(logs).toEqual(['[field] interpolation failed — beads not found, field not built, or generation failed']);
    expect(cp.execFileSync).not.toHaveBeenCalled();
  });

  it('interpolate births a hybrid when the (mocked) generator saves an artifact', async () => {
    writeBeads();
    cp.execFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'node') return 'Saved: /tmp/artifacts/hybridwork123456/source.txt\n';
      return 'console.log("hybrid")';
    });
    await runFieldCommand(['interpolate', 'bead-a', 'bead-b', '0.25']);
    expect(logs).toEqual([
      '[field] HYBRID BORN: hybrid-hybridwork12 (hybrid:svg+p5) at α=0.25 from bead-a × bead-b',
      '[field]   dir: /tmp/artifacts/hybridwork123456',
    ]);
    const nodeCall = cp.execFileSync.mock.calls[0];
    expect(nodeCall[0]).toBe('node');
    expect(nodeCall[1][0]).toBe('bin/sinter');
  });

  it('interpolate reports failure when the generator output has no Saved: line', async () => {
    writeBeads();
    cp.execFileSync.mockReturnValue('generation refused');
    await runFieldCommand(['interpolate', 'bead-a', 'bead-b']);
    expect(logs).toEqual(['[field] interpolation failed — beads not found, field not built, or generation failed']);
  });

  it('an unknown subcommand prints usage and exits 1', async () => {
    await expect(runFieldCommand(['wander'])).rejects.toThrow('exit:1');
    expect(errors).toEqual(['usage: sinter field [frontier|interpolate <a> <b> [alpha]]']);
  });
});
