import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLedger } from '../../scripts/lib/final-qa-ledger.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const entry = (testPath: string) => ({
  path: testPath,
  owner: 'Owner',
  launchRisk: 'risk',
  reason: 'reason',
  action: 'action',
  verification: 'pnpm vitest run x',
});

describe('final QA ledger fragments', () => {
  let dir: string;
  let ledgerPath: string;
  let fragments: string;

  const writeBase = (extra: Record<string, unknown> = {}) =>
    writeFileSync(ledgerPath, JSON.stringify({ pendingTests: [], skippedOrGatedTests: [], ...extra }));
  const writeFragment = (name: string, body: unknown) =>
    writeFileSync(path.join(fragments, name), typeof body === 'string' ? body : JSON.stringify(body));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'final-qa-ledger-'));
    ledgerPath = path.join(dir, 'ledger.json');
    fragments = path.join(dir, 'ledger');
    mkdirSync(fragments);
    writeBase();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('merges a fragment with inline base entries and reports no errors', () => {
    writeBase({ skippedOrGatedTests: [entry('test/a.test.ts')] });
    writeFragment('b.json', { section: 'skippedOrGatedTests', entry: entry('test/b.test.ts') });
    const errors: string[] = [];
    const ledger = loadLedger(ledgerPath, errors);
    expect(errors).toEqual([]);
    expect(ledger.skippedOrGatedTests.map((e: { path: string }) => e.path)).toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(ledger.pendingTests).toEqual([]);
  });

  it('routes a pendingTests fragment to the pending section', () => {
    writeFragment('p.json', { section: 'pendingTests', entry: entry('test/pending/p.test.ts') });
    const errors: string[] = [];
    const ledger = loadLedger(ledgerPath, errors);
    expect(errors).toEqual([]);
    expect(ledger.pendingTests).toHaveLength(1);
    expect(ledger.skippedOrGatedTests).toEqual([]);
  });

  it('fails loudly on a duplicate entry across fragments and against the base file', () => {
    writeBase({ skippedOrGatedTests: [entry('test/a.test.ts')] });
    writeFragment('a-again.json', { section: 'skippedOrGatedTests', entry: entry('test/a.test.ts') });
    writeFragment('b1.json', { section: 'skippedOrGatedTests', entry: entry('test/b.test.ts') });
    writeFragment('b2.json', { section: 'skippedOrGatedTests', entry: entry('test/b.test.ts') });
    const errors: string[] = [];
    const ledger = loadLedger(ledgerPath, errors);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Duplicate ledger entry for test/a.test.ts in');
    expect(errors[1]).toContain('Duplicate ledger entry for test/b.test.ts in');
    expect(ledger.skippedOrGatedTests.map((e: { path: string }) => e.path)).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });

  it('fails loudly on malformed JSON, a wrong shape, an unknown section and a non-json file', () => {
    writeFragment('broken.json', '{ not json');
    writeFragment('shape.json', { section: 'skippedOrGatedTests' });
    writeFragment('section.json', { section: 'other', entry: entry('test/c.test.ts') });
    writeFragment('notes.txt', 'stray');
    const errors: string[] = [];
    const ledger = loadLedger(ledgerPath, errors);
    expect(errors).toHaveLength(4);
    expect(errors.filter(e => e.startsWith('Malformed ledger fragment'))).toHaveLength(3);
    expect(errors.some(e => e.includes('not a .json file') && e.includes('notes.txt'))).toBe(true);
    expect(ledger.skippedOrGatedTests).toEqual([]);
  });

  it('keeps every committed fragment well-formed with all required keys', () => {
    const errors: string[] = [];
    const ledger = loadLedger(path.join(repoRoot, 'docs/launch/final-qa-test-surface-ledger.json'), errors);
    expect(errors).toEqual([]);
    const fragmentFiles = readdirSync(path.join(repoRoot, 'docs/launch/ledger'));
    expect(ledger.skippedOrGatedTests.length + ledger.pendingTests.length).toBe(fragmentFiles.length);
    for (const e of ledger.skippedOrGatedTests) {
      for (const key of ['path', 'owner', 'launchRisk', 'reason', 'action', 'verification']) {
        expect(typeof e[key], `${e.path}.${key}`).toBe('string');
      }
    }
    const base = JSON.parse(readFileSync(path.join(repoRoot, 'docs/launch/final-qa-test-surface-ledger.json'), 'utf8'));
    expect(base.skippedOrGatedTests).toEqual([]);
  });
});
