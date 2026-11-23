import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validateSVGFragment } from '../../../src/generators/svg/SVGFragment.js';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSharedRuntimeRoot } from '../../../src/runtime-core/ProductionLiminalRuntime.js';
import { loadPieceExemplars, pieceArchiveDir } from '../../../src/learning/PieceExemplars.js';
import { SeedArchive } from '../../../src/gallery/SeedArchive.js';
import { assertGovernedCliCompatibility, runProductionCliGenerate }
  from '../../../src/cli/LiminalProductionGenerate.js';

describe('governed CLI generation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('records the batch prompt ID and verified playable digest in the accepted seed', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'liminal-cli-seed-'));
    try {
      vi.stubEnv('HOME', path.join(project, 'home'));
      vi.stubEnv('SINTER_PROJECT_ROOT', project);
      vi.stubEnv('SINTER_PROMPT_ID', 'study-01');
      const outputRoot = path.join(project, 'out');
      const operationId = 'operation:seed';
      const hash = createHash('sha256').update(operationId).digest('hex');
      const directory = path.join(outputRoot, 'artifacts', hash);
      const source = '<svg><circle r="3"/></svg>';
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'source.txt'), source);
      const result = { operationId, roles: { generator: 'test-generator' }, receipt: { artifactDigest: 'a'.repeat(64) },
        artifacts: { playableDigest: 'b'.repeat(64) },
        evaluation: { score: 0.8, admissionEligible: true, identityValid: true } };
      const factory = vi.fn(async () => ({
        createCommand: () => ({ idempotencyKey: 'seed' }), close: async () => undefined,
        port: { submitCreate: async () => ({ kind: 'create', result }), readVerifiedCreateResult: async () => result,
          readBoundTasteAdmission: async () => undefined },
        createAuthority: { readVerifiedArtifact: async () => ({ source }) },
      }) as never);
      await runProductionCliGenerate({ prompt: 'A circle study', domain: 'svg', outputRoot }, factory);

      const name = 'svg-' + hash.slice(0, 8);
      expect(await new SeedArchive(pieceArchiveDir(project)).loadSeed(name))
        .toMatchObject({ promptId: 'study-01', playableSha256: 'b'.repeat(64) });
      const learning = path.join(project, '.sinter', 'learning');
      mkdirSync(learning, { recursive: true });
      writeFileSync(path.join(learning, 'holdout-prompts.txt'), 'study-01\n');
      expect(await loadPieceExemplars('svg', project)).toEqual([]);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
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
    // --voice-file is wired into generate (src/audio/VoiceBrief.ts); help must not call it unsupported.
    expect(line('--voice-file')).not.toContain('[not with generate]');
    for (const flag of ['--stages', '--use-swarm', '--learn', '--intuition', '--aesthetic', '--aesthetic-config', '--voice', '--model']) {
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

  it('SINTER_LIMINAL_RUNTIME_ROOT wins over a non-default -o for the state root', async () => {
    const outputRoot = path.resolve('/tmp/liminal-explicit-output');
    const envRuntimeRoot = path.resolve('/tmp/liminal-worker-state');
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', envRuntimeRoot);
    const factory = vi.fn(async () => { throw new Error('bootstrap-stopped'); });
    await expect(runProductionCliGenerate({ prompt: 'Test', domain: 'svg',
      outputRoot }, factory)).rejects.toThrow('bootstrap-stopped');
    expect(factory).toHaveBeenCalledWith({ root: envRuntimeRoot, artifactRoot: outputRoot });
  });

  describe('run-dir projection mirror under a shared runtime root', () => {
    const projection = (operationId: string) => ({ kind: 'create', status: 'completed',
      commandDigest: 'd', result: { operationId } });
    const setup = (operationId: string, writeArtifact: boolean) => {
      const outputRoot = mkdtempSync(path.join(tmpdir(), 'liminal-run-'));
      const stateRoot = mkdtempSync(path.join(tmpdir(), 'liminal-shared-'));
      vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', stateRoot);
      if (writeArtifact) {
        const dir = path.join(outputRoot, 'artifacts',
          createHash('sha256').update(operationId).digest('hex'));
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'source.txt'), 'x');
      }
      const proj = projection(operationId);
      const factory = vi.fn(async () => ({ createCommand: vi.fn(() => ({ idempotencyKey: 'key-1' })),
        port: { submitCreate: vi.fn(async () => proj) }, close: vi.fn(async () => undefined) }) as never);
      return { outputRoot, factory, proj };
    };

    it('writes this run\'s Create projection into -o so the run dir is self-describing', async () => {
      const { outputRoot, factory, proj } = setup('operation:mirror', true);
      await runProductionCliGenerate({ prompt: 'p', domain: 'p5', outputRoot }, factory);
      const mirrored = JSON.parse(readFileSync(path.join(outputRoot, 'product-projections.json'), 'utf8'));
      expect(mirrored).toEqual({ 'key-1': proj });
    });

    it('does not mirror a replayed Create whose artifacts live in another run dir', async () => {
      const { outputRoot, factory } = setup('operation:replayed', false);
      await runProductionCliGenerate({ prompt: 'p', domain: 'p5', outputRoot }, factory);
      expect(existsSync(path.join(outputRoot, 'product-projections.json'))).toBe(false);
    });
  });

  it('unset SINTER_LIMINAL_RUNTIME_ROOT keeps -o as the state root', async () => {
    const outputRoot = path.resolve('/tmp/liminal-explicit-output');
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', undefined);
    const factory = vi.fn(async () => { throw new Error('bootstrap-stopped'); });
    await expect(runProductionCliGenerate({ prompt: 'Test', domain: 'svg',
      outputRoot }, factory)).rejects.toThrow('bootstrap-stopped');
    expect(factory).toHaveBeenCalledWith({ root: outputRoot, artifactRoot: outputRoot });
  });

  it('an empty SINTER_LIMINAL_RUNTIME_ROOT keeps -o as the state root', async () => {
    const outputRoot = path.resolve('/tmp/liminal-explicit-output');
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', '   ');
    const factory = vi.fn(async () => { throw new Error('bootstrap-stopped'); });
    await expect(runProductionCliGenerate({ prompt: 'Test', domain: 'svg',
      outputRoot }, factory)).rejects.toThrow('bootstrap-stopped');
    expect(factory).toHaveBeenCalledWith({ root: outputRoot, artifactRoot: outputRoot });
  });

  it('a relative SINTER_LIMINAL_RUNTIME_ROOT keeps -o as the state root', async () => {
    const outputRoot = path.resolve('/tmp/liminal-explicit-output');
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', 'relative/state');
    const factory = vi.fn(async () => { throw new Error('bootstrap-stopped'); });
    await expect(runProductionCliGenerate({ prompt: 'Test', domain: 'svg',
      outputRoot }, factory)).rejects.toThrow('bootstrap-stopped');
    expect(factory).toHaveBeenCalledWith({ root: outputRoot, artifactRoot: outputRoot });
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
    const hostProofAt = (out: string) => path.join(out, 'artifacts',
      createHash('sha256').update(operationId).digest('hex'), 'fragment.host.html');

    it('writes the accepted source as fragment.svg and returns its path', async () => {
      const out = tmp();
      const generated = await runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg',
        outputRoot: out, fragmentSpec: spec }, factoryFor(out, accepted));
      expect(generated.fragmentPath).toBe(fragmentAt(out));
      const written = readFileSync(fragmentAt(out), 'utf8');
      expect(written).toBe(accepted);
      expect(validateSVGFragment(written, spec).valid).toBe(true);
    });

    it('writes a host-page proof next to the fragment (#1162)', async () => {
      const out = tmp();
      const generated = await runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg',
        outputRoot: out, fragmentSpec: spec }, factoryFor(out, accepted));
      expect(generated.hostProofPath).toBe(hostProofAt(out));
      const page = readFileSync(hostProofAt(out), 'utf8');
      expect(page).toContain(accepted);
      expect(page).toContain('--art-red:');
      expect(page).toMatch(/<\/html>\s*$/);
    });

    it('writes no fragment.svg in standalone mode', async () => {
      const out = tmp();
      const generated = await runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg',
        outputRoot: out }, factoryFor(out, accepted));
      expect(generated.fragmentPath).toBeUndefined();
      expect(generated.hostProofPath).toBeUndefined();
      expect(existsSync(fragmentAt(out))).toBe(false);
      expect(existsSync(hostProofAt(out))).toBe(false);
    });

    it('writes no fragment.svg when generation fails', async () => {
      const out = tmp();
      await expect(runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg',
        outputRoot: out, fragmentSpec: spec }, factoryFor(out, null, true))).rejects.toThrow('GENERATION_FAILED');
      expect(existsSync(fragmentAt(out))).toBe(false);
      expect(existsSync(hostProofAt(out))).toBe(false);
    });

    it('refuses to publish a stored source that is not a valid fragment', async () => {
      const out = tmp();
      await expect(runProductionCliGenerate({ prompt: 'ribbon', domain: 'svg', outputRoot: out,
        fragmentSpec: spec }, factoryFor(out, accepted.replace('var(--art-red)', '#f00'))))
        .rejects.toThrow('SVG_FRAGMENT_INVALID');
      expect(existsSync(fragmentAt(out))).toBe(false);
    });
  });

  it.each([true, false])('teaches Create from the latest active snapshot only when one exists (active=%s)', async active => {
    const root = path.resolve('/tmp/liminal-teach-test');
    const result = { operationId: 'operation:teach' } as never;
    const createCommand = vi.fn(() => ({ idempotencyKey: 'teach' }) as never);
    const latestActive = vi.fn(() => active ? { snapshotDigest: 'a'.repeat(64) } : undefined);
    const factory = vi.fn(async () => ({ root, createCommand, activatedKnowledge: { latestActive },
      port: { submitCreate: vi.fn(async () => ({ kind: 'create', result })) },
      close: vi.fn(async () => undefined) }) as never);

    await runProductionCliGenerate({ prompt: 'A deep field', domain: 'p5', outputRoot: root,
      maxTransportAttempts: 2, teachScope: 'visual' }, factory);

    expect(latestActive).toHaveBeenCalledWith('visual');
    expect(createCommand).toHaveBeenCalledWith({ prompt: 'A deep field', domain: 'p5',
      maxTransportAttempts: 2,
      ...(active ? { teaching: { targetScope: 'visual', snapshotDigest: 'a'.repeat(64) } } : {}) });
  });

  it('SINTER_TEACH_STRICT=1: requested teaching with no active snapshot fails instead of running untaught, before any Create', async () => {
    vi.stubEnv('SINTER_TEACH_STRICT', '1');
    const root = path.resolve('/tmp/liminal-teach-strict');
    const createCommand = vi.fn(); const submitCreate = vi.fn();
    const close = vi.fn(async () => undefined);
    const factory = vi.fn(async () => ({ root, createCommand, activatedKnowledge: { latestActive: () => undefined },
      port: { submitCreate }, close }) as never);
    await expect(runProductionCliGenerate({ prompt: 'A deep field', domain: 'p5', outputRoot: root, teachScope: 'visual' }, factory))
      .rejects.toThrow('TEACHING_SNAPSHOT_MISSING:visual');
    expect(submitCreate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('--teach with -o fallback reads the shared root that dream activate writes, not the -o dir', async () => {
    const outputRoot = path.resolve('/tmp/liminal-teach-out');
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', undefined);
    vi.stubEnv('SINTER_LIMINAL_KNOWLEDGE_ROOT', undefined);
    const factory = vi.fn(async () => { throw new Error('bootstrap-stopped'); });
    await expect(runProductionCliGenerate({ prompt: 'Test', domain: 'svg', outputRoot,
      teachScope: 'visual' }, factory)).rejects.toThrow('bootstrap-stopped');
    expect(factory).toHaveBeenCalledWith({ root: outputRoot, artifactRoot: outputRoot,
      knowledgeRoot: defaultSharedRuntimeRoot() });
  });

  it('--teach leaves an explicit SINTER_LIMINAL_KNOWLEDGE_ROOT to the runtime', async () => {
    const outputRoot = path.resolve('/tmp/liminal-teach-out');
    vi.stubEnv('SINTER_LIMINAL_KNOWLEDGE_ROOT', path.resolve('/tmp/liminal-shared-knowledge'));
    const factory = vi.fn(async () => { throw new Error('bootstrap-stopped'); });
    await expect(runProductionCliGenerate({ prompt: 'Test', domain: 'svg', outputRoot,
      teachScope: 'visual' }, factory)).rejects.toThrow('bootstrap-stopped');
    expect(factory).toHaveBeenCalledWith({ root: outputRoot, artifactRoot: outputRoot });
  });

  it('blender: refuses before any runtime or provider call when the host cannot render', async () => {
    const factory = vi.fn();
    await expect(runProductionCliGenerate({ prompt: 'a scene', domain: 'blender',
      outputRoot: path.resolve('/tmp/liminal-blender-test'), blenderReadiness: () => {
        throw new Error('BLENDER_LANE_NOT_READY: this host cannot render Blender, so no model call was made.');
      } }, factory as never)).rejects.toThrow('BLENDER_LANE_NOT_READY');
    expect(factory).not.toHaveBeenCalled();
  });

  it('blender: writes preview.html showing the rendered frame, not the Python source', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'liminal-blender-preview-'));
    const dir = path.join(root, 'artifacts', createHash('sha256').update('operation:bl').digest('hex'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'source.txt'), 'import bpy\nprint("<b>")');
    writeFileSync(path.join(dir, 'early-frame.png'), Buffer.from('PNGDATA'));
    const factory = vi.fn(async () => ({ root, createCommand: () => ({}), close: async () => undefined,
      port: { submitCreate: async () => ({ kind: 'create', result: { operationId: 'operation:bl' } }) } }) as never);
    const generated = await runProductionCliGenerate({ prompt: 'a scene', domain: 'blender',
      outputRoot: root, blenderReadiness: () => undefined }, factory);
    expect(generated.previewPath).toBe(path.join(dir, 'preview.html'));
    const html = readFileSync(generated.previewPath!, 'utf8');
    expect(html).toContain(`<img alt="Blender render" src="data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}">`);
    expect(html).toContain('import bpy\nprint("&lt;b&gt;")');
  });

  it('blender: no preview when no frame was rendered', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'liminal-blender-nopreview-'));
    const factory = vi.fn(async () => ({ root, createCommand: () => ({}), close: async () => undefined,
      port: { submitCreate: async () => ({ kind: 'create', result: { operationId: 'operation:none' } }) } }) as never);
    const generated = await runProductionCliGenerate({ prompt: 'a scene', domain: 'blender',
      outputRoot: root, blenderReadiness: () => undefined }, factory);
    expect(generated.previewPath).toBeUndefined();
  });
});

describe('Sol audit F04/G01: a replay never claims saved artifacts', () => {
  const opId = 'operation:replay-claim';
  const dirOf = (root: string) => path.join(root, 'artifacts', createHash('sha256').update(opId).digest('hex'));
  // First run persists bytes the way LiminalCommandFilePersistence does; a second run with the same key persists nothing.
  const factory = (writeInto: string | null) => vi.fn(async () => ({
    createCommand: vi.fn(() => ({ idempotencyKey: 'same-key' })),
    port: { submitCreate: vi.fn(async () => {
      if (writeInto) { mkdirSync(dirOf(writeInto), { recursive: true }); writeFileSync(path.join(dirOf(writeInto), 'source.txt'), 'x'); }
      return { kind: 'create', status: 'completed', commandDigest: 'd', result: { operationId: opId } };
    }) },
    close: vi.fn(async () => undefined) }) as never);

  it('first run: artifactsPresent; second run, different -o, shared state: absent, original location named', async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'sol-state-'));
    const out1 = mkdtempSync(path.join(tmpdir(), 'sol-out1-'));
    const out2 = mkdtempSync(path.join(tmpdir(), 'sol-out2-'));
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', stateRoot);
    const first = await runProductionCliGenerate({ prompt: 'p', domain: 'p5', outputRoot: out1 }, factory(out1));
    expect(first.artifactsPresent).toBe(true);
    expect(existsSync(first.sourcePath)).toBe(true);
    const second = await runProductionCliGenerate({ prompt: 'p', domain: 'p5', outputRoot: out2 }, factory(null));
    expect(second.artifactsPresent).toBe(false);
    expect(existsSync(second.sourcePath)).toBe(false);
    expect(second.originalArtifactDirectory).toBe(dirOf(out1));
  });
});

describe('replayNoticeLines', () => {
  it('is silent when artifacts exist and never says Saved when they do not', async () => {
    const { replayNoticeLines } = await import('../../../src/cli/LiminalProductionGenerate.js');
    expect(replayNoticeLines({ artifactsPresent: true }, '/o')).toBeNull();
    const lines = replayNoticeLines({ artifactsPresent: false, originalArtifactDirectory: '/first/artifacts/abc' }, '/o')!;
    expect(lines.join('\n')).toContain('/first/artifacts/abc');
    expect(lines.join('\n')).not.toMatch(/Saved|HTML/);
  });
});
