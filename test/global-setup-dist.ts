import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Tests that spawn the built CLI or read the packed install (dist/) fail with ERR_MODULE_NOT_FOUND
 * on a fresh checkout. CI runs `pnpm build` first, so dist/ exists there and this does nothing.
 * Locally it builds once when the CLI entry is missing, so a bare `vitest run` tells the truth.
 */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, '..');
  if (existsSync(path.join(root, 'dist', 'cli', 'index.js')) || process.env.LIMINAL_SKIP_DIST_BUILD === '1') return;
  const built = spawnSync('npx', ['tsc', '--incremental', 'false'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) throw new Error('dist build failed; run `pnpm build` and read the errors');
}
