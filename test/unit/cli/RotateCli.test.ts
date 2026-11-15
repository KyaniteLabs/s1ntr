import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: cp.execFileSync }));

import { runRotateCommand } from '../../../src/cli/RotateCli.js';

describe('runRotateCommand', () => {
  let dir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rotate-cli-'));
    mkdirSync(join(dir, '.omx', 'atelier', 'prompts'), { recursive: true });
    logs = [];
    errors = [];
    cp.execFileSync.mockReset();
    process.exitCode = undefined;
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMatrix(): void {
    writeFileSync(join(dir, '.omx', 'atelier', 'prompts', 'model-rotation.json'), JSON.stringify({
      me: {
        hostname: hostname(),
        models: [
          { id: 'glm-5.3', provider: 'openai', base: 'https://api.z.ai/api/coding/paas/v4' },
          { id: 'unknown-model', provider: 'openai', base: 'https://example.invalid/v1' },
        ],
      },
    }));
  }

  it('prints usage on stderr for an unknown subcommand', () => {
    runRotateCommand(['bogus']);
    expect(errors).toEqual(['usage: sinter rotate [next|audit|stats|record <model> <domain> <mean>]']);
  });

  it('record persists outcomes that stats then ranks by average score', () => {
    runRotateCommand(['record', 'glm-5.3', 'svg', '4']);
    runRotateCommand(['record', 'glm-5.3', 'svg', '3']);
    runRotateCommand(['record', 'other', 'p5', '2']);
    logs.length = 0;
    runRotateCommand(['stats']);
    expect(logs).toEqual([
      '[rotate] current: unknown',
      '  3.50  glm-5.3  (2 turns, best: svg)',
      '  2.00  other  (1 turns, best: p5)',
    ]);
  });

  it('record rejects a non-numeric mean with exit code 2 and records nothing', () => {
    runRotateCommand(['record', 'glm-5.3', 'svg', 'abc']);
    expect(errors).toEqual(['[rotate] record: mean must be a number']);
    expect(process.exitCode).toBe(2);
    expect(logs).toEqual([]);
  });

  it('record with too few arguments falls through to usage', () => {
    runRotateCommand(['record', 'glm-5.3']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('usage: sinter rotate');
  });

  it('audit with no matrix says so and exits 3', () => {
    cp.execFileSync.mockReturnValue('[]');
    runRotateCommand(['audit']);
    expect(logs).toEqual(['no rotation matrix for this machine']);
    expect(process.exitCode).toBe(3);
  });

  it('audit maps lanes to Dispatch executors and flags unmapped and dispatch-only rows', () => {
    writeMatrix();
    cp.execFileSync.mockReturnValue(JSON.stringify([
      { executor: 'zai-glm', available: true },
      { executor: 'agy-gemini-flash', available: true },
    ]));
    runRotateCommand(['audit']);
    expect(logs).toEqual([
      'available\tglm-5.3\tzai-glm',
      'unmapped\tunknown-model\tno exact Dispatch mapping',
      'dispatch-only\tagy-gemini-flash\tadapter review required',
    ]);
    expect(process.exitCode).toBe(3);
    expect(cp.execFileSync).toHaveBeenCalledWith('pushing-dispatch', ['doctor', '--json'], expect.any(Object));
  });

  it('audit marks lanes doctor-unavailable when Dispatch cannot be queried', () => {
    writeMatrix();
    cp.execFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    runRotateCommand(['audit']);
    expect(logs[0]).toBe('doctor-unavailable\tglm-5.3\tzai-glm');
    expect(process.exitCode).toBe(3);
  });

  it('next emits the first Dispatch-available lane as JSON', () => {
    writeMatrix();
    cp.execFileSync.mockReturnValue(JSON.stringify([{ executor: 'zai-glm', available: true }]));
    runRotateCommand(['next']);
    const lane = JSON.parse(logs[0]);
    expect(lane.modelId).toBe('glm-5.3');
    expect(lane.provider).toBe('openai');
  });

  it('next holds when no lane is available', () => {
    writeMatrix();
    cp.execFileSync.mockReturnValue(JSON.stringify([{ executor: 'zai-glm', available: false }]));
    runRotateCommand(['next']);
    expect(JSON.parse(logs[0])).toEqual({ modelId: 'hold', note: 'no Dispatch-available mapped rotation lane' });
  });
});
