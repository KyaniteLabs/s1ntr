/**
 * Group C closeout: full rerender-reevaluate on a product run made in this test, the OS-sandbox run
 * (only where user namespaces exist), and the llm cache-hit seam (skipped with reason, owned by #1423).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';
import { runInSandbox } from '../../src/sandbox/index.js';
import { P5_SKETCH } from './p5Sketch.js';

vi.setConfig({ testTimeout: 280_000 });
let work: string; let fake: FakeProvider;
beforeAll(async () => { work = mkdtempSync(path.join(tmpdir(), 'organ-rr2-')); fake = await startFakeProvider({ generate: () => P5_SKETCH }); });
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });
const repo = path.resolve(__dirname, '../..');

describe('rerender-reevaluate: full run on a run root this test generated', () => {
  it('generate (fake provider) -> grant from the real receipt -> spawned rerender-reevaluate re-judges it once', async () => {
    const home = path.join(work, 'h'); const env = { ...fakeProviderEnv(fake, { home, stateRoot: path.join(work, 's') }), LIMINAL_DISABLE_SANDBOX: 'true' };
    const out = path.join(work, 'run');
    const gen = await runSinterAsync(['generate', '-o', out, '--domain', 'p5', 'a quiet harbor'], env);
    // exit 3 = generated, judged below the floor; the run root and its signed receipt still exist, which is all a re-judge needs
    expect([0, 3], gen.out.slice(-800)).toContain(gen.status);
    expect(gen.out).toMatch(/Signed receipt: [0-9a-f]{64}/);
    const proj = JSON.parse(readFileSync(path.join(out, 'product-projections.json'), 'utf8')) as Record<string, { kind: string; result: { receipt: { signature: string; evidenceDigest: string } } }>;
    const [key, create] = Object.entries(proj).find(([, v]) => v.kind === 'create')!;
    const grantPath = path.join(work, 'grant.json');
    writeFileSync(grantPath, JSON.stringify({ schema: 'sinter.rerender-reevaluation-authority', schemaVersion: 1,
      sourceHeadSha: key.split(':')[1], parentCreateIdempotencyKey: key,
      parentReceiptSignature: create.result.receipt.signature, parentEvidenceDigest: create.result.receipt.evidenceDigest,
      maxTransportAttempts: 1, candidateCount: 0, evaluatorTimeoutMs: 120000 }));
    const promptFile = path.join(work, 'prompt.txt'); writeFileSync(promptFile, 'a quiet harbor');
    const judgedBefore = fake.judged.length;
    const rr = await runSinterAsync(['rerender-reevaluate', '--run-root', out, '--grant', grantPath, '--prompt-file', promptFile, '--repo-root', repo], env);
    expect([0, 2], rr.out.slice(-1200)).toContain(rr.status);          // 2 = judged but not admission-eligible
    expect(rr.out).toMatch(/"grantDigest": "[0-9a-f]{64}"/);
    expect(fake.judged.length).toBeGreaterThan(judgedBefore);          // the evaluator ran
    expect(existsSync(path.join(out, 'rerender-reevaluation.json'))).toBe(true);
    // bypass: a grant that names another receipt is refused before any judging
    writeFileSync(grantPath, JSON.stringify({ ...JSON.parse(readFileSync(grantPath, 'utf8')), parentReceiptSignature: 'f'.repeat(64) }));
    const bad = await runSinterAsync(['rerender-reevaluate', '--run-root', out, '--grant', grantPath, '--prompt-file', promptFile], env);
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/REEVALUATION_GRANT_PARENT_MISMATCH/);
  });
});

// Probe the real thing: launch Chromium with its OS sandbox ON. Hosts whose AppArmor profile blocks user
// namespaces (this one) answer "No usable sandbox"; CI answers fine and runs the test below.
delete process.env.LIMINAL_DISABLE_SANDBOX;
const probe = await runInSandbox('function setup(){ noLoop(); } function draw(){}', { timeoutMs: 60_000 });
const osSandbox = !/No usable sandbox|Failed to launch the browser/i.test(probe.error ?? '');
if (!osSandbox) console.warn('[organ-skip] OS sandbox run test SKIPPED: this host blocks unprivileged user namespaces (AppArmor: "No usable sandbox"). It runs in CI.');
describe('sandbox: Chromium OS sandbox ON (no opt-out)', () => {
  it.skipIf(!osSandbox)('a clean sketch completes and a throwing one reports its error with the OS sandbox enabled', async () => {
    delete process.env.LIMINAL_DISABLE_SANDBOX;
    const ok = await runInSandbox('function setup(){ createCanvas(50,50); noLoop(); } function draw(){ background(10); }', { timeoutMs: 60_000 });
    const bad = await runInSandbox('function setup(){ throw new Error("ORGAN_BOOM"); }', { timeoutMs: 60_000 });
    expect(ok.error, JSON.stringify(ok)).toBeUndefined();
    expect(ok.completed).toBe(true);
    expect(bad.error ?? '').toMatch(/ORGAN_BOOM/);
  });
});

/*
 * #1423 SEAM (coordinator owns that PR; no src/llm edits here).
 * File: src/llm/LLMClient.ts, generate path ~line 1925 (`this.cache.get(systemPrompt, userPrompt, cacheScope)`).
 * Make the cache injectable so a test can prove a hit never reaches the transport:
 *   1. constructor(config, deps?: { cache?: Pick<CacheManager,'get'|'set'> }); this.cache = deps?.cache ?? new CacheManager(...)
 *   2. test builds LLMClient with a recording cache + a transport spy, calls generate twice with identical prompts
 *   3. first call: cache.get -> null, transport called once, cache.set stored
 *   4. second call: cache.get -> hit, result.fromCache === true, transport NOT called again
 *   5. bypassCache:true, role 'harness', and image inputs must skip cache.get (already branches at that line)
 * Also seam: LLMClient.loadRoles() prints a raw stack trace on a corrupt roles/config file; return a typed ConfigError instead.
 */
describe('llm: cache hit through LLMClient', () => {
  it.skip('second identical generate is served from cache and the transport is not called (blocked on #1423 cache-injection seam, see comment above)', () => {
    expect(true).toBe(false);
  });
});
