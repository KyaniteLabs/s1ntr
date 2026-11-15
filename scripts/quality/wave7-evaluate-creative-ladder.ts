import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  evaluateWave7CreativeLadder,
  type Wave7CreativeLadderEvidence,
} from '../../src/runtime-core/Wave7CreativeLadder.js';

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: tsx scripts/quality/wave7-evaluate-creative-ladder.ts <evidence.json>');
  process.exit(2);
}

const inputPath = path.resolve(inputArg);
const evidence = JSON.parse(await fs.readFile(inputPath, 'utf8')) as Wave7CreativeLadderEvidence;
const result = evaluateWave7CreativeLadder(evidence);
console.log(JSON.stringify({ inputPath, ...result }, null, 2));
if (!result.passed) process.exit(1);
