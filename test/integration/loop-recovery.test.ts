import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runGovernedLoops, LoopReplayIntegrityError, loopFolder, type RunLoopsInput } from '../../src/cli/LiminalProductionLoops.js';
import { runProductionCliGenerate } from '../../src/cli/LiminalProductionGenerate.js';
import { runComposeLoops } from '../../src/cli/LiminalProductionComposeLoops.js';
import { createTestReceiptAuthority, LiminalCommandService, type LiminalCommandEffects } from '../../src/runtime-core/LiminalCommandService.js';
import { FileLiminalArtifactStore, FileLiminalOperationJournal } from '../../src/runtime-core/LiminalCommandFilePersistence.js';
import { FileLiminalProductCommandStore, LiminalProductCommandPort } from '../../src/runtime-core/LiminalProductCommandPort.js';
import { FileGenerationCheckpointStore } from '../../src/runtime-core/GenerationCheckpoints.js';
import { createLiminalProductionEffects } from '../../src/runtime-core/LiminalProductionEffects.js';
import * as runtime from '../../src/runtime-core/ProductionLiminalRuntime.js';
import type { CoordinatedCompositionResult } from '../../src/creative-run/CreativeRunCoordinatorBase.js';
import { compileCreativeThesis } from '../../src/creative-intelligence/CreativeIntelligence.js';
import { assertProviderAttemptAllowed } from '../../src/llm/LLMClient.js';

let out: string;
beforeEach(() => {
  out = mkdtempSync(path.join(tmpdir(), 'loop-recovery-'));
  vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', '');
  vi.stubEnv('SINTER_PROJECT_ROOT', out);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(out, { recursive: true, force: true }); });

const identities = { generator: 'fake/generator', evaluator: 'fake/evaluator', renderer: 'fake/renderer',
  harness: 'fake/harness', studio: 'fake/studio' };
const sha = '7'.repeat(40);
const createCommand = runtime.commandFactory({ sourceHeadSha: sha, canonicalMainSha: sha, sourceKind: 'explicit',
  sourceHeadSource: 'caller', canonicalMainSource: 'caller' }, identities);
const dispatched = vi.fn();
const effects: LiminalCommandEffects = {
  generate: async input => {
    await input.startTransport();
    dispatched();
    return { source: 'draft ' + dispatched.mock.calls.length, playable: '<html/>', provenance: 'fixture' };
  },
  render: async () => ({ status: 'rendered', rendererIdentity: identities.renderer,
    earlyFrame: Buffer.from('early'), lateFrame: Buffer.from('late'), runtimeErrors: [],
    audio: { relevant: false, state: 'not-applicable' } }),
  evaluate: async input => {
    await input.startTransport();
    return { score: 0.8, degraded: false, identityValid: true,
      evaluatorIdentity: identities.evaluator, evidenceDigest: input.evidenceDigest };
  },
};

function factory(activeEffects = effects) {
  return async ({ root }: { root?: string } = {}) => {
    if (!root) throw new Error('test requires a file-backed loop');
    const createAuthority = new LiminalCommandService({ effects: activeEffects,
      journal: new FileLiminalOperationJournal(path.join(root, 'operation-journal.json')),
      artifacts: new FileLiminalArtifactStore(path.join(root, 'artifacts')), authority: createTestReceiptAuthority(sha) });
    const port = new LiminalProductCommandPort(createAuthority, undefined,
      new FileLiminalProductCommandStore(path.join(root, 'product-projections.json')));
    return { createAuthority, createCommand, port, identities, close: async () => {} } as runtime.ProductionLiminalRuntime;
  };
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function checkpointPrefix(length: number) {
  const file = path.join(out, 'loops-manifest.json');
  const manifest = read(file);
  writeFileSync(file, JSON.stringify({ ...manifest, records: manifest.records.slice(0, length) }));
}

function generate(activeEffects: LiminalCommandEffects, loops: number, retryUnknown?: RunLoopsInput['retryUnknown'], interrupt = false) {
  return runGovernedLoops({ request: 'a field', domain: 'p5', outputRoot: out, loops, providerCallsPerLoop: 2,
    verifyResumedCreates: true, retryUnknown, retryArgs: ['generate', '--domain', 'p5', '--loops', String(loops), '-o', out, 'a field'],
    generateOne: async ({ prompt, outputRoot, attemptId, replayOnly, onRetryUnknown }) => {
      const g = await runProductionCliGenerate({ prompt, outputRoot, attemptId, domain: 'p5',
        adoptReplayedArtifacts: true, maxTransportAttempts: 2, replayOnly, onRetryUnknown }, factory(activeEffects)).catch(error => {
          if (interrupt) throw new LoopReplayIntegrityError(error);
          throw error;
        });
      return { score: g.prior!.score, critique: g.prior!.critique, prior: g.prior, providerCalls: g.result.attempts.consumed };
    } });
}

it('refuses a billed truncated reply on default resume and prints the scoped retry command', async () => {
  const send = vi.fn(async () => ({ success: false, finishReason: 'length',
    code: 'function setup() { createCanvas(720, 480); }\nfunction draw() { ellipse(', usage: { completionTokens: 4096 } }));
  const truncated = createLiminalProductionEffects({
    generator: { getConfig: () => ({ provider: 'fake', model: 'generator', maxTokens: 4096 }), generate: send } as never,
    evaluator: {} as never, renderer: {} as never, generatorIdentity: identities.generator,
    evaluatorIdentity: identities.evaluator, rendererIdentity: identities.renderer,
    checkpoints: new FileGenerationCheckpointStore(path.join(out, 'checkpoints')),
  });
  await expect(generate(truncated, 2, false, true)).rejects.toThrow('GENERATION_TRUNCATED');
  expect(send).toHaveBeenCalledTimes(2);
  const journal = read(path.join(loopFolder(out, 1), 'operation-journal.json'));
  expect(Object.values(journal.operations)).toEqual([expect.objectContaining({ attemptsConsumed: 1 })]);
  expect(Object.values(journal.effects)).toEqual([expect.objectContaining({ state: 'ambiguous' })]);
  const error = await generate(truncated, 2).then(() => undefined, reason => reason);
  expect(send).toHaveBeenCalledTimes(2);
  expect(error?.message).toMatch(/loop 1\/2.*outcome is unknown.*already have been billed.*completed loops are safe/is);
  expect(error?.message).toContain(`sinter generate --domain p5 --loops 2 -o ${out} 'a field' --retry-unknown=1`);
});

it('retries only the unprojected Create in place and replays its new identity on restart', async () => {
  const first = await generate(effects, 2);
  expect(first.manifest.records.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
  const original = path.join(loopFolder(out, 1), 'operation-journal.json');
  const bytes = readFileSync(original);
  const dir = loopFolder(out, 2);
  const operations = () => Object.keys(read(path.join(dir, 'operation-journal.json')).operations);
  const before = operations();
  rmSync(path.join(dir, 'product-projections.json'));
  checkpointPrefix(1);
  dispatched.mockClear();
  const [recovered] = await Promise.all([generate(effects, 2, true), generate(effects, 2, true)]);
  expect(dispatched).toHaveBeenCalledTimes(1);
  expect(readFileSync(original)).toEqual(bytes);
  expect(operations()).toHaveLength(before.length + 1);
  expect(operations()).toEqual(expect.arrayContaining(before));
  expect(recovered.manifest.ownerRetries).toEqual([expect.objectContaining({ loop: 2, attemptId: expect.any(String) })]);
  await generate(effects, 2);
  await generate(effects, 2, true);
  expect(dispatched).toHaveBeenCalledTimes(1);
});

function composeFixture() {
  vi.spyOn(runtime, 'createProductionLiminalRuntime').mockImplementation(factory());
  const delegate = { composeFromPrompt: vi.fn(async () => {
    assertProviderAttemptAllowed();
    return { html: '<html>field</html>', title: 'Field', background: '#000', successCount: 1,
      creativeThesis: compileCreativeThesis('A field opens into light.'),
      layers: [{ domain: 'p5' as const, prompt: 'a field', blendMode: 'normal' as const, opacity: 1,
        code: 'field', codeLength: 5, generated: true, artifactHtml: '<html>field</html>' }] } as CoordinatedCompositionResult;
  }) };
  const run = (retryUnknown?: RunLoopsInput['retryUnknown']) => runComposeLoops({ prompt: 'a field',
    outputRoot: out, loops: 2, providerCallsPerLoop: 1, delegate, retryUnknown,
    retryArgs: ['compose', '--loops', '2', '-o', out, '--prompt', 'a field'] });
  return { run, delegate };
}

it.each([0, 2])('recovers a missing compose piece from the completed journal with %i checkpointed loops', async records => {
  const { run, delegate } = composeFixture();
  const first = await run();
  const piece = path.join(loopFolder(out, 1), 'compose-loop.json');
  const expected = readFileSync(piece);
  rmSync(piece);
  checkpointPrefix(records);
  const result = await run();
  expect(result.bestLoop).toBe(first.bestLoop);
  expect(readFileSync(piece)).toEqual(expected);
  expect(delegate.composeFromPrompt).toHaveBeenCalledTimes(2);
});

it('keeps an incomplete compose journal replay-only until the owner retries that loop', async () => {
  const { run, delegate } = composeFixture();
  delegate.composeFromPrompt.mockRejectedValueOnce(new LoopReplayIntegrityError('provider timed out'));
  await expect(run()).rejects.toThrow('provider timed out');
  const calls = delegate.composeFromPrompt.mock.calls.length;
  await expect(run()).rejects.toThrow(/loop 1\/2.*unknown.*--retry-unknown=1/is);
  expect(delegate.composeFromPrompt).toHaveBeenCalledTimes(calls);
  const journalFile = path.join(loopFolder(out, 1), 'operation-journal.json');
  const before = readFileSync(journalFile);
  await expect(run()).rejects.toThrow('--retry-unknown=1');
  expect(readFileSync(journalFile)).toEqual(before);
  const retried = await run(1);
  expect(retried.manifest.records.map(r => r.loop)).toEqual([1]);
  expect(retried.manifest.ownerRetries).toHaveLength(1);
  expect(delegate.composeFromPrompt).toHaveBeenCalledTimes(calls + 1);
});

it('keeps both replaced roots and mismatched accounting closed to owner retries', async () => {
  const { run, delegate } = composeFixture();
  await run();
  const dir = loopFolder(out, 2);
  const piece = path.join(dir, 'compose-loop.json');
  const original = readFileSync(piece);
  checkpointPrefix(1);
  writeFileSync(piece, JSON.stringify({ ...read(piece), providerCalls: 0 }));
  await expect(run(true)).rejects.toThrow('COMPOSE_LOOP_PROVIDER_ACCOUNTING_MISMATCH');
  writeFileSync(piece, original);
  renameSync(dir, dir + '-saved');
  mkdirSync(dir);
  await expect(run(true)).rejects.toThrow('LOOPS_RESUME_EFFECT_MISMATCH');
  expect(delegate.composeFromPrompt).toHaveBeenCalledTimes(2);
});

it('refuses a substituted compose export while restoring a checkpointed piece', async () => {
  const { run, delegate } = composeFixture();
  await run();
  const dir = loopFolder(out, 1);
  rmSync(path.join(dir, 'compose-loop.json'));
  writeFileSync(path.join(dir, 'composition.html'), 'replacement');
  await expect(run(true)).rejects.toThrow('LOOPS_RESUME_ARTIFACT_MISMATCH');
  expect(readFileSync(path.join(dir, 'composition.html'), 'utf8')).toBe('replacement');
  expect(delegate.composeFromPrompt).toHaveBeenCalledTimes(2);
});

it('the CLI exits nonzero after a kill and its printed command retries only the named loop', () => {
  const args = ['compose', '--loops', '3', '--max-provider-calls', '1', '-o', 'run', '--prompt', "a field's light"];
  const preload = path.resolve('test/helpers/killedComposePreload.mjs');
  const bin = path.resolve('bin/sinter');
  const cli = (argv: string[]) => spawnSync(process.execPath, ['--import', preload, bin, ...argv], {
    cwd: out, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: out, NODE_ENV: 'test' } });
  const killed = cli(args);
  expect(killed.signal, killed.stderr).toBe('SIGKILL');
  const sent = () => readFileSync(path.join(out, 'dispatches'), 'utf8');
  expect(sent()).toBe('xx');
  const resume = cli(args);
  expect(resume.status, resume.stderr).toBe(1);
  expect(sent()).toBe('xx');
  expect(resume.stderr).toContain('Loop 2/3');
  expect(resume.stderr).toContain("sinter compose --loops 3 --max-provider-calls 1 -o run --prompt 'a field'\\''s light' --retry-unknown=2");
  const retry = cli([...args, '--retry-unknown=2']);
  expect(retry.status, retry.stderr).toBe(0);
  expect(sent()).toBe('xxx');
  const manifest = read(path.join(out, 'run', 'loops-manifest.json'));
  expect(manifest.records.map((r: { status: string }) => r.status)).toEqual(['resumed', 'ok']);
  expect(manifest.ownerRetries).toEqual([expect.objectContaining({ loop: 2 })]);
}, 100_000);

it('keeps the state root, command digest and legacy manifest checks ahead of consent', async () => {
  await generate(effects, 2);
  dispatched.mockClear();
  vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', out);
  await expect(generate(effects, 2, true)).rejects.toThrow('LOOPS_RESUME_EFFECT_MISMATCH');
  vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', '');
  const file = path.join(loopFolder(out, 1), 'product-projections.json');
  const projections = read(file);
  projections[Object.keys(projections)[0]].commandDigest = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(projections));
  await expect(generate(effects, 2, true)).rejects.toThrow('LOOP_REPLAY_PROJECTION_MISSING_OR_WRONG_COMMAND');
  const manifestFile = path.join(out, 'loops-manifest.json');
  const manifest = read(manifestFile);
  delete manifest.requestBindingVersion;
  writeFileSync(manifestFile, JSON.stringify(manifest));
  await expect(generate(effects, 2, true)).rejects.toThrow('LOOPS_UNBOUND_PRIOR_RUN');
  expect(dispatched).not.toHaveBeenCalled();
});
