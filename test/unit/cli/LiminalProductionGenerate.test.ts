import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validateSVGFragment } from '../../../src/generators/svg/SVGFragment.js';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertGovernedCliCompatibility, runProductionCliGenerate }
  from '../../../src/cli/LiminalProductionGenerate.js';

describe('governed CLI generation', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('fails incompatible legacy flags closed', () => {
    expect(() => assertGovernedCliCompatibility({ useSwarm: true }))
      .toThrow('GOVERNED_GENERATE_FLAGS_UNSUPPORTED:--use-swarm');
    expect(() => assertGovernedCliCompatibility({ stages: 'generate' }))
      .toThrow('GOVERNED_GENERATE_FLAGS_UNSUPPORTED:--stages');
    expect(() => assertGovernedCliCompatibility({ explicitMaxIterations: 1 }))
      .not.toThrow();
  });

  it('help never advertises a flag that governed generate rejects as usable with it', () => {
    const help = readFileSync(path.resolve(__dirname, '../../../bin/sinter'), 'utf8');
    const line = (flag: string) => help.split('\n').find((l) => l.includes(`'  ${flag} `) || l.includes(`'  ${flag},`)) ?? '';
    expect(line('--max-iterations')).toContain('generate accepts only 1');
    for (const flag of ['--stages', '--use-swarm', '--learn', '--intuition', '--aesthetic', '--aesthetic-config', '--voice', '--voice-file', '--model']) {
      expect([flag, line(flag).includes('[not with generate]')]).toEqual([flag, true]);
    }
  });

  it.each([false, true])('submits Create with worker-scoped state=%s and returns artifact paths', async workerScoped => {
    const root = workerScoped
      ? path.join(process.env.HOME || '/tmp', '.sinter', 'output')
      : path.resolve('/tmp/liminal-cli-test');
    const stateRoot = path.resolve('/tmp/liminal-worker-state');
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', workerScoped ? stateRoot : undefined);
    const result = { operationId: 'operation:cli' } as never;
    const command = { idempotencyKey: 'governed-cli' } as never;
    const createCommand = vi.fn(() => command);
    const submitCreate = vi.fn(async () => ({ kind: 'create', result }));
    const close = vi.fn(async () => undefined);
    const factory = vi.fn(async () => ({ root, createCommand,
      port: { submitCreate }, close }) as never);

    const generated = await runProductionCliGenerate({ prompt: 'A deep field',
      domain: 'p5', outputRoot: root, maxTransportAttempts: 2 }, factory);

    expect(factory).toHaveBeenCalledWith({
      root: workerScoped ? stateRoot : root, artifactRoot: root });
    expect(createCommand).toHaveBeenCalledWith({ prompt: 'A deep field',
      domain: 'p5', maxTransportAttempts: 2 });
    expect(submitCreate).toHaveBeenCalledWith('cli', command);
    expect(generated.sourcePath).toMatch(/artifacts\/[a-f0-9]{64}\/source\.txt$/);
    expect(generated.playablePath).toMatch(/artifacts\/[a-f0-9]{64}\/playable\.html$/);
    expect(generated.sourcePath).toContain(`${root}/artifacts/`);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps an explicit output root as the replay root even when worker state is configured', async () => {
    const root = path.resolve('/tmp/liminal-explicit-output');
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', path.resolve('/tmp/liminal-worker-state'));
    const factory = vi.fn(async () => { throw new Error('bootstrap-stopped'); });
    await expect(runProductionCliGenerate({ prompt: 'Test', domain: 'svg',
      outputRoot: root }, factory)).rejects.toThrow('bootstrap-stopped');
    expect(factory).toHaveBeenCalledWith({ root, artifactRoot: root });
  });

  it('places paired CLI artifacts under the configured collector root', async () => {
    const artifactsRoot = path.resolve('/tmp/liminal-worker-runtime/artifacts');
    const outputRoot = path.join(artifactsRoot, 'paired', 'pair-1', 'active', 'turn-190');
    const operationId = 'operation:paired-cli';
    const submitCreate = vi.fn(async () => ({ kind: 'create', result: { operationId } }));
    const factory = vi.fn(async () => ({ createCommand: vi.fn(() => ({})),
      port: { submitCreate }, close: vi.fn(async () => undefined) }) as never);
    const generated = await runProductionCliGenerate({ prompt: 'A paired field',
      domain: 'p5', outputRoot }, factory);
    const operationDirectory = createHash('sha256').update(operationId).digest('hex');
    expect(generated.playablePath).toBe(path.join(outputRoot, 'artifacts', operationDirectory, 'playable.html'));
    expect(generated.playablePath.startsWith(`${artifactsRoot}${path.sep}`)).toBe(true);
  });

  describe('SVG fragment asset (#1162)', () => {
    const spec = { tokens: ['art-red'], motion: 'none' as const };
    const accepted = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0L10 10" stroke="var(--art-red)"/></svg>';
    const operationId = 'operation:fragment';
    // Stub at the runtime boundary: persists source.txt the way LiminalCommandFilePersistence does.
    const factoryFor = (outputRoot: string, source: string | null, fail = false) =>
      vi.fn(async () => ({ createCommand: vi.fn(() => ({})),
        port: { submitCreate: vi.fn(async () => {
          if (fail) throw new Error('GENERATION_FAILED');
          const dir = path.join(outputRoot, 'artifacts', createHash('sha256').update(operationId).digest('hex'));
          mkdirSync(dir, { recursive: true });
          if (source !== null) writeFileSync(path.join(dir, 'source.txt'), source);
          return { kind: 'create', result: { operationId } };
        }) }, close: vi.fn(async () => undefined) }) as never);
    const tmp = () => mkdtempSync(path.join(tmpdir(), 'sinter-fragment-'));
    const fragmentAt = (out: string) => path.join(out, 'artifacts',
      createHash('sha256').update(operationId).digest('hex'), 'fragment.svg');

    it('writes the accepted source as fragment.svg and returns its path', async () => {
      const out = tmp();
      const generated = await runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg',
        outputRoot: out, fragmentSpec: spec }, factoryFor(out, accepted));
      expect(generated.fragmentPath).toBe(fragmentAt(out));
      const written = readFileSync(fragmentAt(out), 'utf8');
      expect(written).toBe(accepted);
      expect(validateSVGFragment(written, spec).valid).toBe(true);
    });

    it('writes no fragment.svg in standalone mode', async () => {
      const out = tmp();
      const generated = await runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg',
        outputRoot: out }, factoryFor(out, accepted));
      expect(generated.fragmentPath).toBeUndefined();
      expect(existsSync(fragmentAt(out))).toBe(false);
    });

    it('writes no fragment.svg when generation fails', async () => {
      const out = tmp();
      await expect(runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg',
        outputRoot: out, fragmentSpec: spec }, factoryFor(out, null, true))).rejects.toThrow('GENERATION_FAILED');
      expect(existsSync(fragmentAt(out))).toBe(false);
    });

    it('refuses to publish a stored source that is not a valid fragment', async () => {
      const out = tmp();
      await expect(runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg', outputRoot: out,
        fragmentSpec: spec }, factoryFor(out, accepted.replace('var(--art-red)', '#f00'))))
        .rejects.toThrow('SVG_FRAGMENT_INVALID');
      expect(existsSync(fragmentAt(out))).toBe(false);
    });
  });
});
