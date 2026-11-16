import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A brand-new user runs `sinter "<prompt>"`, `sinter --configure` or `sinter studio`
// with an empty HOME. Every entrypoint resolves its authority through
// resolveRuntimeExecutorAuthority(), so that is the seam this test drives.

const saved = { HOME: process.env.HOME, ROOT: process.env.SINTER_EXECUTOR_AUTHORITY_ROOT };
let home: string;

const freshModule = async () => {
  vi.resetModules();
  return import('../../../src/identity/executorAuthorityBootstrap.js');
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'first-run-home-'));
  process.env.HOME = home;
  // Any value leaves test mode and takes the real production path; the pinned root ignores it.
  process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = join(home, 'ignored-by-pinned-root');
});

afterEach(() => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.ROOT === undefined) delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
  else process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = saved.ROOT;
  rmSync(home, { recursive: true, force: true });
});

describe('first run on a fresh machine', () => {
  it('creates a private host trust key instead of refusing to start', async () => {
    const { resolveRuntimeExecutorAuthority } = await freshModule();
    resolveRuntimeExecutorAuthority();

    const rootDir = join(home, '.sinter', 'executor-authority');
    const keyPath = join(rootDir, 'trust-key.json');
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(rootDir).mode & 0o777).toBe(0o700);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'ignored-by-pinned-root'))).toBe(false);
  });

  it('reuses the same key on the next run', async () => {
    (await freshModule()).resolveRuntimeExecutorAuthority();
    const keyPath = join(home, '.sinter', 'executor-authority', 'trust-key.json');
    const first = readFileSync(keyPath, 'utf8');
    (await freshModule()).resolveRuntimeExecutorAuthority();
    expect(readFileSync(keyPath, 'utf8')).toBe(first);
  });

  it('keeps verification strict: it never mints a key to verify against', async () => {
    const { loadPinnedProductionHostAuthority } = await freshModule();
    expect(() => loadPinnedProductionHostAuthority()).toThrow('existing host trust key is required');
    expect(existsSync(join(home, '.sinter', 'executor-authority', 'trust-key.json'))).toBe(false);
  });
});
