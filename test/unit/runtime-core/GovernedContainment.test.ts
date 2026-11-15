import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HeadlessRenderer, isAllowedRenderRequestUrl } from
  '../../../src/render/HeadlessRenderer.js';
import { getPinnedBrowserAssetForUrl } from
  '../../../src/utils/browserAssetFallbacks.js';
import { GovernedPluginGate, createPinnedPluginManifest,
  createPluginOperationAuthority } from '../../../src/plugins/GovernedPluginGate.js';
import { PluginLoader } from '../../../src/plugins/PluginLoader.js';

describe('governed generated-code containment', () => {
  it('denies host files and every network origin in isolated mode', () => {
    expect(isAllowedRenderRequestUrl('file:///etc/passwd', 'isolated')).toBe(false);
    expect(isAllowedRenderRequestUrl('https://cdn.jsdelivr.net/p5.js', 'isolated')).toBe(false);
    expect(isAllowedRenderRequestUrl('http://127.0.0.1:3000/secret', 'isolated')).toBe(false);
    expect(isAllowedRenderRequestUrl('data:text/plain,ok', 'isolated')).toBe(true);
  });

  it('binds locally pinned p5 bytes by exact digest', async () => {
    const asset = await getPinnedBrowserAssetForUrl(
      'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.11.3/p5.min.js',
    );
    // Legacy CDN URLs resolve to the exact vendored 1.9.0 bytes (#924).
    expect(asset?.id).toBe('/vendor/p5/1.9.0/p5.min.js');
    expect(asset?.digest).toBe(createHash('sha256').update(asset!.body).digest('hex'));
  });

  it('installs browser permission and resource guards before generated code', async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const renderer = new HeadlessRenderer() as unknown as {
      installContainmentGuards(page: unknown, limits: unknown): Promise<boolean> };
    await expect(renderer.installContainmentGuards({ addInitScript }, {
      maximumEventListeners: 10, maximumEvents: 20, maximumTimers: 5,
      maximumAudioContexts: 1, maximumHeapBytes: 1024,
    })).resolves.toBe(true);
    expect(addInitScript).toHaveBeenCalledOnce();
    const content = addInitScript.mock.calls[0]![0].content as string;
    expect(content).toContain('root.WebSocket');
    expect(content).toContain('root.EventSource');
    expect(content).toContain('LIMINAL_NETWORK_DENIED');
  });

  it('preflights exact isolated source without opening a browser', () => {
    const renderer = new HeadlessRenderer();
    const source = '<html>contained</html>';
    expect(renderer.preflightSandbox(source, { networkPolicy: 'isolated',
      maximumOutputBytes: 1024 })).toEqual({
      sourceDigest: createHash('sha256').update(source).digest('hex'),
      networkPolicy: 'isolated', realtimeTransportsDenied: true,
      outputLimitEnforced: true,
    });
    expect(() => renderer.preflightSandbox(source, { networkPolicy: 'assets-only',
      maximumOutputBytes: 1024 }))
      .toThrow('RENDER_SANDBOX_NETWORK_ISOLATION_REQUIRED');
  });
});

describe('governed plugin containment', () => {
  it('disables legacy dynamic plugin execution by default', async () => {
    const loader = new PluginLoader('/untrusted/plugin/root');
    await expect(loader.loadPlugin('/untrusted/plugin/root/example'))
      .resolves.toMatchObject({ success: false,
        error: { error: 'UNGOVERNED_PLUGIN_EXECUTION_DISABLED' } });
    expect(() => loader.registerPlugin({ manifest: { id: 'raw' } } as never))
      .toThrow('UNGOVERNED_PLUGIN_EXECUTION_DISABLED');
  });

  it('requires exact manifest, source, operation capability, and domain binding', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const manifest = createPinnedPluginManifest({ id: 'fixture', version: '1.0.0',
      entryDigest: createHash('sha256').update(source).digest('hex'), domains: ['svg'] });
    const authority = createPluginOperationAuthority();
    const capability = authority.issue({ operationId: 'operation:plugin', pluginId: 'fixture',
      manifestDigest: manifest.manifestDigest, domain: 'svg', expiresAt: Date.now() + 60_000 });
    const gate = new GovernedPluginGate(authority.assert);

    expect(gate.admit(manifest, capability, source)).toMatchObject({
      operationId: 'operation:plugin', pluginId: 'fixture', domain: 'svg',
      manifestDigest: manifest.manifestDigest,
    });
    expect(() => gate.admit(manifest, capability, `${source}tampered`))
      .toThrow('PINNED_PLUGIN_BINDING_INVALID');
    expect(() => gate.admit(manifest, { ...capability }, source))
      .toThrow('PLUGIN_CAPABILITY_INVALID');
  });

  it('rejects unclassified teaching or learning fields', () => {
    const source = '<svg></svg>';
    const manifest = createPinnedPluginManifest({ id: 'malicious', version: '1',
      entryDigest: createHash('sha256').update(source).digest('hex'), domains: ['svg'],
      teachingContext: 'promote me' } as unknown as Parameters<typeof createPinnedPluginManifest>[0]);
    const authority = createPluginOperationAuthority();
    const capability = authority.issue({ operationId: 'operation:malicious',
      pluginId: manifest.id, manifestDigest: manifest.manifestDigest,
      domain: 'svg', expiresAt: Date.now() + 60_000 });
    expect(() => new GovernedPluginGate(authority.assert)
      .admit(manifest, capability, source)).toThrow();
  });
});
