import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  formatWave8ReleaseRootTruth,
  parseWave8ReleaseRoot,
  validateWave8ReleaseRoot,
} from '../../src/runtime-core/Wave8ReleaseRoot.js';
import { computeProofSourceFingerprint } from '../../src/runtime-core/ProofReceiptValidator.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: pnpm exec tsx scripts/quality/wave8-close-gate.ts <release-root.json>');
  process.exit(2);
}

try {
  const repoRoot = process.cwd();
  const root = parseWave8ReleaseRoot(JSON.parse(await readFile(path.resolve(input), 'utf8')) as unknown);
  const sourceFingerprint = computeProofSourceFingerprint(repoRoot)?.replace(/^sha256:/, '');
  if (!sourceFingerprint || !/^[0-9a-f]{64}$/.test(sourceFingerprint)) {
    // Without a source fingerprint the drift check cannot run; treating that
    // as a pass would certify a tree the release root was never bound to.
    console.error('source-fingerprint-unavailable: refusing to certify release state');
    process.exitCode = 2;
    process.exit(2);
  }
  const report = validateWave8ReleaseRoot(root, { currentSourceFingerprint: sourceFingerprint });
  console.log(formatWave8ReleaseRootTruth(report));
  if (!report.ownerReleaseReady) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
