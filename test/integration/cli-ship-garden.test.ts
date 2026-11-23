/**
 * `sinter ship garden|rollback` is wired to a real on-disk PolicyChangeManifest (owner rule: wire, never stub).
 * Real binary: stage -> promote (gated) -> roll back, with the manifest file checked after every step.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let home: string;
let manifestFile: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'sinter-ship-')); manifestFile = path.join(home, '.sinter', 'garden', 'policy-manifest.json'); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function sinter(args: string[]) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/sinter'), ...args], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const disk = () => JSON.parse(readFileSync(manifestFile, 'utf8')) as { records: Array<{ id: string; status: string; metricsAfter: Record<string, number> }> };

describe('ship garden / ship rollback', () => {
  it('stages, promotes behind the gate, then rolls back, with state on disk at each step', () => {
    expect(sinter(['ship', 'garden']).out).toContain('No policy changes tracked');

    const staged = sinter(['ship', 'garden', 'stage', 'taste', 'raise', 'novelty', 'weight', '--before', 'quality=0.5,novelty=0.4']);
    expect(staged.status, staged.out).toBe(0);
    expect(disk().records.map(r => [r.id, r.status])).toEqual([['change-1', 'staged']]);

    const promoted = sinter(['ship', 'garden', 'promote', 'change-1', '--after', 'quality=0.6,novelty=0.5']);
    expect(promoted.status, promoted.out).toBe(0);
    expect(disk().records[0]).toMatchObject({ status: 'promoted', metricsAfter: { quality: 0.6, novelty: 0.5 } });
    expect(sinter(['ship', 'garden']).out).toContain('change-1  promoted');

    const rolled = sinter(['ship', 'rollback', 'change-1', '--reason', 'novelty drifted']);
    expect(rolled.status, rolled.out).toBe(0);
    expect(disk().records[0].status).toBe('rolled-back');

    // Rolling back twice is an error, not a silent success.
    const again = sinter(['ship', 'rollback', 'change-1']);
    expect(again.status).toBe(1);
    expect(again.out).toContain('not promoted');
  });

  it('blocks a promotion that regresses a metric and leaves the change staged', () => {
    sinter(['ship', 'garden', 'stage', 'taste', 'risky', '--before', 'quality=0.8']);
    const blocked = sinter(['ship', 'garden', 'promote', 'change-1', '--after', 'quality=0.5']);
    expect(blocked.status).toBe(1);
    expect(blocked.out).toContain('Not promoted');
    expect(disk().records[0].status).toBe('staged');
  });

  it('reports unknown ids and bad input as failures without creating state', () => {
    const missing = sinter(['ship', 'rollback', 'change-9']);
    expect(missing.status).toBe(1);
    expect(missing.out).toContain('Change not found');
    const bad = sinter(['ship', 'garden', 'stage', 'taste', 'x', '--before', 'quality=abc']);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('Bad metric');
    expect(existsSync(manifestFile) ? disk().records.length : 0).toBe(0);
  });

  it('keeps ids unique across runs (no lost or reused change ids)', () => {
    sinter(['ship', 'garden', 'stage', 'a', 'one', '--before', 'q=1']);
    sinter(['ship', 'garden', 'stage', 'b', 'two', '--before', 'q=1']);
    expect(disk().records.map(r => r.id)).toEqual(['change-1', 'change-2']);
  });
});
