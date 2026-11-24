import { describe, expect, it, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCrossSiteWrite, portOf, allowedHostsFor } from '../../src/security/LocalRequestGuard.js';
import { validateUrl, validateUrlSync, pinnedFetch, SSRFError } from '../../src/security/UrlValidator.js';
import { ArchiveLearning } from '../../src/learning/ArchiveLearning.js';
import { AutoFixOrchestrator } from '../../src/fix/AutoFixOrchestrator.js';
import { CodeValidator } from '../../src/core/CodeValidator.js';
import * as harnessAgent from '../../src/harness/agent/index.js';
import { readFileTool, restoreBackupTool } from '../../src/harness/tools/index.js';
import { Status } from '../../src/types/status.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Wave 4B UltraQA hardening', () => {
  describe('LocalRequestGuard cross-port and wildcard-bind Origin enforcement', () => {
    it('extracts ports cleanly and rejects cross-port localhost writes', () => {
      expect(portOf('localhost:3100')).toBe('3100');
      expect(portOf('localhost')).toBe('');
      expect(portOf('evil@localhost:3100')).toBeNull();

      const loopback = allowedHostsFor('127.0.0.1');
      expect(isCrossSiteWrite({ origin: 'http://localhost:3100', host: 'localhost:3100' }, loopback)).toBe(false);
      expect(isCrossSiteWrite({ origin: 'http://localhost:9999', host: 'localhost:3100' }, loopback)).toBe(true);
      expect(isCrossSiteWrite({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:3100' }, loopback)).toBe(true);
    });

    it('rejects foreign Origin headers even on 0.0.0.0 wildcard binds', () => {
      const wildcard = allowedHostsFor('0.0.0.0');
      expect(wildcard).toBeNull();
      expect(isCrossSiteWrite({ origin: 'https://evil.com', host: '192.168.1.10:3100' }, wildcard)).toBe(true);
      expect(isCrossSiteWrite({ origin: 'http://192.168.1.10:3100', host: '192.168.1.10:3100' }, wildcard)).toBe(false);
      expect(isCrossSiteWrite({ origin: 'https://evil.com' }, wildcard)).toBe(true);
    });
  });

  describe('UrlValidator canonical IPv6, NAT64, multicast, wildcard hygiene, and pinnedFetch', () => {
    it('blocks expanded IPv6 loopback, NAT64 metadata, and IPv6 multicast', async () => {
      expect(() => validateUrlSync('http://[0:0:0:0:0:0:0:1]:8080/', { allowLocalhost: false })).toThrow(SSRFError);
      expect(() => validateUrlSync('http://[0000:0000:0000:0000:0000:0000:0000:0000]/')).toThrow(SSRFError);
      expect(() => validateUrlSync('http://[64:ff9b::169.254.169.254]/latest', { allowPrivateIPs: true })).toThrow(/cloud metadata/i);
      expect(() => validateUrlSync('http://[ff02::1]/')).toThrow(/private IP/i);

      const resolvingNat64 = async () => ({ address: '64:ff9b::a9fe:a9fe', family: 6 });
      await expect(
        validateUrl('https://rebind.example.com/', { allowPrivateIPs: true }, resolvingNat64),
      ).rejects.toThrow(/cloud metadata/i);
    });

    it('does not treat localhost or IP literals as wildcard subdomain suffixes', () => {
      expect(() => validateUrlSync('http://evil.localhost:8080/', { allowedHosts: ['api.example.com'] })).toThrow(/not in the allowed list/i);
      expect(() => validateUrlSync('http://[fd00:0ec2:0:0:0:0:0:0254]/latest', { allowPrivateIPs: true })).toThrow(/cloud metadata/i);
      expect(() => validateUrlSync('https://sub.api.example.com/', { allowedHosts: ['api.example.com'] })).not.toThrow();
    });

    it('enforces blocked hosts, allowLocalhost=false, and allowedHosts in pinnedFetch before connecting', async () => {
      await expect(pinnedFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/cloud metadata/i);
      await expect(pinnedFetch('http://localhost:1234/v1', { allowLocalhost: false })).rejects.toThrow(/localhost/i);
      await expect(pinnedFetch('https://evil.example.com/', { allowedHosts: ['api.example.com'] })).rejects.toThrow(/not in the allowed list/i);
    });
  });

  describe('ArchiveLearning.load() and fragment persistence/query', () => {
    it('loads persisted items via ArchiveLearning.load() and returns stored fragments from queryFragments()', async () => {
      const archivePath = join(tmpdir(), `wave4b-archive-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      try {
        const writer = new ArchiveLearning({ archivePath, minQuality: 0.5 });
        await writer.load();
        const added = await writer.addFragment({
          id: 'frag-1',
          text: 'radial caustic ripples in indigo',
          score: 13.5,
          source: 'proposal',
          persona: 'chromatic-alchemist',
          mode: 'shader',
          round: 2,
          tags: ['caustics'],
          sessionPrompt: 'bioluminescent reef',
        } as never, 'glsl');
        expect(added?.domain).toBe('glsl');
        expect(added?.output).toBe('radial caustic ripples in indigo');

        const reader = new ArchiveLearning({ archivePath, minQuality: 0.5 });
        await reader.load();
        const all = reader.queryFragments({ domain: 'glsl' });
        expect(all).toHaveLength(1);
        expect(all[0].fragment?.persona).toBe('chromatic-alchemist');
        expect(all[0].fragment?.mode).toBe('shader');

        const filteredHit = reader.queryFragments({ persona: 'chromatic-alchemist', mode: 'shader' });
        expect(filteredHit).toHaveLength(1);
        const filteredMiss = reader.queryFragments({ persona: 'other-persona' });
        expect(filteredMiss).toHaveLength(0);
      } finally {
        await fs.unlink(archivePath).catch(() => {});
      }
    });
  });

  describe('AutoFixOrchestrator verification failure rollback', () => {
    it('restores session backups in reverse order and marks rolledBack=true when post-fix verification fails', async () => {
      vi.spyOn(readFileTool, 'execute').mockResolvedValue({
        success: true,
        data: { content: 'export const broken = 1;' },
      } as never);
      vi.spyOn(harnessAgent, 'createLLMModeAgent').mockReturnValue({
        executeTask: vi.fn().mockResolvedValue({
          status: Status.SUCCESS,
          stepCount: 3,
          backups: ['/tmp/bak-1', '/tmp/bak-2'],
          messages: [],
        }),
      } as never);
      const restoreSpy = vi.spyOn(restoreBackupTool, 'execute').mockResolvedValue({ success: true } as never);

      const orchestrator = new AutoFixOrchestrator({ getConfig: () => ({ model: 'test' }) } as never);
      vi.spyOn(orchestrator as unknown as { verifyBuild: () => boolean }, 'verifyBuild').mockReturnValue(false);

      const result = await orchestrator.executeFix({
        type: 'file-error',
        target: 'src/broken.ts',
        errorDescription: 'syntax error',
      });

      expect(result.success).toBe(false);
      expect(result.buildPassed).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(restoreSpy.mock.calls.map((c) => c[0])).toEqual([
        { backupPath: '/tmp/bak-2' },
        { backupPath: '/tmp/bak-1' },
      ]);
    });
  });

  describe('CodeValidator guarded vs unconditional runtime throw', () => {
    it('allows defensive WebGL shader/framebuffer throws guarded by if() in custom HTML', () => {
      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Moire</title></head><body><canvas id="c" width="800" height="600"></canvas><script>
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2');
function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || 'Shader compile error');
  }
  return sh;
}
if (!gl) {
  throw new Error('WebGL2 unavailable');
}
</script></body></html>`;
      const result = CodeValidator.validate(html, 'custom');
      expect(result.valid).toBe(true);
    });

    it('still rejects unconditional top-level or entrypoint throw statements', () => {
      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Broken</title></head><body><canvas id="c" width="800" height="600"></canvas><script>
throw new Error('guaranteed failure');
</script></body></html>`;
      const result = CodeValidator.validate(html, 'custom');
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain('explicit throw');
    });
  });
});
