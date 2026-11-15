import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(here, '..', '..', '..', 'scripts', 'quality', 'self-improve-daemon.sh');
const fixtures: string[] = [];

/** A throwaway repo whose bin/sinter and cycle script just record that they ran. */
function runDaemon(buildExit: number, maxIterations: number) {
  const root = mkdtempSync(join(tmpdir(), 'self-improve-daemon-'));
  fixtures.push(root);
  const repo = join(root, 'repo');
  const shims = join(root, 'shims');
  const ran = join(root, 'ran.log');
  mkdirSync(join(repo, 'bin'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'quality'), { recursive: true });
  mkdirSync(shims);
  const recorder = (label: string) =>
    `require('node:fs').appendFileSync(process.env.FAKE_RAN, '${label} ' + process.argv.slice(2).join(' ') + '\\n');\n`;
  writeFileSync(join(repo, 'bin', 'sinter'), recorder('sinter'));
  writeFileSync(join(repo, 'scripts', 'quality', 'self-improve-cycle.mjs'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FAKE_RAN, 'cycle\\n');\n`);
  writeFileSync(join(shims, 'pnpm'), `#!/bin/sh\necho build >> "$FAKE_RAN"\nexit ${buildExit}\n`, { mode: 0o755 });
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

  const result = spawnSync('bash', [DAEMON], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${shims}:${process.env.PATH ?? ''}`,
      HOME: root,
      FAKE_RAN: ran,
      SINTER_REPO: repo,
      SINTER_CYCLE_INTERVAL: '0',
      SINTER_MAX_ITERATIONS: String(maxIterations),
    },
  });
  const steps = existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n') : [];
  const marker = join(repo, '.quality', 'last-build-sha');
  return { result, steps, builtSha: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('self-improve-daemon build gate (#1321)', () => {
  it('a failed build skips the iteration instead of running the previous dist', () => {
    const { result, steps, builtSha } = runDaemon(1, 2);

    expect(result.status).toBe(0);
    // Both iterations retry the build; nothing downstream ever runs on a stale dist.
    expect(steps).toEqual(['build', 'build']);
    expect(builtSha).toBe(null);
    expect(result.stdout).toContain('SKIPPING iteration');
    expect(result.stdout).not.toContain('running PREVIOUS dist');
    expect(result.stdout).toContain('reached SINTER_MAX_ITERATIONS=2');
  });

  it('a successful build records HEAD and runs the tend/train/reflect/cycle steps once per iteration', () => {
    const { result, steps, builtSha } = runDaemon(0, 1);

    expect(result.status).toBe(0);
    expect(steps).toEqual([
      'build',
      'sinter garden tend',
      'sinter preferences train',
      'sinter chat reflect',
      'cycle',
    ]);
    expect(builtSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
