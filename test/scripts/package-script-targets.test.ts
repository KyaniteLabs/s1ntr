import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');

interface PackageJson {
  scripts: Record<string, string>;
}

interface LocalScriptTarget {
  scriptName: string;
  command: string;
  target: string;
}

function normalizeTarget(rawTarget: string): string {
  return rawTarget.replace(/^['"]|['"]$/g, '');
}

function isLocalTarget(target: string): boolean {
  return target.startsWith('./')
    || target.startsWith('bin/')
    || target.startsWith('scripts/')
    || target.startsWith('src/')
    || target.startsWith('test/');
}

function extractLocalScriptTargets(pkg: PackageJson): LocalScriptTarget[] {
  const targets: LocalScriptTarget[] = [];
  const executablePattern = /\b(?:node|tsx|bash|sh)\s+("[^"]+"|'[^']+'|[^\s&|;]+)/g;

  for (const [scriptName, command] of Object.entries(pkg.scripts)) {
    for (const match of command.matchAll(executablePattern)) {
      const target = normalizeTarget(match[1] ?? '');
      if (!target || target.startsWith('-') || !isLocalTarget(target)) continue;
      targets.push({ scriptName, command, target });
    }
  }

  return targets;
}

describe('package script targets', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;

  it('does not wire package scripts to missing local command targets', () => {
    const missingTargets = extractLocalScriptTargets(pkg)
      .filter(({ target }) => !fs.existsSync(path.join(repoRoot, target)));

    expect(missingTargets).toEqual([]);
  });

  it('keeps the route performance proof wired to its script', () => {
    expect(pkg.scripts['proof:route-performance']).toBe('tsx scripts/proof/route-performance-budget.ts');
    expect(fs.existsSync(path.join(repoRoot, 'scripts/proof/route-performance-budget.ts'))).toBe(true);
  });

  it('does not carry a stale NODE_OPTIONS=--no-deprecation prefix on tsx scripts', () => {
    const tsxScripts = Object.entries(pkg.scripts).filter(([, command]) => /\btsx\b/.test(command));
    expect(tsxScripts.length).toBeGreaterThan(0);

    const offenders = tsxScripts
      .filter(([, command]) => command.includes('NODE_OPTIONS=--no-deprecation'))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it('documents the tsx deprecation history', () => {
    expect(fs.existsSync(path.join(repoRoot, 'docs/notes/tsx-deprecation-suppression.md'))).toBe(true);
  });
});


describe('package scripts named in docs', () => {
  const scriptPath = path.join(repoRoot, 'scripts/ci/check-package-script-targets.mjs');
  const fixtures: string[] = [];

  function runCheck(readme: string): { status: number | null; stdout: string; stderr: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-targets-'));
    fixtures.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }));
    fs.writeFileSync(path.join(root, 'README.md'), readme);
    const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  afterEach(() => {
    for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when every command in code names a real script or a pnpm command', () => {
    const result = runCheck([
      'Run `pnpm install`, then `pnpm build` and `pnpm test`.',
      '',
      '```bash',
      'pnpm run build -- --watch',
      'npm run build',
      'pnpm --filter gui dev',
      '```',
      '',
      'Outside code, pnpm ghost and npm run ghost are prose and are not checked.',
      '',
    ].join('\n'));

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Package script target check passed:');
    expect(result.status).toBe(0);
  });

  it('fails and names the file and line when a doc names a script that does not exist', () => {
    const result = runCheck([
      'Run `pnpm run ghost` first.',
      '',
      '```bash',
      'pnpm phantom',
      'npm run build',
      '```',
      '',
    ].join('\n'));

    expect(result.stderr).toContain('- README.md:1: pnpm run ghost names a package script that does not exist');
    expect(result.stderr).toContain('- README.md:4: pnpm phantom names a package script that does not exist');
    expect(result.stderr).not.toContain('npm run build');
    expect(result.status).toBe(1);
  });
});
