/**
 * Organs that teach the generator: each one's state must change the brief the real production
 * generation sends to the generator seat. Disconnect the organ and the assertion fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOrganGeneration, type OrganRun } from './harness.js';

let cwd: string;
let baseline: OrganRun;
const runs: OrganRun[] = [];
async function run(input: Parameters<typeof runOrganGeneration>[0]) {
  const r = await runOrganGeneration({ cwd, ...input }); runs.push(r); return r;
}

beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'organ-cwd-'));
  baseline = await run({});
}, 180_000);
afterAll(async () => {
  for (const r of runs) await r.cleanup();
  await rm(cwd, { recursive: true, force: true });
});

describe('brief organs (production generation)', () => {
  it('baseline run reaches the judge with a scored evaluation', () => {
    expect(baseline.generatorCalls.length).toBeGreaterThan(0);
    expect(baseline.judgeCalls.length).toBeGreaterThan(0);
    expect(baseline.evaluation.score).toBeGreaterThan(0);
  });

  it('lessons organ: .omx/atelier/lessons/hints.json lands in the generator brief', async () => {
    const marker = 'ORGAN-LESSON-MARKER-7f3a';
    await mkdir(path.join(cwd, '.omx/atelier/lessons'), { recursive: true });
    await writeFile(path.join(cwd, '.omx/atelier/lessons/hints.json'),
      JSON.stringify([{ id: 'organ_probe', text: marker, domains: 'all' }]));
    const taught = await run({});
    await rm(path.join(cwd, '.omx/atelier/lessons'), { recursive: true, force: true });
    expect(baseline.systemPrompt).not.toContain(marker);
    expect(taught.systemPrompt).toContain(marker);
  }, 180_000);

  it('best-per-domain organ: the recorded best piece is shown as the exemplar', async () => {
    const marker = 'ORGAN-ANCHOR-MARKER-91bc';
    const dir = path.join(cwd, 'best-html');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'source.txt'), `<!-- ${marker} -->`);
    await mkdir(path.join(cwd, '.omx/atelier'), { recursive: true });
    await writeFile(path.join(cwd, '.omx/atelier/best-per-domain.json'),
      JSON.stringify({ html: { dir, mean: 4.5, scoreScale: 5 } }));
    const taught = await run({});
    await rm(path.join(cwd, '.omx/atelier/best-per-domain.json'), { force: true });
    expect(baseline.systemPrompt).not.toContain(marker);
    expect(taught.systemPrompt).toContain(marker);
  }, 180_000);

  it('retrieval-exemplar organ: SINTER_EXEMPLARS_FILE lands in the generator brief', async () => {
    const marker = 'ORGAN-EXEMPLAR-MARKER-c0de';
    const file = path.join(cwd, 'exemplars.json');
    await writeFile(file, JSON.stringify({ exemplars: [{ domain: 'html', score: 0.9, liked: true, code: `<!-- ${marker} -->` }] }));
    const taught = await run({ env: { SINTER_EXEMPLARS_FILE: file } });
    expect(baseline.systemPrompt + baseline.userPrompt).not.toContain(marker);
    expect(taught.systemPrompt + taught.userPrompt).toContain(marker);
  }, 180_000);
});
