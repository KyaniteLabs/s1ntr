import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectWave7RepositoryReleaseTruth,
  compareWave7ReleaseTruth,
  formatWave7RepositoryReleaseTruth,
} from '../../../src/runtime-core/Wave7RepositoryReleaseTruth.js';
import { WAVE7_RELEASE_CONJUNCT_IDS } from '../../../src/runtime-core/Wave7ReleaseReadinessValidator.js';

const roots: string[] = [];
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'wave7-truth-')); roots.push(value); return value; }
afterEach(() => roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })));

describe('Wave7RepositoryReleaseTruth', () => {
  it('emits the full identical red contract when release evidence is absent', () => {
    const report = collectWave7RepositoryReleaseTruth(root());
    expect(report.ownerReleaseReady).toBe(false);
    expect(report.conjuncts.map(item => item.id)).toEqual(WAVE7_RELEASE_CONJUNCT_IDS);
    expect(JSON.parse(formatWave7RepositoryReleaseTruth(report))).toEqual(report);
    expect(compareWave7ReleaseTruth([report, structuredClone(report), structuredClone(report)])).toEqual({ passed: true, failures: [] });
  });

  it('fails semantic agreement on any readiness or blocker drift', () => {
    const report = collectWave7RepositoryReleaseTruth(root());
    const drifted = structuredClone(report);
    drifted.blockers = [];
    expect(compareWave7ReleaseTruth([report, drifted, report])).toEqual({
      passed: false, failures: ['report 2 disagrees with report 1'],
    });
    expect(compareWave7ReleaseTruth([report])).toMatchObject({ passed: false });
  });
});
