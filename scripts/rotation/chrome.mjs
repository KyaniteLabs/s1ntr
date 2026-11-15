/**
 * Chrome resolution for rotation batteries (F9 residual / F23).
 *
 * Durable home + system Chrome fallback. Puppeteer default cache under
 * ~/.cache is purgeable; prefer ~/.sinter/browsers and macOS system Chrome.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BROWSERS_HOME = path.join(os.homedir(), '.sinter', 'browsers');

/**
 * Apply purge-resistant browser env defaults when unset.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function ensureRotationBrowserEnv(env = process.env) {
  if (!env.PUPPETEER_CACHE_DIR) {
    env.PUPPETEER_CACHE_DIR = path.join(DEFAULT_BROWSERS_HOME, 'puppeteer');
  }
  if (!env.PLAYWRIGHT_BROWSERS_PATH) {
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(DEFAULT_BROWSERS_HOME, 'playwright');
  }
  return env;
}

/**
 * First existing Chrome/Chromium binary suitable for puppeteer.launch.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function resolveChromeExecutable(env = process.env) {
  ensureRotationBrowserEnv(env);
  /** @type {string[]} */
  const candidates = [];

  for (const key of [
    'PUPPETEER_EXECUTABLE_PATH',
    'CHROME_PATH',
    'GOOGLE_CHROME_BIN',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
  ]) {
    if (env[key]) candidates.push(env[key]);
  }

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
  } else if (process.platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    );
  }

  // Durable puppeteer cache (chrome for testing layouts)
  const cacheRoots = [
    env.PUPPETEER_CACHE_DIR,
    path.join(DEFAULT_BROWSERS_HOME, 'puppeteer'),
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ].filter(Boolean);

  for (const root of cacheRoots) {
    const found = scanPuppeteerChrome(root);
    if (found) candidates.push(found);
  }

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * @param {string} root
 * @returns {string | undefined}
 */
function scanPuppeteerChrome(root) {
  try {
    if (!fs.existsSync(root)) return undefined;
    const stack = [root];
    let depth = 0;
    while (stack.length && depth < 400) {
      depth += 1;
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name === '.git') continue;
          stack.push(full);
        } else if (
          ent.name === 'Google Chrome for Testing'
          || ent.name === 'chrome'
          || ent.name === 'Chromium'
          || ent.name === 'chrome.exe'
        ) {
          // Prefer mac app binary path markers
          if (
            full.includes('Google Chrome for Testing.app')
            || full.includes('Chromium.app')
            || ent.name === 'chrome'
            || ent.name === 'chrome.exe'
            || ent.name === 'Google Chrome for Testing'
          ) {
            return full;
          }
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Options for puppeteer.launch used by rotation / audition gates.
 * @param {object} [extra]
 */
export function puppeteerLaunchOptions(extra = {}) {
  ensureRotationBrowserEnv();
  const executablePath = resolveChromeExecutable();
  const { args: extraArgs, ...rest } = extra;
  const args = extraArgs || [
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ];
  return {
    headless: 'new',
    ...(executablePath ? { executablePath } : {}),
    args,
    ...rest,
  };
}
