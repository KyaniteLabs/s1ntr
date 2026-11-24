import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));

function readJson(file: string): { engines?: { node?: string } } {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// "20.x || 22.x" -> [20, 22]; ">=20.0.0" -> [20]
function majors(range: string): number[] {
  return range.split('||').map((part) => Number(part.match(/\d+/)?.[0] ?? NaN));
}

describe('declared Node version', () => {
  it('never promises a Node version the native SQLite binding cannot install on', () => {
    const declared = readJson(path.join(root, 'package.json')).engines?.node ?? '';
    const sqlite = readJson(require.resolve('better-sqlite3/package.json')).engines?.node ?? '';

    const declaredFloor = Math.min(...majors(declared));
    const sqliteFloor = Math.min(...majors(sqlite));

    expect(declared.startsWith('>=')).toBe(true);
    expect(sqliteFloor).toBe(20);
    expect(declaredFloor).toBeGreaterThanOrEqual(sqliteFloor);
  });

  it('pins .nvmrc to a major the SQLite binding supports', () => {
    const nvmrc = fs.readFileSync(path.join(root, '.nvmrc'), 'utf-8').trim();
    const sqlite = readJson(require.resolve('better-sqlite3/package.json')).engines?.node ?? '';

    expect(majors(sqlite)).toContain(Number(nvmrc));
  });
});
