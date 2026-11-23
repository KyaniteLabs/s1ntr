/**
 * `generate --lane batch` through the REAL built binary (build dist first), a fake Anthropic Message Batches server and a separate fake judge.
 * Proves: only generation requests reach Anthropic, judges stay on the other provider, waves carry each piece's own code and critique,
 * resume never resubmits, failures retry in a bounded batch, spend is capped by a cumulative ledger, and guards refuse bad configs.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, LIVELY_HTML, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';
import { startFakeAnthropic, type FakeAnthropic, type FakeAnthropicOptions } from '../helpers/fakeAnthropicBatchServer.js';

vi.setConfig({ testTimeout: 290_000 });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let judge: FakeProvider; let work: string; let anth: FakeAnthropic | null = null;
beforeAll(async () => {
  judge = await startFakeProvider({ judge: () => ({ ...goodJudgeReply(0.7), reasoning: `CRITIQUE-${judge.judged.length}-xyzzy` }) });
  work = mkdtempSync(path.join(tmpdir(), 'sinter-batch-'));
});
afterEach(async () => { await anth?.close(); anth = null; });
afterAll(async () => { await judge.close(); rmSync(work, { recursive: true, force: true }); });

const html = (id: string) => LIVELY_HTML.replace('<title>Orbit</title>', `<title>${id}</title>`);
const okReply: FakeAnthropicOptions['reply'] = (r) => ({ type: 'succeeded', text: html(r.custom_id) });
const textOf = (r: { params: any }) => JSON.stringify(r.params.messages);
function writePrompts(dir: string, n: number): string {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'prompts.json');
  writeFileSync(f, JSON.stringify({ schema: 't', prompts: Array.from({ length: n }, (_, i) => ({ id: `piece${i}`, domain: 'html', reasoning: 'xhigh', prompt: `orbit number ${i}` })) }));
  return f;
}
function env(name: string, a: FakeAnthropic, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...fakeProviderEnv(judge, { home: path.join(work, name, 'home'), stateRoot: path.join(work, name, 'state') }),
    ANTHROPIC_API_KEY: 'sk-ant-test-not-real', ANTHROPIC_BASE_URL: a.baseUrl, SINTER_BATCH_TEST_BASE_URL: a.baseUrl, ...extra };
}
const args = (out: string, file: string, loops: number, budget: number, more: string[] = []) =>
  ['generate', '-o', out, '--lane', 'batch', '--batch-file', file, '--loops', String(loops), '--budget-usd', String(budget), '--batch-model', 'claude-opus-5-5', '--batch-poll-seconds', '0.05', ...more];

describe('batch lane: 3 prompts x 3 loops', () => {
  it('sends only generation to Anthropic (one batch per wave), judges go to the other provider, each piece carries its own code and critique', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const out = path.join(work, 'a', 'out');
    const run = await runSinterAsync(args(out, writePrompts(path.join(work, 'a'), 3), 3, 55), env('a', anth));
    expect(run.status, run.out).toBe(0);
    expect(anth.batches).toHaveLength(3);
    expect(anth.batches.map((b) => b.requests.length)).toEqual([3, 3, 3]);
    expect(anth.liveMessages).toBe(0); expect(anth.otherCalls).toEqual([]); expect(anth.violations).toEqual([]);
    // The first drafts are text prompts. Revisions can carry frames of their own prior take.
    const all = anth.batches.flatMap((b) => b.requests);
    expect(anth.batches[0].requests.filter(r => textOf(r).includes('"type":"image"'))).toHaveLength(0);
    expect(all.map(r => r.custom_id).sort()).toEqual([
      'p000l1', 'p000l2', 'p000l3', 'p001l1', 'p001l2', 'p001l3', 'p002l1', 'p002l2', 'p002l3',
    ]);
    expect(judge.judged.length).toBeGreaterThanOrEqual(9);
    expect(judge.generated).toHaveLength(0); // the generator never used the judge provider
    // wave 2 carries each piece's own loop-1 code, and not another piece's
    const w2 = anth.batches[1].requests;
    expect(w2.map((r) => r.custom_id).sort()).toEqual(['p000l2', 'p001l2', 'p002l2']);
    for (const r of w2) {
      const idx = r.custom_id.slice(0, 4); const own = `<title>${idx}l1</title>`;
      expect(textOf(r)).toContain(own); expect(textOf(r)).toContain('This is loop 2 of 3. Below is the piece from loop 1'); expect(textOf(r)).toContain('CRITIQUE-');
      for (const other of ['p000', 'p001', 'p002'].filter((x) => x !== idx)) expect(textOf(r)).not.toContain(`<title>${other}l1</title>`);
    }
    // identical cache_control on the shared system prefix of every request
    const cc = all.map((r) => JSON.stringify(r.params.system?.[0]?.cache_control));
    expect(new Set(cc)).toEqual(new Set([JSON.stringify({ type: 'ephemeral', ttl: '1h' })]));
    // output layout matches the live loops path, with batch ids and usage
    for (let i = 0; i < 3; i++) {
      const m = JSON.parse(readFileSync(path.join(out, `piece${i}`, 'loops-manifest.json'), 'utf8'));
      expect(m.records.map((r: any) => r.loop)).toEqual([1, 2, 3]);
      const primaryId = `p${String(i).padStart(3, '0')}l1`;
      const waveId = anth.batches[0].id;
      expect(m.records[0].batch.batchIds).toContain(waveId);
      expect(m.records[0].batch.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ customId: primaryId, batchId: waveId, outcome: 'succeeded',
          usage: expect.objectContaining({ output_tokens: 2000 }) }),
      ]));
    }
    const summary = JSON.parse(readFileSync(path.join(out, 'batch-lane.json'), 'utf8'));
    expect(summary.batches.map((batch: { batchId: string }) => batch.batchId)).toEqual(anth.batches.map((batch) => batch.id));
    expect(run.out).toMatch(/worst case/i);
  });
});

describe('batch lane: spend safety', () => {
  it('dry run submits nothing and shows the remaining budget', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const run = await runSinterAsync(args(path.join(work, 'd', 'out'), writePrompts(path.join(work, 'd'), 3), 3, 55, ['--dry-run']), env('d', anth));
    expect(run.status, run.out).toBe(0);
    expect(anth.submitAttempts()).toBe(0); expect(anth.batches).toHaveLength(0);
    expect(run.out).toMatch(/remaining/i); expect(run.out).toMatch(/Dry run: nothing was submitted/);
  });
  it('refuses, before any submit, when the worst case exceeds --budget-usd', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const run = await runSinterAsync(args(path.join(work, 'e', 'out'), writePrompts(path.join(work, 'e'), 3), 3, 0.5), env('e', anth));
    expect(run.status, run.out).toBe(5);
    expect(anth.submitAttempts()).toBe(0); expect(run.out).toContain('Stopped for budget before wave 1');
  });
  it('requires --budget-usd', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const a = args(path.join(work, 'f', 'out'), writePrompts(path.join(work, 'f'), 1), 1, 55); a.splice(a.indexOf('--budget-usd'), 2);
    const run = await runSinterAsync(a, env('f', anth));
    expect(run.status).toBe(1); expect(run.out).toMatch(/--budget-usd/); expect(anth.submitAttempts()).toBe(0);
  });
  it('the cap is cumulative: a different runtime root sees what the first run spent from the same home', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const e = env('g', anth); const file = writePrompts(path.join(work, 'g'), 1);
    const first = await runSinterAsync(args(path.join(work, 'g', 'o1'), file, 1, 55), e);
    expect(first.status, first.out).toBe(0);
    const ledger = JSON.parse(readFileSync(path.join(work, 'g', 'home', '.sinter', 'provider-budgets.json'), 'utf8'));
    const entry = Object.values<any>(ledger.entries ?? ledger)[0];
    expect(entry.spendUsd).toBeGreaterThan(0);
    // spent so far = 1000 in + 2000 out on opus batch prices
    expect(entry.spendUsd).toBeCloseTo((1000 * 2 + 2000 * 10) / 1e6, 6);
    const dry = await runSinterAsync(args(path.join(work, 'g', 'o2'), file, 1, 55, ['--dry-run']), { ...e, SINTER_LIMINAL_RUNTIME_ROOT: path.join(work, 'g', 'other-state') });
    expect(dry.out).toContain((55 - entry.spendUsd).toFixed(2).slice(0, 4));
  });
});

describe('batch lane: guards', () => {
  it('refuses a numbered retry of an unknown batch submission', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const output = path.join(work, 'numbered');
    const command = args(output, writePrompts(output, 1), 1, 55, ['--dry-run', '--retry-unknown=1']);
    const run = await runSinterAsync(command, env('numbered', anth));
    expect(run.out).toContain('BATCH_RETRY_UNKNOWN');
    expect(run.status).toBe(2);
    expect(anth.submitAttempts()).toBe(0);
  });
  it('refuses a malformed spend ledger before any submission', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const name = 'invalid-spend';
    const e = env(name, anth);
    const ledger = path.join(e.HOME!, '.sinter', 'provider-budgets.json');
    const host = new URL(anth.baseUrl).host;
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, JSON.stringify({ [host]: { capUsd: 55 } }));
    const file = writePrompts(path.join(work, name), 1);
    const run = await runSinterAsync(args(path.join(work, name, 'out'), file, 1, 55), e);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('PROVIDER_BUDGET_CONFIG_INVALID');
    expect(anth.submitAttempts()).toBe(0);
  });
  it('requires a provider call cap that covers both generation and evaluation', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const name = 'low-provider-cap';
    const file = writePrompts(path.join(work, name), 1);
    const flags = args(path.join(work, name, 'out'), file, 1, 55, ['--max-provider-calls', '1']);
    const run = await runSinterAsync(flags, env(name, anth));
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('BATCH_PROVIDER_CALL_LIMIT_INVALID');
    expect(anth.submitAttempts()).toBe(0);
  });
  it('counts a timed-out evaluator attempt against the same limit as generation', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const slow = await startFakeProvider({ judge: () => goodJudgeReply(0.7), judgeDelayMs: 20_000 });
    try {
      const name = 'retry-budget';
      const dir = path.join(work, name);
      const e = env(name, anth, { LIMINAL_EVALUATOR_BASE_URL: slow.baseUrl, LIMINAL_EVALUATOR_TIMEOUT_MS: '4000' });
      const flags = args(path.join(dir, 'out'), writePrompts(dir, 1), 1, 55, ['--max-provider-calls', '2']);
      const run = await runSinterAsync(flags, e);
      expect(run.status, run.out).toBe(1);
      expect(run.out).toContain('r1=unscored');
      expect(anth.submitAttempts()).toBe(1);
      expect(slow.judged).toHaveLength(1);
    } finally { await slow.close(); }
  });

  it('refuses a base URL that is not api.anthropic.com (the z.ai entry) with no request sent', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const e = env('h', anth); e.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'; delete e.SINTER_BATCH_TEST_BASE_URL;
    const run = await runSinterAsync(args(path.join(work, 'h', 'out'), writePrompts(path.join(work, 'h'), 1), 1, 55), e);
    expect(run.status, run.out).toBe(2); expect(run.out).toMatch(/api\.anthropic\.com/); expect(anth.submitAttempts()).toBe(0);
  });
  it('refuses a config that routes the judge to the Anthropic key', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const e = env('i', anth, { LIMINAL_EVALUATOR_PROVIDER: 'anthropic', LIMINAL_EVALUATOR_BASE_URL: anth.baseUrl, LIMINAL_EVALUATOR_MODEL: 'claude-opus-5-5', LIMINAL_EVALUATOR_API_KEY: 'sk-ant-test-not-real' });
    const run = await runSinterAsync(args(path.join(work, 'i', 'out'), writePrompts(path.join(work, 'i'), 1), 1, 55), e);
    expect(run.status, run.out).toBe(2); expect(run.out).toMatch(/judge/i); expect(anth.submitAttempts()).toBe(0);
  });
});

describe('batch lane: failures, backoff and resume', () => {
  it('backs off on a 429 at submit, reports invalid_request per piece without stopping the others, retries an errored and an expired request in a bounded follow-up batch', async () => {
    anth = await startFakeAnthropic({ rateLimitSubmits: 2, reply: (r, c) => {
      if (r.custom_id === 'p000l1') return { type: 'errored', errorType: 'invalid_request_error', message: 'bad prompt' };
      if (r.custom_id === 'p001l1') return c.attempt === 1 ? { type: 'errored', errorType: 'api_error', message: 'transient' } : { type: 'succeeded', text: html(r.custom_id) };
      if (r.custom_id === 'p002l1') return c.attempt === 1 ? { type: 'expired' } : { type: 'succeeded', text: html(r.custom_id) };
      return { type: 'succeeded', text: html(r.custom_id) };
    } });
    const out = path.join(work, 'j', 'out');
    const run = await runSinterAsync(args(out, writePrompts(path.join(work, 'j'), 3), 1, 55, ['--batch-concurrency', '1']), env('j', anth));
    expect(run.status, run.out).toBe(1);
    expect(anth.submitAttempts()).toBe(4); // 2 x 429, the wave, one bounded retry batch
    expect(anth.batches).toHaveLength(2);
    expect(anth.batches[1].requests.map((r) => r.custom_id).sort()).toEqual(['p001l1', 'p002l1']); // invalid_request is NOT retried
    const m0 = JSON.parse(readFileSync(path.join(out, 'piece0', 'loops-manifest.json'), 'utf8'));
    expect(m0.records[0].status).toBe('failed'); expect(JSON.stringify(m0.records[0])).toMatch(/invalid_request/);
    expect(m0.providerCallsConsumed).toBe(1);
    for (const i of [1, 2]) {
      const manifest = JSON.parse(readFileSync(path.join(out, `piece${i}`, 'loops-manifest.json'), 'utf8'));
      expect(manifest.records[0]).toMatchObject({ status: 'ok', providerCalls: 3 });
      expect(manifest.providerCallsConsumed).toBe(3);
    }
  });
  it('holds the reservation and refuses resubmission when an accepted POST loses its response', async () => {
    anth = await startFakeAnthropic({ reply: okReply, failFirstSubmitResponse: true });
    const e = env('uncertain', anth);
    const output = path.join(work, 'uncertain', 'out');
    const command = args(output, writePrompts(path.join(work, 'uncertain'), 1), 1, 55);
    const first = await runSinterAsync(command, e);
    expect(first.status).toBe(2);
    expect(first.out).toContain('BATCH_SUBMIT_UNCERTAIN');
    expect(anth.submitAttempts()).toBe(1);
    expect(anth.batches).toHaveLength(1);
    const journal = JSON.parse(readFileSync(path.join(e.SINTER_LIMINAL_RUNTIME_ROOT!, 'operation-journal.json'), 'utf8'));
    const submissions = Object.entries(journal.operations).filter(([key]) => key.startsWith('batch-submit:'));
    expect(submissions).toHaveLength(1);
    expect(submissions[0][1]).toMatchObject({ attemptsConsumed: 1 });
    const budgets = JSON.parse(readFileSync(path.join(e.HOME!, '.sinter', 'provider-budgets.json'), 'utf8'));
    const host = new URL(anth.baseUrl).host;
    expect(budgets[host].spendUsd).toBe(0);
    expect(Object.keys(budgets[host].reservations)).toHaveLength(1);
    const resumed = await runSinterAsync(command, e);
    expect(resumed.status).toBe(2);
    expect(resumed.out).toContain('reservation without a batch ID');
    expect(anth.submitAttempts()).toBe(1);
  });
  it('honors the runtime endpoint earmark before a POST even with home budget available', async () => {
    anth = await startFakeAnthropic({ reply: okReply });
    const name = 'runtime-earmark';
    const output = path.join(work, name, 'out');
    const e = env(name, anth);
    const runtime = path.join(e.SINTER_LIMINAL_RUNTIME_ROOT!, '.sinter');
    mkdirSync(runtime, { recursive: true });
    const host = new URL(anth.baseUrl).host;
    writeFileSync(path.join(runtime, 'provider-budgets.json'),
      JSON.stringify({ [host]: { capUsd: 55, spendUsd: 0, allowedModels: ['claude-sonnet-5-5'] } }));
    const run = await runSinterAsync(args(output, writePrompts(path.join(work, name), 1), 1, 55), e);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('PROVIDER_BUDGET_MODEL_NOT_ALLOWED');
    expect(anth.submitAttempts()).toBe(0);
    const budget = JSON.parse(readFileSync(path.join(e.HOME!, '.sinter', 'provider-budgets.json'), 'utf8'));
    expect(Object.keys(budget[host].reservations)).toEqual([]);
  });

  it('a re-run after the process dies mid-wave never resubmits a wave that already has a batch id', async () => {
    anth = await startFakeAnthropic({ reply: okReply, pollsBeforeEnd: 40 });
    const out = path.join(work, 'k', 'out'); const e = env('k', anth); const file = writePrompts(path.join(work, 'k'), 2);
    const child = spawn(process.execPath, [path.join(repoRoot, 'bin/sinter'), ...args(out, file, 2, 55, ['--batch-concurrency', '2'])], { cwd: repoRoot, env: e });
    const killedAt = Date.now();
    while (anth.batches.length < 1 && Date.now() - killedAt < 120_000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500)); // let the id reach the journal
    child.kill('SIGKILL'); await new Promise((r) => child.on('close', r));
    expect(anth.batches).toHaveLength(1);
    anth.batches[0].polls = 100; // the wave ends now
    const run = await runSinterAsync(args(out, file, 2, 55, ['--batch-concurrency', '2']), e);
    expect(run.status, run.out).toBe(0);
    expect(anth.batches).toHaveLength(2); // wave 1 was NOT resubmitted; wave 2 is the only new batch
    expect(anth.batches[1].requests.map((r) => r.custom_id).sort()).toEqual(['p000l2', 'p001l2']);
    const manifestFile = path.join(out, 'piece0', 'loops-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(manifest.records.map((record: { status: string }) => record.status)).toEqual(['ok', 'ok']);

    const previousJudgeCalls = judge.judged.length;
    const replayed = await runSinterAsync(args(out, file, 2, 55, ['--batch-concurrency', '2']), e);
    expect(replayed.status, replayed.out).toBe(0);
    expect(anth.batches).toHaveLength(2);
    expect(judge.judged.length).toBe(previousJudgeCalls);
    const after = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(after.records.map((record: { status: string }) => record.status)).toEqual(['resumed', 'resumed']);
    expect(after.records[1].batch).toEqual(manifest.records[1].batch);

    const cached = path.join(out, 'batch-lane', 'results', 'p000l1.json');
    const cache = readFileSync(cached);
    rmSync(cached);
    const missing = await runSinterAsync(args(out, file, 2, 55, ['--batch-concurrency', '2']), e);
    expect(missing.status, missing.out).toBe(2);
    expect(missing.out).toContain('BATCH_RESULT_INTEGRITY');
    expect(anth.batches).toHaveLength(2);
    writeFileSync(cached, cache);

    writeFileSync(path.join(manifest.records[0].artifactDirectory, 'source.txt'), 'tampered source');
    const corrupted = await runSinterAsync(args(out, file, 2, 55, ['--batch-concurrency', '2']), e);
    expect(corrupted.status, corrupted.out).toBe(1);
    expect(corrupted.out).toContain('LOOP_RECOVERY_INTEGRITY');
    expect(anth.batches).toHaveLength(2);
    expect(judge.judged.length).toBe(previousJudgeCalls);
  });
});
