/**
 * Sol 6.2 lane 3 closeout (L3-09 NBE, L3-15 judge-evidence negatives, L3-16 sss-score capture status): the real
 * `bin/sinter` against the local fake provider with a real browser. Loopback only, no paid call. Needs a built dist.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, LIVELY_HTML, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

const NBE_SETTINGS = JSON.stringify({
  palette: ['#06142a', '#277daf', '#f8d76b'], layout: 'ring', emitters: 5,
  reason: 'A ring of bright sources makes the field visible against the dark background.',
});

let work: string;
beforeAll(() => { work = mkdtempSync(path.join(tmpdir(), 'sinter-closeout-')); });
afterAll(() => { rmSync(work, { recursive: true, force: true }); });
let seq = 0;
const envFor = (fake: FakeProvider) => { const n = seq++;
  return { env: fakeProviderEnv(fake, { home: path.join(work, `home${n}`), stateRoot: path.join(work, `state${n}`) }), out: path.join(work, `out${n}`) }; };

describe('L3-09: NBE must be observed converging', () => {
  it('a document that posts nbe:converged is judged and accepted', async () => {
    const fake = await startFakeProvider({ generate: () => NBE_SETTINGS, judge: () => goodJudgeReply(0.8) });
    try {
      const { env, out } = envFor(fake);
      const run = await runSinterAsync(['generate', '-o', out, '--domain', 'nbe', 'a cascade field'], env);
      expect(run.status).toBe(0);
      expect(fake.judged.length).toBeGreaterThan(0);
    } finally { await fake.close(); }
  });
  it('a ready engine that never delivers the convergence signal does not reach the judge', async () => {
    const fake = await startFakeProvider({ generate: () => NBE_SETTINGS, judge: () => goodJudgeReply(0.95) });
    try {
      const { env, out } = envFor(fake);
      const preload = new URL('../fixtures/nbe-silence-convergence.mjs', import.meta.url);
      const run = await runSinterAsync(['generate', '-o', out, '--domain', 'nbe', 'a cascade field'],
        { ...env, NODE_OPTIONS: `--import=${preload.href}` });
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/NBE_NOT_CONVERGED/);
      expect(fake.judged.length).toBe(0);
    } finally { await fake.close(); }
  });
});

describe('L3-15 / L3-16: spawned CLI paths', () => {
  it('judge-evidence --write-negatives records a real hard-negative (<0.2) Create; sss-score reports a capture failure as infra (exit 8)', async () => {
    const fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.1) });
    try {
      const { env, out } = envFor(fake);
      const run = await runSinterAsync(['generate', '-o', out, '--domain', 'html', 'an orbit'], env);
      expect(run.status).toBe(3);
      const saved = /Saved: (\S+)/.exec(run.out)?.[1];
      expect(saved && existsSync(saved)).toBe(true);
      const negatives = path.join(work, 'neg.jsonl');
      const je = await runSinterAsync(['judge-evidence', out, '--state-root', env.SINTER_LIMINAL_RUNTIME_ROOT!,
        '--write-negatives', negatives], env);
      expect(je.status, je.out).toBe(0);
      expect(je.out).toMatch(/Judge evidence:/);
      expect(existsSync(negatives)).toBe(true);
      expect(readFileSync(negatives, 'utf8').trim().length).toBeGreaterThan(0);
      const dir = path.dirname(saved!);
      const sss = await runSinterAsync(['sss-score', dir], { ...env, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/nonexistent/chrome' });
      expect(sss.out).toMatch(/SCORE_CAPTURE_FAILED/);
      expect(sss.status).toBe(8);
      expect(sss.out).not.toMatch(/SSS_SCORE_BLANK_ARTIFACT/);
    } finally { await fake.close(); }
  });
});
