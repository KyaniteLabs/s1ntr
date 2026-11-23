/**
 * Dogfood chain gap "gallery -> next brief": a second governed generate in the same project used to send a
 * byte-identical system brief. An accepted piece now reaches the next brief as what worked and why (technique words
 * and quoted judge comments, no code); a down-voted piece and a holdout piece never do. The real binary talks to the
 * fake provider, which records every request body.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIVELY_HTML, fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 290_000, hookTimeout: 290_000 });

const HEADER = 'Earlier pieces of yours that worked for this kind of work';
let work: string; let proj: string; let fake: FakeProvider; let env: NodeJS.ProcessEnv; let n = 0;
const run = (prompt: string) => {
  const index = n++;
  return runSinterAsync(['generate', '-o', path.join(work, `out-${index}`), '--domain', 'html', prompt],
    { ...env, SINTER_PROMPT_ID: `study-${index}` }, proj);
};
const lastSystem = () => fake.generated.at(-1)!.system;
const seeds = () => readdirSync(path.join(proj, '.sinter', 'seed-archive')).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(path.join(proj, '.sinter', 'seed-archive', f), 'utf8')) as {
    seed: string; sourceSha256: string; promptId: string; playableSha256: string;
  });

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-nextbrief-'));
  proj = path.join(work, 'proj'); mkdirSync(proj, { recursive: true });
  fake = await startFakeProvider({
    // every piece differs (a comment), so each has its own source sha
    generate: ({ index }) => LIVELY_HTML.replace('</body>', `<!-- piece ${index} --></body>`),
    judge: () => ({ ...goodJudgeReply(0.8), reasoning: 'Confident orbiting trails with rich colour' }),
  });
  env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

describe('an accepted piece reaches the next governed brief', () => {
  it('the first brief carries no earlier-pieces section', async () => {
    const first = await run('a slow orbit of colored light');
    expect(first.status).toBe(0);
    expect(lastSystem()).not.toContain(HEADER);
    expect(seeds()).toHaveLength(1);
    expect(seeds()[0]).toMatchObject({ promptId: 'study-0', playableSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('the second brief differs: it names the first piece technique and the judge praise, with no code', async () => {
    const before = lastSystem();
    const second = await run('a second orbit, brighter');
    expect(second.status).toBe(0);
    const system = lastSystem();
    expect(system).not.toBe(before);
    expect(system).toContain(HEADER);
    expect(system).toContain('motion trails');
    expect(system).not.toContain('Confident orbiting trails with rich colour');
    expect(fake.generated.at(-1)!.user).toContain('["Confident orbiting trails with rich colour"]');
    expect(system).not.toContain('fillRect');
    expect(system).not.toContain('requestAnimationFrame');
  });

  it('a down-voted piece never appears, and a holdout piece never appears', async () => {
    const [a, b] = seeds();
    const learning = path.join(proj, '.sinter', 'learning'); mkdirSync(learning, { recursive: true });
    writeFileSync(path.join(learning, 'source-votes.jsonl'), JSON.stringify({ source_sha256: a.sourceSha256, vote: 'down', at: '2026-11-19T00:00:00Z' }) + '\n');
    await run('a third orbit');
    // b is still offered (one piece left), a is not: the section lists exactly one numbered piece
    expect(lastSystem()).toContain(HEADER);
    expect(lastSystem().split('\n').filter(l => /^\d\. /.test(l))).toHaveLength(1);
    writeFileSync(path.join(learning, 'holdout-prompts.txt'), b.promptId + '\n');
    // the third piece (accepted just now) is the only one left
    const third = seeds().find(s => s.sourceSha256 !== a.sourceSha256 && s.sourceSha256 !== b.sourceSha256)!;
    writeFileSync(path.join(learning, 'source-votes.jsonl'), [a, third].map(s => JSON.stringify({ source_sha256: s.sourceSha256, vote: 'down', at: '2026-11-19T00:00:00Z' })).join('\n') + '\n');
    await run('a fourth orbit');
    expect(lastSystem()).not.toContain(HEADER);
  });
});
