/** The art-batch learning step drives bin/sinter flags the generic parser used to reject. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bin = path.resolve(import.meta.dirname, '../../bin/sinter');
const home = mkdtempSync(path.join(os.tmpdir(), 'learn-cli-home-'));
const cliTimeoutMs = 30_000;
// Projection import verifies idempotence with two cold CLI invocations.
const testTimeoutMs = 2 * cliTimeoutMs + 5_000;
const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: home, encoding: 'utf8', timeout: cliTimeoutMs,
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env } });
  if (r.error) throw r.error;
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}` };
};

describe('learning-step CLI contract', { timeout: testTimeoutMs }, () => {
  it('judge-evidence accepts --write-negatives', () => {
    const dir = path.join(home, 'run'); mkdirSync(dir, { recursive: true });
    const r = run(['judge-evidence', dir, '--write-negatives', path.join(home, 'neg.jsonl')]);
    expect(r.out).not.toMatch(/Unknown option/);
    expect(r.out).toMatch(/Judge evidence: accepted=0/);
  });
  it('legacy-backfill reaches its own usage, not the generic option error', () => {
    const r = run(['legacy-backfill', 'x.jsonl', '--out', path.join(home, 'o.jsonl'), '--write-negatives', path.join(home, 'n.jsonl')]);
    expect(r.out).not.toMatch(/Unknown option/);
  });
  it('runtime import-projections copies missing Creates into the shared root', () => {
    const run1 = path.join(home, 'run1'); const shared = path.join(home, 'shared');
    mkdirSync(run1, { recursive: true });
    const proj = { 'k-create': { kind: 'create', result: { operationId: 'operation:1' } }, 'k-other': { kind: 'review', result: {} } };
    writeFileSync(path.join(run1, 'product-projections.json'), JSON.stringify(proj));
    const r = run(['runtime', 'import-projections', run1], { SINTER_LIMINAL_RUNTIME_ROOT: shared });
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/imported=1 present=0/);
    const sharedDoc = JSON.parse(readFileSync(path.join(shared, 'product-projections.json'), 'utf8'));
    expect(Object.keys(sharedDoc)).toEqual(['k-create']);
    expect(run(['runtime', 'import-projections', run1], { SINTER_LIMINAL_RUNTIME_ROOT: shared }).out).toMatch(/imported=0 present=1/);
  });
  it('compost add fails closed on a missing seat config when free seats are required', () => {
    const r = run(['compost', 'add', path.join(home, 'x.txt')],
      { SINTER_LEARNING_FREE_SEATS_ONLY: '1', SINTER_CONFIG_PATH: path.join(home, 'absent.json') });
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/LEARNING_NO_FREE_SEAT/);
  });
});
