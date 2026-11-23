import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SinterFS } from '../../../src/fs/SinterFS.js';
import { EmergenceHooks } from '../../../src/emergence/EmergenceHooks.js';
import { PreferenceDatasetBuilder } from '../../../src/learning/PreferenceDatasetBuilder.js';
import { ingestGovernedOutputs, governedOutputKey, type GovernedOutputRow }
  from '../../../src/emergence/GovernedOutputIngest.js';

const sources: Record<string, string> = {
  a: 'function setup(){createCanvas(400,400)}function draw(){background(10);ellipse(200,200,50,50)}',
  b: 'function setup(){createCanvas(400,400);noLoop()}function draw(){for(let i=0;i<400;i+=4){line(i,0,400-i,400)}}',
  c: 'void main(){}',
};
const row = (id: string, score: number, extra: Partial<GovernedOutputRow> = {}): GovernedOutputRow => ({
  run_dir: `out/m/${id}/`, finished_utc: '2026-11-17T00:00:00Z', model: 'glm/flash', domain: 'p5',
  score, admission_eligible: true, degraded: false, artifact_digest: id.repeat(64).slice(0, 64),
  source_path: `/virtual/${id}.txt`, ...extra });

describe('governed output ingest into the taste archive', () => {
  let root: string; let fs: SinterFS; let prev: string | undefined;
  beforeEach(() => { prev = process.env.SINTER_PROJECT_ROOT;
    root = mkdtempSync(join(tmpdir(), 'ingest-')); process.env.SINTER_PROJECT_ROOT = root;
    fs = SinterFS.open(root); });
  afterEach(() => { fs.close(); rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SINTER_PROJECT_ROOT; else process.env.SINTER_PROJECT_ROOT = prev; });
  const read = (p: string) => sources[p.match(/\/virtual\/(\w)/)![1]!] ?? '';

  it('archives only admission-eligible, non-degraded rows and is idempotent', async () => {
    const hooks = new EmergenceHooks(fs, { minQuality: 0 });
    const rows = [row('a', 0.8), row('b', 0.4), row('c', 0.9, { admission_eligible: false }),
      row('d', 0.9, { degraded: true, source_path: '/virtual/a.txt' }),
      row('e', 0.9, { score: undefined as never, source_path: '/virtual/a.txt' })];
    const first = await ingestGovernedOutputs(hooks, rows, new Set(), read);
    expect(first.ingested.sort()).toEqual([governedOutputKey(rows[0]!), governedOutputKey(rows[1]!)].sort());
    expect(first.skipped).toBe(3);
    const second = await ingestGovernedOutputs(hooks, rows, new Set(first.ingested), read);
    expect(second.ingested).toEqual([]);
  });

  it('gives taste train score-gap pseudo pairs, never human labels', async () => {
    const hooks = new EmergenceHooks(fs, { minQuality: 0 });
    await ingestGovernedOutputs(hooks, [row('a', 0.9), row('b', 0.3)], new Set(), read);
    const elites = new EmergenceHooks(fs, { minQuality: 0 }).getArchive().getAllElites();
    expect(elites.length).toBe(2);
    const dataset = new PreferenceDatasetBuilder().build(elites);
    expect(dataset.pairs.length).toBeGreaterThan(0);
    expect(dataset.pairs.every(p => p.channel === 'pseudo')).toBe(true);
  });

  it('skips rows whose source cannot be read instead of failing the batch', async () => {
    const hooks = new EmergenceHooks(fs, { minQuality: 0 });
    const out = await ingestGovernedOutputs(hooks, [row('a', 0.8)], new Set(), () => { throw new Error('ENOENT'); });
    expect(out.ingested).toEqual([]); expect(out.failed).toBe(1);
  });
});
