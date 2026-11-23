import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium as playwrightChromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchPlaywrightChromium, NO_USABLE_SANDBOX } from '../../src/security/SandboxConfig.js';

type Options = { headless?: boolean; chromiumSandbox?: boolean };
type Launcher = { launch(options: Options): Promise<unknown> };

const helpers = {
  src: (chromium: Launcher, options: Options) => launchPlaywrightChromium(chromium, options),
};

// Playwright's own wording when the host cannot sandbox Chromium.
const SANDBOX_FAILED = 'browserType.launch: Target page, context or browser has been closed\n'
  + 'Browser logs:\nChromium sandboxing failed!\n================================\n';

function fakeChromium(failSandboxed?: Error) {
  const calls: Options[] = [];
  return {
    calls,
    async launch(options: Options) {
      calls.push(options);
      if (options.chromiumSandbox && failSandboxed) throw failSandboxed;
      return { sandboxed: options.chromiumSandbox };
    },
  };
}

function onPlatform(platform: NodeJS.Platform) {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  return () => Object.defineProperty(process, 'platform', { value: original });
}

const repoRoot = path.resolve(__dirname, '../..');
const helperFiles = [
  path.join('src', 'security', 'SandboxConfig.ts'),
];

function sourceFiles() {
  const roots = ['src', ...readdirSync(path.join(repoRoot, 'packages')).map((name) => path.join('packages', name, 'src'))];
  return roots.flatMap((root) => {
    try {
      return readdirSync(path.join(repoRoot, root), { recursive: true, encoding: 'utf8' })
        .filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f))
        .map((f) => path.join(root, f));
    } catch { return []; }
  });
}

// Blank out comments and string literals, keeping offsets and line numbers.
function stripCommentsAndStrings(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    (m) => (/^['"`]/.test(m) ? m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m[0] : m.replace(/[^\n]/g, ' ')));
}

const PLAYWRIGHT_IMPORT = /(?:from\s*|import\(\s*|require\(\s*)['"]playwright(?:-core)?['"]/;

/**
 * Lines where a file that imports Playwright — ESM or require(), including
 * `import x = require(...)` — reaches Chromium other than by importing
 * `chromium` under its own name and passing it to launchPlaywrightChromium,
 * or by reading path metadata (`chromium.executablePath()`) that cannot
 * launch anything.
 */
function chromiumMisuses(source: string): number[] {
  if (!PLAYWRIGHT_IMPORT.test(source)) return [];
  const text = stripCommentsAndStrings(source);
  const line = (index: number) => text.slice(0, index).split('\n').length;
  const bad = new Set<number>();
  for (const m of source.matchAll(/import\s+(?!type\b)(?:\*|\w+)[^;]*?from\s*['"]playwright(?:-core)?['"]/g)) bad.add(line(m.index));
  for (const m of source.matchAll(/\{([^}]*)\}\s*(?:from\s*|=\s*(?:await\s+)?(?:import|require)\(\s*)['"]playwright(?:-core)?['"]/g)) {
    if (/\bchromium\s*(?:as\b|:)/.test(m[1]!)) bad.add(line(m.index));
  }
  for (const m of text.matchAll(/\bchromium\b/g)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    const passed = /launchPlaywrightChromium\(\s*$/.test(before) && /^\s*,/.test(after);
    const imported = /\{[^}]*$/.test(before) && /^[^}]*\}\s*(?:from\s*|=\s*(?:await\s+)?(?:import|require)\(\s*)/.test(after);
    const typed = /\btypeof\s+$/.test(before);
    // Path metadata cannot launch a browser; only a direct `.executablePath()`
    // call is allowed (aliasing the method out still flags).
    const pathOnly = /^\s*\.\s*executablePath\s*\(/.test(after);
    if (!passed && !imported && !typed && !pathOnly) bad.add(line(m.index));
  }
  return [...bad].sort((x, y) => x - y);
}

// Playwright adds --no-sandbox to every Chromium launch unless chromiumSandbox
// is true, whatever the args say (#1685).
describe('Playwright Chromium sandbox', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  for (const [name, launch] of Object.entries(helpers)) {
    describe(name, () => {
      it('launches sandboxed unless LIMINAL_DISABLE_SANDBOX=true', async () => {
        for (const value of ['', 'false']) {
          vi.stubEnv('LIMINAL_DISABLE_SANDBOX', value);
          const chromium = fakeChromium();
          expect(await launch(chromium, { headless: true })).toEqual({ sandboxed: true });
          expect(chromium.calls).toEqual([{ headless: true, chromiumSandbox: true }]);
        }
        vi.stubEnv('LIMINAL_DISABLE_SANDBOX', 'true');
        const chromium = fakeChromium();
        expect(await launch(chromium, { headless: true })).toEqual({ sandboxed: false });
        expect(chromium.calls).toHaveLength(1);
      });

      it('runs unsandboxed only on a Linux host that cannot sandbox Chromium', async () => {
        vi.stubEnv('LIMINAL_DISABLE_SANDBOX', '');
        const restore = onPlatform('linux');
        try {
          const noSandbox = fakeChromium(new Error(SANDBOX_FAILED));
          expect(await launch(noSandbox, {})).toEqual({ sandboxed: false });
          expect(noSandbox.calls.map((c) => c.chromiumSandbox)).toEqual([true, false]);

          const otherFailure = fakeChromium(new Error('Executable doesn\'t exist at /nowhere/chrome'));
          await expect(launch(otherFailure, {})).rejects.toThrow('Executable doesn\'t exist');
          expect(otherFailure.calls).toHaveLength(1);
        } finally { restore(); }

        const restoreMac = onPlatform('darwin');
        try {
          const macFailure = fakeChromium(new Error(SANDBOX_FAILED));
          await expect(launch(macFailure, {})).rejects.toThrow('Chromium sandboxing failed');
          expect(macFailure.calls).toHaveLength(1);
        } finally { restoreMac(); }
      });
    });
  }

  it('the src helper names the same sandbox-failure pattern it matches', () => {
    const text = readFileSync(path.join(repoRoot, helperFiles[0]!), 'utf8');
    expect(text).toContain('NO_USABLE_SANDBOX');
    expect(NO_USABLE_SANDBOX.test('No usable sandbox!')).toBe(true);
    expect(NO_USABLE_SANDBOX.test('Executable doesn\'t exist at /nowhere/chrome')).toBe(false);
  });

  // The real Playwright error path, with a fake browser that fails the way
  // Chrome does on a host without a usable sandbox. No browser starts.
  it.runIf(process.platform === 'linux')('falls back on the error Playwright really throws', async () => {
    vi.stubEnv('LIMINAL_DISABLE_SANDBOX', '');
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-chrome-'));
    try {
      const executablePath = path.join(dir, 'chrome');
      writeFileSync(executablePath, [
        '#!/bin/sh',
        'for a in "$@"; do [ "$a" = "--no-sandbox" ] && { echo unsandboxed >> "$(dirname "$0")/calls"; echo "fake: unsandboxed" >&2; exit 1; }; done',
        'echo sandboxed >> "$(dirname "$0")/calls"',
        'echo "[1:1:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! If you are running on Ubuntu 23.10+ ..." >&2',
        'exit 1',
      ].join('\n'));
      chmodSync(executablePath, 0o755);
      await expect(launchPlaywrightChromium(playwrightChromium, { executablePath, timeout: 15000 }))
        .rejects.toThrow('fake: unsandboxed');
      expect(readFileSync(path.join(dir, 'calls'), 'utf8').split('\n').filter(Boolean))
        .toEqual(['sandboxed', 'unsandboxed']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30000);

  // The scanner below must catch every way around the helpers, including the
  // bypasses review found in its first version.
  it('the launch scanner flags every way around the helpers', () => {
    const imp = "import { chromium } from 'playwright';\n";
    const ok = [
      `${imp}await launchPlaywrightChromium(chromium, {});`,
      "const { chromium } = await import('playwright');\nb = await launchPlaywrightChromium(chromium, { headless: true });",
      `${imp}let b: Awaited<ReturnType<typeof chromium.launch>>;\nb = await launchPlaywrightChromium(chromium, {});`,
      "import type { Browser } from 'playwright';\nconst { chromium } = await import('playwright');\nawait launchPlaywrightChromium(chromium, {});",
      `${imp}// chromium.launch() is wrapped\nconst name = 'chromium';\nawait launchPlaywrightChromium(chromium, {});`,
      "const { chromium } = require('playwright');\nawait launchPlaywrightChromium(chromium, {});",
      "const { chromium } = require('playwright');\nconst p = chromium.executablePath();\nawait launchPlaywrightChromium(chromium, {});",
    ];
    for (const text of ok) expect(chromiumMisuses(text), text).toEqual([]);
    const bypasses = [
      `${imp}await chromium.launch({});`,
      `${imp}await chromium\n  .launch({});`,
      `${imp}await chromium['launch']({});`,
      `${imp}await chromium.launchPersistentContext('/tmp', {});`,
      "import { chromium as pw } from 'playwright';\nawait pw.launch({});",
      "import { chromium as pw } from 'playwright-core';\nawait launchPlaywrightChromium(pw, {});",
      "const { chromium: pw } = await import('playwright');\nawait pw.launch({});",
      `${imp}const { launch } = chromium;\nawait launch({});`,
      `${imp}const bt = chromium;\nawait bt.launch({});`,
      "import * as pw from 'playwright';\nawait pw.chromium.launch({});",
      "import pw from 'playwright';\nawait pw.chromium.launch({});",
      "const { chromium } = require('playwright');\nawait chromium.launch({});",
      "const { chromium: pw } = require('playwright');\nawait pw.launch({});",
      "const pw = require('playwright-core');\nawait pw.chromium.launch({});",
      "import pw = require('playwright');\nawait pw.chromium.launch({});",
      "const { chromium } = require('playwright');\nconst ep = chromium.executablePath;\nawait ep();",
    ];
    for (const text of bypasses) expect(chromiumMisuses(text), text).not.toEqual([]);
  });

  // Only the src helper calls chromium.launch. Everything else goes through it.
  it('every Chromium launch in src and packages goes through launchPlaywrightChromium', () => {
    const misuses: string[] = [];
    let launches = 0;
    for (const file of sourceFiles()) {
      if (helperFiles.includes(file)) continue;
      const text = readFileSync(path.join(repoRoot, file), 'utf8');
      misuses.push(...chromiumMisuses(text).map((line) => `${file}:${line}`));
      launches += [...stripCommentsAndStrings(text).matchAll(/launchPlaywrightChromium\(\s*chromium\s*,/g)].length;
    }
    expect(misuses).toEqual([]);
    expect(launches).toBeGreaterThanOrEqual(5);
  });
});
