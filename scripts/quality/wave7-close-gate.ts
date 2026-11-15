import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateWave7ReleaseReadiness, type Wave7ReleaseEvidenceIndex } from '../../src/runtime-core/Wave7ReleaseReadinessValidator.js';

const manifestArg = process.argv[2];
const evidenceArg = process.argv[3];
if (!manifestArg || !evidenceArg) {
  console.error('Usage: pnpm wave7:close-gate <release-manifest.json> <evidence-index.json>');
  process.exit(2);
}

try {
  const manifest = JSON.parse(await fs.readFile(path.resolve(manifestArg), 'utf8')) as unknown;
  const evidence = JSON.parse(await fs.readFile(path.resolve(evidenceArg), 'utf8')) as Wave7ReleaseEvidenceIndex;
  const report = validateWave7ReleaseReadiness(manifest, evidence);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ownerReleaseReady) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
