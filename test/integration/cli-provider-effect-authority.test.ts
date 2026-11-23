import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProductionCliCycleEffect, runProductionCliProviderEffect } from
  '../../src/cli/LiminalProductionProviderEffect.js';
import { generateMusic } from '../../src/music/generateMusic.js';
import { generateVisuals } from '../../src/generateVisuals.js';
import { bootstrapHostAuthority, pinnedProductionHostAuthorityRoot } from
  '../../src/identity/executorAuthorityBootstrap.js';
import { AutoFixOrchestrator } from '../../src/fix/AutoFixOrchestrator.js';
import { LLMClient } from '../../src/llm/LLMClient.js';
import { bootstrapProductionReceiptAuthority } from
  '../../src/runtime-core/LiminalCommandService.js';
import { bootstrapProductionLiminalOwnerReviewAuthority } from
  '../../src/runtime-core/LiminalOwnerReviewAuthority.js';
import { bootstrapProductionLiminalRuntime } from
  '../../src/runtime-core/ProductionLiminalRuntime.js';

const STRUDEL = 'stack(s("bd*4"), note("c3 e3 g3").s("sawtooth")).cpm(30)';
const HYDRA = 'osc(10, 0.1, 1.2).rotate(0.3).out()';

// Provider config is read from ~/.sinter when the modules above load, before any
// beforeAll runs, so a developer host with a configured seat (e.g. GLM) leaked
// into this file. Pin HOME to a temp dir before the imports evaluate.
const pinnedHome = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cli-provider-home-'));
  process.env.HOME = dir;
  return dir;
});

describe('governed CLI provider effect (#710): live-music and fix transports', () => {
  const roots: string[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;
  let nextCode: () => string;

  let keyFile: string;

  let home: string;

  beforeAll(async () => {
    // The production executor authority is a process singleton bound to the
    // first HOME it sees, so one temp HOME serves the whole file.
    home = pinnedHome;
    keyFile = path.join(home, '.sinter', 'authority', 'liminal-command-receipt.key');
    vi.stubEnv('HOME', home);
    vi.stubEnv('SINTER_EXECUTOR_AUTHORITY_ROOT', '');
    // The pinned host trust root every production LLMClient binds to.
    bootstrapHostAuthority({ rootDir: pinnedProductionHostAuthorityRoot() });
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Real production authority and gate, with its host keys under the temp HOME.
    vi.stubEnv('HOME', home);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SINTER_EXECUTOR_AUTHORITY_ROOT', '');
    LLMClient.clearGlobalCache();
    vi.stubEnv('LLM_BASE_URL', 'http://provider.invalid/v1');
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_MODEL', 'test-model');
    nextCode = () => '```js\n' + STRUDEL + '\n```';
    // Network boundary only: everything above fetch is the real code path.
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'x', model: 'test-model', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: nextCode() }], stop_reason: 'end_turn',
      choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: nextCode() } }],
      usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1,
        total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cli-provider-effect-'));
    roots.push(root);
    return root;
  }

  function factory(close = vi.fn(async () => undefined)) {
    const client = (role: string) => ({ getConfig: () => ({ provider: 'fake-transport',
      model: role, baseUrl: `http://${role}.invalid/v1` }) }) as never;
    return {
      close,
      create: async (options: { root?: string }) => {
        const runtime = await bootstrapProductionLiminalRuntime({ root: options.root,
          generator: client('generator'), evaluator: client('evaluator'),
          renderer: { render: vi.fn(), close: vi.fn(async () => undefined) } as never,
          sourceRefs: { sourceHeadSha: '1'.repeat(40), canonicalMainSha: '2'.repeat(40) },
          harnessIdentity: 'fake/harness', studioIdentity: 'fake/studio',
          receiptAuthority: await bootstrapProductionReceiptAuthority(keyFile),
          ownerReviewAuthority: await bootstrapProductionLiminalOwnerReviewAuthority(keyFile),
          knowledgeSigningKey: 'provider-effect-knowledge' });
        return Object.freeze({ ...runtime, close: async () => {
          await close();
          await runtime.close();
        } });
      },
    };
  }

  it('rejects an ungoverned generator call before any network traffic (no grant)', async () => {
    const client = new LLMClient({ role: 'generator' });
    await expect(client.generate('system', 'user'))
      .rejects.toThrow('Provider transport requires Liminal product command authority');
    // live-music's visuals step refuses the template fallback, so the same
    // gate surfaces as the reported live-music failure.
    await expect(generateVisuals({ prompt: 'aurora', platform: 'hydra', llm: client }))
      .rejects.toThrow('Provider transport requires Liminal product command authority');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('live-music generation reaches the provider transport under a journal grant', async () => {
    const root = await tempRoot();
    const runtime = factory();
    const llm = new LLMClient({ role: 'generator' });
    const out = await runProductionCliProviderEffect({
      idempotencyKey: 'production-live-music:test-1',
      binding: { surface: 'cli-live-music', prompt: 'aurora' },
      maxGeneratorAttempts: 2,
      outputRoot: root,
      effect: async () => {
            const music = await generateMusic({ prompt: 'aurora', platform: 'strudel', llm });
        nextCode = () => '```js\n' + HYDRA + '\n```';
        const visuals = await generateVisuals({ prompt: 'aurora', platform: 'hydra', llm });
        return { music, visuals };
      },
    }, runtime.create);
    expect(out.music.source).toBe('llm');
    expect(out.music.code).toBe(STRUDEL);
    expect(out.visuals.source).toBe('llm');
    expect(out.visuals.code).toBe(HYDRA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  // Sol F17: the project sync contract must reach the wire for BOTH generators, not just a stdout line.
  it('live-music sends the project sync contract to both the music and the visuals request', async () => {
    const root = await tempRoot();
    const runtime = factory();
    const llm = new LLMClient({ role: 'generator' });
    const { withLiveSync } = await import('../../src/music/liveSyncContract.js');
    const synced = withLiveSync('aurora', { syncMode: 'osc', oscHost: '127.0.0.1:57120' });
    await runProductionCliProviderEffect({
      idempotencyKey: 'production-live-music:sync-1',
      binding: { surface: 'cli-live-music', prompt: 'aurora' },
      maxGeneratorAttempts: 2,
      outputRoot: root,
      effect: async () => {
        const music = await generateMusic({ prompt: synced, sourcePrompt: 'aurora', platform: 'strudel', llm });
        nextCode = () => '```js\n' + HYDRA + '\n```';
        const visuals = await generateVisuals({ prompt: synced, platform: 'hydra', llm });
        return { music, visuals };
      },
    }, runtime.create);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const body = String((call[1] as { body?: unknown }).body);
      expect(body).toContain('Sync mode: osc');
      expect(body).toContain('OSC host: 127.0.0.1:57120');
    }
  });

  it.each(['gui-live-music', 'gui-live-visuals'])('counts each %s transport against one attempt', async surface => {
    const run = factory();
    const client = new LLMClient({ role: 'generator' });
    const root = await tempRoot();
    await expect(runProductionCliProviderEffect({
      idempotencyKey: `production-live-music:${surface}:test`,
      binding: { surface, prompt: 'aurora' },
      outputRoot: root,
      effect: async () => {
        await client.generate('system', 'first');
        await client.generate('system', 'second');
      },
    }, run.create)).rejects.toThrow('TRANSPORT_ATTEMPT_CAP_EXHAUSTED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fix: LLMModeAgent reaches the provider under a grant and is rejected without one', async () => {
    const root = await tempRoot();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const llm = new LLMClient({ role: 'generator' });
      const request = { type: 'natural-language' as const, target: undefined,
        errorDescription: 'rename the helper', dryRun: false, confirmLevel: 'never' as const };
      nextCode = () => 'I have no tool call to make.';
      const ungoverned = await new AutoFixOrchestrator(llm).executeFix(request);
      expect(ungoverned.success).toBe(false);
      expect(ungoverned.error).toBe('Fix failed after 1 steps');
      expect(fetchMock).not.toHaveBeenCalled();

      const runtime = factory();
      await runProductionCliProviderEffect({
        idempotencyKey: 'production-fix:test-agent',
        binding: { surface: 'cli-fix', type: 'natural-language' },
        outputRoot: root,
        effect: () => new AutoFixOrchestrator(llm).executeFix(request),
      }, runtime.create);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(runtime.close).toHaveBeenCalledOnce();
    } finally {
      process.chdir(cwd);
    }
  });

  it('journals each generator transport and blocks an attempt beyond the cycle cap', async () => {
    const root = await tempRoot();
    const client = new LLMClient({ role: 'generator' });
    const run = factory();
    const key = 'production-cycle:test-cap';
    await expect(runProductionCliCycleEffect({
      idempotencyKey: key,
      binding: { surface: 'test-cycle' },
      maxGeneratorAttempts: 2,
      outputRoot: root,
      effect: async () => {
        await client.generate('system', 'first piece');
        await client.generate('system', 'second piece');
        await client.generate('system', 'third piece');
        throw new Error('later cycle stage failed');
      },
    }, run.create)).rejects.toThrow(/TRANSPORT_ATTEMPT_CAP_EXHAUSTED|later cycle stage failed/);
    const journal = JSON.parse(await readFile(path.join(root, 'operation-journal.json'), 'utf8'));
    const operation = journal.operations[key];
    expect(operation.attemptsConsumed).toBe(2);
    expect(journal.events.filter((event: { type: string; operationId: string }) =>
      event.type === 'transport-started' && event.operationId === operation.operationId)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('settles the grant and closes the runtime when the effect throws', async () => {
    const root = await tempRoot();
    const runtime = factory();
    const client = new LLMClient({ role: 'generator' });
    await expect(runProductionCliProviderEffect({
      idempotencyKey: 'production-fix:test-fail',
      binding: { surface: 'cli-fix' },
      outputRoot: root,
      effect: async () => { throw new Error('provider exploded'); },
    }, runtime.create)).rejects.toThrow('provider exploded');
    expect(runtime.close).toHaveBeenCalledOnce();
    // The grant does not outlive the effect: transport is rejected again.
    await expect(client.generate('s', 'u'))
      .rejects.toThrow('Provider transport requires Liminal product command authority');
  });

  it('wires bin/sinter live-music and fix through the governed effect', async () => {
    const cli = await readFile(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
    const live = cli.slice(cli.indexOf('if (isLiveMusic) {'), cli.indexOf("if (cmd === 'site')"));
    expect(live).toMatch(/runProductionCliProviderEffect\(\{[\s\S]*generateMusic[\s\S]*generateVisuals/);
    expect(live).not.toMatch(/await generateMusic\(\{[^}]*\}\);\s*const strudelPath/);
    const fix = cli.slice(cli.indexOf("else if (cmd === 'fix') {"));
    expect(fix.slice(0, 6000)).toMatch(
      /runProductionCliProviderEffect\(\{[\s\S]*effect: \(\) => orchestrator\.executeFix\(fixRequest\)/);
  });

  it('rejects a non-absolute runtime root before bootstrapping', async () => {
    const create = vi.fn();
    await expect(runProductionCliProviderEffect({
      idempotencyKey: 'k', binding: {}, outputRoot: 'relative/root',
      effect: async () => 1,
    }, create as never)).rejects.toThrow('GOVERNED_PROVIDER_EFFECT_ROOT_NOT_ABSOLUTE');
    expect(create).not.toHaveBeenCalled();
  });
});
