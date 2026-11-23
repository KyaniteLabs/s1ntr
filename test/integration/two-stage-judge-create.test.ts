// Sol L3-10: the staged judge (#1731) wired into shipped Create (SINTER_TWO_STAGE_JUDGE=1), through the real bin/sinter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, LIVELY_HTML, type FakeProvider } from '../helpers/fakeProviderServer';

let work: string;
beforeAll(() => { work = mkdtempSync(path.join(tmpdir(), 'sinter-2s-')); });
afterAll(() => { rmSync(work, { recursive: true, force: true }); });
let seq = 0;
async function create(fake: FakeProvider, extraEnv: Record<string, string>, flags: string[] = []) {
  const n = seq++;
  const env = { ...fakeProviderEnv(fake, { home: path.join(work, `h${n}`), stateRoot: path.join(work, `s${n}`) }), ...extraEnv };
  const args = ['generate', '-o', path.join(work, `o${n}`), '--domain', 'html',
    ...flags,
    'a slow orbit of colored light'];
  return runSinterAsync(args, env);
}

describe('staged judge in Create (L3-10)', () => {
  it('flag on: audit + B1 + B2 all run, a clean piece is accepted', async () => {
    const fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) });
    try {
      const run = await create(fake, { SINTER_TWO_STAGE_JUDGE: '1' });
      expect(fake.judged.some(c => /senior code auditor/.test(c.system))).toBe(true);
      expect(fake.judged.some(c => /check rendered frames for visual defects only/.test(c.system))).toBe(true);
      expect(fake.judged.some(c => /creative artifact evaluator/.test(c.system))).toBe(true);
      expect(run.status, run.out).toBe(0);
      expect(run.out).toMatch(/Provider calls: 4\/4/);
    } finally { await fake.close(); }
  }, 300_000);

  it('flag on: a crash finding from the audit caps the piece, exit 3', async () => {
    const fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.9),
      audit: () => ({ findings: [{ severity: 'crash', line: 1, note: 'throws on load' }], score: 0.2 }) });
    try {
      const run = await create(fake, { SINTER_TWO_STAGE_JUDGE: '1' });
      expect(run.status).toBe(3);
    } finally { await fake.close(); }
  }, 300_000);

  it('flag off (default): the shipped single-judge path is unchanged, no audit call', async () => {
    const fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) });
    try {
      const run = await create(fake, {});
      expect(run.status).toBe(0);
      expect(fake.judged.some(c => /senior code auditor|check rendered frames for visual defects only/.test(c.system))).toBe(false);
    } finally { await fake.close(); }
  }, 300_000);

  it('refuses an explicit insufficient cap before any provider call', async () => {
    const fake = await startFakeProvider({ generate: () => LIVELY_HTML });
    try {
      const run = await create(fake, { SINTER_TWO_STAGE_JUDGE: '1' }, ['--max-provider-calls', '2']);
      expect(run.status).not.toBe(0);
      expect(run.out).toContain('LIMINAL_STAGED_TRANSPORT_CAP_TOO_LOW');
      expect(fake.generated).toHaveLength(0);
      expect(fake.judged).toHaveLength(0);
    } finally { await fake.close(); }
  }, 300_000);

  it('a bad SINTER_JUDGE_REASONING value fails loudly instead of defaulting', async () => {
    const fake = await startFakeProvider({ generate: () => LIVELY_HTML });
    try {
      const run = await create(fake, { SINTER_TWO_STAGE_JUDGE: '1', SINTER_JUDGE_REASONING: 'ludicrous' });
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/SINTER_JUDGE_REASONING must be one of/);
    } finally { await fake.close(); }
  }, 300_000);
});
