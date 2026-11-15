import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FragmentArchive } from '../../../src/scavenger/fragments/FragmentArchive.js';

describe('scavenger prompt classification', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('preserves source digest and taint instead of score-sorted truth', async () => {
    dir = await mkdtemp(join(tmpdir(), 'scavenger-class-'));
    const file = join(dir, 'fragments.json');
    await writeFile(file, JSON.stringify({ version: '1', extracted: '', source: 'legacy',
      sourceFiles: 1, curator: 'test', description: '', categories: { prompt_seeds: {
        description: 'legacy', fragments: [{ id: 'high', content: 'high scalar seed',
          source: 'rejected', score: 10 }] } } }));
    const archive = new FragmentArchive(file);
    await archive.load();
    const seed = archive.getPromptSeeds()[0]!;
    expect(seed.creativeInput).toMatchObject({ category: 'tainted-exploration',
      taint: 'unknown', content: 'high scalar seed' });
    expect(seed.creativeInput?.category === 'tainted-exploration'
      ? seed.creativeInput.ancestorDigests[0] : '').toMatch(/^[a-f0-9]{64}$/);
    expect(archive.randomPromptSeed()?.category).toBe('tainted-exploration');
  });
});
