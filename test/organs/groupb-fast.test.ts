/**
 * Organ group B, fast spawned proofs (built bin/sinter; only `market smoke` makes one fake-provider call):
 * export (a validated file is packaged; bad code is refused), release (the gate flips with repo state),
 * reporting (report output follows the policy manifest), product (gallery builder + the garden report that uses it),
 * market (smoke receipt written from a real fake-provider answer; a non-code answer fails it).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

const P5 = `function setup(){ createCanvas(400, 400); noStroke(); }
function draw(){ background(10, 20, 40); for (let i = 0; i < 40; i++) { fill(80 + i * 4, 200, 255 - i * 3, 180); circle(200 + 150 * Math.cos(frameCount * 0.02 + i), 200 + 150 * Math.sin(frameCount * 0.02 + i), 14); } }`;

let work: string; let fake: FakeProvider; let n = 0; let answer = P5;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-groupb-fast-'));
  fake = await startFakeProvider({ generate: () => answer });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });
const env = () => { const i = n++; return fakeProviderEnv(fake, { home: path.join(work, `home${i}`), stateRoot: path.join(work, `state${i}`) }); };
const inDir = (name: string) => { const d = path.join(work, name); mkdirSync(d, { recursive: true }); return d; };

describe('export: a piece is packaged only after its code validates', () => {
  it('html, js and zip are written from a good file; too-small code is refused and writes nothing', async () => {
    const d = inDir('export'); const good = path.join(d, 'piece.js'); const bad = path.join(d, 'bad.js');
    writeFileSync(good, P5); writeFileSync(bad, 'function setup(){}');
    const e = env();
    const html = await runSinterAsync(['export', 'html', good, '-o', path.join(d, 'o.html')], e);
    expect(html.status, html.out).toBe(0);
    const page = readFileSync(path.join(d, 'o.html'), 'utf8');
    expect(page).toContain('createCanvas(400, 400)'); expect(page.toLowerCase()).toContain('<html');
    expect((await runSinterAsync(['export', 'js', good, '-o', path.join(d, 'o.js')], e)).status).toBe(0);
    expect((await runSinterAsync(['export', 'zip', good, '-o', path.join(d, 'o.zip')], e)).status).toBe(0);
    expect(readFileSync(path.join(d, 'o.zip')).subarray(0, 2).toString()).toBe('PK');
    const refused = await runSinterAsync(['export', 'html', bad, '-o', path.join(d, 'bad.html')], e);
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/Code validation failed/);
    expect(existsSync(path.join(d, 'bad.html'))).toBe(false);
  });
});

describe('release: the gate flips when repo state changes', () => {
  it('a temp repo with every domain implementation file passes; deleting one makes the gate fail and exit 1', async () => {
    const { CREATIVE_DOMAIN_GAUNTLET_DOMAINS } = await import('../../src/runtime-core/CreativeDomainGauntlet.js');
    const root = inDir('gate-repo');
    for (const dom of CREATIVE_DOMAIN_GAUNTLET_DOMAINS) for (const f of dom.implementationFiles) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), '// stub\n'); }
    const run = async () => { const r = await runSinterAsync(['release', 'gate', '--dry-run', '--repo-root', root], env()); return { r, json: JSON.parse(r.out.slice(r.out.indexOf('{'))) }; };
    const before = await run();
    expect(before.json.checks.find((c: { id: string }) => c.id === 'creative-domain-gauntlet').status).toBe('pass');
    expect(before.json.ready, before.r.out).toBe(true); expect(before.r.status).toBe(0);
    rmSync(path.join(root, 'src/generators/svg/SVGGenerator.ts'));
    const after = await run();
    expect(after.json.checks.find((c: { id: string }) => c.id === 'creative-domain-gauntlet').status).toBe('fail');
    expect(after.json.ready).toBe(false); expect(after.r.status).toBe(1);
  });
});

describe('reporting: `report provenance` and `report readiness` follow the policy manifest', () => {
  it('a staged garden change appears in the report; before it the report says none', async () => {
    const e = { ...env(), SINTER_GARDEN_MANIFEST_PATH: path.join(inDir('manifest'), 'policy-manifest.json') };
    const empty = await runSinterAsync(['report', 'provenance'], e);
    expect(empty.status, empty.out).toBe(0);
    expect(empty.out).toMatch(/Garden stable/);
    const staged = await runSinterAsync(['ship', 'garden', 'stage', 'taste', 'raise', 'novelty', '--before', 'quality=0.5'], e);
    expect(staged.status, staged.out).toBe(0);
    const after = await runSinterAsync(['report', 'provenance'], e);
    expect(after.out).toMatch(/1 policy changes tracked, 0 promoted/);
    await runSinterAsync(['ship', 'garden', 'promote', 'change-1', '--after', 'quality=0.6'], e);
    const promoted = await runSinterAsync(['report', 'provenance'], e);
    expect(promoted.out).toMatch(/1 policy changes tracked, 1 promoted/);
    expect((await runSinterAsync(['report', 'readiness'], e)).out).not.toBe(empty.out);
  });
});

describe('product: the gallery builder ranks and groups archive cells, and the garden report prints its summary', () => {
  it('ranks by quality, groups by provenance, and `report garden` shows the gallery line', async () => {
    const { GalleryBuilder } = await import('../../src/product/GalleryBuilder.js');
    const mk = (id: string, q: number, prov: string) => ({ entryId: id, qualityScore: q, signals: { novelty: q }, lineage: { provenance: prov } });
    const cell = (id: string, elite: unknown, near: unknown[] = []) => ({ cellId: id, elite, nearElites: near });
    const g = new GalleryBuilder().build([cell('a', mk('x', 0.4, 'seed')), cell('b', mk('y', 0.9, 'mutation'), [mk('z', 0.6, 'seed')])] as never);
    expect(g.totalItems).toBe(3); expect(g.topItem?.entry.entryId).toBe('y'); expect(g.groups.length).toBe(2);
    expect(new GalleryBuilder().build([]).totalItems).toBe(0);
    const out = await runSinterAsync(['report', 'garden'], env(), inDir('garden'));
    expect(out.status, out.out).toBe(0);
    expect(out.out).toMatch(/Gallery: \d+ items in \d+ groups/);
  });
});

describe('market: `market smoke` turns one provider answer into the smoke receipt', () => {
  it('usable p5 code passes and writes the receipt; a non-code answer fails with a blocker and exit 1', async () => {
    const root = inDir('market-pass'); const e = env();
    answer = P5;
    const ok = await runSinterAsync(['market', 'smoke', '--repo-root', root], e);
    expect(ok.status, ok.out).toBe(0);
    const receipt = JSON.parse(readFileSync(path.join(root, '.omx/proof/live-provider-smoke.json'), 'utf8'));
    expect(receipt.status).toBe('pass');
    expect(existsSync(path.join(root, receipt.artifactPaths?.[0] ?? '.omx/proof/live-provider-smoke/p5.js'))).toBe(true);
    answer = 'I am sorry, I cannot help with that.';
    const root2 = inDir('market-fail');
    const bad = await runSinterAsync(['market', 'smoke', '--repo-root', root2], env());
    answer = P5;
    expect(bad.status).toBe(1);
    expect(JSON.parse(readFileSync(path.join(root2, '.omx/proof/live-provider-smoke.json'), 'utf8')).status).not.toBe('pass');
  });
});
