import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginLoader } from '../../src/plugins/PluginLoader.js';
import { createPinnedPluginManifest, createPluginOperationAuthority } from '../../src/plugins/GovernedPluginGate.js';

const source = 'throw Error("host import sentinel");\n';
const manifest = createPinnedPluginManifest({
  id: 'demo', version: '1.0.0', entryDigest: createHash('sha256').update(source).digest('hex'), domains: ['p5'],
});

afterEach(() => vi.unstubAllEnvs());

describe('governed plugin admission', () => {
  it('returns pinned bytes only for the authorized operation and unchanged entry', () => {
    const authority = createPluginOperationAuthority();
    const capability = authority.issue({
      operationId: 'render-demo', pluginId: manifest.id, manifestDigest: manifest.manifestDigest,
      domain: 'p5', expiresAt: Date.now() + 60_000,
    });
    const loader = new PluginLoader();
    const input = { manifest, capability, source, assertCapability: authority.assert };
    expect(loader.admitPinnedWorkload(input)).toMatchObject({
      operationId: 'render-demo', pluginId: 'demo', domain: 'p5', source, entryDigest: manifest.entryDigest,
    });
    expect(() => loader.admitPinnedWorkload({ ...input, source: source + '// changed' }))
      .toThrow('PINNED_PLUGIN_BINDING_INVALID');
  });

  it.each(['0', '1'])('refuses host imports with a matching sidecar and legacy opt-in %s', async flag => {
    vi.stubEnv('SINTER_PLUGINS_GOVERNED', flag);
    const root = await mkdtemp(path.join(os.tmpdir(), 'organ-plugin-'));
    try {
      const dir = path.join(root, 'demo');
      await mkdir(dir);
      await writeFile(path.join(dir, 'index.mjs'), source);
      await writeFile(path.join(dir, 'plugin.pinned.json'), JSON.stringify(manifest));
      await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({
        id: 'demo', name: 'Demo', version: '1.0.0', description: 'Fixture',
        entry: 'index.mjs', domains: ['p5'], keywords: ['demo'],
      }));
      const loader = new PluginLoader(root);
      await expect(loader.loadPlugin(dir)).resolves.toMatchObject({
        success: false, error: { error: 'UNGOVERNED_PLUGIN_EXECUTION_DISABLED' },
      });
      expect(loader.isLoaded('demo')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
