import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { QualityArchive, type ArchiveEntry } from '../../src/learning/QualityArchive.js';
import { createCreativeLabelAdmission } from '../../src/learning/CreativeLabelAdmission.js';

const entry = (id: string, qualityScore = 0.8, domain = 'p5'): ArchiveEntry => ({
  id, domain, prompt: `prompt ${id}`, output: `output ${id}`, qualityScore,
  metadata: {}, createdAt: '2026-11-11T00:00:00.000Z',
});

async function idsOnDisk(path: string, domain = 'p5'): Promise<string[]> {
  const data = JSON.parse(await readFile(path, 'utf8')) as { archives: Record<string, ArchiveEntry[]> };
  return (data.archives[domain] ?? []).map(e => e.id).sort();
}

describe('QualityArchive concurrent writers', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qa-conc-'));
    path = join(dir, 'archive.json');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('keeps both entries when two instances loaded the same empty archive', async () => {
    const a = new QualityArchive({ path });
    const b = new QualityArchive({ path });
    await a.load(); await b.load();
    await a.add(entry('A'));
    await b.add(entry('B'));
    expect(await idsOnDisk(path)).toEqual(['A', 'B']);
    expect(b.getAll('p5').map(e => e.id).sort()).toEqual(['A', 'B']);
  });

  it('keeps every interleaved add and still trims to the best scores', async () => {
    const a = new QualityArchive({ path, maxExamplesPerDomain: 6 });
    const b = new QualityArchive({ path, maxExamplesPerDomain: 6 });
    await a.load(); await b.load();
    await Promise.all([
      ...[1, 3, 5, 7, 9].map(i => a.add(entry(`a${i}`, i / 10))),
      ...[2, 4, 6, 8, 10].map(i => b.add(entry(`b${i}`, i / 10))),
    ]);
    expect(await idsOnDisk(path)).toEqual(['a5', 'a7', 'a9', 'b10', 'b6', 'b8']);
  });

  it('a stale end-of-run save() does not drop entries another writer added', async () => {
    const run = new QualityArchive({ path });
    const other = new QualityArchive({ path });
    await run.load(); await other.load();
    await other.add(entry('other'));
    await run.save();
    expect(await idsOnDisk(path)).toEqual(['other']);
  });

  it('usage, rating and rescore changes from a stale instance land on the fresh data', async () => {
    const a = new QualityArchive({ path });
    const b = new QualityArchive({ path });
    await a.load(); await b.load();
    await a.add(entry('X', 0.7));
    await b.recordUsage('X');
    await b.addUserRating('X', 4);
    expect(await b.rescoreEntry('X', 0.9, 'judge-v2')).toBe(true);
    expect(await b.rescoreEntry('missing', 0.9, 'judge-v2')).toBe(false);
    const fresh = new QualityArchive({ path });
    await fresh.load();
    const x = fresh.getById('X')!;
    expect([x.usedCount, x.userRating, x.qualityScore]).toEqual([1, 4, 0.9]);
  });

  it('refuses to write while the file on disk is unreadable', async () => {
    const a = new QualityArchive({ path });
    await a.load();
    // A directory at the archive path is unreadable as a file, even for root.
    const { mkdir, stat } = await import('node:fs/promises');
    await mkdir(path);
    await expect(a.add(entry('A'))).rejects.toThrow('ARCHIVE_RECOVERY_REQUIRED');
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it('keeps a creative label through a reload so the exemplar can still teach', async () => {
    const output = 'output L';
    const labelled: ArchiveEntry = { ...entry('L'), output,
      creativeLabel: createCreativeLabelAdmission({ trustKind: 'universal-criterion',
        allowedUses: ['few-shot'], artifactDigest: createHash('sha256').update(output).digest('hex'),
        evidenceDigest: 'b'.repeat(64), decisionDigest: 'c'.repeat(64), rendered: true,
        identityValid: true, digestMatched: true, degraded: false }) };
    await new QualityArchive({ path }).add(labelled);
    const reloaded = new QualityArchive({ path });
    await reloaded.load();
    expect(QualityArchive.isTeachingEligible(reloaded.getById('L')!, 'few-shot')).toBe(true);
  });

  it('keeps every entry when two OS processes add at the same time', async () => {
    const root = resolve(__dirname, '../..');
    const script = join(dir, 'writer.mts');
    await writeFile(script, `
      import { QualityArchive } from ${JSON.stringify(join(root, 'src/learning/QualityArchive.ts'))};
      const [path, tag] = process.argv.slice(2);
      const archive = new QualityArchive({ path, maxExamplesPerDomain: 100 });
      await archive.load();
      for (let i = 0; i < 12; i++) {
        await archive.add({ id: tag + i, domain: 'p5', prompt: 'p', output: 'o' + tag + i,
          qualityScore: 0.8, metadata: {}, createdAt: '2026-11-11T00:00:00.000Z' });
      }
    `);
    const runWriter = (tag: string) => new Promise<number>((done, fail) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, path, tag],
        { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', d => { err += String(d); });
      child.on('error', fail);
      child.on('exit', code => (code === 0 ? done(code) : fail(new Error(`writer ${tag} exited ${code}: ${err}`))));
    });
    await Promise.all([runWriter('p'), runWriter('q')]);
    const ids = await idsOnDisk(path);
    expect(ids.length).toBe(24);
    expect(ids.filter(id => id.startsWith('p')).length).toBe(12);
  }, 60_000);
});
