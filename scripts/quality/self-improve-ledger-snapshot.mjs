#!/usr/bin/env node

import path from 'node:path';

import { exportLedgerSnapshot } from './self-improve-ledger.mjs';

const destinationDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : undefined;

try {
  const result = exportLedgerSnapshot({ destinationDir });
  console.log(`snapshot: ${result.records} records`);
  console.log(`source:   ${result.sourcePath}`);
  console.log(`written:  ${result.destinationPath}`);
} catch (error) {
  console.error(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
