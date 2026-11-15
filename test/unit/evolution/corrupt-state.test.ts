import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AestheticModel } from '../../../src/evolution/AestheticModel.js';
import { MapElites } from '../../../src/evolution/MapElites.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'liminal-corrupt-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('corrupt evolution state', () => {
  it('quarantines a corrupt aesthetic model and refuses to overwrite it', async () => {
    const dir = await tempDir();
    const file = join(dir, 'aesthetic_model.json');
    await writeFile(file, '{"broken"');

    const model = new AestheticModel();
    await expect(model.load(file)).rejects.toThrow(/AESTHETIC_MODEL_CORRUPT/);
    await model.save(file);

    expect(await readdir(dir)).toContainEqual(expect.stringMatching(/aesthetic_model\.json\.corrupt\./));
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });


  it('quarantines a schema-invalid aesthetic model instead of accepting it', async () => {
    const dir = await tempDir();
    const file = join(dir, 'aesthetic_model.json');
    await writeFile(file, '{"behavior":[1],"rating":3}');

    const model = new AestheticModel();
    await expect(model.load(file)).rejects.toThrow(/AESTHETIC_MODEL_CORRUPT/);
    expect(await readdir(dir)).toContainEqual(expect.stringMatching(/aesthetic_model\.json\.corrupt\./));
  });

  it('starts empty when the aesthetic model is absent and saves atomically', async () => {
    const dir = await tempDir();
    const file = join(dir, 'aesthetic_model.json');
    const model = new AestheticModel();

    await model.load(file);
    await model.save(file);

    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([]);
  });

  it('quarantines a corrupt MAP-Elites archive and refuses to overwrite it', async () => {
    const dir = await tempDir();
    const file = join(dir, 'map_elites.json');
    await writeFile(file, '{"cells": [');

    const archive = new MapElites();
    await expect(archive.load(file)).rejects.toThrow(/MAP_ELITES_CORRUPT/);
    await archive.save(file);

    expect(await readdir(dir)).toContainEqual(expect.stringMatching(/map_elites\.json\.corrupt\./));
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['empty object', '{}'],
    ['non-array dims', '{"dims":"10x10","cells":[]}'],
    ['zero-sized dim', '{"dims":[10,0],"cells":[]}'],
    ['cells not an array', '{"dims":[2,2],"cells":{"0,0":{}}}'],
    ['cell missing fitness', '{"dims":[2,2],"cells":[["0,0",{"creationId":"c1","behavior":[0.1,0.2]}]]}'],
    ['non-finite behavior', '{"dims":[2,2],"cells":[["0,0",{"creationId":"c1","fitness":1,"behavior":["x"]}]]}'],
  ])('quarantines a schema-invalid MAP-Elites archive (%s) and refuses to overwrite it', async (_label, body) => {
    const dir = await tempDir();
    const file = join(dir, 'map_elites.json');
    await writeFile(file, body);

    const archive = new MapElites([2, 2]);
    await expect(archive.load(file)).rejects.toThrow(/MAP_ELITES_CORRUPT: .*schema-invalid archive/);
    await archive.save(file);

    const entries = await readdir(dir);
    const quarantined = entries.filter(e => e.startsWith('map_elites.json.corrupt.'));
    expect(quarantined.length).toBe(1);
    expect(await readFile(join(dir, quarantined[0]), 'utf-8')).toBe(body);
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips a valid MAP-Elites archive without quarantine', async () => {
    const dir = await tempDir();
    const file = join(dir, 'map_elites.json');
    const original = new MapElites([2, 2]);
    original.insert('c1', [0.1, 0.9], 0.7);
    await original.save(file);

    const loaded = new MapElites([5, 5]);
    await loaded.load(file);

    expect(loaded.getAllCells().map(c => [c.creationId, c.fitness])).toEqual([['c1', 0.7]]);
    expect(await readdir(dir)).toEqual(['map_elites.json']);
  });

  it('starts empty when the MAP-Elites archive is absent and saves atomically', async () => {
    const dir = await tempDir();
    const file = join(dir, 'map_elites.json');
    const archive = new MapElites();

    await archive.load(file);
    await archive.save(file);

    const parsed = JSON.parse(await readFile(file, 'utf-8')) as { cells: unknown[] };
    expect(parsed.cells).toEqual([]);
  });
});
