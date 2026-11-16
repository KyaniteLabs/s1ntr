import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getChromeArgs,
  isSandboxEnabled,
  sandboxOptOutArgs,
  SECURE_CHROME_ARGS,
  DANGEROUS_CHROME_ARGS,
} from '../../src/security/SandboxConfig.js';

describe('SandboxConfig', () => {
  // Per-key env save/restore avoids whole-object process.env replacement.
  const envKey = 'LIMINAL_DISABLE_SANDBOX';
  let savedEnv: string | undefined;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = process.env[envKey];
    delete process.env[envKey];
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = savedEnv;
    consoleWarnSpy.mockRestore();
  });

  describe('getChromeArgs', () => {
    it('should return secure args by default (sandbox enabled)', () => {
      const args = getChromeArgs();
      
      // Should include secure args
      expect(args).toContain('--disable-dev-shm-usage');
      expect(args).toContain('--no-first-run');
      expect(args).toContain('--disable-gpu');
      // With --disable-gpu, WebGL draws only through software, as the renderer's does
      expect(args).toContain('--enable-unsafe-swiftshader');
      
      // Should NOT include dangerous args
      expect(args).not.toContain('--no-sandbox');
      expect(args).not.toContain('--disable-setuid-sandbox');
    });

    it('should NOT disable sandbox when only forceDisableSandbox is true', () => {
      // Environment variable is NOT set
      const args = getChromeArgs({ forceDisableSandbox: true });
      
      // Should NOT include dangerous args because env var is not set
      expect(args).not.toContain('--no-sandbox');
      expect(args).not.toContain('--disable-setuid-sandbox');
      
      // Warning should NOT be logged
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should NOT disable sandbox when only env var is set', () => {
      // Set environment variable
      process.env.LIMINAL_DISABLE_SANDBOX = 'true';
      
      // But forceDisableSandbox is NOT set
      const args = getChromeArgs();
      
      // Should NOT include dangerous args because forceDisableSandbox is false
      expect(args).not.toContain('--no-sandbox');
      expect(args).not.toContain('--disable-setuid-sandbox');
      
      // Warning should NOT be logged
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should disable sandbox ONLY when both conditions are met', () => {
      // Set environment variable
      process.env.LIMINAL_DISABLE_SANDBOX = 'true';
      
      // AND forceDisableSandbox is true
      const args = getChromeArgs({ forceDisableSandbox: true });
      
      // Should include dangerous args
      expect(args).toContain('--no-sandbox');
      expect(args).toContain('--disable-setuid-sandbox');
      
      // Warning SHOULD be logged (via Logger which prefixes with [SandboxConfig])
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SandboxConfig]')
      );
    });

    it('should include all secure args even when sandbox is disabled', () => {
      process.env.LIMINAL_DISABLE_SANDBOX = 'true';
      const args = getChromeArgs({ forceDisableSandbox: true });
      
      // Should still have secure args
      expect(args).toContain('--disable-dev-shm-usage');
      expect(args).toContain('--no-first-run');
      expect(args).toContain('--disable-gpu');
    });

    it('should handle env var value "false" correctly', () => {
      process.env.LIMINAL_DISABLE_SANDBOX = 'false';
      const args = getChromeArgs({ forceDisableSandbox: true });
      
      // Should NOT disable sandbox because env var is "false"
      expect(args).not.toContain('--no-sandbox');
    });

    it('should handle empty env var correctly', () => {
      process.env.LIMINAL_DISABLE_SANDBOX = '';
      const args = getChromeArgs({ forceDisableSandbox: true });
      
      // Should NOT disable sandbox because env var is empty
      expect(args).not.toContain('--no-sandbox');
    });
  });

  describe('isSandboxEnabled', () => {
    it('should return true when --no-sandbox is NOT in args', () => {
      const args = ['--disable-dev-shm-usage', '--no-first-run'];
      expect(isSandboxEnabled(args)).toBe(true);
    });

    it('should return false when --no-sandbox IS in args', () => {
      const args = ['--disable-dev-shm-usage', '--no-sandbox', '--no-first-run'];
      expect(isSandboxEnabled(args)).toBe(false);
    });

    it('should return true for default secure args', () => {
      expect(isSandboxEnabled(SECURE_CHROME_ARGS)).toBe(true);
    });

    it('should return false for dangerous args', () => {
      expect(isSandboxEnabled(DANGEROUS_CHROME_ARGS)).toBe(false);
    });
  });

  describe('SECURE_CHROME_ARGS', () => {
    it('should contain expected secure arguments', () => {
      expect(SECURE_CHROME_ARGS).toContain('--disable-dev-shm-usage');
      expect(SECURE_CHROME_ARGS).toContain('--no-first-run');
      expect(SECURE_CHROME_ARGS).toContain('--disable-gpu');
    });

    // Chrome reads any --disable-web-security switch, "=false" included, as
    // "turn web security off" (#1684).
    it('never carries a --disable-web-security switch, in any form', () => {
      const launches = [SECURE_CHROME_ARGS, getChromeArgs(), getChromeArgs({ forceDisableSandbox: true })];
      for (const args of launches) {
        expect(args.filter((arg) => arg.startsWith('--disable-web-security'))).toEqual([]);
      }
    });

    it('should NOT contain --no-zygote or --single-process (incompatible with sandbox enabled)', () => {
      // --no-zygote and --single-process require --no-sandbox to function — omitting them
      // prevents the "Zygote cannot be disabled if sandbox is enabled" crash.
      expect(SECURE_CHROME_ARGS).not.toContain('--no-zygote');
      expect(SECURE_CHROME_ARGS).not.toContain('--single-process');
    });

    it('should NOT contain --no-sandbox', () => {
      expect(SECURE_CHROME_ARGS).not.toContain('--no-sandbox');
    });

    it('should NOT contain --disable-setuid-sandbox', () => {
      expect(SECURE_CHROME_ARGS).not.toContain('--disable-setuid-sandbox');
    });
  });

  describe('DANGEROUS_CHROME_ARGS', () => {
    it('should contain dangerous arguments', () => {
      expect(DANGEROUS_CHROME_ARGS).toContain('--no-sandbox');
      expect(DANGEROUS_CHROME_ARGS).toContain('--disable-setuid-sandbox');
    });
  });

  describe('sandboxOptOutArgs', () => {
    it('returns no flags unless the container opt-out is set', () => {
      expect(sandboxOptOutArgs()).toEqual([]);
      process.env[envKey] = 'false';
      expect(sandboxOptOutArgs()).toEqual([]);
    });

    it('returns exactly the dangerous flags when LIMINAL_DISABLE_SANDBOX=true', () => {
      process.env[envKey] = 'true';
      expect(sandboxOptOutArgs()).toEqual(['--no-sandbox', '--disable-setuid-sandbox']);
    });
  });

  describe('browser launches in src/', () => {
    it('never hard-code --no-sandbox outside SandboxConfig', async () => {
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) { walk(full); continue; }
          if (!/\.tsx?$/.test(name) || full.endsWith(join('security', 'SandboxConfig.ts'))) continue;
          const code = readFileSync(full, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
          if (/['"`]--no-sandbox['"`]/.test(code)) offenders.push(full);
        }
      };
      walk(join(process.cwd(), 'src'));
      expect(offenders).toEqual([]);
    });

    // Puppeteer adds no software WebGL, and with --disable-gpu (or no GPU)
    // a WebGL sketch gets no context, so a check would judge a blank page
    // the renderer never shows (#1681). Playwright adds the flag itself.
    it('give every Puppeteer browser the software WebGL the renderer has', async () => {
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const { join, relative } = await import('node:path');
      const launches: string[] = [];
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) { walk(full); continue; }
          if (!/\.tsx?$/.test(name)) continue;
          const code = readFileSync(full, 'utf8');
          // A direct launch, or launch options handed to a library (Revideo).
          for (const m of code.matchAll(/puppeteer(?:\.default)?\.launch\(\{[\s\S]*?\}\)|\bpuppeteer:\s*\{[\s\S]*?\}/g)) {
            const where = `${relative(process.cwd(), full)}@${code.slice(0, m.index).split('\n').length}`;
            launches.push(where);
            if (!/getChromeArgs\(|SOFTWARE_WEBGL_ARGS|--enable-unsafe-swiftshader/.test(m[0])) offenders.push(where);
          }
        }
      };
      walk(join(process.cwd(), 'src'));
      expect(launches.length).toBeGreaterThanOrEqual(8);
      expect(offenders).toEqual([]);
    });
  });
});
