import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedArchive } from '../../src/gallery/SeedArchive.js';

describe('SeedArchive entry integrity', () => {
  let directory: string;
  let archive: SeedArchive;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'seed-integrity-'));
    archive = new SeedArchive(directory);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps the requested seed identity when metadata has a seed field', async () => {
    await archive.saveSeed('requested-seed', { seed: 'different-seed', prompt: 'quiet' });
    expect(await archive.loadSeed('requested-seed'))
      .toEqual({ seed: 'requested-seed', prompt: 'quiet' });
  });

  it.each([null, 7, 'text', [], { seed: 'other' }, { prompt: 'missing seed' }])(
    'rejects parsed data that is not the requested seed entry (%j)', async data => {
      await fs.writeFile(join(directory, 'requested-seed.json'), JSON.stringify(data));
      await expect(archive.loadSeed('requested-seed'))
        .rejects.toThrow('Seed archive entry does not match requested seed');
    });

  it('preserves read failures instead of reporting a missing entry', async () => {
    await archive.saveSeed('requested-seed', { prompt: 'quiet' });
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(failure);
    await expect(archive.loadSeed('requested-seed')).rejects.toBe(failure);
  });

  it('rejects an identity inherited from Object.prototype', async () => {
    await fs.writeFile(join(directory, 'requested-seed.json'), '{}');
    Object.defineProperty(Object.prototype, 'seed', {
      value: 'requested-seed', configurable: true,
    });
    try {
      await expect(archive.loadSeed('requested-seed'))
        .rejects.toThrow('Seed archive entry does not match requested seed');
    } finally {
      Reflect.deleteProperty(Object.prototype, 'seed');
    }
  });
});
