/**
 * Sol lane 3 rows 2/3/5 (the four low-risk partials), each through the REAL spawned bin/sinter on the fake provider:
 *  - SINTER_CONFIG_PATH roles: model names come from the config file, not LIMINAL_LLM_* env.
 *  - --reasoning: the requested level reaches the provider request body.
 *  - SINTER_LIMINAL_KNOWLEDGE_ROOT: --teach reads activated-knowledge.json from that root, not the state root.
 *  - SINTER_ART_GENERATION_WALL_SECONDS: the generator is told the wall-clock budget derived from it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer';

let work: string;
let fake: FakeProvider;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-cfg-'));
  fake = await startFakeProvider({ judge: () => goodJudgeReply(0.8) });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

const baseEnv = (name: string) => fakeProviderEnv(fake, { home: path.join(work, name, 'home'), stateRoot: path.join(work, name, 'state') });
const gen = (name: string, extra: string[] = []) => ['generate', '-o', path.join(work, name, 'out'), '--domain', 'html', ...extra, 'orbiting dots'];

describe('operator config controls (spawned, fake provider)', () => {
  it('SINTER_CONFIG_PATH roles pick the models; no LIMINAL_LLM_* env', async () => {
    const env = baseEnv('cfg');
    for (const k of ['LIMINAL_LLM_BASE_URL', 'LIMINAL_LLM_MODEL', 'LIMINAL_LLM_API_KEY']) delete env[k];
    const cfg = path.join(work, 'cfg.json');
    const role = (model: string) => ({ provider: 'openai', baseUrl: fake.baseUrl, model, apiKey: 'cfg-key' });
    writeFileSync(cfg, JSON.stringify({ roles: { generator: role('gpt-5.4-cfgrole-gen'), evaluator: role('gpt-5.4-cfgrole-eval') } }));
    env.SINTER_CONFIG_PATH = cfg;
    const before = fake.bodies.length;
    const run = await runSinterAsync(gen('cfg'), env);
    const mine = fake.bodies.slice(before).join('\n');
    expect(mine, run.out.slice(0, 1500)).not.toEqual('');
    expect(run.out.slice(-1500), 'cfg run').not.toMatch(/localhost:1234/);
    expect(mine).toContain('gpt-5.4-cfgrole-gen');
    expect(mine).toContain('gpt-5.4-cfgrole-eval');
    expect([0, 3], run.out.slice(-900)).toContain(run.status);
  }, 300_000);

  it('--reasoning high reaches the provider request', async () => {
    const before = fake.bodies.length;
    const run = await runSinterAsync(gen('reason', ['--reasoning', 'high']), baseEnv('reason'));
    expect(run.out).toMatch(/Reasoning: high \(all roles\)/);
    expect(fake.bodies.slice(before).some(b => /"reasoning_effort"\s*:\s*"high"|"effort"\s*:\s*"high"|"thinking"[^}]*high/.test(b)),
      fake.bodies.slice(before, before + 1).join('').slice(0, 600)).toBe(true);
    expect([0, 3], run.out.slice(-900)).toContain(run.status);
  }, 300_000);

  it('SINTER_ART_GENERATION_WALL_SECONDS becomes the generator time budget', async () => {
    const env = { ...baseEnv('wall'), SINTER_ART_GENERATION_WALL_SECONDS: '120' };
    const before = fake.generated.length;
    const run = await runSinterAsync(gen('wall'), env);
    const first = fake.generated[before];
    expect(first, run.out.slice(-800)).toMatchObject({ system: expect.any(String), user: expect.any(String) });
    expect(`${first.system}\n${first.user}`).toMatch(/TIME BUDGET: about 2 minutes/);
  }, 300_000);

  it('SINTER_LIMINAL_KNOWLEDGE_ROOT is where --teach looks for activated knowledge', async () => {
    const env = baseEnv('know');
    const kroot = path.join(work, 'know', 'knowledge');
    mkdirSync(kroot, { recursive: true });
    writeFileSync(path.join(kroot, 'activated-knowledge.json'), '{ not json');
    const withRoot = await runSinterAsync(gen('know', ['--teach', 'visual']), { ...env, SINTER_LIMINAL_KNOWLEDGE_ROOT: kroot });
    const without = await runSinterAsync(gen('know2', ['--teach', 'visual']), baseEnv('know2'));
    // The corrupt file is only reachable through the knowledge root, so only that run may mention it.
    expect(without.out).toMatch(/UNTAUGHT: no active knowledge for scope "visual" in .*know2\/state\/activated-knowledge\.json/);
    expect(withRoot.out).not.toMatch(/UNTAUGHT/);
    // Typed error naming the file and the remedy, not a bare JSON SyntaxError.
    expect(withRoot.out).toMatch(/OPERATOR_STATE_FILE_CORRUPT/);
    expect(withRoot.out).toContain(path.join(kroot, 'activated-knowledge.json'));
    expect(withRoot.out).toMatch(/Restore it from a backup/);
    expect(withRoot.status).toBe(1);
  }, 300_000);
});
