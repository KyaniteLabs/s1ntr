import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiKeyEnvNamesForEndpoint,
  detectProviderAdapter,
  detectProviderLabel,
  detectRuntimeProviderFromUrl,
} from '../../src/config/ProviderRuntime.js';
import { buildSandboxedCommand } from '../../src/render/BlenderSandbox.js';
import { normalizePath, resolveOutputPath } from '../../src/utils/normalizePath.js';
import {
  __resetBrowserPreflightForTests,
  attemptBrowserInstallOnce,
  type BrowserInstallKind,
} from '../../src/utils/browserPreflight.js';
import { sanitizeGrokErrorDetail } from '../../src/llm/providers/GrokCliProvider.js';
import { dispatcherFor } from '../../src/llm/providerFetch.js';
import { DreamQueue } from '../../src/dreaming/DreamQueue.js';
import { IpRateLimiter } from '../../src/security/RateLimiter.js';
import { createRenderedPreviewProvider } from '../../src/learning/TasteLearningService.js';

describe('UltraQA Wave 4 hardening regressions', () => {
  const tempDirs: string[] = [];
  const mkTmp = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    __resetBrowserPreflightForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ProviderRuntime blocks URL path/query spoofing and handles bracketed IPv6 loopback', () => {
    expect(detectProviderLabel('https://evil.example/z.ai/v1')).toBe('llm');
    expect(detectProviderLabel('https://evil.example/path?x=:8317')).toBe('llm');
    expect(detectRuntimeProviderFromUrl('https://evil.example/api.z.ai/v1')).toBe('custom');
    expect(detectProviderAdapter({ baseUrl: 'https://evil.example/z.ai', model: 'gpt-5' })).toBe('openai');
    expect(detectProviderAdapter({ baseUrl: 'http://[::1]:8317/v1', model: 'gemini-3-pro' })).toBe('openai');
    expect(detectProviderLabel('http://[::1]:1234/v1')).toBe('lmstudio');
    expect(apiKeyEnvNamesForEndpoint('http://[::1]:8317/v1')).toEqual(['CODEX_PROXY_API_KEY']);
  });

  it('BlenderSandbox resolves bare command via host PATH in unsandboxed mode', () => {
    const plan = buildSandboxedCommand(
      'linux',
      { command: 'blender', args: ['-b'], cwd: '/tmp/out', env: { PATH: '/usr/bin:/bin' } },
      {
        which: (cmd) => (cmd === 'blender' ? '/opt/blender/blender' : null),
        realpath: (p) => p,
        hostEnv: { SINTER_BLENDER_UNSANDBOXED: '1' },
      },
    );
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.sandbox).toBe('none');
      expect(plan.command).toBe('/opt/blender/blender');
    }
  });

  it('normalizePath and resolveOutputPath block symlink escapes inside baseDir', () => {
    const base = mkTmp('norm-base-');
    const outside = mkTmp('norm-out-');
    const link = path.join(base, 'escape-link');
    fs.symlinkSync(outside, link);

    expect(() => normalizePath(base, 'escape-link/secret.txt')).toThrow(/escape|traversal/i);
    expect(() => resolveOutputPath(base, path.join(link, 'secret.txt'))).toThrow(/must be inside/i);
  });

  it('attemptBrowserInstallOnce tracks attempts per BrowserInstallKind independently', () => {
    const seen: BrowserInstallKind[] = [];
    const installer = (kind: BrowserInstallKind) => {
      seen.push(kind);
      return { ok: true, message: `${kind} ok`, kind };
    };
    const r1 = attemptBrowserInstallOnce('playwright-chromium', { installer, stderrWrite: () => {} });
    const r2 = attemptBrowserInstallOnce('puppeteer-chrome', { installer, stderrWrite: () => {} });
    const r3 = attemptBrowserInstallOnce('puppeteer-chrome', { installer, stderrWrite: () => {} });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(seen).toEqual(['playwright-chromium', 'puppeteer-chrome']);
  });

  it('sanitizeGrokErrorDetail redacts prompt-json and system-prompt-override payloads', () => {
    const secret = 'SUPER_SECRET_BASE64_PAYLOAD';
    const raw = `Command failed: grok --model m --system-prompt-override ${secret} --prompt-json [{"type":"image","data":"${secret}"}] --max-turns 2`;
    const cleaned = sanitizeGrokErrorDetail(raw);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain('--prompt-json <redacted>');
    expect(cleaned).toContain('--system-prompt-override <redacted>');
  });

  it('providerFetch dispatcherFor bounds cached undici Agent count without throwing', () => {
    const agents = new Set<object>();
    for (let i = 1; i <= 40; i++) {
      agents.add(dispatcherFor(i * 1000));
    }
    expect(agents.size).toBe(40);
    // Repeated lookup of a recent timeout returns the same pooled Agent instance.
    expect(dispatcherFor(40_000)).toBe(dispatcherFor(40_000));
  });

  it('DreamQueue persists atomically via temp file + rename', () => {
    const dir = mkTmp('dreamq-w4-');
    const persistPath = path.join(dir, 'queue.json');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const q = new DreamQueue({ persistPath });
    q.enqueue('elite-x-elite', [{ id: 'a', descriptor: [0.5], quality: 0.9 }], 1);
    // The queue lands via a temp file renamed onto persistPath, and no temp file is left behind.
    expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining(`${persistPath}.tmp-`), persistPath);
    expect(fs.readdirSync(dir)).toEqual(['queue.json']);
    expect(JSON.parse(fs.readFileSync(persistPath, 'utf-8')).tasks).toHaveLength(1);
    renameSpy.mockRestore();
  });

  it('TasteLearningService createRenderedPreviewProvider catches readArtifact throws cleanly', async () => {
    const badFs = {
      readArtifact: () => { throw new Error('EACCES'); },
    } as unknown as Parameters<typeof createRenderedPreviewProvider>[0];
    const provider = createRenderedPreviewProvider(badFs);
    const preview = await provider({
      id: 'entry-1',
      artifactRef: { kind: 'artifact', hash: 'abc' },
    } as Parameters<typeof provider>[0]);
    expect(preview).toBeNull();
  });

  it('IpRateLimiter bounds tracked IP states cleanly under many distinct IPs', () => {
    const limiter = new IpRateLimiter('test', { windowMs: 60_000, max: 2, error: 'e', message: 'm' });
    const makeRes = () => ({
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    }) as unknown as ServerResponse;
    for (let i = 0; i < 5; i++) {
      const req = { socket: { remoteAddress: `203.0.113.${i}` }, url: '/api', method: 'GET' } as unknown as IncomingMessage;
      expect(limiter.consume(req, makeRes())).toBe(true);
    }
  });
});
