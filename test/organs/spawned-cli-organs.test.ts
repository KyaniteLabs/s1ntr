/**
 * RAN proof: organs exercised in a spawned `bin/sinter generate` child against a local fake HTTP provider,
 * with the real headless renderer. (The legacy multi-iteration loop is not reachable here: spawned legacy
 * providers are blocked by "Provider transport requires Liminal product command authority", by design;
 * loop carry-over is proven in loop-carry-organ.test.ts at the model seam.)
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, LIVELY_HTML } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });
const SVG = '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="#223344"/><circle cx="70" cy="80" r="40" fill="#4a7a9a"/><rect x="100" y="90" width="70" height="60" fill="#c8a45a"/><path d="M10 180 Q100 120 190 180" stroke="#e8e0d0" stroke-width="4" fill="none"/></svg>';
let work: string; let n = 0;
beforeAll(() => { work = mkdtempSync(path.join(tmpdir(), 'organ-spawned-')); });
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

async function create(domain: string, code: string, judgeScore = 0.8) {
  const fake = await startFakeProvider({ generate: () => code, judge: () => goodJudgeReply(judgeScore) });
  try {
    const i = n++;
    const env = fakeProviderEnv(fake, { home: path.join(work, `h${i}`), stateRoot: path.join(work, `s${i}`) });
    const out = path.join(work, `o${i}`);
    const run = await runSinterAsync(['generate', '-o', out, '--domain', domain, 'a calm study in two shapes'], env);
    return { run, fake: { generated: [...fake.generated], judged: [...fake.judged] }, saved: /Saved: (\S+)/.exec(run.out)?.[1] };
  } finally { await fake.close(); }
}

describe('organs ran in a spawned CLI (fake provider, real renderer)', () => {
  it('generators + runtime-core + render + perception + judge: html run is accepted after the judge sees frames', async () => {
    const r = await create('html', LIVELY_HTML);
    expect(r.run.status, r.run.out.slice(-600)).toBe(0);
    expect(r.saved && existsSync(r.saved)).toBe(true);
    expect(r.fake.generated.length).toBe(1);
    expect(r.fake.judged[0]?.images).toBeGreaterThan(0);
  });
  it('generators: the medium changes the generator brief (svg vs html)', async () => {
    const a = await create('html', LIVELY_HTML); const b = await create('svg', SVG);
    expect(a.fake.generated[0].system).not.toBe(b.fake.generated[0].system);
  });
  it('creative-vocabulary: the library cards reach the generator brief; the judge brief carries the score bands', async () => {
    const r = await create('html', LIVELY_HTML);
    expect(r.fake.generated[0].system).toContain('OPTIONAL LIBRARY CAPABILITIES');
    expect(r.fake.generated[0].system).toContain('d3-delaunay');
    expect(r.fake.judged[0].system).toContain('Score bands');
  });
  it('judge score decides admission: a weak judge verdict is not accepted', async () => {
    const r = await create('html', LIVELY_HTML, 0.05);
    expect(r.run.status).not.toBe(0);
    expect(r.run.out).not.toMatch(/Generation complete/);
  });
});
