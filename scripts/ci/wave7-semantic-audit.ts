import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compareWave7ReleaseTruth } from '../../src/runtime-core/Wave7RepositoryReleaseTruth.js';
import type { Wave7ReleaseReadinessReport } from '../../src/runtime-core/Wave7ReleaseReadinessValidator.js';

const files = process.argv.slice(2);
if (files.length !== 3) {
  console.error('Usage: pnpm wave7:semantic-audit <market.json> <release.json> <terminal.json>');
  process.exit(2);
}
const reports = await Promise.all(files.map(async file => {
  const parsed = JSON.parse(await fs.readFile(path.resolve(file), 'utf8')) as Wave7ReleaseReadinessReport & { terminal?: boolean };
  return parsed;
}));
const result = compareWave7ReleaseTruth(reports);
console.log(JSON.stringify({ gate: 'wave7-semantic-audit', ...result }, null, 2));
if (!result.passed) process.exitCode = 1;
