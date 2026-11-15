import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Wave 7 CLI release truth', () => {
  it('routes market, release gate, and terminal receipt through one collector', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
    expect(source.match(/collectWave7RepositoryReleaseTruth/g)).toHaveLength(6);
    expect(source).toContain("subCmd === 'receipt'");
    expect(source).toContain('ownerReleaseReady');
  });

  it('makes every command surface report the same exhaustive red truth', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wave7-cli-truth-'));
    const env = { ...process.env,
      SINTER_WAVE7_MANIFEST: path.join(root, 'missing-manifest.json'),
      SINTER_WAVE7_EVIDENCE_INDEX: path.join(root, 'missing-index.json') };
    const run = (...args: string[]) => spawnSync(process.execPath,
      [path.join(process.cwd(), 'bin', 'sinter'), ...args], { encoding: 'utf8', env });
    const release = run('release', 'gate');
    const market = run('market', 'status');
    const readiness = run('readiness', 'status');
    expect([release.status, market.status, readiness.status]).toEqual([1, 2, 2]);
    expect(market.stdout).toBe(release.stdout);
    expect(readiness.stdout).toBe(release.stdout);
    const report = JSON.parse(release.stdout);
    expect(report.ownerReleaseReady).toBe(false);
    expect(report.conjuncts).toHaveLength(16);
    // With a missing manifest the gate must fail on product-complete
    // (no valid campaign origin). Wave 8 added conjuncts that evaluate
    // against real repository state and may pass even without a manifest;
    // the invariant is ownerReleaseReady === false + non-zero exit.
    const blocking = report.conjuncts.filter(
      (item: { passed: boolean; id: string }) => !item.passed);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking.some((item: { id: string }) => item.id === 'product-complete')).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
