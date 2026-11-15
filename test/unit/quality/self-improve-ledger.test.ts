import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendLedgerRecord,
  exportLedgerSnapshot,
  resolveLedgerReadPath,
  resolveLedgerWritePath,
} from '../../../scripts/quality/self-improve-ledger.mjs';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = join(tmpdir(), `sinter-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('self-improve ledger paths', () => {
  it('writes outside the repository by default', () => {
    const root = tempDir();
    const ledger = resolveLedgerWritePath({ cwd: join(root, 'repo'), home: join(root, 'home'), env: {} });
    expect(ledger).toBe(join(root, 'home', '.sinter', 'quality', 'self-improve-ledger.jsonl'));

    appendLedgerRecord({ ts: 'now', completed: 1 }, { cwd: join(root, 'repo'), home: join(root, 'home'), env: {} });
    expect(readFileSync(ledger, 'utf8')).toContain('"completed":1');
  });

  it('honors the one explicit path override for reads and writes', () => {
    const root = tempDir();
    const env = { SINTER_PROGRESS_LEDGER_PATH: 'runtime/custom.jsonl' };
    const expected = join(root, 'runtime', 'custom.jsonl');
    expect(resolveLedgerWritePath({ cwd: root, home: root, env })).toBe(expected);
    expect(resolveLedgerReadPath({ cwd: root, home: root, env })).toBe(expected);
  });

  it('falls back to the frozen tracked ledger only when runtime data is absent', () => {
    const root = tempDir();
    const cwd = join(root, 'repo');
    const home = join(root, 'home');
    const legacy = join(cwd, 'docs', 'validation', 'self-improve-ledger.jsonl');
    expect(resolveLedgerReadPath({ cwd, home, env: {} })).toBe(legacy);

    const runtime = join(home, '.sinter', 'quality', 'self-improve-ledger.jsonl');
    mkdirSync(join(runtime, '..'), { recursive: true });
    writeFileSync(runtime, '{"ts":"runtime"}\n');
    expect(resolveLedgerReadPath({ cwd, home, env: {} })).toBe(runtime);
  });

  it('exports a validated timestamped snapshot without changing the source', () => {
    const root = tempDir();
    const sourcePath = join(root, 'runtime.jsonl');
    const destinationDir = join(root, 'snapshots');
    writeFileSync(sourcePath, '{"ts":"one"}\n{"ts":"two"}\n');

    const result = exportLedgerSnapshot({
      sourcePath,
      destinationDir,
      now: new Date('2026-07-26T04:05:06.789Z'),
    });

    expect(result.destinationPath).toBe(
      join(destinationDir, 'self-improve-2026-07-26T04-05-06-789Z.jsonl'),
    );
    expect(result.records).toBe(2);
    expect(readFileSync(result.destinationPath, 'utf8')).toBe(readFileSync(sourcePath, 'utf8'));
  });

  it('rejects invalid JSONL before writing a snapshot', () => {
    const root = tempDir();
    const sourcePath = join(root, 'runtime.jsonl');
    const destinationDir = join(root, 'snapshots');
    writeFileSync(sourcePath, '{"ts":"valid"}\nnot-json\n');

    expect(() => exportLedgerSnapshot({ sourcePath, destinationDir })).toThrow();
    expect(existsSync(destinationDir)).toBe(false);
  });
});
