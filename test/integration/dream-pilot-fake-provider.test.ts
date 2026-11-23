/**
 * Sol lane 4 pilot: the full Dream chain through the REAL binary against local fake providers (no paid call, no network).
 *   generate x4 -> dream autoseal -> dream run x2 -> dream transfer x2 -> dream activate -> dream compound
 * Stacked on #1933 (test/helpers/fakeProviderServer.ts).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';
import { appendFileSync } from 'node:fs';
import { dreamReplies, LESSON_PREFIX, sha256 } from '../helpers/fakeDreamProvider.js';
import type { CompoundCreateProjection } from '../../src/runtime-core/CompoundCreateProofPort.js';

vi.setConfig({ testTimeout: 900_000 });
let gen: FakeProvider; let evalA: FakeProvider; let evalB: FakeProvider; let work: string;
const R = dreamReplies(undefined, () => path.join(work, 'state', 'product-projections.json'));
const log = (x: string): void => { if (process.env.DREAM_PILOT_LOG) appendFileSync(process.env.DREAM_PILOT_LOG, x + '\n'); };
beforeAll(async () => {
  gen = await startFakeProvider({ generate: R.generate, judge: R.judge });
  evalA = await startFakeProvider({ generate: R.generate, judge: R.judge });
  evalB = await startFakeProvider({ generate: R.generate, judge: R.judge });
  work = process.env.DREAM_PILOT_WORK ?? mkdtempSync(path.join(tmpdir(), 'dream-pilot-'));
  mkdirSync(work, { recursive: true });
});
afterAll(async () => { await Promise.all([gen.close(), evalA.close(), evalB.close()]); if (!process.env.DREAM_PILOT_WORK) rmSync(work, { recursive: true, force: true }); });

describe('dream pilot', () => {
  it('chain', async () => {
    const home = path.join(work, 'home'); const state = path.join(work, 'state'); const know = path.join(work, 'know');
    mkdirSync(know, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...fakeProviderEnv(gen, { home, stateRoot: state }),
      LIMINAL_EVALUATOR_BASE_URL: evalA.baseUrl, LIMINAL_EVALUATOR_MODEL: 'gpt-5.4', LIMINAL_EVALUATOR_API_KEY: 'fake',
      LIMINAL_STUDIO_BASE_URL: evalB.baseUrl, LIMINAL_STUDIO_MODEL: 'gpt-5.4', LIMINAL_STUDIO_API_KEY: 'fake',
      SINTER_LIMINAL_KNOWLEDGE_ROOT: know };
    const storeFile = path.join(state, 'product-projections.json');
    const have = () => { try { return Object.keys(JSON.parse(readFileSync(storeFile, 'utf8'))).length; } catch { return 0; } };
    if (have() < 4) for (const p of ['an orbit of light', 'a drifting lantern field', 'glass rain over a city', 'slow tide of embers']) {
      const g = await runSinterAsync(['generate', '-o', path.join(work, 'out', p.replace(/\W+/g, '-')), '--domain', 'html', p], env);
      expect(g.status, g.out.slice(-600)).toBe(0);
    }
    const store = JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, { kind: string; result: { evidence: { rendererEnvironmentDigest: string }; evaluation: { score: number } ; evaluatorIdentity?: string } }>;
    const first = Object.values(store).find(v => v.kind === 'create')!;
    const judgeId = String((first.result as unknown as { evaluation: { evaluatorIdentity: string } }).evaluation.evaluatorIdentity);
    const renderer = first.result.evidence.rendererEnvironmentDigest;
    const seal = path.join(work, 'seal');
    const a = await runSinterAsync(['dream', 'autoseal', '--judge', judgeId, '--out', seal, '--store', storeFile], env);
    log('AUTOSEAL ' + a.status + ' ' + a.out.slice(-500));
    expect(a.status, a.out).toBe(0);
    const holdouts = [0, 1].map(i => { const f = path.join(work, `holdout-${i}.txt`); writeFileSync(f, `Unseen holdout ${i}: build a calm scene with clear foreground and background layers.\n`); return f; });
    const runs = readdirSync(seal).filter(f => /^dream-run-\d+\.json$/.test(f)).sort();
    expect(runs.length).toBe(2);
    const denv = (i: number): NodeJS.ProcessEnv => ({ ...env, SINTER_DREAM_HOLDOUT_FILE: holdouts[i], SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST: renderer,
      SINTER_DREAM_MAX_PROVIDER_ATTEMPTS: '7', SINTER_DREAM_CAMPAIGN_ID: `pilot-${i}` });
    for (const [i, f] of runs.entries()) {
      const r = await runSinterAsync(['dream', 'run', path.join(seal, f)], denv(i));
      log(`RUN${i} ` + r.status + ' ' + r.out.slice(-700) + ' | ' + R.log.kinds.join(','));
      expect(r.status, r.out.slice(-800)).toBe(0);
    }
    const keys: string[] = [];
    for (const [i, f] of runs.entries()) {
      const key = (JSON.parse(readFileSync(path.join(seal, f), 'utf8')) as { idempotencyKey: string }).idempotencyKey;
      const cmd = path.join(seal, `transfer-${i}.json`);
      writeFileSync(cmd, JSON.stringify({ schema: 'sinter.dream-transfer-command', schemaVersion: 1, idempotencyKey: `transfer:${key}`, dreamKey: key }));
      const t = await runSinterAsync(['dream', 'transfer', cmd], denv(i));
      log(`TRANSFER${i} ` + t.status + ' ' + t.out.slice(-900) + ' | JUDGED ' + JSON.stringify([...gen.judged, ...evalA.judged, ...evalB.judged].slice(-4).map(c => [c.images, c.user.slice(0, 150)])));
      expect(t.status, t.out.slice(-800)).toBe(0);
      keys.push(`transfer:${key}`);
    }
    const act = path.join(seal, 'activate.json');
    writeFileSync(act, JSON.stringify({ schema: 'sinter.dream-activation-command', schemaVersion: 1,
      idempotencyKey: `activate:${sha256(keys.slice().sort().join('\0')).slice(0, 24)}`, transferKeys: keys }));
    const ac = await runSinterAsync(['dream', 'activate', act], denv(0));
    log('ACTIVATE ' + ac.status + ' ' + ac.out.slice(-1200));
    expect(ac.status, ac.out.slice(-800)).toBe(0);
    log('KNOW ' + readdirSync(know) + ' ' + readFileSync(path.join(know, 'activated-knowledge.json'), 'utf8').slice(0, 600));
    const comp = path.join(seal, 'compound.json');
    writeFileSync(comp, JSON.stringify({ schema: 'sinter.compound-create-command', schemaVersion: 1, idempotencyKey: 'compound-pilot',
      activation: JSON.parse(readFileSync(act, 'utf8')) }));
    const cc = await runSinterAsync(['dream', 'compound', comp], denv(0));
    log('COMPOUND ' + cc.status + ' ' + cc.out.slice(-1800) + ' | ' + R.log.kinds.slice(-14).join(','));
    expect(cc.status, cc.out.slice(-800)).toBe(0);
    // The activated lesson reached a later Create prompt, and the compound judge preferred that arm.
    expect(R.log.kinds, 'a Create after activation carried the validated-transfer lesson').toContain('create-taught');
    expect(gen.generated.some(c => (c.system + c.user).includes(LESSON_PREFIX))).toBe(true);
    const projectionFile = path.join(state, 'compound-create-projections.json');
    const savedProjection = readFileSync(projectionFile, 'utf8');
    const projections = Object.values(JSON.parse(savedProjection) as Record<string, CompoundCreateProjection>);
    expect(projections).toHaveLength(1);
    const compound = projections[0]!;
    log('COMPOUND-PROJECTION ' + JSON.stringify(compound).slice(0, 600));
    expect(compound.outcome, 'compound gain proven').toBe('compound-proven');
    expect(compound.trials.length).toBeGreaterThan(0);
    for (const trial of compound.trials) {
      expect(trial.meanDelta, 'treatment score minus control score').toBeGreaterThan(0);
    }
    const requests = () => [gen, evalA, evalB].map((provider) => [provider.generated.length, provider.judged.length]);
    const beforeReplay = requests();
    const replay = await runSinterAsync(['dream', 'compound', comp], denv(0));
    expect(replay.status, replay.out.slice(-800)).toBe(0);
    expect(requests()).toEqual(beforeReplay);
    expect(readFileSync(projectionFile, 'utf8')).toBe(savedProjection);
  });
});
