/**
 * F9 browser preflight (#401): purge-resistant browser home, one-shot install
 * self-heal, and disk-pressure sentinel.
 *
 * Root cause: macOS purges regenerable caches under disk pressure
 * (~/.cache/puppeteer, ~/Library/Caches/ms-playwright). Durable home is
 * ~/.sinter/browsers — shared across all worktrees, not a Caches directory.
 */

import { existsSync, mkdirSync, readdirSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Logger } from './Logger.js';

/** Shared durable browser root (not under Caches / .cache). */
export const DEFAULT_BROWSERS_HOME = join(homedir(), '.sinter', 'browsers');

export const PLAYWRIGHT_BROWSERS_SUBDIR = 'playwright';
export const PUPPETEER_CACHE_SUBDIR = 'puppeteer';

/** Free-space ratio below this triggers a non-blocking warning. */
export const DISK_PRESSURE_FREE_RATIO = 0.1;

export type BrowserInstallKind = 'playwright-chromium' | 'puppeteer-chrome';

export interface BrowserInstallResult {
  ok: boolean;
  /** Offline / network / command-missing gap (no install attempted successfully). */
  offlineOrUnavailable?: boolean;
  message: string;
  kind: BrowserInstallKind;
}

export type BrowserInstaller = (kind: BrowserInstallKind) => BrowserInstallResult;

export interface DiskPressureFinding {
  /** true when free ratio is below DISK_PRESSURE_FREE_RATIO */
  underPressure: boolean;
  path: string;
  freeBytes: number;
  totalBytes: number;
  freeRatio: number;
  freeGB: number;
  freePct: number;
  message: string | null;
}

export interface BrowserPreflightOptions {
  /** Injected installer (tests). Default spawns playwright/puppeteer CLIs. */
  installer?: BrowserInstaller;
  /** Injected disk probe (tests). */
  diskProbe?: (path: string) => DiskPressureFinding | null;
  /** Skip install attempt (resolve-only). */
  skipInstall?: boolean;
  /** Force re-check disk even if already checked this process. */
  forceDiskCheck?: boolean;
  /** Force another install attempt (tests). */
  forceInstallAttempt?: boolean;
  /** stderr writer (tests). Default: process.stderr.write */
  stderrWrite?: (chunk: string) => void;
  /** Telemetry sink for disk-pressure finding (tests). Default: best-effort recordEvent. */
  recordFinding?: (finding: DiskPressureFinding) => void;
}

export interface ChromiumLaunchOptions {
  headless: true;
  executablePath?: string;
}

/**
 * Keep direct Playwright launches aligned with the CI-provided Chromium.
 * PLAYWRIGHT_BROWSERS_PATH selects a cache; it does not make chromium.launch()
 * use PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH automatically.
 */
export function chromiumLaunchOptions(
  env: NodeJS.ProcessEnv = process.env,
  resolveManaged?: () => string | undefined,
): ChromiumLaunchOptions {
  const executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const injectedExecutable = !executablePath ? resolveManaged?.() : undefined;
  if (injectedExecutable) return { headless: true, executablePath: injectedExecutable };
  if (!executablePath && env === process.env) {
    const { playwrightPath } = ensurePurgeResistantBrowserEnv(env);
    const durableExecutable = scanChromiumUnder(playwrightPath);
    if (durableExecutable) return { headless: true, executablePath: durableExecutable };
  }
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  };
}

// --- process-once state (resettable in tests) ---

let envApplied = false;
let installAttempted = false;
let lastInstallResult: BrowserInstallResult | null = null;
let diskChecked = false;
let lastDiskFinding: DiskPressureFinding | null = null;

/** Test-only: reset once-per-process flags. */
export function __resetBrowserPreflightForTests(): void {
  envApplied = false;
  installAttempted = false;
  lastInstallResult = null;
  diskChecked = false;
  lastDiskFinding = null;
}

/**
 * Default durable browser home paths.
 * Playwright and Puppeteer use different cache layouts — keep subdirs.
 */
export function defaultPlaywrightBrowsersPath(home = DEFAULT_BROWSERS_HOME): string {
  return join(home, PLAYWRIGHT_BROWSERS_SUBDIR);
}

export function defaultPuppeteerCacheDir(home = DEFAULT_BROWSERS_HOME): string {
  return join(home, PUPPETEER_CACHE_SUBDIR);
}

/**
 * Set PLAYWRIGHT_BROWSERS_PATH + PUPPETEER_CACHE_DIR to ~/.sinter/browsers/*
 * when unset. Explicit user env always wins. Idempotent per process.
 *
 * CI reuse: if the durable default is empty but `/opt/pw-browsers` already
 * has chromium (runner image), keep pointing PLAYWRIGHT_BROWSERS_PATH there
 * only when the user did not set an override — that path is not a macOS
 * Caches dir and is the existing CI provision path.
 *
 * Also ensures the directories exist so first install lands in the durable home.
 */
export function ensurePurgeResistantBrowserEnv(
  env: NodeJS.ProcessEnv = process.env,
  options?: { home?: string; mkdir?: boolean },
): { playwrightPath: string; puppeteerPath: string; applied: boolean } {
  const home = options?.home ?? DEFAULT_BROWSERS_HOME;
  const playwrightDefault = defaultPlaywrightBrowsersPath(home);
  const puppeteerDefault = defaultPuppeteerCacheDir(home);
  const ciProvisioned = '/opt/pw-browsers';

  let applied = false;

  if (!env.PLAYWRIGHT_BROWSERS_PATH) {
    // Prefer durable home; fall back to pre-provisioned CI path when present.
    const useCi =
      existsSync(ciProvisioned)
      && !hasChromiumDir(playwrightDefault)
      && hasChromiumDir(ciProvisioned);
    env.PLAYWRIGHT_BROWSERS_PATH = useCi ? ciProvisioned : playwrightDefault;
    applied = true;
  }
  if (!env.PUPPETEER_CACHE_DIR) {
    env.PUPPETEER_CACHE_DIR = puppeteerDefault;
    applied = true;
  }

  // Never re-point at macOS Caches/ or ~/.cache (purge-prone). Legacy installs
  // are still discovered read-only via scanLegacyBrowserCaches().

  if (options?.mkdir !== false) {
    try {
      mkdirSync(env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true });
      mkdirSync(env.PUPPETEER_CACHE_DIR, { recursive: true });
    } catch (err) {
      // Non-fatal (the install step also fails loudly), but say why browsers will not install.
      Logger.warn('browserPreflight', 'could not create browser cache directories:', err);
    }
  }

  envApplied = true;
  return {
    playwrightPath: env.PLAYWRIGHT_BROWSERS_PATH,
    puppeteerPath: env.PUPPETEER_CACHE_DIR,
    applied: applied || envApplied,
  };
}

function hasChromiumDir(browsersPath: string): boolean {
  try {
    return readdirSync(browsersPath).some((d) => d.startsWith('chromium'));
  } catch {
    return false;
  }
}

/**
 * Pure free-space check (statvfs-equivalent via fs.statfsSync).
 * Returns null when the platform probe is unavailable.
 */
export function probeDiskPressure(
  targetPath: string,
  threshold = DISK_PRESSURE_FREE_RATIO,
): DiskPressureFinding | null {
  const statfs = typeof statfsSync === 'function' ? statfsSync : null;
  if (!statfs) return null;

  try {
    const s = statfs(targetPath);
    const bsize = Number(s.bsize);
    const blocks = Number(s.blocks);
    const bavail = Number(s.bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || blocks <= 0) {
      return null;
    }
    const totalBytes = blocks * bsize;
    const freeBytes = bavail * bsize;
    const freeRatio = freeBytes / totalBytes;
    const freeGB = freeBytes / (1024 ** 3);
    const freePct = freeRatio * 100;
    const underPressure = freeRatio < threshold;
    const message = underPressure
      ? `[browser-preflight] DISK PRESSURE: volume for "${targetPath}" has ` +
        `${freeGB.toFixed(1)}GB free (${freePct.toFixed(1)}% < ${(threshold * 100).toFixed(0)}%). ` +
        `macOS purges regenerable caches first (~/.cache/puppeteer, ~/Library/Caches/ms-playwright), ` +
        `which silently breaks render/sandbox/sing. Durable browser home: ${DEFAULT_BROWSERS_HOME}.`
      : null;

    return {
      underPressure,
      path: targetPath,
      freeBytes,
      totalBytes,
      freeRatio,
      freeGB,
      freePct,
      message,
    };
  } catch {
    return null;
  }
}

/**
 * Once-per-process disk sentinel: warn on stderr + optional telemetry.
 * Never throws / never blocks.
 */
export function checkDiskPressureOnce(
  options: BrowserPreflightOptions = {},
): DiskPressureFinding | null {
  if (diskChecked && !options.forceDiskCheck) {
    return lastDiskFinding;
  }
  diskChecked = true;

  const target =
    process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? process.env.PUPPETEER_CACHE_DIR
    ?? DEFAULT_BROWSERS_HOME;

  const probe = options.diskProbe ?? probeDiskPressure;
  const finding = probe(target);
  lastDiskFinding = finding;

  if (finding?.underPressure && finding.message) {
    const write = options.stderrWrite ?? ((c: string) => {
      process.stderr.write(c.endsWith('\n') ? c : `${c}\n`);
    });
    write(finding.message);

    const record = options.recordFinding ?? defaultRecordDiskFinding;
    try {
      record(finding);
    } catch {
      // telemetry must never break preflight
    }
  }

  return finding;
}

function defaultRecordDiskFinding(finding: DiskPressureFinding): void {
  // Best-effort async ledger write — fire and forget.
  void import('../telemetry/EventLedger.js')
    .then(({ recordEvent }) =>
      recordEvent({
        event: 'infra.diskPressure',
        model: null,
        provider: null,
        role: null,
        runId: null,
        episodeId: null,
        domain: null,
        inputHash: null,
        verdict: 'warning',
        latencyMs: null,
        costUsd: null,
        evidenceRefs: [],
        payload: {
          path: finding.path,
          freeBytes: finding.freeBytes,
          totalBytes: finding.totalBytes,
          freeRatio: finding.freeRatio,
          freeGB: Number(finding.freeGB.toFixed(2)),
          freePct: Number(finding.freePct.toFixed(2)),
          browsersHome: DEFAULT_BROWSERS_HOME,
        },
      }),
    )
    .catch(() => {
      /* ignore */
    });
}

/**
 * Default installer: spawn playwright / puppeteer CLI once.
 * No network mock in production — CI tests inject their own installer.
 */
export function defaultBrowserInstaller(kind: BrowserInstallKind): BrowserInstallResult {
  const cmds: Record<BrowserInstallKind, { cmd: string; args: string[] }> = {
    'playwright-chromium': {
      cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', 'playwright', 'install', 'chromium'],
    },
    'puppeteer-chrome': {
      cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', 'puppeteer', 'browsers', 'install', 'chrome'],
    },
  };
  const { cmd, args } = cmds[kind];
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      env: process.env,
      timeout: 10 * 60 * 1000,
    });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      const offline =
        err.code === 'ENOENT'
        || /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(String(err.message));
      return {
        ok: false,
        offlineOrUnavailable: offline || err.code === 'ENOENT',
        message: `Failed to spawn ${cmd}: ${err.message}`,
        kind,
      };
    }
    if (result.status === 0) {
      return { ok: true, message: `${kind} install succeeded`, kind };
    }
    const combined = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    const offline = /ENOTFOUND|EAI_AGAIN|network|offline|getaddrinfo|ETIMEDOUT/i.test(combined);
    return {
      ok: false,
      offlineOrUnavailable: offline,
      message: combined.slice(0, 500) || `${kind} install exited ${result.status}`,
      kind,
    };
  } catch (err) {
    return {
      ok: false,
      offlineOrUnavailable: true,
      message: err instanceof Error ? err.message : String(err),
      kind,
    };
  }
}

/** Skip real network installs in unit/CI-fast unless an installer is injected. */
function shouldSkipDefaultInstall(options: BrowserPreflightOptions): boolean {
  if (options.installer) return false;
  if (process.env.LIMINAL_ALLOW_BROWSER_INSTALL === '1') return false;
  return (
    process.env.LIMINAL_SKIP_BROWSER_INSTALL === '1'
    || process.env.LIMINAL_CI_FAST === '1'
    || process.env.VITEST === 'true'
    || process.env.VITEST === '1'
  );
}

/**
 * Attempt browser install at most once per process (unless forceInstallAttempt).
 */
export function attemptBrowserInstallOnce(
  kind: BrowserInstallKind,
  options: BrowserPreflightOptions = {},
): BrowserInstallResult {
  if (installAttempted && !options.forceInstallAttempt) {
    return lastInstallResult ?? {
      ok: false,
      message: 'Install already attempted this process',
      kind,
    };
  }
  installAttempted = true;

  const write = options.stderrWrite ?? ((c: string) => {
    process.stderr.write(c.endsWith('\n') ? c : `${c}\n`);
  });

  if (shouldSkipDefaultInstall(options)) {
    const result: BrowserInstallResult = {
      ok: false,
      offlineOrUnavailable: true,
      message:
        'Browser auto-install skipped (test/CI-fast). Inject installer in tests, ' +
        'or set LIMINAL_ALLOW_BROWSER_INSTALL=1 for a real install.',
      kind,
    };
    lastInstallResult = result;
    write(`[browser-preflight] ${result.message}`);
    return result;
  }

  write(
    `[browser-preflight] Chromium missing — attempting one-shot install (${kind}). ` +
    `Durable home: ${process.env.PLAYWRIGHT_BROWSERS_PATH ?? DEFAULT_BROWSERS_HOME}`,
  );

  const installer = options.installer ?? defaultBrowserInstaller;
  const result = installer(kind);
  lastInstallResult = result;

  if (result.ok) {
    write(`[browser-preflight] Install succeeded (${kind}).`);
  } else {
    write(`[browser-preflight] Install failed (${kind}): ${result.message}`);
  }
  return result;
}

/**
 * Actionable error when Chromium cannot be resolved after preflight.
 */
export function missingChromiumError(details?: {
  installResult?: BrowserInstallResult | null;
  browsersPath?: string;
}): Error {
  const browsersPath =
    details?.browsersPath
    ?? process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? defaultPlaywrightBrowsersPath();
  const install = details?.installResult;
  const offline = install?.offlineOrUnavailable
    ? ' Network/offline gap — install requires network access.'
    : '';
  const installNote = install && !install.ok
    ? ` Auto-install failed: ${install.message}.`
    : install?.ok
      ? ' Auto-install reported success but binary still missing.'
      : ' Auto-install was not possible.';

  return new Error(
    `[browser-preflight] FATAL: Chromium executable not found under "${browsersPath}".` +
    `${installNote}${offline} ` +
    `Fix: \`pnpm exec playwright install chromium\` and/or \`pnpm exec puppeteer browsers install chrome\` ` +
    `(or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). ` +
    `Browsers live at ${DEFAULT_BROWSERS_HOME} (purge-resistant; not under Caches). ` +
    `See docs/agents/browser-home.md.`,
  );
}

/**
 * Full preflight: env defaults → disk sentinel → resolve-or-install.
 * Returns executable path when found; throws loud Error when still missing
 * after one install attempt (unless skipInstall and not found → undefined).
 */
export function preflightChromiumExecutablePath(
  resolve: () => string | undefined,
  options: BrowserPreflightOptions & {
    installKind?: BrowserInstallKind;
    /** When true (default), throw missingChromiumError if still absent after install. */
    throwIfMissing?: boolean;
  } = {},
): string | undefined {
  ensurePurgeResistantBrowserEnv();
  checkDiskPressureOnce(options);

  const found = resolve();
  if (found) return found;

  if (options.skipInstall) {
    if (options.throwIfMissing) throw missingChromiumError({ installResult: null });
    return undefined;
  }

  const kind = options.installKind ?? 'playwright-chromium';
  const installResult = attemptBrowserInstallOnce(kind, options);
  const after = resolve();
  if (after) return after;

  if (options.throwIfMissing !== false) {
    throw missingChromiumError({ installResult });
  }
  return undefined;
}

/**
 * Legacy-cache scan helpers (reuse if durable home empty but old install remains).
 * Used only as a last-resort read path before install — does not re-home env to Caches.
 */
export function scanLegacyBrowserCaches(): string | undefined {
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
  }
  candidates.push(join(homedir(), '.cache', 'ms-playwright'));
  candidates.push(join(homedir(), '.cache', 'puppeteer'));

  for (const root of candidates) {
    if (!existsSync(root)) continue;
    const found = scanChromiumUnder(root);
    if (found) return found;
  }
  return undefined;
}

function scanChromiumUnder(browsersPath: string): string | undefined {
  try {
    const dirs = readdirSync(browsersPath);
    for (const dir of dirs) {
      if (!dir.startsWith('chromium') && !dir.startsWith('chrome')) continue;
      for (const sub of [
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome/mac_arm-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ]) {
        // Skip glob-like entries — only concrete relative paths
        if (sub.includes('*')) continue;
        const candidate = join(browsersPath, dir, sub);
        if (existsSync(candidate)) return candidate;
      }
      // puppeteer chrome layout: chrome/mac_arm-*/...
      const chromeDir = join(browsersPath, dir);
      if (dir === 'chrome' || existsSync(chromeDir)) {
        const nested = findChromeBinaryRecursive(chromeDir, 4);
        if (nested) return nested;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function findChromeBinaryRecursive(root: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(root)) return undefined;
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(root, ent.name);
      if (ent.isFile() && (ent.name === 'chrome' || ent.name === 'Chromium' || ent.name === 'Google Chrome for Testing')) {
        return full;
      }
      if (ent.isDirectory()) {
        const found = findChromeBinaryRecursive(full, depth - 1);
        if (found) return found;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
