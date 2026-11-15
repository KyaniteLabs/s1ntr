import { promises as fs } from 'node:fs';
import path from 'node:path';
import { auditWave7Artifacts } from '../../src/runtime-core/Wave7LeakAudit.js';

const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const targets = process.argv.slice(2).filter((value, index, all) => value !== '--output' && all[index - 1] !== '--output');
if (!output || targets.length === 0) {
  console.error('Usage: pnpm wave7:leak-audit <artifact-path...> --output <receipt.json>');
  process.exit(2);
}
const result = auditWave7Artifacts(targets.map(value => path.resolve(value)));
const receipt = { schemaVersion: 1, gate: 'wave7-leak-audit', generatedAt: new Date().toISOString(), ...result };
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(path.resolve(output), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
if (!result.passed) process.exitCode = 1;
