/**
 * Organ proofs for the plumbing modules (src/tui, src/sandbox, src/plugins, src/utils/env).
 * Each test moves one input and asserts the observable output moved, so bypassing the module fails it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sandboxCalls: string[] = [];
vi.mock('../../src/sandbox/index.js', () => ({
  runInSandbox: async (code: string) => { sandboxCalls.push(code); return { completed: false, error: 'SANDBOX_DENIED_NETWORK' }; },
}));

describe('tui: sanitizeTerminalText guards the operator log (EventBus)', () => {
  const saved = { v: process.env.VITEST, n: process.env.NODE_ENV };
  afterEach(() => { process.env.VITEST = saved.v; process.env.NODE_ENV = saved.n; vi.restoreAllMocks(); });

  it('strips terminal escapes and redacts prompt text from event lines', async () => {
    const { eventBus } = await import('../../src/core/EventBus.js');
    delete process.env.VITEST; process.env.NODE_ENV = 'production';
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    eventBus.emit('process:log', 'organ', { message: 'hello \x1b]0;pwned\x07\x1b[31mred\x1b[0m prompt: SECRET-BRIEF' });
    const line = out.join('');
    expect(line).toContain('hello');
    expect(line).not.toContain('pwned');
    expect(line).not.toContain('\x1b[31m');
    expect(line).not.toContain('SECRET-BRIEF');
    expect(line).toContain('[redacted]');
  });
});

describe('sandbox: network-isolated render gate (HeadlessRenderer.renderWithEvidence)', () => {
  afterEach(() => { delete process.env.LIMINAL_NETWORK_ISOLATED_RENDER; sandboxCalls.length = 0; });

  it('flag on + p5: the sandbox vets the code first and a denial rejects the candidate', async () => {
    process.env.LIMINAL_NETWORK_ISOLATED_RENDER = 'true';
    const { HeadlessRenderer } = await import('../../src/render/HeadlessRenderer.js');
    const ev = await new HeadlessRenderer().renderWithEvidence('function setup(){createCanvas(10,10)} function draw(){}', { domain: 'p5' } as never);
    expect(sandboxCalls.length, 'sandbox was bypassed').toBe(1);
    expect(ev.candidateFailure).toBe(true);
  });

  it('flag off (default): the sandbox is not consulted', async () => {
    const { isNetworkIsolatedRenderEnabled } = await import('../../src/security/SandboxConfig.js');
    expect(isNetworkIsolatedRenderEnabled()).toBe(false);
  });
});

describe('plugins: ungoverned plugin code never runs in production', () => {
  it('default loader refuses to execute plugin modules', async () => {
    const { PluginLoader } = await import('../../src/plugins/PluginLoader.js');
    const loader = new PluginLoader();
    const results = await loader.loadAll();
    expect(results.length, 'no plugin manifests found; test would be vacuous').toBeGreaterThan(0);
    expect(loader.getAllPlugins().length).toBe(0);
    for (const r of results) {
      expect(r.success).toBe(false);
      expect(JSON.stringify(r)).toContain('UNGOVERNED_PLUGIN_EXECUTION_DISABLED');
    }
  });
});

describe('utils/env: SINTER_ and LIMINAL_ prefixes are one setting', () => {
  afterEach(() => { for (const k of ['SINTER_ORGAN_X', 'LIMINAL_ORGAN_X']) delete process.env[k]; });
  it('a LIMINAL_ value is read through the SINTER_ name and the SINTER_ value wins', async () => {
    const { env, mirrorBrandEnv } = await import('../../src/utils/env.js');
    process.env.LIMINAL_ORGAN_X = 'legacy';
    expect(env('ORGAN_X')).toBe('legacy');
    mirrorBrandEnv();
    expect(process.env.SINTER_ORGAN_X).toBe('legacy');
    process.env.SINTER_ORGAN_X = 'canon';
    expect(env('ORGAN_X')).toBe('canon');
  });
});
