import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildWave7OwnerReviewPacket, type Wave7OwnerReviewInput } from '../../src/runtime-core/Wave7OwnerCreativeReview.js';

const inputArg = process.argv[2];
const outputArg = process.argv[3];
if (!inputArg || !outputArg) {
  console.error('Usage: tsx scripts/quality/wave7-owner-review-packet.ts <blind-pairs.json> <output-dir>');
  process.exit(2);
}
const inputPath = path.resolve(inputArg);
const outputDir = path.resolve(outputArg);
const input = JSON.parse(await fs.readFile(inputPath, 'utf8')) as Wave7OwnerReviewInput;
const base = path.dirname(inputPath);
for (const pair of input.pairs) {
  for (const artifact of [pair.artifactA, pair.artifactB]) {
    for (const ref of [artifact.screenshotRef, artifact.artifactRef, artifact.mediaRef].filter(Boolean) as string[]) {
      await fs.access(path.resolve(base, ref));
    }
  }
}
const packet = buildWave7OwnerReviewPacket(input);
await fs.mkdir(outputDir, { recursive: true });
const contactSheet = path.join(outputDir, 'wave-7-contact-sheet.html');
const decisions = path.join(outputDir, 'owner-decisions.json');
await fs.writeFile(contactSheet, packet.html, 'utf8');
await fs.writeFile(decisions, `${JSON.stringify({
  releaseHead: input.releaseHead,
  sourceFingerprint: input.sourceFingerprint,
  status: 'owner-not-reached',
  decisions: packet.decisions,
}, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ contactSheet, decisions, status: 'owner-not-reached' }, null, 2));
