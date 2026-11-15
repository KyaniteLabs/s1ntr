import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/check-orphans.sh');
const exceptionsPath = 'scripts/orphan-exceptions.txt';

// src/app.ts is imported by src/index.ts, so it has a runtime importer.
const wiredModule = {
  'src/index.ts': "export * from './app.js';\n",
  'src/app.ts': 'export const app = 1;\n',
};

// src/lonely.ts is imported by its test and by nothing else.
const testOnlyModule = {
  'src/lonely.ts': 'export const lonely = 1;\n',
  'test/lonely.test.ts': "import { lonely } from '../src/lonely.js';\n",
};

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
}

const fixtures: string[] = [];

function runCheck(files: Record<string, string>): { status: number | null; stdout: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'check-orphans-'));
  fixtures.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const result = spawnSync('bash', [scriptPath], { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scripts/check-orphans.sh', () => {
  it('passes when every module has a runtime importer', () => {
    const result = runCheck({ ...wiredModule, [exceptionsPath]: '# none\n' });

    expect(result.stdout).toBe('No orphaned files found.\n');
    expect(result.status).toBe(0);
  });

  it('fails a module that only a test imports', () => {
    const result = runCheck({ ...wiredModule, ...testOnlyModule, [exceptionsPath]: '# none\n' });

    expect(result.stdout).toContain('ORPHAN: src/lonely.ts\n');
    expect(result.stdout).toContain('1 orphaned file(s) and 0 exception problem(s) found.');
    expect(result.status).toBe(1);
  });

  it('passes a test-only module that has a dated exception, and prints the date', () => {
    const reviewBy = daysFromNow(30);
    const result = runCheck({
      ...wiredModule,
      ...testOnlyModule,
      [exceptionsPath]: `# header\n\nsrc/lonely.ts ${reviewBy} waiting on a caller\n`,
    });

    expect(result.stdout).toBe(`EXCEPTION: src/lonely.ts (review by ${reviewBy})\nNo orphaned files found.\n`);
    expect(result.status).toBe(0);
  });

  it('fails once the review date has passed', () => {
    const result = runCheck({
      ...wiredModule,
      ...testOnlyModule,
      [exceptionsPath]: 'src/lonely.ts 2020-01-01 waiting on a caller\n',
    });

    expect(result.stdout).toContain('EXPIRED EXCEPTION: src/lonely.ts was due for review on 2020-01-01.');
    expect(result.stdout).toContain('0 orphaned file(s) and 1 exception problem(s) found.');
    expect(result.status).toBe(1);
  });

  it('fails a review date more than 180 days ahead', () => {
    const reviewBy = daysFromNow(400);
    const result = runCheck({
      ...wiredModule,
      ...testOnlyModule,
      [exceptionsPath]: `src/lonely.ts ${reviewBy} waiting on a caller\n`,
    });

    expect(result.stdout).toContain(`BAD EXCEPTION: src/lonely.ts has review date ${reviewBy}, more than 180 days ahead.`);
    expect(result.status).toBe(1);
  });

  it('fails an exception that has no date or no reason', () => {
    const reviewBy = daysFromNow(30);
    const noReason = runCheck({ ...wiredModule, ...testOnlyModule, [exceptionsPath]: `src/lonely.ts ${reviewBy}\n` });
    const noDate = runCheck({ ...wiredModule, ...testOnlyModule, [exceptionsPath]: 'src/lonely.ts someday maybe\n' });

    const message = 'BAD EXCEPTION: src/lonely.ts needs a review-by date written YYYY-MM-DD, then a reason.';
    expect(noReason.stdout).toContain(message);
    expect(noReason.status).toBe(1);
    expect(noDate.stdout).toContain(message);
    expect(noDate.status).toBe(1);
  });

  it('fails an exception for a module that has an importer or no longer exists', () => {
    const reviewBy = daysFromNow(30);
    const result = runCheck({
      ...wiredModule,
      [exceptionsPath]: `src/app.ts ${reviewBy} has an importer\nsrc/gone.ts ${reviewBy} was deleted\n`,
    });

    expect(result.stdout).toContain('STALE EXCEPTION: src/app.ts is gone or has an importer now.');
    expect(result.stdout).toContain('STALE EXCEPTION: src/gone.ts is gone or has an importer now.');
    expect(result.stdout).toContain('0 orphaned file(s) and 2 exception problem(s) found.');
    expect(result.status).toBe(1);
  });
});
