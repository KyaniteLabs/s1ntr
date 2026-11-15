import fs from 'node:fs';
import path from 'node:path';
import { WAVE7_CONTRACT_DIGEST } from './Wave7ReleaseContract.js';
import {
  validateWave7ReleaseReadiness,
  WAVE7_RELEASE_CONJUNCT_IDS,
  type Wave7ReleaseEvidenceIndex,
  type Wave7ReleaseReadinessReport,
} from './Wave7ReleaseReadinessValidator.js';
import {
  collectWave8ReleaseRootTruth,
  wave8ReleaseRootPaths,
  type Wave8ReleaseReadinessReport,
} from './Wave8ReleaseRoot.js';

type RepositoryReleaseTruth = Wave7ReleaseReadinessReport | Wave8ReleaseReadinessReport;

export interface Wave7RepositoryTruthPaths {
  manifestPath: string;
  evidenceIndexPath: string;
}

export function wave7RepositoryTruthPaths(repoRoot: string): Wave7RepositoryTruthPaths {
  return {
    manifestPath: process.env.SINTER_WAVE7_MANIFEST
      ? path.resolve(process.env.SINTER_WAVE7_MANIFEST)
      : path.join(repoRoot, '.quality', 'wave-7', 'release', 'release-manifest.json'),
    evidenceIndexPath: process.env.SINTER_WAVE7_EVIDENCE_INDEX
      ? path.resolve(process.env.SINTER_WAVE7_EVIDENCE_INDEX)
      : path.join(repoRoot, '.quality', 'wave-7', 'release', 'evidence-index.json'),
  };
}

function unavailable(reason: string): Wave7ReleaseReadinessReport {
  const conjuncts = WAVE7_RELEASE_CONJUNCT_IDS.map(id => ({ id, passed: false, failures: [reason] }));
  return {
    schemaVersion: 1, wave: 7, contractDigest: WAVE7_CONTRACT_DIGEST,
    releaseRootDigest: 'unfrozen', ownerReleaseReady: false,
    circulationReady: false, recoveryReady: false, creativeLadderReady: false, compoundReady: false,
    conjuncts, blockers: conjuncts.map(item => `${item.id}: ${reason}`),
  };
}

export function collectWave7RepositoryReleaseTruth(repoRoot = process.cwd()): Wave7ReleaseReadinessReport | Wave8ReleaseReadinessReport {
  const wave8Path = wave8ReleaseRootPaths(repoRoot).rootPath;
  if (process.env.SINTER_WAVE8_RELEASE_ROOT || fs.existsSync(wave8Path)) {
    return collectWave8ReleaseRootTruth(repoRoot);
  }
  const paths = wave7RepositoryTruthPaths(repoRoot);
  if (!fs.existsSync(paths.manifestPath) || !fs.existsSync(paths.evidenceIndexPath)) {
    return unavailable('frozen release manifest or evidence index is missing');
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8')) as unknown;
    const evidence = JSON.parse(fs.readFileSync(paths.evidenceIndexPath, 'utf8')) as Wave7ReleaseEvidenceIndex;
    return validateWave7ReleaseReadiness(manifest, evidence);
  } catch (error) {
    return unavailable(`release evidence invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function formatWave7RepositoryReleaseTruth(report: RepositoryReleaseTruth): string {
  return JSON.stringify(report, null, 2);
}

function truthProjection(report: RepositoryReleaseTruth) {
  if ('contractDigest' in report) {
    return {
      contractDigest: report.contractDigest, releaseRootDigest: report.releaseRootDigest,
      ownerReleaseReady: report.ownerReleaseReady, conjuncts: report.conjuncts, blockers: report.blockers,
    };
  }
  return {
    wave: report.wave, releaseRootDigest: report.releaseRootDigest,
    ownerReleaseReady: report.ownerReleaseReady, conjuncts: report.conjuncts, blockers: report.blockers,
  };
}

export function compareWave7ReleaseTruth(reports: RepositoryReleaseTruth[]): { passed: boolean; failures: string[] } {
  if (reports.length !== 3) return { passed: false, failures: ['exactly market, release, and terminal reports are required'] };
  const expected = JSON.stringify(truthProjection(reports[0]));
  const failures = reports.flatMap((report, index) =>
    JSON.stringify(truthProjection(report)) === expected ? [] : [`report ${index + 1} disagrees with report 1`]);
  return { passed: failures.length === 0, failures };
}
