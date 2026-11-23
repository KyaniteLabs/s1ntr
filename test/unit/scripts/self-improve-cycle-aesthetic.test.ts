// @no-cli-spawn: reads the cycle driver as text, never runs the CLI
/**
 * F14 supersedes B8: governed Create rejects --learn/--intuition/--aesthetic, so the cycle must not pass them
 * (every autonomous generation failed with GOVERNED_GENERATE_FLAGS_UNSUPPORTED). The critic runs inside governed Create.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { assertGovernedCliCompatibility, parseTeachScope } from '../../../src/cli/LiminalProductionGenerate.js';
import { PROVIDER_DEFAULTS } from '../../../src/config/ProviderRuntime.js';
import { loadRoleConfig } from '../../../src/config/RoleConfig.js';
// @ts-expect-error plain .mjs helper
import { buildGovernedGenerateArgs, resolveDreamQueuePath, governedGeneratorEnv } from '../../../scripts/quality/self-improve-domains.mjs';
import { DreamQueue } from '../../../src/dreaming/DreamQueue.js';
import fs from 'node:fs';

describe('self-improve cycle uses the governed surface (F14)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds arguments that governed generate accepts', () => {
    const args: string[] = buildGovernedGenerateArgs('a prompt', 'html', '.quality/rsi/g_1');
    for (const bad of ['--learn', '--intuition', '--aesthetic', '--provider', '--model']) expect(args).not.toContain(bad);
    expect(args.slice(0, 2)).toEqual(['bin/sinter', 'generate']);
    expect(args).toContain('--teach');   // replaces --learn/--intuition: activated knowledge teaches the run
    expect(() => assertGovernedCliCompatibility({})).not.toThrow();
  });
  it.each([
    ['p5', 'visual'], ['glsl', 'visual'], ['three', 'visual'], ['hydra', 'visual'], ['svg', 'visual'],
    ['ascii', 'visual'], ['kinetic', 'motion'], ['strudel', null], ['tone', null], ['textgen', null],
  ])('selects the supported teaching scope for %s', (domain, scope) => {
    const args: string[] = buildGovernedGenerateArgs('a prompt', domain, 'out');
    const index = args.indexOf('--teach');
    if (scope === null) expect(index).toBe(-1);
    else expect(parseTeachScope(args[index + 1])).toBe(scope);
  });

  it.each([undefined, 'http://127.0.0.1:9002/v1'])('routes Three.js with generic endpoint %s', async genericUrl => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-role-'));
    try {
      const config = path.join(dir, 'config.json');
      const evaluator = { baseUrl: 'http://127.0.0.1:9003/v1', model: 'pinned-evaluator' };
      fs.writeFileSync(config, JSON.stringify({ roles: {
        generator: { baseUrl: 'http://127.0.0.1:9001/v1', model: 'pinned-generator' }, evaluator,
      } }));
      vi.stubEnv('SINTER_CONFIG_PATH', config);
      for (const prefix of ['SINTER', 'LIMINAL']) {
        for (const role of ['GENERATOR', 'EVALUATOR', 'LLM']) {
          for (const field of ['BASE_URL', 'MODEL', 'PROVIDER']) vi.stubEnv(`${prefix}_${role}_${field}`, undefined);
        }
      }
      vi.stubEnv('LIMINAL_LLM_BASE_URL', genericUrl);
      for (const [key, value] of Object.entries(governedGeneratorEnv('three', PROVIDER_DEFAULTS.minimax))) {
        vi.stubEnv(key, value as string);
      }
      const roles = await loadRoleConfig(dir);
      expect(roles.generator).toMatchObject({ provider: 'minimax', baseUrl: PROVIDER_DEFAULTS.minimax.baseUrl, model: 'MiniMax-M3' });
      expect(roles.evaluator).toMatchObject(evaluator);
      expect(governedGeneratorEnv('html', PROVIDER_DEFAULTS.minimax)).toEqual({});
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('reads the dream queue from SINTER_DREAM_QUEUE_PATH exactly like garden tend, else the default', () => {
    const home = path.join(os.tmpdir(), 'sinter-fixture-home');
    const configured = path.join(home, 'configured-queue.json');
    expect(resolveDreamQueuePath({ SINTER_DREAM_QUEUE_PATH: configured }, home)).toBe(configured);
    expect(resolveDreamQueuePath({}, home)).toBe(path.join(home, '.sinter/dreams/queue.json'));
  });
  it('a dream queued at a nondefault root is the one the cycle dequeues', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-')); const file = path.join(dir, 'queue.json');
    try {
      const writer = new DreamQueue({ persistPath: file });
      const sources = [{ id: 'a', descriptor: [0.2], quality: 0.8 }, { id: 'b', descriptor: [0.7], quality: 0.9 }];
      const id = writer.enqueue('cross-modal', sources, 1);
      const reader = new DreamQueue({ persistPath: resolveDreamQueuePath({ SINTER_DREAM_QUEUE_PATH: file }) });
      expect(reader.dequeue()).toMatchObject({ id, strategy: 'cross-modal', sources, status: 'running' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
