import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { migrateConfigHome } from '../../../src/config/migrateConfigHome.js';
import { loadConfig } from '../../../src/config/ConfigLoader.js';

describe('migrateConfigHome', () => {
  let home: string;
  const legacy = () => path.join(home, '.liminal');
  const sinter = () => path.join(home, '.sinter');

  // The old folder cannot be moved (another drive); everything else works.
  const crossDevice = () => ({
    ...fs,
    renameSync: (from: string, to: string) => {
      if (from === legacy()) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      fs.renameSync(from, to);
    },
  }) as unknown as typeof fs;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-home-'));
    fs.mkdirSync(path.join(legacy(), 'keys'), { recursive: true });
    fs.writeFileSync(path.join(legacy(), 'config.json'), '{"defaultProvider":"lmstudio","providers":{}}');
    fs.writeFileSync(path.join(legacy(), 'keys', 'host.key'), 'k');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('leaves files alone for --help and --version', () => {
    expect(migrateConfigHome(home, ['--help'])).toBe('skipped');
    expect(migrateConfigHome(home, ['generate', '--version'])).toBe('skipped');
    expect(fs.existsSync(legacy())).toBe(true);
    expect(fs.existsSync(sinter())).toBe(false);
  });

  it('moves the whole legacy folder on a real command', () => {
    expect(migrateConfigHome(home, ['gallery'])).toBe('moved');
    expect(fs.readFileSync(path.join(sinter(), 'keys', 'host.key'), 'utf8')).toBe('k');
    expect(fs.existsSync(legacy())).toBe(false);
  });

  it('copies everything and keeps the original when the move fails', () => {
    expect(migrateConfigHome(home, ['gallery'], crossDevice())).toBe('copied');
    expect(fs.readFileSync(path.join(sinter(), 'keys', 'host.key'), 'utf8')).toBe('k');
    expect(fs.readFileSync(path.join(sinter(), 'config.json'), 'utf8')).toBe('{"defaultProvider":"lmstudio","providers":{}}');
    expect(fs.existsSync(path.join(legacy(), 'keys', 'host.key'))).toBe(true);
  });

  it('removes a half copy so the next run tries again', () => {
    const halfCopy = {
      ...crossDevice(),
      cpSync: (_from: string, to: string) => {
        fs.mkdirSync(to);
        fs.writeFileSync(path.join(to, 'config.json'), '{}');
        throw new Error('disk full');
      },
    } as unknown as typeof fs;
    expect(migrateConfigHome(home, ['gallery'], halfCopy)).toBe('failed');
    expect(fs.readdirSync(home)).toEqual(['.liminal']);
    expect(migrateConfigHome(home, ['gallery'])).toBe('moved');
  });

  it('keeps ~/.sinter when another Sinter process finishes the move first', () => {
    // Both processes saw the old folder and no ~/.sinter; the other one moves it
    // just before this one tries.
    const lostTheRace = {
      ...fs,
      renameSync: (from: string, to: string) => {
        fs.renameSync(from, to);
        throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
      },
    } as unknown as typeof fs;
    expect(migrateConfigHome(home, ['gallery'], lostTheRace)).toBe('none');
    expect(fs.readFileSync(path.join(sinter(), 'keys', 'host.key'), 'utf8')).toBe('k');
    expect(fs.readFileSync(path.join(sinter(), 'config.json'), 'utf8')).toBe('{"defaultProvider":"lmstudio","providers":{}}');
  });

  it('keeps the other copy when two processes copy at once', () => {
    const otherCopiedFirst = {
      ...crossDevice(),
      cpSync: (from: string, to: string, options: fs.CopySyncOptions) => {
        fs.cpSync(from, to, options);
        fs.cpSync(from, sinter(), options);
        fs.writeFileSync(path.join(sinter(), 'written-by-other'), 'x');
      },
    } as unknown as typeof fs;
    expect(migrateConfigHome(home, ['gallery'], otherCopiedFirst)).toBe('none');
    expect(fs.readFileSync(path.join(sinter(), 'written-by-other'), 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(sinter(), 'keys', 'host.key'), 'utf8')).toBe('k');
    expect(fs.readdirSync(home).sort()).toEqual(['.liminal', '.sinter']);
  });

  it('does nothing without a home, or when ~/.sinter already exists', () => {
    expect(migrateConfigHome(undefined, ['gallery'])).toBe('none');
    fs.mkdirSync(sinter());
    expect(migrateConfigHome(home, ['gallery'])).toBe('none');
    expect(fs.existsSync(legacy())).toBe(true);
  });

  it('carries keys across when Studio or a library loads the config and the move fails', async () => {
    // loadConfig is the door Studio and library callers use; it never passes through bin/sinter.
    const realHome = process.env.HOME;
    const realRename = fs.renameSync;
    const exdev = () => Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(exdev());
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === legacy()) throw exdev();
      realRename(from, to);
    });
    process.env.HOME = home;
    try {
      const result = await loadConfig(path.join(sinter(), 'config.json'));
      expect(result.isOk() && result.value.defaultProvider).toBe('lmstudio');
      expect(fs.readFileSync(path.join(sinter(), 'keys', 'host.key'), 'utf8')).toBe('k');
      expect(fs.existsSync(path.join(legacy(), 'keys', 'host.key'))).toBe(true);
    } finally {
      process.env.HOME = realHome;
      vi.restoreAllMocks();
    }
  });

  it('keeps the legacy folder when the built CLI prints its version', () => {
    const out = execFileSync('node', ['bin/sinter', '--version'], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out.trim()).toMatch(/\d+\.\d+\.\d+/);
    expect(fs.existsSync(legacy())).toBe(true);
    expect(fs.existsSync(sinter())).toBe(false);
  });
});
