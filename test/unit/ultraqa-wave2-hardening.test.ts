import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordAcceptedPiece } from '../../src/learning/PieceExemplars.js';
import { createLiminalProductionEffects } from '../../src/runtime-core/LiminalProductionEffects.js';
import { sanitizeFilename, sanitizeFFmpegArg, validateFilePath, PathSanitizationError } from '../../src/security/PathSanitizer.js';
import { validateImportPath, ImportValidationError } from '../../src/security/ImportValidator.js';
import { FileCampaignLedgerPersistence } from '../../src/creative-run/CampaignPersistence.js';
import { scanProductionEntrypointAuthorityLocators } from '../../src/runtime-core/ProductionAuthorityScanner.js';
import { LivingSiteDaemon } from '../../src/daemon/LivingSiteDaemon.js';
import { LLMClient } from '../../src/llm/LLMClient.js';

describe('UltraQA Wave 2 hardening regressions', () => {
  it('stableLibraryPrompt keeps batch-lane prompts identical after new piece exemplars are archived and across brainHint draws', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 's1ntr-w2-batch-'));
    vi.stubEnv('SINTER_PROJECT_ROOT', project);
    try {
      const code = [
        'function setup() {',
        '  createCanvas(400, 400);',
        '  noFill();',
        '  strokeWeight(2);',
        '}',
        'function draw() {',
        '  background(10, 12, 18);',
        '  stroke(220, 180, 140);',
        '  for (let i = 0; i < 8; i++) {',
        '    ellipse(width / 2, height / 2, 40 + i * 28, 40 + i * 28);',
        '  }',
        '}',
      ].join('\n');
      const calls: Array<[string, string]> = [];
      const generate = vi.fn(async (sys: string, usr: string) => {
        calls.push([sys, usr]);
        return { success: true, code };
      });
      const effects = createLiminalProductionEffects({
        generator: { getConfig: () => ({ provider: 'fake', model: 'generator' }), generate } as never,
        evaluator: {} as never,
        renderer: {} as never,
        generatorIdentity: 'fake/generator',
        evaluatorIdentity: 'fake/evaluator',
        rendererIdentity: 'fake/renderer',
        stableLibraryPrompt: true,
      });

      await effects.generate({
        identity: 'fake/generator',
        domain: 'p5',
        prompt: 'drifting orbital rings',
        startTransport: vi.fn(async () => 1),
        failTransport: vi.fn(async () => {}),
      });

      // Archive a new accepted piece mid-wave (exact race that caused BATCH_REQUEST_MISMATCH)
      await recordAcceptedPiece(project, {
        name: 'p5-midwave',
        domain: 'p5',
        score: 0.92,
        prompt: 'earlier wave piece',
        source: code,
        judgeReasoning: 'CRITIQUE-midwave',
        at: '2026-11-23T06:00:00Z',
      });

      await effects.generate({
        identity: 'fake/generator',
        domain: 'p5',
        prompt: 'drifting orbital rings',
        startTransport: vi.fn(async () => 1),
        failTransport: vi.fn(async () => {}),
      });

      expect(calls).toHaveLength(2);
      expect(calls[1][0]).toBe(calls[0][0]);
      expect(calls[1][1]).toBe(calls[0][1]);
      expect(calls[1][0]).not.toContain('Judge score 0.92');
    } finally {
      vi.unstubAllEnvs();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('PathSanitizer allows ..prefix filenames, validates parent segments, and blocks FFmpeg control bytes', () => {
    expect(sanitizeFilename('..hidden.mp4')).toBe('..hidden.mp4');
    expect(() => sanitizeFilename('..')).toThrow(PathSanitizationError);
    expect(() => sanitizeFilename('../escape.mp4')).toThrow(PathSanitizationError);
    expect(() => validateFilePath('/base/dir;evil/file.mp4', '/base')).toThrow(PathSanitizationError);
    expect(() => sanitizeFFmpegArg('safe\n-filter_complex')).toThrow(PathSanitizationError);
  });

  it('ImportValidator resolves relative paths against projectRoot and blocks sibling prefix bypasses', () => {
    const resolved = validateImportPath('src/index.ts', '/project/root');
    expect(resolved).toBe(path.resolve('/project/root', 'src/index.ts'));
    expect(() => validateImportPath('/project/root-evil/secret.ts', '/project/root')).toThrow(ImportValidationError);
    expect(() => validateImportPath('../outside.ts', '/project/root')).toThrow(ImportValidationError);
  });

  it('FileCampaignLedgerPersistence reclaims stale locks atomically via rename', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's1ntr-w2-lock-'));
    try {
      const store = new FileCampaignLedgerPersistence(dir);
      await store.write('k1', JSON.stringify({ ok: true }));
      // Plant a stale lock directory older than 60s
      const crypto = await import('node:crypto');
      const lockPath = path.join(dir, `${crypto.createHash('sha256').update('k1').digest('hex')}.json.lock`);
      mkdirSync(lockPath);
      const old = new Date(Date.now() - 120_000);
      utimesSync(lockPath, old, old);

      const claimed = await store.claim('k1', async () => 'recovered');
      expect(claimed).toBe('recovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ProductionAuthorityScanner does not treat multi-import files from ScoringEngine as governed-safe', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's1ntr-w2-scan-'));
    try {
      mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
      writeFileSync(
        path.join(dir, 'src', 'core', 'ScoringEngine.ts'),
        'export const scoreRenderedEvidence = () => {};\nexport const dangerous = () => new LLMClient();\n',
      );
      writeFileSync(
        path.join(dir, 'src', 'entry.ts'),
        [
          "import { scoreRenderedEvidence } from './core/ScoringEngine.js';",
          "import { dangerous } from './core/ScoringEngine.js';",
          'export const run = () => [scoreRenderedEvidence, dangerous];',
        ].join('\n'),
      );
      const locators = await scanProductionEntrypointAuthorityLocators(dir, ['src/entry.ts']);
      expect(locators).toContain('src/core/ScoringEngine.ts:provider');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('LivingSiteDaemon.runCycle honors explicit slotId filter', async () => {
    const slots = [
      { id: 'home-hero', page: '/', domains: ['p5'], active: { htmlPath: '', experimentId: 'a', fitness: 0, deployedAt: '', model: 'seed', domain: 'p5' }, challenger: null },
      { id: 'tools-hero', page: '/tools', domains: ['p5'], active: { htmlPath: '', experimentId: 'b', fitness: 0, deployedAt: '', model: 'seed', domain: 'p5' }, challenger: null },
    ];
    const checked: string[] = [];
    const slotManager = {
      getAllSlots: () => slots,
      getSlot: (id: string) => slots.find((s) => s.id === id),
      needsChallenger: (id: string) => { checked.push(id); return false; },
      save: vi.fn(async () => {}),
    };
    const posthog = { isConfigured: () => true };
    const daemon = new LivingSiteDaemon(slotManager as never, posthog as never);

    expect(daemon.generatorAttemptLimit('home-hero')).toBe(5);
    expect(daemon.generatorAttemptLimit('missing-slot')).toBe(0);
    await daemon.runCycle(true, 'tools-hero');
    expect(checked).toEqual(['tools-hero']);
  });

  it('LLMClient.stream does not splice a fallback stream after primary already yielded chunks', async () => {
    const client = new LLMClient({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' } as never);
    const internal = client as unknown as Record<string, unknown>;
    internal.resolveRoleConfigForRequest = vi.fn(async () => {});
    internal.resolveModel = vi.fn(async () => 'gpt-5.4');
    internal.syncResolvedModel = vi.fn();
    internal.getProvider = vi.fn(async () => ({
      name: 'openai',
      getModel: () => 'gpt-5.4',
      getConfig: () => ({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' }),
      async *stream() {
        yield { type: 'content', content: 'partial-' };
        yield { type: 'error', error: 'connection reset mid-stream' };
      },
    }));
    const fallbackStream = vi.fn();
    internal.getFallbackProviders = vi.fn(() => [{
      name: 'fallback',
      getModel: () => 'fallback-model',
      getConfig: () => ({ baseUrl: 'https://api.openai.com/v1', model: 'fallback-model' }),
      stream: fallbackStream,
    }]);

    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of client.stream('sys', 'usr')) {
        chunks.push(chunk);
      }
    }).rejects.toThrow(/connection reset mid-stream/);
    expect(chunks).toEqual(['partial-']);
    expect(fallbackStream).not.toHaveBeenCalled();
  });
});
