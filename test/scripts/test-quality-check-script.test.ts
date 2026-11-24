import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const checkerScript = resolve(repoRoot, 'scripts/testing/test-quality-check.mjs');

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'sinter-quality-check-'));
  tempDirs.push(tempDir);
  mkdirSync(join(tempDir, 'test'), { recursive: true });
  return tempDir;
}

function runChecker(cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, [checkerScript, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('test quality checker script', () => {
  it('flags weak assertion fixtures under strict mode', () => {
    const tempRepo = makeTempRepo();
    const weakFixture = [
      "import { expect, it } from 'vitest';",
      '',
      "it('checks bad assertions against concrete outcomes', () => {",
      '  expect({ ok: true }).toBe' + 'Truthy();',
      "  expect('a').to" + "Contain('a');",
      '  expect({ ok: true }).not.toBe' + 'Null();',
      '  expect({ ok: true }).toEqual(expect.' + 'anything());',
      '});',
      '',
    ].join('\n');

    writeFileSync(join(tempRepo, 'test/weak-assertions.test.ts'), weakFixture);

    const result = runChecker(tempRepo, ['--strict']);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('no-weak-test-assertions');
    expect(output).toContain('toBeTruthy');
    expect(output).toContain('toContain');
    expect(output).toContain('not.toBeNull');
    expect(output).toContain('expect.anything');
  });

  it('accepts baseline warnings but fails newly introduced strict warnings', () => {
    const tempRepo = makeTempRepo();
    const baselinePath = join(tempRepo, 'quality-baseline.txt');
    const knownFixture = [
      "import { expect, it } from 'vitest';",
      '',
      "it('keeps known weak assertions visible', () => {",
      '  expect({ ok: true }).toBe' + 'Truthy();',
      '});',
      '',
    ].join('\n');

    writeFileSync(join(tempRepo, 'test/known-weak.test.ts'), knownFixture);

    const writeBaseline = runChecker(tempRepo, ['--write-baseline', baselinePath]);
    expect(writeBaseline.status).toBe(0);

    const accepted = runChecker(tempRepo, ['--strict', '--baseline', baselinePath]);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain('Known baseline warnings: 1');

    const newFixture = [
      "import { expect, it } from 'vitest';",
      '',
      "it('adds a new weak assertion', () => {",
      "  expect('a').to" + "Contain('a');",
      '});',
      '',
    ].join('\n');
    writeFileSync(join(tempRepo, 'test/new-weak.test.ts'), newFixture);

    const rejected = runChecker(tempRepo, ['--strict', '--baseline', baselinePath]);
    const rejectedOutput = `${rejected.stdout}\n${rejected.stderr}`;

    expect(rejected.status).toBe(1);
    expect(rejectedOutput).toContain('new-weak.test.ts');
    expect(rejectedOutput).toContain('toContain');
  });

  it('keeps a moved baseline warning known but rejects an additional copy', () => {
    const tempRepo = makeTempRepo();
    const baselinePath = join(tempRepo, 'quality-baseline.txt');
    const file = join(tempRepo, 'test/moved-weak.test.ts');
    const assertion = "  expect({ ok: true }).toBe" + 'Truthy();';
    writeFileSync(file, ["import { expect, it } from 'vitest';", "it('known', () => {",
      assertion, '});', ''].join('\n'));
    expect(runChecker(tempRepo, ['--write-baseline', baselinePath]).status).toBe(0);
    writeFileSync(file, ["import { expect, it } from 'vitest';", '', "it('known', () => {",
      assertion, '});', ''].join('\n'));
    expect(runChecker(tempRepo, ['--strict', '--baseline', baselinePath]).status).toBe(0);
    writeFileSync(file, ["import { expect, it } from 'vitest';", '', "it('known', () => {",
      assertion, assertion, '});', ''].join('\n'));
    expect(runChecker(tempRepo, ['--strict', '--baseline', baselinePath]).status).toBe(1);
  });

  it('flags a bare called-assertion but not its negated or argument-checking forms', () => {
    const tempRepo = makeTempRepo();
    const bareCalled = '.toHaveBeen' + 'Called();';
    writeFileSync(join(tempRepo, 'test/called.test.ts'), [
      "import { expect, it, vi } from 'vitest';",
      "it('calls', () => {",
      '  const ran = vi.fn(); const idle = vi.fn(); const alias = vi.fn();',
      "  ran('a'); alias();",
      '  expect(ran)' + bareCalled,
      '  expect(alias).toBe' + 'Called();',
      '  expect(idle).not' + bareCalled,
      '  expect(idle)',
      '    .not',
      '    ' + bareCalled,
      "  expect(ran).toHaveBeenCalledWith('a');",
      '  expect(ran).toHaveBeenCalledTimes(1);',
      '});',
      '',
    ].join('\n'));

    const result = runChecker(tempRepo, ['--strict']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Warnings: 2');
    expect(result.stdout).toContain('called.test.ts:5  [no-weak-test-assertions]  toHaveBeenCalled() only proves the mock ran');
    expect(result.stdout).toContain('called.test.ts:6  [no-weak-test-assertions]  toBeCalled() only proves the mock ran');
  });

  it('fails strict mode on a baseline line whose weak assertion is gone, until it is pruned', () => {
    const tempRepo = makeTempRepo();
    const baselinePath = join(tempRepo, 'quality-baseline.txt');
    const file = join(tempRepo, 'test/paid-debt.test.ts');
    const weak = '  expect({ ok: true }).toBe' + 'Truthy();';
    const strong = '  expect({ ok: true }).toEqual({ ok: true });';
    const fixture = (...body: string[]) =>
      ["import { expect, it } from 'vitest';", "it('checks', () => {", ...body, '});', ''].join('\n');

    writeFileSync(file, fixture(weak, weak));
    expect(runChecker(tempRepo, ['--write-baseline', baselinePath]).status).toBe(0);
    const entriesBefore = readFileSync(baselinePath, 'utf8').split('\n').filter(line => line.startsWith('no-weak'));
    expect(entriesBefore).toHaveLength(2);

    // One of the two weak assertions is fixed: the baseline now has a spare line.
    writeFileSync(file, fixture(strong, weak));
    const lenient = runChecker(tempRepo, ['--baseline', baselinePath]);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain('Stale baseline entries: 1');
    const strict = runChecker(tempRepo, ['--strict', '--baseline', baselinePath]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain('pnpm test:quality:prune');

    // Pruning drops the spare line, keeps the comments and the line that still matches.
    const pruned = runChecker(tempRepo, ['--strict', '--prune-baseline', baselinePath, '--baseline', baselinePath]);
    expect(pruned.status).toBe(0);
    expect(pruned.stdout).toContain('Pruned 1 stale baseline entry');
    const after = readFileSync(baselinePath, 'utf8').split('\n');
    expect(after.filter(line => line.startsWith('#'))).toHaveLength(4);
    expect(after.filter(line => line.startsWith('no-weak'))).toEqual([entriesBefore[1]]);

    // Pruning never accepts new debt: a second weak assertion stays a failure.
    writeFileSync(file, fixture(weak, weak));
    const regrown = runChecker(tempRepo, ['--strict', '--prune-baseline', baselinePath, '--baseline', baselinePath]);
    expect(regrown.status).toBe(1);
    expect(regrown.stdout).toContain('Pruned 0 stale baseline entries');
    expect(readFileSync(baselinePath, 'utf8').split('\n')).toEqual(after);
  });

  it('wires strict final QA quality mode through package scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['test:quality']).toBe(
      'node scripts/testing/test-quality-check.mjs --baseline scripts/testing/test-quality-baseline.txt',
    );
    expect(pkg.scripts['test:quality:strict']).toBe(
      'node scripts/testing/test-quality-check.mjs --strict --baseline scripts/testing/test-quality-baseline.txt',
    );
    expect(pkg.scripts['final-qa:test-quality']).toBe('pnpm test:quality:strict');
    expect(pkg.scripts['test:quality:prune']).toBe(
      'node scripts/testing/test-quality-check.mjs --prune-baseline scripts/testing/test-quality-baseline.txt --baseline scripts/testing/test-quality-baseline.txt',
    );
  });
});
