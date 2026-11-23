/**
 * Secure sandbox configuration for Puppeteer
 * 
 * SECURITY WARNING: Disabling the sandbox (--no-sandbox) should ONLY be done
 * in containerized environments with proper seccomp/apparmor profiles.
 * In production, always use the sandbox.
 */

import { Logger } from '../utils/Logger.js';
import { prepareBrowserScratch } from '../utils/scratchSpace.js';

export interface SandboxConfig {
  /** When true, disables Chrome sandbox (USE WITH CAUTION) */
  disableSandbox: boolean;
  /** Additional Chrome arguments */
  extraArgs: string[];
}

/**
 * Default secure Chrome arguments (sandbox enabled)
 *
 * NOTE: --no-zygote and --single-process are intentionally excluded here.
 * Those flags are only valid when --no-sandbox is also set (Docker containers).
 * Using --no-zygote without --no-sandbox produces a fatal error:
 * "Zygote cannot be disabled if sandbox is enabled."
 */
export const SECURE_CHROME_ARGS = [
  '--disable-dev-shm-usage',     // Required for Docker
  '--no-first-run',              // Skip first run wizards
  '--disable-gpu',               // Disable GPU acceleration
  '--disable-features=IsolateOrigins,site-per-process', // Performance
];

/**
 * WebGL in software. Playwright adds this flag to every Chromium launch, so
 * the renderer that scores artwork draws WebGL. Puppeteer adds nothing, and
 * with --disable-gpu a WebGL sketch fails to get a context and draws nothing.
 * getChromeArgs includes it, so every Puppeteer launch draws what the
 * renderer draws.
 */
export const SOFTWARE_WEBGL_ARGS = ['--enable-unsafe-swiftshader'];

/**
 * Dangerous arguments that disable security (use only when absolutely necessary)
 */
export const DANGEROUS_CHROME_ARGS = [
  '--no-sandbox',              // Disables Chrome sandbox
  '--disable-setuid-sandbox',  // Disables setuid sandbox
];

/**
 * Get Chrome arguments based on configuration
 * 
 * By default, uses secure configuration with sandbox enabled.
 * Sandbox is ONLY disabled when LIMINAL_DISABLE_SANDBOX=true AND explicitly requested.
 */
export function getChromeArgs(options?: { forceDisableSandbox?: boolean }): string[] {
  const disableSandboxEnv = process.env.LIMINAL_DISABLE_SANDBOX === 'true';
  const shouldDisableSandbox = options?.forceDisableSandbox && disableSandboxEnv;
  
  const args = [...SECURE_CHROME_ARGS, ...SOFTWARE_WEBGL_ARGS];
  
  if (shouldDisableSandbox) {
    Logger.warn('SandboxConfig', 'Chrome sandbox is disabled. This should only be used in containerized environments with seccomp/AppArmor profiles.');
    args.push(...DANGEROUS_CHROME_ARGS);
  }
  
  return args;
}

let warnedNoUsableSandbox = false;

/**
 * How Playwright reports a host that cannot sandbox Chromium. It replaces
 * Chrome's "No usable sandbox!" log with "Chromium sandboxing failed!"
 * (playwright-core 1.59.1, server/chromium/chromium.js:150).
 */
export const NO_USABLE_SANDBOX = /Chromium sandboxing failed|No usable sandbox|crbug\.com\/(?:357670|638180)/i;

/**
 * Launch Playwright Chromium with the OS sandbox. Every Playwright launch in
 * src goes through here: Playwright adds --no-sandbox unless chromiumSandbox
 * is true, whatever the args say (#1685).
 *
 * The sandbox is on unless LIMINAL_DISABLE_SANDBOX=true (containerized CI).
 * Some Linux hosts cannot give Chrome a sandbox: Ubuntu 23.10+ restricts
 * unprivileged user namespaces, and a downloaded Chromium has no AppArmor
 * profile. There this relaunches without the sandbox and says so once,
 * rather than breaking every render. Anywhere else a sandbox failure throws.
 */
export async function launchPlaywrightChromium<O extends object, B>(
  chromium: { launch(options: O & { chromiumSandbox?: boolean }): Promise<B> },
  options: O,
): Promise<B> {
  prepareBrowserScratch();   // profile dir off the data volume + free-space check
  if (process.env.LIMINAL_DISABLE_SANDBOX === 'true') {
    return chromium.launch({ ...options, chromiumSandbox: false });
  }
  try {
    return await chromium.launch({ ...options, chromiumSandbox: true });
  } catch (err) {
    if (process.platform !== 'linux'
      || !NO_USABLE_SANDBOX.test(err instanceof Error ? err.message : String(err))) throw err;
    if (!warnedNoUsableSandbox) {
      warnedNoUsableSandbox = true;
      Logger.warn('SandboxConfig', 'Chromium has no usable OS sandbox on this host, so it runs '
        + 'unsandboxed. Give Chromium an AppArmor profile that allows userns, or set '
        + 'LIMINAL_DISABLE_SANDBOX=true to choose this on purpose.');
    }
    return chromium.launch({ ...options, chromiumSandbox: false });
  }
}

/**
 * The sandbox opt-out flags alone, for launches that keep their own rendering
 * flags. Empty unless LIMINAL_DISABLE_SANDBOX=true (containerized CI only).
 */
export function sandboxOptOutArgs(): string[] {
  if (process.env.LIMINAL_DISABLE_SANDBOX !== 'true') return [];
  Logger.warn('SandboxConfig', 'Chrome sandbox is disabled. This should only be used in containerized environments with seccomp/AppArmor profiles.');
  return [...DANGEROUS_CHROME_ARGS];
}

/**
 * Check if sandbox is properly configured
 */
export function isSandboxEnabled(args: string[]): boolean {
  return !args.includes('--no-sandbox');
}

/**
 * Whether the strongest network-isolated executor (Puppeteer `runInSandbox`,
 * which denies ALL network requests except locally-fulfilled library scripts)
 * should gate the live render path.
 *
 * Default OFF: the normal render path uses the Playwright HeadlessRenderer with
 * its CDN allowlist. When LIMINAL_NETWORK_ISOLATED_RENDER=true (hardened
 * deployments), candidate code is first vetted in the fully network-isolated
 * sandbox before it is rendered for scoring, so artifact code that hangs or
 * cannot run under deny-all networking is rejected up front.
 */
export function isNetworkIsolatedRenderEnabled(): boolean {
  return process.env.LIMINAL_NETWORK_ISOLATED_RENDER === 'true';
}
