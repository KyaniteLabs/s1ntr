/**
 * Sol lane 3, operator rows 19, 19b, 21 and 35 driven through the REAL `bin/sinter` process against the local fake
 * provider (loopback only, no paid call, isolated HOME so the receipt key and config of the machine are never touched).
 *
 *  - 19  `authoritative-create --authority <abs>`: frozen authority package -> one governed p5 Create; result.json,
 *        review.html, the playable and both evidence frames land under outputRoot.
 *  - 19b `authoritative-reevaluate`: re-judges the stored frames with NO new generation.
 *  - 21  `judgment compare --input`: a ranking permutation from the vision seat, from labelled PNG frames.
 *  - 35  `hillclimb run`: the live climb with a fake d1 oracle, the fake generator and the fake judge; per-step JSONL
 *        evidence, a summary on stdout, and no admission.
 * Needs `pnpm build` (the binary runs from dist).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

const SHA = 'a'.repeat(40);
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
// A lively, mid-tone p5 sketch that varies with the call index so each hill-climb proposal differs from the incumbent.
const p5 = (i: number) => `function setup(){createCanvas(400,400);noStroke();}
function draw(){background(${20 + (i * 17) % 60},${30 + (i * 11) % 50},${70 + (i * 23) % 80});
for(let k=0;k<12;k++){fill(${120 + (i * 29) % 120},160+k*6,90+k*10,200);
circle(200+120*Math.cos(frameCount/30+k*0.52+${i}),200+120*Math.sin(frameCount/37+k*0.52),30+k*5);}}`;

let work: string;
let fake: FakeProvider;
beforeAll(() => { work = mkdtempSync(path.join(tmpdir(), 'sinter-oprows-')); });
afterAll(async () => { await fake?.close(); rmSync(work, { recursive: true, force: true }); });

/** The evaluator seat is file/role-pinned: the generic LLM_* env never steers it, so it needs its own env (operator fact). */
function withEvaluator(base: NodeJS.ProcessEnv, f: FakeProvider): NodeJS.ProcessEnv {
  return { ...base, LIMINAL_EVALUATOR_BASE_URL: f.baseUrl, LIMINAL_EVALUATOR_MODEL: 'gpt-5.4', LIMINAL_EVALUATOR_API_KEY: 'fake-key' };
}

function env(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(work, 'home-'));
  return fakeProviderEnv(fake, { home, stateRoot: mkdtempSync(path.join(work, 'state-')) });
}

describe('rows 19 / 19b: authoritative create then re-evaluate', () => {
  it('creates one governed p5 candidate and writes the review package, then re-judges it without regenerating', async () => {
    fake = await startFakeProvider({ generate: () => p5(1), judge: () => goodJudgeReply(0.8) });
    const outputRoot = path.join(work, 'c0-run');
    mkdirSync(outputRoot, { recursive: true });
    const provider = { executor: 'fake', provider: 'openai', baseUrl: fake.baseUrl, model: 'gpt-5.4' };
    const authority = {
      schema: 'sinter.wave8-c0-authority', schemaVersion: 1, canonicalMainSha: SHA, sourceHeadSha: SHA, mainFrozen: true,
      activeBlocker: 'one-rendered-c0', prompt: 'a field of drifting lanterns', domains: ['p5'], layers: ['composition', 'palette'],
      maxTransportAttempts: 2, evalMode: 'strict-browser',
      renderer: { identity: 'sinter-headless', authorization: 'isolated-playwright' },
      roles: { generator: provider, evaluator: provider, harness: 'fake/harness', studio: 'fake/studio' }, outputRoot,
    };
    const authorityPath = path.join(outputRoot, 'authority.json');
    const authorityBytes = JSON.stringify(authority, null, 2);
    writeFileSync(authorityPath, authorityBytes);

    const e = env();
    const created = await runSinterAsync(['authoritative-create', '--authority', authorityPath], e);
    expect(created.out).not.toMatch(/Authoritative Create failed/);
    expect([0, 2]).toContain(created.status);
    expect(existsSync(path.join(outputRoot, 'result.json'))).toBe(true);
    expect(existsSync(path.join(outputRoot, 'review.html'))).toBe(true);
    const stored = JSON.parse(readFileSync(path.join(outputRoot, 'result.json'), 'utf8'));
    expect(stored.authorityPackageDigest).toBe(sha256(authorityBytes));
    expect(existsSync(stored.playablePath)).toBe(true);
    expect(existsSync(stored.earlyFramePath)).toBe(true);
    expect(existsSync(stored.lateFramePath)).toBe(true);
    const generatedAfterCreate = fake.generated.length;
    expect(generatedAfterCreate).toBeGreaterThanOrEqual(1);

    // 19b: a repair authority bound to the parent authority digest; judge only, no regeneration.
    const repairPath = path.join(outputRoot, 'reevaluation-authority.json');
    writeFileSync(repairPath, JSON.stringify({
      schema: 'sinter.wave8-c0-reevaluation-authority', sourceHeadSha: SHA, parentAuthorityDigest: sha256(authorityBytes),
      maxTransportAttempts: 1, candidateCount: 0, evaluatorTimeoutMs: 120_000,
    }));
    const judgedBefore = fake.judged.length;
    const re = await runSinterAsync(['authoritative-reevaluate', '--authority', authorityPath, '--reevaluation-authority', repairPath], e);
    expect(re.out, `create: ${created.status} ${created.out.slice(-500)} :: ${JSON.stringify(stored.result?.evaluation ?? stored.result).slice(0, 1500) + JSON.stringify(Object.keys(stored))}`).not.toMatch(/Authoritative re-evaluation failed/);
    expect([0, 2]).toContain(re.status);
    expect(fake.generated.length).toBe(generatedAfterCreate);
    expect(fake.judged.length).toBeGreaterThan(judgedBefore);
    expect(existsSync(path.join(outputRoot, 'evaluation-repair-result.json'))).toBe(true);
  });

  it('rejects a non-absolute authority path and an incomplete package with exit 1', async () => {
    const e = env();
    const rel = await runSinterAsync(['authoritative-create', '--authority', 'relative.json'], e);
    expect(rel.status).toBe(1);
    const bad = path.join(work, 'bad-authority.json');
    writeFileSync(bad, '{"schema":"nope"}');
    const inc = await runSinterAsync(['authoritative-create', '--authority', bad], e);
    expect(inc.status).toBe(1);
    expect(inc.out).toMatch(/Invalid or incomplete Wave 8 C0 authority package/);
  });
});

describe('row 21: judgment compare', () => {
  it('ranks labelled early/late frames and prints a permutation with a digest; an invalid ranking is exit 1', async () => {
    const dir = path.join(work, 'compare');
    mkdirSync(dir, { recursive: true });
    const png = async (name: string, rgb: [number, number, number]) => {
      const raw = Buffer.alloc(64 * 64 * 3);
      for (let i = 0; i < 64 * 64; i += 1) { raw[i * 3] = (rgb[0] + i) % 256; raw[i * 3 + 1] = (rgb[1] + i * 2) % 256; raw[i * 3 + 2] = rgb[2]; }
      await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toFile(path.join(dir, name));
    };
    await png('a-early.png', [10, 40, 90]); await png('a-late.png', [20, 60, 120]);
    await png('b-early.png', [200, 90, 30]); await png('b-late.png', [180, 120, 60]);
    const input = path.join(dir, 'rendered-set.json');
    writeFileSync(input, JSON.stringify({ candidates: [
      { id: 'a', evidenceDigest: 'd'.repeat(64), earlyPath: 'a-early.png', latePath: 'a-late.png' },
      { id: 'b', evidenceDigest: 'e'.repeat(64), earlyPath: 'b-early.png', latePath: 'b-late.png' },
    ] }));

    const ok = await startFakeProvider({ judge: () => ({ ranking: ['b', 'a'], reasoning: 'b has more depth' }) });
    try {
      const home = mkdtempSync(path.join(work, 'home-'));
      const r = await runSinterAsync(['judgment', 'compare', '--input', input], withEvaluator(fakeProviderEnv(ok, { home, stateRoot: mkdtempSync(path.join(work, 'state-')) }), ok));
      expect(r.status, r.out.slice(-700)).toBe(0);
      const printed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      expect(printed.ranking).toEqual(['b', 'a']);
      expect(printed.comparisonDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(ok.judged.length).toBe(1);
      expect(ok.judged[0].images).toBe(4);
    } finally { await ok.close(); }

    const bad = await startFakeProvider({ judge: () => ({ ranking: ['a', 'a'], reasoning: 'duplicate' }) });
    try {
      const home = mkdtempSync(path.join(work, 'home-'));
      const r = await runSinterAsync(['judgment', 'compare', '--input', input], withEvaluator(fakeProviderEnv(bad, { home, stateRoot: mkdtempSync(path.join(work, 'state-')) }), bad));
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/RENDERED_COMPARISON_RANKING_INVALID/);
    } finally { await bad.close(); }
  });
});

describe('row 35: hillclimb run', () => {
  it('runs a live climb against a fake d1 oracle, writes per-step JSONL and a summary, and admits nothing', async () => {
    const oracle = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => { res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ answers: { better: { noul: 0.9 } } })); });
    });
    await new Promise<void>((resolve) => oracle.listen(0, '127.0.0.1', resolve));
    const oraclePort = (oracle.address() as AddressInfo).port;
    let n = 1;
    const climbFake = await startFakeProvider({ generate: () => p5(++n), judge: () => goodJudgeReply(0.7) });
    try {
      const start = path.join(work, 'start.js');
      writeFileSync(start, p5(0));
      const out = path.join(work, 'steps.jsonl');
      const home = mkdtempSync(path.join(work, 'home-'));
      const r = await runSinterAsync(['hillclimb', 'run', start, 'brief=drifting lanterns at dusk', `oracle-url=http://127.0.0.1:${oraclePort}`,
        `out=${out}`, 'steps=2', 'patience=2', 'judges=2', 'temperature=0.7'],
        withEvaluator(fakeProviderEnv(climbFake, { home, stateRoot: mkdtempSync(path.join(work, 'state-')) }), climbFake));
      expect(r.out).not.toMatch(/\[hillclimb\]/);
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      expect(summary.steps).toBeGreaterThanOrEqual(1);
      expect(summary.log).toBe(out);
      const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.length).toBe(summary.steps);
      expect(climbFake.generated.length).toBeGreaterThanOrEqual(1);
    } finally { oracle.close(); await climbFake.close(); }
  });
});
