import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  auditWave8CurrentAuthority,
  collectWave8ReleaseRootTruth,
  compareWave8ReleaseRootTruth,
  parseWave8ReleaseReadinessReport,
} from '../../src/runtime-core/Wave8ReleaseRoot.js';

const files = process.argv.slice(2);
if (files.length !== 3) {
  console.error('Usage: pnpm wave8:semantic-audit <market.json> <release.json> <terminal.json>');
  process.exit(2);
}

const reports = await Promise.all(files.map(async file =>
  parseWave8ReleaseReadinessReport(JSON.parse(await readFile(path.resolve(file), 'utf8')))));
const projection = compareWave8ReleaseRootTruth(reports);
const current = collectWave8ReleaseRootTruth(process.cwd());
const currentFailures = reports.flatMap((report, index) => {
  const comparison = compareWave8ReleaseRootTruth([current, current, report]);
  return comparison.passed ? [] : comparison.failures.map(failure => `report ${index + 1} is not current: ${failure}`);
});
const authority = auditWave8CurrentAuthority(
  await readFile(path.resolve('docs/agents/waves/CURRENT.md'), 'utf8'),
);
const failures = [...projection.failures, ...currentFailures, ...authority.failures];
const result = { gate: 'wave8-semantic-audit', passed: failures.length === 0, failures };
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
